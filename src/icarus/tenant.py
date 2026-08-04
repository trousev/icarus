"""Request-scoped tenant resolution: middleware, ContextVar, registry.

Provides the Tenant type, a ContextVar-based tenant carrier, a pure
state-machine tenant resolver, and a JSONL-backed TenantRegistry that
doubles as a GDPR audit ledger.
"""

import hashlib
import hmac as hmac_mod
import json
import os
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator

import structlog

from icarus.config import config

logger = structlog.get_logger("icarus.tenant")

# ── Constants ────────────────────────────────────────────────────────────────

_LIBRECHAT_PLACEHOLDER = "LibreChat_User_ID"
_MAX_IDENTITY_LENGTH = 128


# ── Tenant identity ──────────────────────────────────────────────────────────


@dataclass
class Tenant:
    """A resolved tenant identity for one request.

    ``id`` and ``group_id`` are the same — the raw identity from the header
    (e.g. LibreChat user ID).  No hashing, no prefix mangling.  Logs and
    admin commands show the actual username.

    In legacy mode ``id`` is ``""`` and ``group_id`` is the configured
    ``GRAPHITI_GROUP_ID``.
    """

    id: str        # raw identity from header / body ("" in legacy mode)
    group_id: str  # same as id; in legacy mode = GRAPHITI_GROUP_ID
    via: str       # resolution channel: header | body | legacy_default | legacy_header_ignored

    @classmethod
    def from_identity(cls, tenant_id: str, via: str) -> "Tenant":
        """Derive a tenant from a raw identity."""
        return cls(id=tenant_id, group_id=tenant_id, via=via)

    @classmethod
    def legacy(cls, via: str = "legacy_default") -> "Tenant":
        """Return the singleton legacy tenant."""
        return cls(id="", group_id=config.GRAPHITI_GROUP_ID, via=via)


# ── ContextVar ───────────────────────────────────────────────────────────────

_current_tenant: ContextVar[Tenant | None] = ContextVar(
    "icarus_tenant", default=None
)


def current_tenant() -> Tenant:
    """Return the request-scoped tenant, or the legacy default.

    The request chain (proxy → inject → memory_for_request → search_facts)
    reads this via the ContextVar set by ``TenantMiddleware``.  Outside a
    request context:

    * **LEGACY mode** — falls back to ``config.GRAPHITI_GROUP_ID``.
    * **MULTI_TENANT mode** — raises ``RuntimeError``.  Long-lived tasks
      (write worker, maintenance loop) must pass explicit ``group_id``.
    """
    tenant = _current_tenant.get()
    if tenant is not None:
        return tenant
    if config.MEMORY_MULTI_TENANT:
        raise RuntimeError(
            "current_tenant() called outside a request context in "
            "MULTI_TENANT mode — pass an explicit group_id instead"
        )
    return Tenant.legacy(via="legacy_default")


@contextmanager
def tenant_context(tenant: Tenant) -> Iterator[Tenant]:
    """Temporarily set the tenant (tests, standalone tasks)."""
    token = _current_tenant.set(tenant)
    try:
        yield tenant
    finally:
        _current_tenant.reset(token)


class TenantIsolationError(RuntimeError):
    """Raised when a tenant-scoped operation is attempted without a tenant context."""


def require_tenant() -> Tenant:
    """Return the current tenant or raise TenantIsolationError.

    Use at entry points where tenant context is mandatory (request handlers).
    Background tasks that carry ``group_id`` explicitly should NOT call this —
    they pass the id directly to MemoryClient methods.

    Usage::

        tenant = require_tenant()
        facts = await client.search_facts(q, group_id=tenant.group_id)
    """
    tenant = _current_tenant.get()
    if tenant is None:
        raise TenantIsolationError(
            "Tenant context required but not set. "
            "Pass group_id explicitly or wrap in tenant_context()."
        )
    return tenant


# ── Tenant resolution ────────────────────────────────────────────────────────


