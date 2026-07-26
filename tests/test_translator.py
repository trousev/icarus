"""Tests for icarus.translator."""

from __future__ import annotations

import pytest

from icarus.translator import (
    build_options,
    build_prompt,
    extract_latest_user_message,
    extract_system_message,
)


class TestExtractSystemMessage:
    def test_extracts_system_message(self) -> None:
        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"},
        ]
        assert extract_system_message(messages) == "You are a helpful assistant."

    def test_no_system_message(self) -> None:
        messages = [{"role": "user", "content": "Hello"}]
        assert extract_system_message(messages) is None

    def test_system_message_with_list_content(self) -> None:
        messages = [
            {
                "role": "system",
                "content": [
                    {"type": "text", "text": "You are helpful."},
                    {"type": "text", "text": "Be concise."},
                ],
            },
        ]
        assert extract_system_message(messages) == "You are helpful.\nBe concise."


class TestExtractLatestUserMessage:
    def test_extracts_last_user(self) -> None:
        messages = [
            {"role": "user", "content": "First"},
            {"role": "assistant", "content": "Reply"},
            {"role": "user", "content": "Second"},
        ]
        assert extract_latest_user_message(messages) == "Second"

    def test_raises_on_no_user(self) -> None:
        messages = [{"role": "system", "content": "Sys"}]
        with pytest.raises(ValueError, match="No user message"):
            extract_latest_user_message(messages)

    def test_list_content(self) -> None:
        messages = [
            {
                "role": "user",
                "content": [{"type": "text", "text": "Hello world"}],
            }
        ]
        assert extract_latest_user_message(messages) == "Hello world"


class TestBuildPrompt:
    def test_first_request_serializes_all(self) -> None:
        messages = [
            {"role": "system", "content": "Be helpful."},
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
            {"role": "user", "content": "Write code"},
        ]
        result = build_prompt(messages, is_first=True)
        assert "<user>" in result
        assert "Hi" in result
        assert "<assistant>" in result
        assert "Hello!" in result
        assert "Write code" in result
        # System message is excluded
        assert "Be helpful." not in result

    def test_follow_up_uses_latest_user(self) -> None:
        messages = [
            {"role": "user", "content": "First question"},
            {"role": "assistant", "content": "First answer"},
            {"role": "user", "content": "Follow up"},
        ]
        result = build_prompt(messages, is_first=False)
        assert result == "Follow up"

    def test_first_request_raises_on_empty(self) -> None:
        with pytest.raises(ValueError):
            build_prompt([{"role": "system", "content": "Only system"}], is_first=True)


class TestBuildOptions:
    def test_first_request_with_system_prompt(self) -> None:
        """System → system_prompt, latest user → prompt."""
        from icarus.config import IcarusConfig

        config = IcarusConfig(cwd="/tmp/test")
        options = build_options(
            prompt="Hello",
            config=config,
            system_prompt="Be helpful.",
            is_first=True,
        )
        assert options.system_prompt == "Be helpful."
        assert options.resume is None
        assert options.permission_mode == "bypassPermissions"
        assert options.max_turns == 50
        assert options.include_partial_messages is True

    def test_resume_sets_session_id(self) -> None:
        from icarus.config import IcarusConfig

        config = IcarusConfig()
        options = build_options(
            prompt="Follow up",
            config=config,
            session_id="sdk-session-123",
            is_first=False,
        )
        assert options.resume == "sdk-session-123"
        assert options.system_prompt is None

    def test_readonly_strips_write_tools(self) -> None:
        from icarus.config import IcarusConfig

        config = IcarusConfig(readonly=True)
        options = build_options(prompt="Hi", config=config, is_first=True)
        for tool in ("Write", "Edit"):
            assert tool not in options.allowed_tools
        for tool in ("Read", "Bash", "Grep", "Glob", "WebFetch"):
            assert tool in options.allowed_tools

    def test_custom_allowed_tools(self) -> None:
        from icarus.config import IcarusConfig

        config = IcarusConfig(allowed_tools=["Read", "Grep"])
        options = build_options(prompt="Hi", config=config, is_first=True)
        assert options.allowed_tools == ["Read", "Grep"]
