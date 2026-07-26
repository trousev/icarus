"""Tests for icarus.config."""

from __future__ import annotations

from pathlib import Path

from icarus.config import load_config


class TestLoadConfig:
    """Tests for load_config() with env var and CLI override handling."""

    def test_defaults(self, monkeypatch) -> None:
        """Without env vars or overrides, defaults are used."""
        # Ensure env vars are not set
        for var in (
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
            "ICARUS_PORT",
            "ICARUS_HOST",
        ):
            monkeypatch.delenv(var, raising=False)

        cfg = load_config()
        assert cfg.host == "127.0.0.1"
        assert cfg.port == 9090
        assert cfg.max_turns == 50
        assert cfg.max_budget_usd == 0.50
        assert cfg.log_level == "info"
        assert cfg.readonly is False

    def test_env_vars(self, monkeypatch) -> None:
        """Environment variables are read correctly."""
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.deepseek.com")
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "sk-test")
        monkeypatch.setenv("ANTHROPIC_MODEL", "deepseek-v4")
        monkeypatch.setenv("ICARUS_PORT", "8080")
        monkeypatch.setenv("ICARUS_HOST", "0.0.0.0")
        monkeypatch.setenv("ICARUS_MAX_TURNS", "30")
        monkeypatch.setenv("ICARUS_MAX_BUDGET_USD", "1.00")
        monkeypatch.setenv("ICARUS_LOG_LEVEL", "debug")
        monkeypatch.setenv("ICARUS_READONLY", "1")

        cfg = load_config()
        assert cfg.anthropic_base_url == "https://api.deepseek.com"
        assert cfg.anthropic_auth_token == "sk-test"
        assert cfg.model == "deepseek-v4"
        assert cfg.port == 8080
        assert cfg.host == "0.0.0.0"
        assert cfg.max_turns == 30
        assert cfg.max_budget_usd == 1.00
        assert cfg.log_level == "debug"
        assert cfg.readonly is True

    def test_cli_overrides_take_precedence(self, monkeypatch) -> None:
        """CLI overrides win over env vars."""
        monkeypatch.setenv("ICARUS_PORT", "8080")
        monkeypatch.setenv("ICARUS_MAX_TURNS", "30")

        cfg = load_config({"port": "9090", "max_turns": "100"})
        assert cfg.port == 9090
        assert cfg.max_turns == 100

    def test_cwd_from_env(self, monkeypatch, tmp_path: Path) -> None:
        """ICARUS_CWD is resolved to a Path."""
        monkeypatch.setenv("ICARUS_CWD", str(tmp_path))
        cfg = load_config()
        assert cfg.cwd == tmp_path

    def test_cwd_default(self, monkeypatch) -> None:
        """Default cwd is process working directory."""
        monkeypatch.delenv("ICARUS_CWD", raising=False)
        cfg = load_config()
        assert cfg.cwd == Path.cwd()

    def test_allowed_tools_from_env(self, monkeypatch) -> None:
        """ICARUS_ALLOWED_TOOLS is split on commas."""
        monkeypatch.setenv("ICARUS_ALLOWED_TOOLS", "Read, Grep, Bash")
        cfg = load_config()
        assert cfg.allowed_tools == ["Read", "Grep", "Bash"]

    def test_allowed_tools_empty(self, monkeypatch) -> None:
        """Empty string yields empty list."""
        monkeypatch.setenv("ICARUS_ALLOWED_TOOLS", "")
        cfg = load_config()
        assert cfg.allowed_tools == []

    def test_request_timeout(self, monkeypatch) -> None:
        """ICARUS_REQUEST_TIMEOUT is parsed."""
        monkeypatch.setenv("ICARUS_REQUEST_TIMEOUT", "120")
        cfg = load_config()
        assert cfg.request_timeout == 120
