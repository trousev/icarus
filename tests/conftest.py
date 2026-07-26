"""Shared fixtures for icarus tests."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from icarus.config import IcarusConfig
from tests.helpers import (  # noqa: F401 — re-exported for convenience
    error_auth_events,
    happy_path_events,
    make_assistant_message,
    make_auth_error_result,
    make_result_message,
    make_stream_event,
    make_tool_use_stream_event,
    tool_use_events,
)

# ---------------------------------------------------------------------------
# Config fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def test_config(tmp_path: Path) -> IcarusConfig:
    """An IcarusConfig pointed at a temp directory."""
    return IcarusConfig(
        anthropic_base_url="https://api.test.example.com",
        anthropic_auth_token="test-token",
        model="test-model",
        cwd=tmp_path,
        host="127.0.0.1",
        port=9999,
        max_turns=10,
        max_budget_usd=0.10,
        log_level="debug",
    )


# ---------------------------------------------------------------------------
# Test client
# ---------------------------------------------------------------------------


@pytest.fixture
def client(test_config: IcarusConfig) -> TestClient:
    """FastAPI TestClient with overridden config and session store."""
    # Override the module-level singletons for test isolation
    import icarus.server as server_mod
    from icarus.server import app
    from icarus.session import SessionStore

    server_mod._config = test_config
    server_mod._session_store = SessionStore()
    server_mod._global_semaphore = asyncio.Semaphore(1)

    return TestClient(app)


# ---------------------------------------------------------------------------
# Mock query patch
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_query():
    """Patch ``claude_agent_sdk.query`` at the agent_wrapper boundary."""
    with patch("icarus.agent_wrapper.query") as mock:
        yield mock


# ---------------------------------------------------------------------------
# Temp workspace
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_workspace(tmp_path: Path) -> Path:
    """Temp directory with a dummy ``main.py``."""
    (tmp_path / "main.py").write_text("print('hello')\n")
    return tmp_path
