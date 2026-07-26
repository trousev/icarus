"""Shared test helpers — mock SDK event factories and async generators."""

from __future__ import annotations

from collections.abc import AsyncIterator
from unittest.mock import MagicMock

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    TextBlock,
)

# ---------------------------------------------------------------------------
# Synthetic SDK events (use ``spec=`` so ``isinstance`` checks pass)
# ---------------------------------------------------------------------------


def make_stream_event(text: str) -> MagicMock:
    """Build a mock :class:`StreamEvent` with a text delta."""
    event = MagicMock(spec=StreamEvent)
    event.uuid = "stream-uuid-1"
    event.session_id = "session-1"
    event.event = {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": text},
    }
    event.parent_tool_use_id = None
    return event


def make_tool_use_stream_event(tool_name: str) -> MagicMock:
    """Build a mock StreamEvent signalling the start of a tool-use block."""
    event = MagicMock(spec=StreamEvent)
    event.uuid = "stream-uuid-tool"
    event.session_id = "session-1"
    event.event = {
        "type": "content_block_start",
        "index": 1,
        "content_block": {
            "type": "tool_use",
            "id": "toolu_1",
            "name": tool_name,
            "input": {},
        },
    }
    event.parent_tool_use_id = None
    return event


def make_assistant_message() -> MagicMock:
    """Build a mock AssistantMessage."""
    msg = MagicMock(spec=AssistantMessage)
    msg.content = [TextBlock(text="I've completed the task.")]
    msg.model = "test-model"
    msg.error = None
    msg.stop_reason = "end_turn"
    msg.session_id = "session-1"
    msg.uuid = "msg-uuid-1"
    msg.parent_tool_use_id = None
    msg.usage = None
    msg.message_id = None
    return msg


def make_result_message(
    session_id: str = "session-1",
    is_error: bool = False,
    stop_reason: str = "end_turn",
) -> MagicMock:
    """Build a mock ResultMessage."""
    result = MagicMock(spec=ResultMessage)
    result.subtype = "success"
    result.duration_ms = 100
    result.duration_api_ms = 80
    result.session_id = session_id
    result.is_error = is_error
    result.stop_reason = stop_reason
    result.total_cost_usd = 0.01
    result.num_turns = 3
    result.result = "Done."
    result.errors = []
    result.usage = None
    result.structured_output = None
    result.model_usage = None
    result.permission_denials = None
    result.deferred_tool_use = None
    result.api_error_status = None
    result.uuid = "result-uuid-1"
    result.terminal_reason = None
    return result


def make_auth_error_result() -> MagicMock:
    """Build a ResultMessage simulating an auth failure."""
    result = MagicMock(spec=ResultMessage)
    result.subtype = "success"
    result.duration_ms = 10
    result.duration_api_ms = 0
    result.session_id = "session-auth-err"
    result.is_error = True
    result.stop_reason = "end_turn"
    result.total_cost_usd = 0.0
    result.num_turns = 0
    result.result = None
    result.errors = ["Authentication failed: invalid API key"]
    result.usage = None
    result.structured_output = None
    result.model_usage = None
    result.permission_denials = None
    result.deferred_tool_use = None
    result.api_error_status = None
    result.uuid = "result-err-1"
    result.terminal_reason = None
    return result


# ---------------------------------------------------------------------------
# Async generator helpers
# ---------------------------------------------------------------------------


async def happy_path_events() -> AsyncIterator[MagicMock]:
    """Realistic sequence: text deltas → assistant message → result."""
    yield make_stream_event("Let ")
    yield make_stream_event("me ")
    yield make_stream_event("help.")
    yield make_assistant_message()
    yield make_result_message()


async def error_auth_events() -> AsyncIterator[MagicMock]:
    """Auth failure sequence."""
    yield make_auth_error_result()


def make_rate_limit_result() -> MagicMock:
    """Build a ResultMessage simulating a rate limit error."""
    result = MagicMock(spec=ResultMessage)
    result.subtype = "success"
    result.duration_ms = 10
    result.duration_api_ms = 0
    result.session_id = "session-rate-limit"
    result.is_error = True
    result.stop_reason = "end_turn"
    result.total_cost_usd = 0.0
    result.num_turns = 0
    result.result = None
    result.errors = ["Rate limit exceeded"]
    result.api_error_status = 429
    result.usage = None
    result.structured_output = None
    result.model_usage = None
    result.permission_denials = None
    result.deferred_tool_use = None
    result.uuid = "result-rate-1"
    result.terminal_reason = None
    return result


async def rate_limit_events() -> AsyncIterator[MagicMock]:
    """Rate limit sequence — yields error ResultMessage."""
    yield make_rate_limit_result()


async def tool_use_events() -> AsyncIterator[MagicMock]:
    """Stream that includes a tool call."""
    yield make_stream_event("Let me read the file...")
    yield make_tool_use_stream_event("Read")
    yield make_stream_event("File contents are...")
    yield make_assistant_message()
    yield make_result_message()
