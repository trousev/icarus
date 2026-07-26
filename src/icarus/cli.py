"""CLI entry point — ``icarus serve``."""

from __future__ import annotations

import logging
import os

import click
import structlog
import uvicorn


@click.group()
@click.version_option(package_name="icarus")
def main() -> None:
    """icarus — OpenAI-compatible API wrapper around the Claude Agent SDK."""


@main.command()
@click.option(
    "-p", "--port", type=int, default=None, help="Port to bind to [default: 9090]"
)
@click.option(
    "-H", "--host", type=str, default=None, help="Host address [default: 127.0.0.1]"
)
@click.option(
    "-d",
    "--cwd",
    type=click.Path(exists=True, file_okay=False, dir_okay=True),
    default=None,
    help="Agent working directory [default: current dir]",
)
@click.option(
    "-m", "--model", type=str, default=None, help="Model name [default: from env]"
)
@click.option(
    "-t",
    "--max-turns",
    type=int,
    default=None,
    help="Max tool-call iterations [default: 50]",
)
@click.option(
    "-b",
    "--max-budget",
    type=float,
    default=None,
    help="Cost cap per session (USD) [default: 0.50]",
)
@click.option(
    "-l",
    "--log-level",
    type=click.Choice(["debug", "info", "warning", "error"]),
    default=None,
    help="Log level [default: info]",
)
@click.option(
    "--readonly",
    is_flag=True,
    default=None,
    help="Disable Write and Edit tools",
)
@click.option(
    "--reload",
    is_flag=True,
    default=False,
    help="Dev mode auto-reload",
)
@click.option(
    "--allowed-tools",
    type=str,
    default=None,
    help="Comma-separated tool whitelist",
)
def serve(
    port: int | None,
    host: str | None,
    cwd: str | None,
    model: str | None,
    max_turns: int | None,
    max_budget: float | None,
    log_level: str | None,
    readonly: bool | None,
    reload: bool,
    allowed_tools: str | None,
) -> None:
    """Start the icarus server.

    Reads credentials from ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN
    environment variables (the same ones Claude Code CLI uses).
    """
    # Build CLI overrides dict for load_config()
    cli_overrides: dict = {}
    if port is not None:
        cli_overrides["port"] = port
    if host is not None:
        cli_overrides["host"] = host
    if cwd is not None:
        cli_overrides["cwd"] = cwd
    if model is not None:
        cli_overrides["model"] = model
    if max_turns is not None:
        cli_overrides["max_turns"] = max_turns
    if max_budget is not None:
        cli_overrides["max_budget_usd"] = max_budget
    if log_level is not None:
        cli_overrides["log_level"] = log_level
    if readonly:
        cli_overrides["readonly"] = readonly
    if allowed_tools is not None:
        cli_overrides["allowed_tools"] = allowed_tools

    # Set these as env vars so the server process picks them up
    for key, value in cli_overrides.items():
        env_key = f"ICARUS_{key.upper()}"
        os.environ[env_key] = str(value)

    # Configure structured JSON-line logging to stderr
    _setup_logging(log_level or "info")

    # Validate required env vars
    auth_token = os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
    if not auth_token:
        click.secho(
            "WARNING: ANTHROPIC_AUTH_TOKEN is not set. "
            "The server will start, but API calls will fail with 401.",
            fg="yellow",
            err=True,
        )

    effective_port = port or int(os.environ.get("ICARUS_PORT", "9090"))
    effective_host = host or os.environ.get("ICARUS_HOST", "127.0.0.1")

    click.secho(
        f"icarus v0.1.0 — starting server on {effective_host}:{effective_port}",
        fg="green",
        err=True,
    )
    click.secho(
        f"Model: {model or os.environ.get('ANTHROPIC_MODEL', 'default')}  "
        f"CWD: {cwd or os.getcwd()}  "
        f"Readonly: {readonly or bool(os.environ.get('ICARUS_READONLY'))}",
        fg="blue",
        err=True,
    )

    uvicorn.run(
        "icarus.server:app",
        host=effective_host,
        port=effective_port,
        reload=reload,
        log_level=(log_level or "info"),
        log_config=None,  # let structlog handle it
    )


def _setup_logging(level: str) -> None:
    """Configure structured JSON logging via structlog."""
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
    logging.getLogger("icarus").setLevel(getattr(logging, level.upper(), logging.INFO))


if __name__ == "__main__":
    main()
