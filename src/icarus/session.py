"""Session store mapping OpenAI conversation IDs to Agent SDK sessions."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field


@dataclass
class SessionRecord:
    """Tracks a single conversation: the SDK session id and accumulated messages."""

    sdk_session_id: str
    openai_messages: list[dict] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    locked: bool = False


class SessionStore:
    """Maps chat conversation IDs (from OpenAI ``user`` field) to Agent SDK session IDs.

    Provides per-session ``asyncio.Lock`` for concurrency safety.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, SessionRecord] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, conversation_id: str) -> asyncio.Lock:
        if conversation_id not in self._locks:
            self._locks[conversation_id] = asyncio.Lock()
        return self._locks[conversation_id]

    def get_or_create(self, conversation_id: str) -> SessionRecord:
        """Return existing session for *conversation_id* or create a new one."""
        if conversation_id not in self._sessions:
            self._sessions[conversation_id] = SessionRecord(
                sdk_session_id=str(uuid.uuid4()),
                openai_messages=[],
                created_at=time.time(),
            )
        return self._sessions[conversation_id]

    def get(self, conversation_id: str) -> SessionRecord | None:
        """Return the session for *conversation_id* or ``None``."""
        return self._sessions.get(conversation_id)

    def lock(self, conversation_id: str) -> asyncio.Lock:
        """Return the asyncio.Lock for *conversation_id*."""
        return self._get_lock(conversation_id)

    @property
    def active_count(self) -> int:
        """Number of tracked sessions."""
        return len(self._sessions)
