"""FastAPI application — OpenAI-compatible endpoints backed by the Agent SDK."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .agent_wrapper import stream_agent
from .config import IcarusConfig, load_config
from .session import SessionStore
from .sse import SSE_DONE, format_error_chunk
from .translator import build_prompt, extract_system_message

logger = logging.getLogger("icarus")

# ---------------------------------------------------------------------------
# Singletons — created at app startup
# ---------------------------------------------------------------------------
_session_store: SessionStore
_config: IcarusConfig
_global_semaphore: asyncio.Semaphore

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    role: str
    content: str | list[dict] | None = None
    name: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str = "icarus-agent"
    messages: list[ChatMessage]
    stream: bool = True
    temperature: float | None = 0.7
    user: str | None = None
    max_tokens: int | None = None


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global _session_store, _config, _global_semaphore

    _config = load_config()
    _session_store = SessionStore()
    _global_semaphore = asyncio.Semaphore(1)

    logger.info(
        "icarus server starting",
        extra={
            "host": _config.host,
            "port": _config.port,
            "cwd": str(_config.cwd),
            "model": _config.model,
            "readonly": _config.readonly,
        },
    )
    yield
    logger.info("icarus server shutting down")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="icarus",
    version="0.1.0",
    description="OpenAI-compatible API wrapper around the Claude Agent SDK",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


def get_config() -> IcarusConfig:
    return _config


def get_session_store() -> SessionStore:
    return _session_store


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/v1/models")
async def list_models():
    """OpenAI-standard model list endpoint."""
    return {
        "object": "list",
        "data": [
            {
                "id": "icarus-agent-v1",
                "object": "model",
                "created": 1700000000,
                "owned_by": "icarus",
            }
        ],
    }


@app.get("/health")
async def health():
    """Liveness probe — returns session count and config summary."""
    store = get_session_store()
    return {
        "status": "ok",
        "active_sessions": store.active_count,
        "sdk_connected": True,
        "model": _config.model,
    }


@app.post("/v1/chat/completions")
async def chat_completions(body: ChatCompletionRequest):
    """Main OpenAI-compatible chat completions endpoint with SSE streaming."""
    cfg = get_config()
    store = get_session_store()

    # --- validation ---
    if not body.stream:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": "Only streaming (stream: true) is supported",
                    "type": "invalid_request_error",
                    "code": "stream_required",
                }
            },
        )

    if body.model not in ("icarus-agent", "icarus-agent-v1", ""):
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": f"Unknown model: {body.model}",
                    "type": "invalid_request_error",
                    "code": "model_not_found",
                }
            },
        )

    messages = [m.model_dump(exclude_none=True) for m in body.messages]
    if not messages:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": "No messages provided",
                    "type": "invalid_request_error",
                    "code": None,
                }
            },
        )

    # --- session resolution ---
    conversation_id = body.user or str(uuid.uuid4())
    session_lock = store.lock(conversation_id)

    async def event_generator() -> AsyncIterator[str]:
        async with session_lock:
            record = store.get_or_create(conversation_id)
            is_first = len(record.openai_messages) == 0

            # Extract prompt components
            system_prompt = extract_system_message(messages)
            prompt = build_prompt(messages, is_first=is_first)

            # Track messages for multi-turn context
            record.openai_messages.extend(messages)

            last_event_time = time.monotonic()
            session_id = record.sdk_session_id if not is_first else None

            try:
                async for sse_chunk in stream_agent(
                    prompt=prompt,
                    config=cfg,
                    session_id=session_id,
                    system_prompt=system_prompt,
                    is_first=is_first,
                ):
                    last_event_time = time.monotonic()
                    yield sse_chunk

                    # Timeout check: if no event for request_timeout seconds, abort
                    if (
                        time.monotonic() - last_event_time
                        > cfg.request_timeout
                    ):
                        yield format_error_chunk(
                            f"Request timed out after {cfg.request_timeout}s"
                        )
                        yield SSE_DONE
                        return

                # Persist the SDK session id after a successful run
                new_session_id = getattr(stream_agent, "_last_session_id", None)
                if new_session_id:
                    record.sdk_session_id = new_session_id

            except asyncio.CancelledError:
                logger.info(
                    "SSE stream cancelled (client disconnect)",
                    extra={"session": conversation_id},
                )
                return

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Icarus-Session-Id": conversation_id,
        },
    )
