"""Transparent proxy for OpenAI-compatible APIs with memory injection."""

import asyncio
import hmac as hmac_mod
import json
from contextlib import asynccontextmanager

import httpx
import structlog
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from icarus.config import config
from icarus.logger import RequestLogger
from icarus.memory import (
    MemoryClient,
    _drop_dedup_filter,
    _snapshot_store,
    extract_and_store,
    maintenance_worker,
    memory_client,
    memory_for_request,
    is_conversation_start,
    conversation_key,
)
from icarus.tenant import (
    Tenant,
    TenantRejected,
    _current_tenant,
    current_tenant,
    resolve_tenant,
    tenant_context,
    tenant_registry,
)

_proxy_log = structlog.get_logger("icarus.proxy")


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Startup: connect to Graphiti memory service (non-fatal)."""
    # Multi-tenancy startup validations
    if config.MEMORY_MULTI_TENANT:
        if not config.UPSTREAM_API_KEY:
            _proxy_log.error(
                "tenant_mode_requires_key",
                msg="MEMORY_MULTI_TENANT requires UPSTREAM_API_KEY — "
                    "the chat path is authenticated by it in MT mode",
            )
            raise SystemExit(1)
        if config.ICARUS_ADMIN_API_KEY and (
            config.ICARUS_ADMIN_API_KEY == config.UPSTREAM_API_KEY
        ):
            _proxy_log.error(
                "tenant_admin_key_equals_upstream",
                msg="ICARUS_ADMIN_API_KEY must differ from UPSTREAM_API_KEY",
            )
            raise SystemExit(1)
        if not config.MEMORY_TENANT_HMAC_SECRET:
            _proxy_log.warning(
                "tenant_mode_unsigned_header",
                msg="MT mode with unsigned identity headers: ensure Icarus is "
                    "reachable only by LibreChat (firewall / docker network)",
            )
        # Merge snapshot-table orphans into registry (lost-registry recovery)
        orphans = _snapshot_store.tenant_prefixes()
        if orphans:
            added = tenant_registry.merge_orphans(orphans)
            if added:
                _proxy_log.info(
                    "tenant_registry_recovered_orphans", count=added,
                )
        _proxy_log.info("tenant_mode", mode="multi_tenant")
    else:
        _proxy_log.info("tenant_mode", mode="legacy")

    await memory_client.connect()
    maintenance_worker.start()
    yield
    """Shutdown: release MCP transport + write worker."""
    await maintenance_worker.stop()
    await memory_client.close()


app = FastAPI(title="Icarus Proxy", version="0.3.0", lifespan=lifespan)

logger = RequestLogger(config.LOG_DIR)


# ── Tenant middleware ────────────────────────────────────────────────────────

class TenantMiddleware(BaseHTTPMiddleware):
    """Resolve the request-scoped tenant and set the ContextVar.

    Authoritative resolver: runs once per request, sets the ContextVar
    before the handler, resets it in ``finally``.  Fail-closes in
    MULTI_TENANT mode — absence of identity is an error, never a fallback
    to the legacy group.
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        # Public health + admin routes never need a tenant (admin endpoints
        # take explicit group_id from params, never the ContextVar).
        path = request.url.path
        if path == "/health" or path.startswith("/admin/"):
            return await call_next(request)

        try:
            tenant = await resolve_tenant(request)
        except TenantRejected as exc:
            status = exc.status_code
            if status == 401 and path.startswith("/memory/"):
                status = 403  # API key authenticated but no tenant
            _proxy_log.warning(
                "tenant_rejected",
                path=path,
                status=status,
                reason=exc.reason,
            )
            return Response(
                content=json.dumps({"error": exc.reason}),
                status_code=status,
                media_type="application/json",
            )

        tenant_registry.record_seen(tenant)
        _proxy_log.info(
            "tenant_resolved",
            group_id=tenant.group_id,
            via=tenant.via,
        )
        token = _current_tenant.set(tenant)
        try:
            return await call_next(request)
        finally:
            _current_tenant.reset(token)


