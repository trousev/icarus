"""Server-Sent Events formatting helpers."""

from __future__ import annotations

import json
import uuid as _uuid

SSE_DONE = "data: [DONE]\n\n"


def format_sse_chunk(data: dict, *, done: bool = False) -> str:
    """Format *data* as an SSE ``data:`` line.

    Every chunk includes ``"object": "chat.completion.chunk"`` for
    OpenAI compatibility unless it's the ``[DONE]`` sentinel.
    """
    if not done:
        data.setdefault("id", f"chatcmpl-{_uuid.uuid4().hex[:16]}")
        data.setdefault("object", "chat.completion.chunk")
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def format_error_chunk(message: str, *, code: str = "internal_error") -> str:
    """Emit an SSE error chunk. The stream is then closed with ``[DONE]``."""
    return format_sse_chunk({
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": f"\n\n[Error: {message}]\n\n"},
                "finish_reason": "error",
            }
        ],
        "error": {"message": message, "type": "server_error", "code": code},
    })
