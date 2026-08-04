"""Tests for tenant resolution, state machine, and ContextVar propagation."""

import hashlib
import hmac as hmac_mod

import pytest
from icarus.config import config
from icarus.tenant import (
    Tenant,
    TenantRejected,
    _current_tenant,
    _tenant_from_header,
    current_tenant,
    resolve_tenant,
    tenant_context,
    tenant_registry,
)


# ── Fake request for testing resolve_tenant ──────────────────────────────────


class FakeHeaders:
    """Case-insensitive header store (matches HTTP semantics)."""

    def __init__(self, headers: dict[str, str] | None = None):
        self._headers = {k.lower(): v for k, v in (headers or {}).items()}

    def get(self, key: str, default: str = "") -> str:
        return self._headers.get(key.lower(), default)


class FakeURL:
    def __init__(self, path: str = "/v1/chat/completions"):
        self.path = path


class FakeRequest:
    def __init__(self, headers: dict[str, str] | None = None, path: str = "/v1/chat/completions"):
        self.headers = FakeHeaders(headers)
        self.url = FakeURL(path)
        self._body = b"{}"

    async def body(self) -> bytes:
        return self._body


# ── Tenant dataclass ─────────────────────────────────────────────────────────


class TestTenant:
    def test_from_identity_deterministic(self):
        """T7: Same identity → same group across calls."""
        t1 = Tenant.from_identity("alice", via="header")
        t2 = Tenant.from_identity("alice", via="header")
        assert t1.group_id == t2.group_id
        assert t1.group_id.startswith("t-")
        assert len(t1.group_id) == 18  # "t-" + 16 hex

    def test_from_identity_different_users(self):
        """Different users get different groups."""
        alice = Tenant.from_identity("alice", via="header")
        bob = Tenant.from_identity("bob", via="header")
        assert alice.group_id != bob.group_id

    def test_legacy_uses_configured_group(self, monkeypatch):
        monkeypatch.setattr(config, "GRAPHITI_GROUP_ID", "mygroup")
        t = Tenant.legacy()
        assert t.group_id == "mygroup"
        assert t.id == ""
        assert t.via == "legacy_default"


# ── Tenant resolution state machine ──────────────────────────────────────────


