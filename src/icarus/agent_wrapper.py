"""Thin wrapper around the Agent SDK ``query()`` async generator."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    StreamEvent,
    query,
)

from .sse import SSE_DONE, format_error_chunk, format_sse_chunk

logger = logging.getLogger(__name__)


def _extract_text_delta(event: StreamEvent) -> str | None:
    """Pull a text delta from a raw Anthropic stream event, if any."""
    raw = event.event
    if raw.get("type") == "content_block_delta":
        delta = raw.get("delta", {})
        if delta.get("type") == "text_delta":
            return delta.get("text", "")
    return None


def _is_tool_use_start(event: StreamEvent) -> tuple[bool, str]:
    """Check if *event* signals the start of a tool-use block.

    Returns ``(is_tool, tool_name)``.
    """
    raw = event.event
    if raw.get("type") == "content_block_start":
        block = raw.get("content_block", {})
        if block.get("type") == "tool_use":
            return True, block.get("name", "unknown")
    return False, ""


def _extract_assistant_text(msg: AssistantMessage) -> str:
    """Extract plain text from an assistant message's content blocks."""
    parts: list[str] = []
    for block in msg.content:
        from claude_agent_sdk import TextBlock

        if isinstance(block, TextBlock):
            parts.append(block.text)
    return "\n".join(parts)


async def stream_agent(
    *,
    prompt: str,
    config,  # IcarusConfig
    session_id: str | None = None,
    system_prompt: str | None = None,
    is_first: bool = True,
) -> AsyncIterator[str]:
    """Run the Agent SDK and yield SSE-formatted string chunks.

    Parameters
    ----------
    prompt:
        The prompt string to send to the agent.
    config:
        The application configuration.
    session_id:
        SDK session ID to resume, or ``None`` for a fresh session.
    system_prompt:
        System prompt string (only set on the first request).
    is_first:
        Whether this is the first request in the conversation.
    """
    from .translator import build_options

    options: ClaudeAgentOptions = build_options(
        prompt=prompt,
        config=config,
        session_id=session_id,
        system_prompt=system_prompt,
        is_first=is_first,
    )

    # Emit initial role delta — required by many chat UIs
    yield format_sse_chunk({
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant"},
                "finish_reason": None,
            }
        ],
        "usage": None,
    })

    returned_session_id: str | None = None
    finish_reason: str = "stop"
    saw_error = False

    try:
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, StreamEvent):
                # --- text delta ---
                text = _extract_text_delta(msg)
                if text:
                    yield format_sse_chunk({
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": text},
                                "finish_reason": None,
                            }
                        ]
                    })
                    continue

                # --- tool-use start marker ---
                is_tool, tool_name = _is_tool_use_start(msg)
                if is_tool:
                    yield format_sse_chunk({
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "content": f"\n\n🔧 {tool_name}...\n\n"
                                },
                                "finish_reason": None,
                            }
                        ]
                    })
                    continue

            elif isinstance(msg, AssistantMessage):
                # In streaming mode text already arrived via StreamEvent;
                # we just check for error flags.
                if msg.error:
                    saw_error = True
                    finish_reason = "error"
                    error_text = f"\n\n[Agent error: {msg.error}]\n\n"
                    yield format_sse_chunk({
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": error_text},
                                "finish_reason": None,
                            }
                        ]
                    })

            elif isinstance(msg, ResultMessage):
                returned_session_id = msg.session_id
                if msg.stop_reason:
                    finish_reason = msg.stop_reason
                if msg.is_error and not saw_error:
                    saw_error = True
                    finish_reason = "error"

    except asyncio.CancelledError:
        logger.info("Agent query cancelled (client disconnect)")
        yield format_error_chunk("Request cancelled")
        yield SSE_DONE
        raise
    except Exception:
        logger.exception("Agent query failed")
        yield format_error_chunk("Agent execution failed")
        yield SSE_DONE
        return

    # --- final chunk with finish_reason and usage ---
    yield format_sse_chunk({
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "error" if saw_error else finish_reason,
            }
        ],
        "usage": None,
    })

    # Store session_id for the caller
    stream_agent._last_session_id = returned_session_id

    yield SSE_DONE


# Mutable attribute set after each call so the server can persist the session id.
stream_agent._last_session_id: str | None = None
