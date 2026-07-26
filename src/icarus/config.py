"""Configuration from environment variables with CLI override support."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass
class IcarusConfig:
    """Configuration loaded from env vars, overridable by CLI flags."""

    backend: Literal["agent-sdk", "opencode"] = "agent-sdk"
    anthropic_base_url: str = "https://api.anthropic.com"
    anthropic_auth_token: str = ""
    model: str = "claude-sonnet-4-20250514"
    subagent_model: str = ""
    cwd: Path = field(default_factory=Path.cwd)
    host: str = "127.0.0.1"
    port: int = 9090
    allowed_tools: list[str] = field(default_factory=list)
    max_turns: int = 50
    max_budget_usd: float = 0.50
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    readonly: bool = False
    request_timeout: int = 300


def load_config(cli_overrides: dict | None = None) -> IcarusConfig:
    """Build an :class:`IcarusConfig` from environment variables, with optional
    CLI overrides taking precedence.

    Environment variables read:
        ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL,
        ANTHROPIC_SMALL_MODEL, ICARUS_HOST, ICARUS_PORT, ICARUS_MAX_TURNS,
        ICARUS_MAX_BUDGET_USD, ICARUS_CWD, ICARUS_LOG_LEVEL,
        ICARUS_ALLOWED_TOOLS, ICARUS_READONLY, ICARUS_REQUEST_TIMEOUT
    """
    overrides = cli_overrides or {}

    cwd_raw = overrides.get("cwd") or os.environ.get("ICARUS_CWD", "")
    cwd = Path(cwd_raw) if cwd_raw else Path.cwd()

    allowed_tools_raw = overrides.get("allowed_tools") or os.environ.get(
        "ICARUS_ALLOWED_TOOLS", ""
    )
    allowed_tools = (
        [t.strip() for t in allowed_tools_raw.split(",") if t.strip()]
        if allowed_tools_raw
        else []
    )

    return IcarusConfig(
        anthropic_base_url=(
            overrides.get("anthropic_base_url")
            or os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
        ),
        anthropic_auth_token=(
            overrides.get("anthropic_auth_token")
            or os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
        ),
        model=(
            overrides.get("model")
            or os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
        ),
        subagent_model=os.environ.get("ANTHROPIC_SMALL_MODEL", ""),
        host=overrides.get("host") or os.environ.get("ICARUS_HOST", "127.0.0.1"),
        port=int(overrides.get("port") or os.environ.get("ICARUS_PORT", "9090")),
        max_turns=int(
            overrides.get("max_turns") or os.environ.get("ICARUS_MAX_TURNS", "50")
        ),
        max_budget_usd=float(
            overrides.get("max_budget_usd")
            or os.environ.get("ICARUS_MAX_BUDGET_USD", "0.50")
        ),
        cwd=cwd,
        log_level=(
            overrides.get("log_level")
            or os.environ.get("ICARUS_LOG_LEVEL", "info")
        ),
        allowed_tools=allowed_tools,
        readonly=bool(
            overrides.get("readonly")
            or os.environ.get("ICARUS_READONLY", "")
        ),
        request_timeout=int(
            overrides.get("request_timeout")
            or os.environ.get("ICARUS_REQUEST_TIMEOUT", "300")
        ),
    )