class TenantRejected(Exception):
    """Tenant resolution failed; carries the HTTP status and reason."""

    def __init__(self, status_code: int, reason: str) -> None:
        super().__init__(reason)
        self.status_code = status_code
        self.reason = reason


def _is_chat_path(path: str) -> bool:
    """Return True for chat-completion paths (matches proxy.py routing)."""
    return path.endswith("chat/completions")


def _tenant_from_header(header: str) -> Tenant:
    """Validate a header identity; raises ``TenantRejected`` on malformed input."""
    if not header.strip():
        raise TenantRejected(400, "empty tenant identity")
    if len(header) > _MAX_IDENTITY_LENGTH:
        raise TenantRejected(400, "tenant identity too long")
    if header == _LIBRECHAT_PLACEHOLDER:
        raise TenantRejected(400, "LibreChat placeholder identity rejected")

    tenant_id = header
    if config.MEMORY_TENANT_HMAC_SECRET:
        # Signed wire format: "{id}.{hmac_sha256(secret, id)[:32]}"
        try:
            tenant_id, signature = header.rsplit(".", 1)
        except ValueError:
            raise TenantRejected(401, "unverifiable tenant signature")
        expected = hmac_mod.new(
            config.MEMORY_TENANT_HMAC_SECRET.encode(),
            tenant_id.encode(),
            hashlib.sha256,
        ).hexdigest()[:32]
        if not hmac_mod.compare_digest(signature, expected):
            raise TenantRejected(401, "unverifiable tenant signature")

    return Tenant.from_identity(tenant_id, via="header")


async def _body_user(request) -> str | None:
    """Extract ``body["user"]``, rejecting the LibreChat placeholder constant.

    This guard is mandatory — a bare ``body["user"]`` bet silently collapses
    every user into group ``"LibreChat_User_ID"`` (the spec's "silent constant
    collapse" hazard).
    """
    try:
        body = await request.body()
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    user = data.get("user") if isinstance(data, dict) else None
    if not isinstance(user, str):
        return None
    user = user.strip()
    if not user or user == _LIBRECHAT_PLACEHOLDER or len(user) > _MAX_IDENTITY_LENGTH:
        logger.warning("tenant_body_user_rejected")
        return None
    return user


async def resolve_tenant(request) -> Tenant:
    """Resolve the request tenant per the two-mode state machine.

    **LEGACY**: always resolves to ``GRAPHITI_GROUP_ID`` (header present →
    ignored with a warning).

    **MULTI_TENANT**: header → validation → HMAC → body fallback (chat
    routes only) → ``TenantRejected``.
    """
    header = request.headers.get(config.MEMORY_TENANT_HEADER, "").strip()

    if not config.MEMORY_MULTI_TENANT:
        if header:
            logger.warning(
                "tenant_header_ignored",
                header=config.MEMORY_TENANT_HEADER,
            )
            return Tenant.legacy(via="legacy_header_ignored")
        return Tenant.legacy(via="legacy_default")

    # MULTI_TENANT mode
    # Check for empty/malformed before checking presence —
    # whitespace-only headers are 400, not 401.
    header_raw = request.headers.get(config.MEMORY_TENANT_HEADER, "")
    if header_raw and not header_raw.strip():
        raise TenantRejected(400, "empty tenant identity")
    if header:
        return _tenant_from_header(header)

    if _is_chat_path(request.url.path) and config.MEMORY_BODY_USER_FALLBACK:
        body_user = await _body_user(request)
        if body_user is not None:
            return Tenant.from_identity(body_user, via="body")

    raise TenantRejected(401, "missing tenant identity")


# ── Tenant registry (JSONL audit ledger) ─────────────────────────────────────