app.add_middleware(TenantMiddleware)


# ── Auth dependencies ────────────────────────────────────────────────────────


def _check_auth(request: Request) -> bool:
    """Verify the request uses the configured upstream API key.

    Uses constant-time comparison to avoid timing side-channels.
    """
    auth = request.headers.get("authorization", "")
    expected = f"Bearer {config.UPSTREAM_API_KEY}"
    return hmac_mod.compare_digest(auth, expected)


def require_operator(request: Request) -> None:
    """FastAPI dependency: reject requests without the upstream API key."""
    if not _check_auth(request):
        raise HTTPException(status_code=401, detail="unauthorized")


def require_admin(request: Request) -> None:
    """FastAPI dependency: reject requests without the admin API key."""
    if not config.ICARUS_ADMIN_API_KEY:
        raise HTTPException(status_code=404, detail="not found")
    auth = request.headers.get("authorization", "")
    expected = f"Bearer {config.ICARUS_ADMIN_API_KEY}"
    if not hmac_mod.compare_digest(auth, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def get_current_tenant() -> Tenant:
    """FastAPI dependency: the request-scoped tenant.

    Set by ``TenantMiddleware`` before handlers run; this is a typed
    consumer and a belt-and-suspenders guard.
    """
    tenant = _current_tenant.get()
    if tenant is None:
        raise HTTPException(status_code=403, detail="missing tenant identity")
    return tenant


# ── Specific routes (must be registered before the catch-all) ──────────────


@app.get("/health")
async def health():
    """Health check endpoint (public)."""
    return {
        "status": "ok",
        "upstream": config.UPSTREAM_BASE_URL,
        "memory_enabled": config.MEMORY_ENABLED,
        "memory_injection": bool(config.MEMORY_INJECTION),
        "multi_tenant": config.MEMORY_MULTI_TENANT,
        "graphiti": "ok" if memory_client.available else "unreachable",
        "memory": {
            "writes_total": memory_client.writes_total,
            "writes_failed": memory_client.writes_failed,
            "writes_last_error": memory_client.writes_last_error,
            "queue_depth": memory_client._write_queue.qsize(),
            "last_maintenance": maintenance_worker.last_run_iso,
            "trimmed_edges_24h": maintenance_worker.trimmed_edges_24h,
            "rejected_24h": memory_client.writes_rejected_24h,
        },
    }


# ── Memory management API ──────────────────────────────────────────────────


@app.get("/memory/status")
async def memory_status(
    request: Request,
    _: None = Depends(require_operator),
    tenant: Tenant = Depends(get_current_tenant),
):
    """Get memory system status for the current tenant."""
    return {
        "status": "ok",
        "tenant_group_id": tenant.group_id,
        "tenant_via": tenant.via,
        "upstream": config.UPSTREAM_BASE_URL,
        "memory_enabled": config.MEMORY_ENABLED,
        "graphiti": "ok" if memory_client.available else "unreachable",
        "memory": {
            "writes_total": memory_client.writes_total,
            "writes_failed": memory_client.writes_failed,
            "writes_last_error": memory_client.writes_last_error,
            "queue_depth": memory_client._write_queue.qsize(),
            "last_maintenance": maintenance_worker.last_run_iso,
            "trimmed_edges_24h": maintenance_worker.trimmed_edges_24h,
            "rejected_24h": memory_client.writes_rejected_24h,
        },
    }


@app.get("/memory/facts")
async def memory_facts(
    request: Request,
    q: str = "",
    limit: int = 20,
    _: None = Depends(require_operator),
    tenant: Tenant = Depends(get_current_tenant),
):
    """Search the knowledge graph for facts (tenant-scoped)."""
    facts = await memory_client.search_facts(
        q, limit=limit, group_id=tenant.group_id,
    )
    return {
        "facts": [
            {
                "uuid": f.uuid,
                "fact": f.fact,
                "name": f.name,
                "valid_at": f.valid_at,
                "invalid_at": f.invalid_at,
            }
            for f in facts
        ]
    }


@app.post("/memory/forget")
async def memory_forget(
    request: Request,
    _: None = Depends(require_operator),
    tenant: Tenant = Depends(get_current_tenant),
):
    """Forget a fact, episode, or topic (tenant-scoped).

    Body: {"fact_uuid": "..."} or {"episode_uuid": "..."} or {"message": "..."}
    """
    try:
        data = await request.json()
    except Exception:
        return {"error": "invalid_json"}

    if "fact_uuid" in data:
        ok = await memory_client.delete_fact(data["fact_uuid"], group_id=tenant.group_id)
        return {"status": "deleted" if ok else "error"}

    if "episode_uuid" in data:
        ok = await memory_client.delete_episode(data["episode_uuid"], group_id=tenant.group_id)
        return {"status": "deleted" if ok else "error"}

    if "message" in data:
        # Find facts matching the message, then delete them (tenant-scoped)
        facts = await memory_client.search_facts(
            data["message"], limit=5, group_id=tenant.group_id,
        )
        deleted = 0
        for f in facts:
            try:
                await memory_client.delete_fact(f.uuid, group_id=tenant.group_id)
                deleted += 1
            except Exception:
                pass
        return {"status": "done", "deleted": deleted}

    return {"error": "missing fact_uuid, episode_uuid, or message"}


@app.post("/memory/purge")
async def memory_purge(
    request: Request,
    _: None = Depends(require_operator),
    tenant: Tenant = Depends(get_current_tenant),
):
    """Purge all memory for the current tenant."""
    try:
        data = await request.json()
    except Exception:
        return {"error": "invalid_json"}
    if data.get("confirm") != "purge-all":
        return {"error": "must confirm with 'purge-all'"}

    group_id = tenant.group_id

    # 1. Mark purged_at (so the write worker drops queued jobs)
    purged_at = tenant_registry.record_purge(group_id)

    # 2. Sweep SnapshotStore cache + set purged_at guard BEFORE Graphiti purge
    _snapshot_store.delete_prefix(f"{group_id}:")

    # 3. Enumerated verified deletion
    result = await memory_client.purge_tenant(group_id)

    # 4. Drop the per-tenant DedupFilter
    _drop_dedup_filter(group_id)

    return {
        "status": "purged",
        "group_id": group_id,
        "purged_at": purged_at,
        **result,
    }


# ── Admin endpoints ──────────────────────────────────────────────────────────


@app.get("/admin/tenants")
async def admin_tenants(
    request: Request,
    _: None = Depends(require_admin),
    identity: str = "",
):
    """List all tenants (admin-only, local data — zero Graphiti round trips)."""
    if identity:
        # Look up a specific tenant by raw identity
        import hashlib
        target = f"t:{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16]}"
        rec = tenant_registry.get(target)
        return {"tenants": [rec] if rec else [], "total": 1 if rec else 0}

    tenants = tenant_registry.all()
    # Enrich with snapshot counts from SQLite
    for t in tenants:
        gid = t["group_id"]
        t["snapshot_count"] = 0  # lightweight; deep stats are behind /admin/tenant/{gid}/status

    return {"tenants": tenants, "total": len(tenants)}


@app.get("/admin/tenant/{group_id}/status")
async def admin_tenant_status(
    group_id: str,
    request: Request,
    _: None = Depends(require_admin),
):
    """Deep per-tenant stats (one Graphiti search)."""
    rec = tenant_registry.get(group_id)
    try:
        facts = await memory_client.search_facts(
            "", limit=1000, group_id=group_id, include_invalid=True,
        )
    except Exception:
        facts = []
    return {
        "group_id": group_id,
        "registry": rec,
        "fact_count": len(facts),
    }


@app.post("/admin/tenant/{group_id}/purge")
async def admin_tenant_purge(
    group_id: str,
    request: Request,
    _: None = Depends(require_admin),
):
    """GDPR erasure: purge all memory for a tenant (admin-only)."""
    # 1. Mark purged_at
    purged_at = tenant_registry.record_purge(group_id)

    # 2. Sweep SnapshotStore cache + purged_at guard BEFORE Graphiti purge
    snapshots_deleted = _snapshot_store.delete_prefix(f"{group_id}:")

    # 3. Enumerated verified deletion
    result = await memory_client.purge_tenant(group_id)

    # 4. Drop DedupFilter
    _drop_dedup_filter(group_id)

    _proxy_log.info(
        "tenant_purge_completed",
        group_id=group_id,
        purged_at=purged_at,
        snapshots_deleted=snapshots_deleted,
        **result,
    )

    return {
        "status": "purged",
        "group_id": group_id,
        "purged_at": purged_at,
        "snapshots_deleted": snapshots_deleted,
        **result,
    }


# ── Memory injection ───────────────────────────────────────────────────────


def inject_static_memory(body: bytes) -> bytes:
    """Inject a static system message from MEMORY_INJECTION env var.

    If the body contains system messages, the memory is inserted immediately
    after the last system message. If there are no system messages, the memory
    is prepended as the first message.
    """
    if not config.MEMORY_INJECTION:
        return body

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body

    messages = data.get("messages", [])
    if not messages:
        return body

    insert_at = 0
    for i, msg in enumerate(messages):
        if msg.get("role") == "system":
            insert_at = i + 1

    memory_msg = {"role": "system", "content": config.MEMORY_INJECTION}
    messages.insert(insert_at, memory_msg)
    data["messages"] = messages

    return json.dumps(data).encode("utf-8")


def _insert_memory_into_body(body: bytes, memory_text: str) -> bytes:
    """Insert `memory_text` as a system message after the last system message."""
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body

    messages = data.get("messages", [])
    if not messages:
        return body

    insert_at = 0
    for i, msg in enumerate(messages):
        if msg.get("role") == "system":
            insert_at = i + 1

    messages.insert(insert_at, {"role": "system", "content": memory_text})
    data["messages"] = messages
    return json.dumps(data).encode("utf-8")


async def inject_dynamic_memory(body: bytes) -> bytes:
    """Inject memory from the knowledge graph (if enabled) or fall back to static.

    Dynamic injection only happens for conversation starts. Continuations
    re-inject the same frozen snapshot (from SQLite cache) for prompt cache stability.
    """
    if not config.MEMORY_ENABLED:
        return inject_static_memory(body)

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body

    messages = data.get("messages", [])
    if not messages:
        return body

    memory_text = await memory_for_request(memory_client, messages)
    if memory_text:
        return _insert_memory_into_body(body, memory_text)

    # Fall back to static injection if dynamic memory is empty
    return inject_static_memory(body)


def _schedule_memory_extraction(
    body: bytes,
    request_id: str,
) -> None:
    """Schedule fire-and-forget memory extraction after a successful response.

    Uses asyncio.create_task rather than BackgroundTasks — the write path
    must survive MCP session timeouts and connection drops, which can
    cancel request-scoped background tasks.
    """
    if not config.MEMORY_ENABLED:
        return

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return

    messages = data.get("messages", [])
    if not messages:
        return

    key = conversation_key(messages)
    known_facts: list[str] = []

    import structlog
    _bg_log = structlog.get_logger("icarus.memory")
    _bg_log.info("memory_extraction_scheduled", request_id=request_id, key=key[:12])

    # Use asyncio.create_task — survives MCP session timeouts that can
    # cancel request-scoped BackgroundTasks
    asyncio.create_task(
        extract_and_store(
            memory_client,
            messages,
            key,
            known_facts,
            request_id,
        )
    )


# ── Catch-all proxy route ──────────────────────────────────────────────────


async def _proxy_streaming(request, upstream_url, forward_headers, modified_body, request_id):
    """Forward a streaming request to upstream, yielding chunks as they arrive.

    Uses its own httpx client so the client outlives the returned generator.
    """
    client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))

    upstream_req = client.build_request(
        method=request.method,
        url=upstream_url,
        headers=forward_headers,
        content=modified_body,
    )
    upstream_resp = await client.send(upstream_req, stream=True)

    response_headers = dict(upstream_resp.headers)
    for h in ("transfer-encoding", "content-encoding", "content-length"):
        response_headers.pop(h, None)

    # Accumulate all chunks so we can log the full body, then yield from memory
    chunks: list[bytes] = []

    async def stream_response():
        try:
            async for chunk in upstream_resp.aiter_bytes():
                chunks.append(chunk)
                yield chunk
        except httpx.HTTPError:
            # Client disconnected or upstream dropped — still log what we got
            pass
        finally:
            full_body = b"".join(chunks)
            logger.log_response(
                request_id,
                upstream_resp.status_code,
                full_body,
                response_headers,
            )
            await client.aclose()

    return StreamingResponse(
        stream_response(),
        status_code=upstream_resp.status_code,
        headers=response_headers,
    )


