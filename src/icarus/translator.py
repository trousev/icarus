"""Translation layer: OpenAI Chat Completions messages ↔ Agent SDK prompt/options."""

from __future__ import annotations

from claude_agent_sdk import ClaudeAgentOptions


def extract_system_message(messages: list[dict]) -> str | None:
    """Return the content of the first ``system`` message, or ``None``."""
    for msg in messages:
        if msg.get("role") == "system":
            content = msg.get("content", "")
            if isinstance(content, list):
                # Multimodal content — extract text parts only
                parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                return "\n".join(parts) if parts else None
            return content or None
    return None


def extract_latest_user_message(messages: list[dict]) -> str:
    """Return the content of the last ``user`` message.

    Raises ``ValueError`` if no user message is found.
    """
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                return "\n".join(parts) if parts else ""
            return str(content)
    raise ValueError("No user message found in the messages array")


def _render_message(msg: dict) -> str:
    """Render a single OpenAI-format message as an XML-tagged string."""
    role = msg.get("role", "user")
    content = msg.get("content", "")
    if isinstance(content, list):
        parts = [p.get("text", "") for p in content if p.get("type") == "text"]
        content = "\n".join(parts) if parts else ""
    return f"<{role}>\n{content}\n</{role}>"


def build_prompt(messages: list[dict], *, is_first: bool) -> str:
    """Build the prompt string for the SDK.

    On the first request all non-system messages are serialised with XML
    role tags.  On follow-up (resume) requests only the latest user message
    is sent — the SDK replays history from its session file.
    """
    if is_first:
        non_system = [m for m in messages if m.get("role") != "system"]
        if not non_system:
            raise ValueError("No non-system messages to build prompt from")
        return "\n\n".join(_render_message(m) for m in non_system)

    return extract_latest_user_message(messages)


def build_options(
    *,
    prompt: str,
    config,  # IcarusConfig (lazy import to avoid circular)
    session_id: str | None = None,
    system_prompt: str | None = None,
    is_first: bool = True,
) -> ClaudeAgentOptions:
    """Construct :class:`ClaudeAgentOptions` for an SDK ``query()`` call."""
    allowed_tools = config.allowed_tools if config.allowed_tools else [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebFetch",
    ]

    # Apply readonly mode: strip write-capable tools
    if config.readonly:
        allowed_tools = [t for t in allowed_tools if t not in ("Write", "Edit")]

    kwargs: dict = {
        "allowed_tools": allowed_tools,
        "permission_mode": "bypassPermissions",
        "max_turns": config.max_turns,
        "max_budget_usd": config.max_budget_usd,
        "cwd": str(config.cwd),
        "include_partial_messages": True,
        "setting_sources": [],
    }

    if config.model:
        kwargs["model"] = config.model
    if config.subagent_model:
        kwargs["model"] = config.subagent_model

    if is_first and system_prompt:
        kwargs["system_prompt"] = system_prompt
    else:
        kwargs["system_prompt"] = None

    if session_id:
        kwargs["resume"] = session_id

    return ClaudeAgentOptions(**kwargs)
