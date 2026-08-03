"""Tests for the memory injection logic."""

from icarus.proxy import inject_memory
from icarus.config import config


def test_inject_memory_after_existing_system_message():
    """Memory should be inserted after the last system message."""
    config.MEMORY_INJECTION = "User name is Alex"
    body = (
        b'{"messages": ['
        b'{"role": "system", "content": "You are helpful"},'
        b'{"role": "user", "content": "Hi"}'
        b']}'
    )
    result = inject_memory(body)
    import json

    data = json.loads(result)
    assert len(data["messages"]) == 3
    assert data["messages"][0]["role"] == "system"
    assert data["messages"][0]["content"] == "You are helpful"
    assert data["messages"][1]["role"] == "system"
    assert data["messages"][1]["content"] == "User name is Alex"
    assert data["messages"][2]["role"] == "user"


def test_inject_memory_no_system_message():
    """Memory should be prepended when no system message exists."""
    config.MEMORY_INJECTION = "User name is Alex"
    body = (
        b'{"messages": ['
        b'{"role": "user", "content": "Hi"}'
        b']}'
    )
    import json

    result = inject_memory(body)
    data = json.loads(result)
    assert len(data["messages"]) == 2
    assert data["messages"][0]["role"] == "system"
    assert data["messages"][0]["content"] == "User name is Alex"
    assert data["messages"][1]["role"] == "user"


def test_inject_memory_empty_disabled():
    """When no memory is configured, body should be unchanged."""
    config.MEMORY_INJECTION = ""
    body = b'{"messages": [{"role": "user", "content": "Hi"}]}'
    result = inject_memory(body)
    assert result == body


def test_inject_memory_multiple_system_messages():
    """Memory should be inserted after the last system message."""
    config.MEMORY_INJECTION = "Memory"
    body = (
        b'{"messages": ['
        b'{"role": "system", "content": "Sys1"},'
        b'{"role": "system", "content": "Sys2"},'
        b'{"role": "user", "content": "Hi"}'
        b']}'
    )
    import json

    result = inject_memory(body)
    data = json.loads(result)
    assert len(data["messages"]) == 4
    assert data["messages"][0]["content"] == "Sys1"
    assert data["messages"][1]["content"] == "Sys2"
    assert data["messages"][2]["content"] == "Memory"
    assert data["messages"][3]["role"] == "user"