class TenantRegistry:
    """Append-only JSONL registry of discovered tenants.

    Doubles as the GDPR audit ledger (T9) and the enumeration source for
    maintenance.  Every event appends a record carrying the FULL merged
    state, so reload is last-record-wins.  No-ops in LEGACY mode — the
    legacy group is config, not a discovered tenant.
    """

    def __init__(self, path: str = config.MEMORY_REGISTRY_FILE) -> None:
        self._path = path
        self._tenants: dict[str, dict] = {}   # group_id → latest record
        self._load()

    # ── Events ────────────────────────────────────────────────────────────

    def record_seen(self, tenant: Tenant) -> None:
        """Log request-entry tenant resolution (called by the middleware)."""
        if not config.MEMORY_MULTI_TENANT:
            return
        # group_id is the raw username — no hashing needed
        self._append_event(tenant.group_id, tenant.id, "seen")

    def record_write(self, group_id: str) -> None:
        """Log a background write enqueue (called by extract_and_store)."""
        if not config.MEMORY_MULTI_TENANT:
            return
        self._append_event(group_id, group_id, "write")

    def record_purge(self, group_id: str) -> str:
        """Mark a tenant purged; returns the ISO ``purged_at`` timestamp.

        This is step 1 of the purge sequence — the write worker drops
        queued jobs against ``is_purged_after`` before any graph deletion
        runs.
        """
        now = datetime.now(timezone.utc).isoformat()
        self._append_event(group_id, self._tenants.get(group_id, {}).get("identity", group_id), "purge", purged_at=now)
        return now

    # ── Reads ─────────────────────────────────────────────────────────────

    def get(self, group_id: str) -> dict | None:
        """Return the latest record for *group_id*, or None."""
        return self._tenants.get(group_id)

    def all(self) -> list[dict]:
        """Return all tenant records."""
        return list(self._tenants.values())

    def group_ids(self) -> list[str]:
        """Return all known (non-purged) group_ids."""
        return sorted(self._tenants)

    def is_purged_after(self, group_id: str, ref_time: datetime) -> bool:
        """True if the tenant was purged at or after *ref_time* (worker job-drop)."""
        rec = self._tenants.get(group_id)
        if not rec or not rec.get("purged_at"):
            return False
        purged = datetime.fromisoformat(rec["purged_at"])
        return ref_time <= purged

    # ── Startup recovery ──────────────────────────────────────────────────

    def merge_orphans(self, group_ids: list[str]) -> int:
        """Register snapshot-table tenants missing from the registry.

        Called at startup (lifespan) — recovers a lost registry file.
        Returns the number of tenants added.
        """
        if not config.MEMORY_MULTI_TENANT:
            return 0
        added = 0
        for gid in group_ids:
            if gid and gid not in self._tenants:
                self._append_event(gid, gid, "orphan")
                added += 1
        return added

    # ── Internals ─────────────────────────────────────────────────────────

    def _load(self) -> None:
        """Load the JSONL file; last record per group_id wins."""
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path) as f:
                for line_no, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        logger.warning(
                            "tenant_registry_skip_bad_line",
                            line_no=line_no,
                        )
                        continue
                    gid = rec.get("group_id")
                    if gid:
                        self._tenants[gid] = rec
        except OSError:
            logger.warning("tenant_registry_load_failed", path=self._path)

    def _append_event(
        self,
        group_id: str,
        identity: str,
        event_type: str,
        purged_at: str | None = None,
    ) -> None:
        """Append one record and update in-memory state."""
        now = datetime.now(timezone.utc).isoformat()
        cur = self._tenants.get(group_id, {})
        rec = {
            "group_id": group_id,
            "identity": identity or cur.get("identity", group_id),
            "first_seen": cur.get("first_seen", now),
            "last_seen": now,
            "last_write": now if event_type == "write" else cur.get("last_write"),
            "purged_at": purged_at if event_type == "purge" else cur.get("purged_at"),
            "event_type": event_type,
        }
        self._tenants[group_id] = rec
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            with open(self._path, "a") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            logger.warning("tenant_registry_write_failed", group_id=group_id)


# Module-level singleton
tenant_registry = TenantRegistry()
