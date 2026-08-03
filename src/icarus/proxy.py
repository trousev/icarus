"""Transparent proxy for OpenAI-compatible APIs with memory injection."""

import json
from contextlib import asynccontextmanager

import httpx
from fastapi import BackgroundTasks, FastAPI, Request, Response
from fastapi.responses import StreamingResponse

from icarus.config import config
from icarus.logger import RequestLogger
from icarus.memory import (
    MemoryClient,
    memory_client,
    memory_for_request,
    is_conversation_start,
    conversation_key,
)


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Startup: connect to Graphiti memory service (non-fatal)."""
    await memory_client.connect()
    yield
    """Shutdown: release MCP transport + write worker."""
    await memory_client.close()


app = FastAPI(title="Icarus Proxy", version="0.2.0", lifespan=lifespan)

logger = RequestLogger(config.LOG_DIR)


# ── Specific routes (must be registered before the catch-all) ──────────────


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "upstream": config.UPSTREAM_BASE_URL,
        "memory_enabled": config.MEMORY_ENABLED,
        "memory_injection": bool(config.MEMORY_INJECTION),
        "graphiti": "ok" if memory_client.available else "unreachable",
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
    """Catch-all route that proxies requests to the upstream API."""

    upstream_url = f"{config.UPSTREAM_BASE_URL}/{path}"
    body = await request.body()

    # Inject memory into chat completion requests (before logging so we capture both)
    modified_body = body
    injected = False
    if path == "v1/chat/completions" and body:
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