class TestResolveTenant:
    async def test_legacy_no_header(self, monkeypatch):
        """T8: No identity → legacy behavior."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", False)
        monkeypatch.setattr(config, "GRAPHITI_GROUP_ID", "default")
        req = FakeRequest()
        tenant = await resolve_tenant(req)
        assert tenant.group_id == "default"
        assert tenant.via == "legacy_default"

    async def test_legacy_header_ignored(self, monkeypatch):
        """Legacy mode with header — ignored with warning."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", False)
        monkeypatch.setattr(config, "GRAPHITI_GROUP_ID", "default")
        req = FakeRequest({"x-user-id": "alice"})
        tenant = await resolve_tenant(req)
        assert tenant.group_id == "default"
        assert tenant.via == "legacy_header_ignored"

    async def test_mt_valid_header(self, monkeypatch):
        """MT mode with valid header → Tenant."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        monkeypatch.setattr(config, "MEMORY_TENANT_HEADER", "x-user-id")
        req = FakeRequest({"x-user-id": "alice"})
        tenant = await resolve_tenant(req)
        assert tenant.via == "header"
        assert tenant.id == "alice"
        assert tenant.group_id.startswith("t-")

    async def test_mt_missing_header_401(self, monkeypatch):
        """MT mode without header → TenantRejected(401)."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        req = FakeRequest({})
        with pytest.raises(TenantRejected) as exc:
            await resolve_tenant(req)
        assert exc.value.status_code == 401

    async def test_mt_empty_header_400(self, monkeypatch):
        """MT mode with empty header → TenantRejected(400)."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        monkeypatch.setattr(config, "MEMORY_TENANT_HEADER", "x-user-id")
        req = FakeRequest({"x-user-id": "   "})
        with pytest.raises(TenantRejected) as exc:
            await resolve_tenant(req)
        assert exc.value.status_code == 400

    async def test_mt_header_too_long_400(self, monkeypatch):
        """MT mode with header >128 chars → 400."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        req = FakeRequest({"x-user-id": "x" * 200})
        with pytest.raises(TenantRejected) as exc:
            await resolve_tenant(req)
        assert exc.value.status_code == 400

    async def test_mt_librechat_placeholder_rejected(self, monkeypatch):
        """LibreChat_User_ID constant → 400 (silent collapse guard)."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        req = FakeRequest({"x-user-id": "LibreChat_User_ID"})
        with pytest.raises(TenantRejected) as exc:
            await resolve_tenant(req)
        assert exc.value.status_code == 400
        assert "placeholder" in exc.value.reason.lower()

    async def test_mt_hmac_valid(self, monkeypatch):
        """HMAC-signed header with correct signature → Tenant."""
        secret = "test-secret"
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        monkeypatch.setattr(config, "MEMORY_TENANT_HMAC_SECRET", secret)
        tid = "alice"
        sig = hmac_mod.new(
            secret.encode(), tid.encode(), hashlib.sha256
        ).hexdigest()[:32]
        req = FakeRequest({"x-user-id": f"{tid}.{sig}"})
        tenant = await resolve_tenant(req)
        assert tenant.id == "alice"
        assert tenant.via == "header"

    async def test_mt_hmac_invalid_401(self, monkeypatch):
        """HMAC-signed header with wrong signature → 401."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        monkeypatch.setattr(config, "MEMORY_TENANT_HMAC_SECRET", "test-secret")
        req = FakeRequest({"x-user-id": "alice.badsignature"})
        with pytest.raises(TenantRejected) as exc:
            await resolve_tenant(req)
        assert exc.value.status_code == 401

    async def test_mt_body_user_fallback(self, monkeypatch):
        """Body user field fallback when enabled."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        monkeypatch.setattr(config, "MEMORY_BODY_USER_FALLBACK", True)
        req = FakeRequest({})
        req._body = b'{"user": "alice", "messages": []}'
        tenant = await resolve_tenant(req)
        assert tenant.via == "body"
        assert tenant.id == "alice"

    async def test_mt_body_user_librechat_rejected(self, monkeypatch):
        """Body user = LibreChat constant → rejected."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        monkeypatch.setattr(config, "MEMORY_BODY_USER_FALLBACK", True)
        req = FakeRequest({})
        req._body = b'{"user": "LibreChat_User_ID", "messages": []}'
        with pytest.raises(TenantRejected) as exc:
            await resolve_tenant(req)
        assert exc.value.status_code == 401


# ── ContextVar propagation ───────────────────────────────────────────────────


class TestContextVar:
    def test_current_tenant_legacy_fallback(self, monkeypatch):
        """Outside request context in legacy mode → legacy tenant."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", False)
        monkeypatch.setattr(config, "GRAPHITI_GROUP_ID", "default")
        t = current_tenant()
        assert t.group_id == "default"
        assert t.via == "legacy_default"

    def test_current_tenant_mt_raises(self, monkeypatch):
        """Outside request context in MT mode → RuntimeError."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        with pytest.raises(RuntimeError, match="outside a request context"):
            current_tenant()

    def test_tenant_context_sets_and_resets(self, monkeypatch):
        """tenant_context() sets the ContextVar and resets on exit."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        alice = Tenant.from_identity("alice", via="test")
        with tenant_context(alice):
            assert current_tenant().group_id == alice.group_id
        # After exit, ContextVar is reset → RuntimeError in MT mode
        with pytest.raises(RuntimeError):
            current_tenant()

    def test_tenant_context_nested(self, monkeypatch):
        """Nested tenant_context: inner wins, outer restored."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        alice = Tenant.from_identity("alice", via="test")
        bob = Tenant.from_identity("bob", via="test")
        with tenant_context(alice):
            assert current_tenant().id == "alice"
            with tenant_context(bob):
                assert current_tenant().id == "bob"
            assert current_tenant().id == "alice"


# ── _tenant_from_header edge cases ───────────────────────────────────────────


