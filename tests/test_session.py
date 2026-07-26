"""Tests for icarus.session."""

from __future__ import annotations

from icarus.session import SessionRecord, SessionStore


class TestSessionStore:
    def test_get_or_create_new(self) -> None:
        store = SessionStore()
        record = store.get_or_create("conv-1")
        assert isinstance(record, SessionRecord)
        assert record.sdk_session_id is not None
        assert record.openai_messages == []

    def test_get_or_create_returns_same(self) -> None:
        store = SessionStore()
        r1 = store.get_or_create("conv-1")
        r2 = store.get_or_create("conv-1")
        assert r1 is r2
        assert r1.sdk_session_id == r2.sdk_session_id

    def test_get_existing(self) -> None:
        store = SessionStore()
        store.get_or_create("conv-1")
        record = store.get("conv-1")
        assert record is not None
        assert record.sdk_session_id is not None

    def test_get_missing(self) -> None:
        store = SessionStore()
        assert store.get("nonexistent") is None

    def test_different_conversations_separate(self) -> None:
        store = SessionStore()
        r1 = store.get_or_create("conv-1")
        r2 = store.get_or_create("conv-2")
        assert r1.sdk_session_id != r2.sdk_session_id

    def test_active_count(self) -> None:
        store = SessionStore()
        assert store.active_count == 0
        store.get_or_create("conv-1")
        assert store.active_count == 1
        store.get_or_create("conv-2")
        assert store.active_count == 2

    def test_lock_per_session(self) -> None:
        store = SessionStore()
        lock1 = store.lock("conv-1")
        lock2 = store.lock("conv-1")
        assert lock1 is lock2  # same lock object
        lock3 = store.lock("conv-2")
        assert lock1 is not lock3

    def test_message_accumulation(self) -> None:
        store = SessionStore()
        record = store.get_or_create("conv-1")
        record.openai_messages.append({"role": "user", "content": "Hello"})
        record.openai_messages.append({"role": "assistant", "content": "Hi!"})
        assert len(record.openai_messages) == 2