async def _proxy_buffered(request, upstream_url, forward_headers, modified_body, request_id):
    """Forward a non-streaming request to upstream, returning the full response."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
        upstream_resp = await client.request(
            method=request.method,
            url=upstream_url,
            headers=forward_headers,
            content=modified_body,
        )
        response_body = upstream_resp.content

        response_headers = {}
        for key, value in upstream_resp.headers.items():
            lower = key.lower()
            if lower in ("transfer-encoding", "content-encoding"):
                continue
            response_headers[key] = value

        logger.log_response(
            request_id,
            upstream_resp.status_code,
            response_body,
            response_headers,
        )

        return Response(
            content=response_body,
            status_code=upstream_resp.status_code,
            headers=response_headers,
        )


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def proxy(request: Request, path: str, background_tasks: BackgroundTasks):
    """Catch-all route that proxies requests to the upstream API.

    In MT mode the chat path requires the upstream API key (the same
    gate that protects /memory/* endpoints).  This closes the LAN
    attacker vector: only clients holding the key can reach the memory
    system.
    """
    # Auth gate in MT mode — must precede body read / injection / extraction
    if config.MEMORY_MULTI_TENANT and not _check_auth(request):
        return Response(content='{"error":"unauthorized"}', status_code=401)

    upstream_url = f"{config.UPSTREAM_BASE_URL}/{path}"
    body = await request.body()

    # Inject memory into chat completion requests (before logging so we capture both)
    modified_body = body
    injected = False
    if path in ("v1/chat/completions", "chat/completions") and body:
        modified_body = await inject_dynamic_memory(body)
        injected = modified_body != body

    # Log incoming request — with both original and modified bodies
    request_id = logger.log_request(
        method=request.method,
        path=path,
        body=body,
        headers=dict(request.headers),
        modified_body=modified_body if injected else None,
        injected=injected,
    )

    # Schedule fire-and-forget memory extraction after successful response
    if path in ("v1/chat/completions", "chat/completions") and body:
        _schedule_memory_extraction(body, request_id)

    # Build forwarding headers: pass through client headers but override auth,
    # and drop headers that would break the upstream request or cause
    # compression (we don't decompress, so ask upstream for plaintext).
    forward_headers = {}
    for key, value in request.headers.items():
        lower = key.lower()
        if lower in ("host", "content-length", "transfer-encoding", "accept-encoding"):
            continue
        forward_headers[key] = value

    # Always use our configured upstream API key
    if config.UPSTREAM_API_KEY:
        forward_headers["authorization"] = f"Bearer {config.UPSTREAM_API_KEY}"

    # Check if this is a streaming request
    is_streaming = False
    try:
        req_data = json.loads(body)
        is_streaming = req_data.get("stream", False)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass

    try:
        if is_streaming:
            return await _proxy_streaming(
                request, upstream_url, forward_headers, modified_body, request_id
            )
        else:
            return await _proxy_buffered(
                request, upstream_url, forward_headers, modified_body, request_id
            )
    except httpx.HTTPError as exc:
        logger._log.error(
            "upstream_error",
            request_id=request_id,
            error=str(exc),
            upstream_url=upstream_url,
        )
        return Response(
            content=json.dumps({"error": f"Upstream error: {exc}"}),
            status_code=502,
            media_type="application/json",
        )