class TestTenantFromHeader:
    def test_valid_header(self, monkeypatch):
        monkeypatch.setattr(config, "MEMORY_TENANT_HMAC_SECRET", "")
        t = _tenant_from_header("alice")
        assert t.id == "alice"
        assert t.via == "header"

    def test_empty_header_raises(self, monkeypatch):
        monkeypatch.setattr(config, "MEMORY_TENANT_HMAC_SECRET", "")
        with pytest.raises(TenantRejected) as exc:
            _tenant_from_header("")
        assert exc.value.status_code == 400

    def test_whitespace_header_raises(self, monkeypatch):
        monkeypatch.setattr(config, "MEMORY_TENANT_HMAC_SECRET", "")
        with pytest.raises(TenantRejected) as exc:
            _tenant_from_header("   ")
        assert exc.value.status_code == 400

    def test_too_long_header_raises(self, monkeypatch):
        monkeypatch.setattr(config, "MEMORY_TENANT_HMAC_SECRET", "")
        with pytest.raises(TenantRejected) as exc:
            _tenant_from_header("x" * 200)
        assert exc.value.status_code == 400

    def test_librechat_placeholder_raises(self, monkeypatch):
        monkeypatch.setattr(config, "MEMORY_TENANT_HMAC_SECRET", "")
        with pytest.raises(TenantRejected) as exc:
            _tenant_from_header("LibreChat_User_ID")
        assert exc.value.status_code == 400


# ── Tenant Registry ──────────────────────────────────────────────────────────


class TestTenantRegistry:
    def test_record_seen_noop_in_legacy(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", False)
        reg_path = tmp_path / "registry.jsonl"
        reg = tenant_registry.__class__(str(reg_path))
        reg.record_seen(Tenant.legacy())
        assert reg.all() == []

    def test_record_seen_and_retrieve(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        reg_path = tmp_path / "registry.jsonl"
        reg = tenant_registry.__class__(str(reg_path))
        alice = Tenant.from_identity("alice", via="header")
        reg.record_seen(alice)
        assert len(reg.all()) == 1
        assert reg.get(alice.group_id) is not None
        assert reg.get(alice.group_id)["group_id"] == alice.group_id

    def test_record_purge_and_is_purged_after(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        reg_path = tmp_path / "registry.jsonl"
        reg = tenant_registry.__class__(str(reg_path))
        alice = Tenant.from_identity("alice", via="header")
        reg.record_seen(alice)
        purged_at = reg.record_purge(alice.group_id)
        from datetime import datetime, timezone
        # A write from before purge → should be dropped
        assert reg.is_purged_after(
            alice.group_id,
            datetime.fromisoformat(purged_at),
        )
        # A write from after purge → should NOT be dropped
        future = datetime.fromisoformat(purged_at).replace(
            hour=23, minute=59
        )
        if future <= datetime.fromisoformat(purged_at):
            import datetime as dt
            future = datetime.now(timezone.utc)
        assert not reg.is_purged_after(alice.group_id, future)

    def test_merge_orphans(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        reg_path = tmp_path / "registry.jsonl"
        reg = tenant_registry.__class__(str(reg_path))
        added = reg.merge_orphans(["t-abc123", "t-def456"])
        assert added == 2
        assert "t-abc123" in {t["group_id"] for t in reg.all()}

    def test_persistence(self, monkeypatch, tmp_path):
        """Records survive reload."""
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        reg_path = tmp_path / "registry.jsonl"
        reg1 = tenant_registry.__class__(str(reg_path))
        alice = Tenant.from_identity("alice", via="header")
        reg1.record_seen(alice)
        # Reload
        reg2 = tenant_registry.__class__(str(reg_path))
        assert reg2.get(alice.group_id) is not None

    def test_corrupt_line_skipped(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "MEMORY_MULTI_TENANT", True)
        reg_path = tmp_path / "registry.jsonl"
        # Write a corrupt line + a valid line
        reg_path.write_text('not json\n{"group_id": "t:abc", "first_seen": "x", "last_seen": "x", "event_type": "seen"}\n')
        reg = tenant_registry.__class__(str(reg_path))
        # Corrupt line skipped, valid line loaded
        assert len(reg.all()) >= 1
