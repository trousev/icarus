"""Transparent proxy for OpenAI-compatible APIs with memory injection."""

import json
import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

from icarus.config import config
from icarus.logger import RequestLogger

app = FastAPI(title="Icarus Proxy", version="0.1.0")

logger = RequestLogger(config.LOG_DIR)


# ── Specific routes (must be registered before the catch-all) ──────────────


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "upstream": config.UPSTREAM_BASE_URL,
        "memory_injection": bool(config.MEMORY_INJECTION),
    }


# ── Memory injection ───────────────────────────────────────────────────────


def inject_memory(body: bytes) -> bytes:
    """Inject a second system message after existing system messages.

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

    # Find insertion point: right after the last system message
    insert_at = 0
    for i, msg in enumerate(messages):
        if msg.get("role") == "system":
            insert_at = i + 1

    memory_msg = {"role": "system", "content": config.MEMORY_INJECTION}
    messages.insert(insert_at, memory_msg)
    data["messages"] = messages

    return json.dumps(data).encode("utf-8")


# ── Catch-all proxy route ──────────────────────────────────────────────────


async def _proxy_streaming(client, request, upstream_url, forward_headers, modified_body, request_id):
    """Forward a streaming request to upstream, yielding chunks as they arrive."""
    upstream_req = client.build_request(
        method=request.method,
        url=upstream_url,
        headers=forward_headers,
        content=modified_body,
    )
    upstream_resp = await client.send(upstream_req, stream=True)

    async def stream_response():
        try:
            async for chunk in upstream_resp.aiter_bytes():
                yield chunk
        except httpx.HTTPError:
            # Client disconnected or upstream dropped — stop streaming
            pass

    response_headers = dict(upstream_resp.headers)
    for h in ("transfer-encoding", "content-encoding", "content-length"):
        response_headers.pop(h, None)

    logger.log_response(
        request_id,
        upstream_resp.status_code,
        b"[streaming response -- body not logged]",
        response_headers,
    )

    return StreamingResponse(
        stream_response(),
        status_code=upstream_resp.status_code,
        headers=response_headers,
    )


async def _proxy_buffered(client, request, upstream_url, forward_headers, modified_body, request_id):
    """Forward a non-streaming request to upstream, returning the full response."""
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
async def proxy(request: Request, path: str):
    """Catch-all route that proxies requests to the upstream API."""

    upstream_url = f"{config.UPSTREAM_BASE_URL}/{path}"
    body = await request.body()

    # Log incoming request
    request_id = logger.log_request(
        method=request.method,
        path=path,
        body=body,
        headers=dict(request.headers),
    )

    # Inject memory into chat completion requests
    modified_body = body
    if path == "v1/chat/completions" and body:
        modified_body = inject_memory(body)

    # Build forwarding headers: pass through client headers but override auth,
    # and drop headers that would break the upstream request
    forward_headers = {}
    for key, value in request.headers.items():
        lower = key.lower()
        if lower in ("host", "content-length", "transfer-encoding"):
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
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            if is_streaming:
                return await _proxy_streaming(
                    client, request, upstream_url, forward_headers, modified_body, request_id
                )
            else:
                return await _proxy_buffered(
                    client, request, upstream_url, forward_headers, modified_body, request_id
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
