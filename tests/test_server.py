"""End-to-end tests for the FastAPI server endpoints."""

from __future__ import annotations

import json


class TestModelsEndpoint:
    def test_returns_model_list(self, client) -> None:
        resp = client.get("/v1/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert len(data["data"]) == 1
        assert data["data"][0]["id"] == "icarus-agent-v1"


class TestHealthEndpoint:
    def test_returns_status(self, client) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "active_sessions" in data
        assert data["sdk_connected"] is True


class TestChatCompletionsValidation:
    def test_non_stream_rejected(self, client) -> None:
        """stream: false → 400."""
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "icarus-agent",
                "messages": [{"role": "user", "content": "Hello"}],
                "stream": False,
            },
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"]["code"] == "stream_required"

    def test_invalid_model(self, client) -> None:
        """Unknown model → 400."""
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "gpt-999",
                "messages": [{"role": "user", "content": "Hello"}],
                "stream": True,
            },
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"]["code"] == "model_not_found"

    def test_empty_messages(self, client) -> None:
        """No messages → 400."""
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "icarus-agent",
                "messages": [],
                "stream": True,
            },
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"]["type"] == "invalid_request_error"


class TestChatCompletionsStreaming:
    def test_rate_limit_stream(self, client, mock_query) -> None:
        """Rate limit error from SDK is streamed as error chunk + [DONE]."""
        from tests.helpers import rate_limit_events

        mock_query.return_value = rate_limit_events()

        with client.stream(
            "POST",
            "/v1/chat/completions",
            json={
                "model": "icarus-agent",
                "messages": [{"role": "user", "content": "Hello"}],
                "stream": True,
                "user": "test-user-rate",
            },
        ) as response:
            assert response.status_code == 200
            lines = list(response.iter_lines())
            assert "data: [DONE]" in lines

    def test_happy_path_sse_stream(self, client, mock_query) -> None:
        """Happy path returns SSE chunks from agent → UI."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        with client.stream(
            "POST",
            "/v1/chat/completions",
            json={
                "model": "icarus-agent",
                "messages": [
                    {"role": "system", "content": "Be helpful."},
                    {"role": "user", "content": "Hello world"},
                ],
                "stream": True,
                "user": "test-user-1",
            },
        ) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")

            lines = []
            for line in response.iter_lines():
                lines.append(line)

            # Should end with [DONE]
            assert "data: [DONE]" in lines

    def test_auth_error_stream(self, client, mock_query) -> None:
        """Agent auth error produces 200 with error in stream."""
        from tests.helpers import error_auth_events

        mock_query.return_value = error_auth_events()

        with client.stream(
            "POST",
            "/v1/chat/completions",
            json={
                "model": "icarus-agent",
                "messages": [{"role": "user", "content": "Hello"}],
                "stream": True,
                "user": "test-user-auth",
            },
        ) as response:
            assert response.status_code == 200
            lines = list(response.iter_lines())
            assert "data: [DONE]" in lines

    def test_conversation_resume(self, client, mock_query) -> None:
        """Second request with same 'user' reuses the session."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        payload = {
            "model": "icarus-agent",
            "messages": [
                {"role": "user", "content": "First message"},
            ],
            "stream": True,
            "user": "resume-user",
        }

        # First request
        with client.stream("POST", "/v1/chat/completions", json=payload) as resp:
            list(resp.iter_lines())  # consume

        # Second request with same user
        with client.stream("POST", "/v1/chat/completions", json={
            **payload,
            "messages": [
                {"role": "user", "content": "Follow-up message"},
            ],
        }) as resp:
            lines = list(resp.iter_lines())
            assert "data: [DONE]" in lines
            assert resp.status_code == 200

    def test_new_user_creates_fresh_session(self, client, mock_query) -> None:
        """Each new 'user' value creates a new session."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        payload = {
            "model": "icarus-agent",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": True,
        }

        # User A
        with client.stream("POST", "/v1/chat/completions", json={
            **payload, "user": "user-a",
        }) as resp:
            list(resp.iter_lines())

        # User B
        with client.stream("POST", "/v1/chat/completions", json={
            **payload, "user": "user-b",
        }) as resp:
            list(resp.iter_lines())

        # Both should have completed without error
        import icarus.server as server_mod
        assert server_mod._session_store.active_count == 2

    def test_x_icarus_session_id_header(self, client, mock_query) -> None:
        """Response includes X-Icarus-Session-Id header."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        with client.stream(
            "POST",
            "/v1/chat/completions",
            json={
                "model": "icarus-agent",
                "messages": [{"role": "user", "content": "Hi"}],
                "stream": True,
                "user": "header-test",
            },
        ) as response:
            list(response.iter_lines())
            assert "x-icarus-session-id" in response.headers

    def test_stream_includes_role_delta(self, client, mock_query) -> None:
        """First SSE chunk includes role: assistant delta."""
        from tests.helpers import happy_path_events

        mock_query.return_value = happy_path_events()

        with client.stream(
            "POST",
            "/v1/chat/completions",
            json={
                "model": "icarus-agent",
                "messages": [{"role": "user", "content": "Hello"}],
                "stream": True,
                "user": "role-test",
            },
        ) as response:
            lines = []
            for line in response.iter_lines():
                if line.startswith("data: ") and line != "data: [DONE]":
                    lines.append(line)
                    if len(lines) >= 2:
                        break

        # First data chunk should be the role delta
        first = json.loads(lines[0].removeprefix("data: "))
        assert first["choices"][0]["delta"]["role"] == "assistant"
        assert first["object"] == "chat.completion.chunk"
