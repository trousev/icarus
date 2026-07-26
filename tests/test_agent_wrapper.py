"""Tests for icarus.agent_wrapper."""

from __future__ import annotations

import json

import pytest

from icarus.agent_wrapper import _extract_text_delta, _is_tool_use_start, stream_agent
from icarus.sse import SSE_DONE


class TestExtractTextDelta:
    def test_text_delta(self) -> None:
        from tests.helpers import make_stream_event

        evt = make_stream_event("hello")
        assert _extract_text_delta(evt) == "hello"

    def test_non_delta_event(self) -> None:
        from tests.helpers import make_tool_use_stream_event

        evt = make_tool_use_stream_event("Read")
        assert _extract_text_delta(evt) is None


class TestIsToolUseStart:
    def test_tool_use_start(self) -> None:
        from tests.helpers import make_tool_use_stream_event

        evt = make_tool_use_stream_event("Read")
        is_tool, name = _is_tool_use_start(evt)
        assert is_tool is True
        assert name == "Read"

    def test_not_tool_use(self) -> None:
        from tests.helpers import make_stream_event

        evt = make_stream_event("text")
        is_tool, name = _is_tool_use_start(evt)
        assert is_tool is False
        assert name == ""


class TestStreamAgent:
    @pytest.mark.asyncio
    async def test_happy_path_streams_sse(self, mock_query, test_config) -> None:
        """Text deltas arrive as SSE content chunks followed by [DONE]."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        chunks = []
        async for chunk in stream_agent(
            prompt="Hello",
            config=test_config,
            is_first=True,
            system_prompt="Be helpful.",
        ):
            chunks.append(chunk)

        # First chunk should be role delta
        first = json.loads(chunks[0].removeprefix("data: "))
        assert first["choices"][0]["delta"] == {"role": "assistant"}

        # Should have content chunks
        content_deltas = []
        for chunk in chunks[1:]:
            if chunk == SSE_DONE:
                break
            data = json.loads(chunk.removeprefix("data: "))
            delta = data["choices"][0]["delta"]
            if "content" in delta:
                content_deltas.append(delta["content"])

        assert "Let " in content_deltas
        assert "me " in content_deltas
        assert "help." in content_deltas

        # Last chunk before DONE should have finish_reason
        last_data = json.loads(chunks[-2].removeprefix("data: "))
        assert last_data["choices"][0]["finish_reason"] is not None

        # Final chunk is [DONE]
        assert chunks[-1] == SSE_DONE

    @pytest.mark.asyncio
    async def test_auth_error(self, mock_query, test_config) -> None:
        """Auth failure emits error SSE chunk + [DONE]."""
        from tests.helpers import error_auth_events

        mock_query.return_value = error_auth_events()

        chunks = []
        async for chunk in stream_agent(
            prompt="Hello",
            config=test_config,
            is_first=True,
        ):
            chunks.append(chunk)

        # Should end with [DONE]
        assert chunks[-1] == SSE_DONE

    @pytest.mark.asyncio
    async def test_tool_use_marker(self, mock_query, test_config) -> None:
        """Tool-use blocks produce a marker in the stream."""
        from tests.helpers import tool_use_events

        mock_query.return_value = tool_use_events()

        chunks = []
        async for chunk in stream_agent(
            prompt="Read file",
            config=test_config,
            is_first=True,
        ):
            chunks.append(chunk)

        # Find the tool-use marker
        content_chunks = []
        for chunk in chunks:
            if chunk.startswith("data: ") and chunk != SSE_DONE:
                data = json.loads(chunk.removeprefix("data: "))
                delta = data["choices"][0]["delta"]
                if "content" in delta:
                    content_chunks.append(delta["content"])

        tool_markers = [c for c in content_chunks if "Read" in c]
        assert len(tool_markers) > 0  # tool-use marker emitted for Read

    @pytest.mark.asyncio
    async def test_session_id_captured(self, mock_query, test_config) -> None:
        """After a successful run, _last_session_id is set."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        chunks = []
        async for chunk in stream_agent(
            prompt="Hello",
            config=test_config,
            is_first=True,
        ):
            chunks.append(chunk)

        assert stream_agent._last_session_id == "session-1"

    @pytest.mark.asyncio
    async def test_initial_role_chunk(self, mock_query, test_config) -> None:
        """The very first SSE chunk always has delta.role = 'assistant'."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        chunks = []
        async for chunk in stream_agent(
            prompt="Hello",
            config=test_config,
            is_first=True,
        ):
            chunks.append(chunk)
            if len(chunks) >= 1:
                break

        data = json.loads(chunks[0].removeprefix("data: "))
        assert data["choices"][0]["delta"]["role"] == "assistant"
        assert data["object"] == "chat.completion.chunk"
