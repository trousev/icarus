"""Tests for the memory system components."""

import json

from icarus.memory import (
    DedupFilter,
    _contains_sensitive,
    conversation_key,
    is_conversation_start,
    _format_injection,
)
from icarus.memory import Fact


# ── conversation_key ──────────────────────────────────────────────────────


def test_conversation_key_same_first_message():
    """Same first user message should produce same key."""
    msgs1 = [{"role": "user", "content": "Hello, can you help me?"}]
    msgs2 = [
        {"role": "system", "content": "You are helpful"},
        {"role": "user", "content": "Hello, can you help me?"},
    ]
    assert conversation_key(msgs1) == conversation_key(msgs2)


def test_conversation_key_different_first_message():
    """Different first user messages should produce different keys."""
    msgs1 = [{"role": "user", "content": "Hello"}]
    msgs2 = [{"role": "user", "content": "Help me with Rust"}]
    assert conversation_key(msgs1) != conversation_key(msgs2)


def test_conversation_key_no_user():
    """No user message returns sentinel key."""
    msgs = [{"role": "system", "content": "You are helpful"}]
    assert conversation_key(msgs) == "no-user"


def test_conversation_key_strips_whitespace():
    """Leading/trailing whitespace should be normalized."""
    msgs1 = [{"role": "user", "content": "  hello  "}]
    msgs2 = [{"role": "user", "content": "hello"}]
    assert conversation_key(msgs1) == conversation_key(msgs2)


# ── is_conversation_start ─────────────────────────────────────────────────


def test_is_conversation_start_true():
    """No assistant messages = new conversation."""
    msgs = [
        {"role": "system", "content": "You are helpful"},
        {"role": "user", "content": "Hi"},
    ]
    assert is_conversation_start(msgs) is True


def test_is_conversation_start_false():
    """Has assistant message = continuation."""
    msgs = [
        {"role": "system", "content": "You are helpful"},
        {"role": "user", "content": "Hi"},
        {"role": "assistant", "content": "Hello!"},
        {"role": "user", "content": "Help me"},
    ]
    assert is_conversation_start(msgs) is False


# ── _contains_sensitive ───────────────────────────────────────────────────


def test_contains_sensitive_deepseek_key():
    assert _contains_sensitive("My key is sk-abc123def456ghijklmn") is True


def test_contains_sensitive_openai_key():
    assert _contains_sensitive("sk-proj-longkeyhere") is True


def test_contains_sensitive_aws_key():
    assert _contains_sensitive("AKIA1234567890ABCDEF") is True


def test_contains_sensitive_password_assignment():
    assert _contains_sensitive("password = hunter2!!") is True


def test_contains_sensitive_email():
    assert _contains_sensitive("my email is alex@example.com") is True


def test_contains_sensitive_clean_text():
    assert _contains_sensitive("The user prefers Rust for systems programming.") is False


def test_contains_sensitive_project_fact():
    assert _contains_sensitive("Alex works on Icarus proxy") is False


# ── DedupFilter ───────────────────────────────────────────────────────────


def test_dedup_l1_exact_duplicate():
    df = DedupFilter(max_size=100)
    fact = "The user prefers Rust for systems programming."
    assert df.check_l1(fact) is False  # Not seen yet
    df.add(fact)
    assert df.check_l1(fact) is True   # Now it's a duplicate


def test_dedup_l1_normalized():
    """Normalization should catch case/whitespace/punctuation variants."""
    df = DedupFilter(max_size=100)
    df.add("The user prefers Rust for systems programming.")
    assert df.check_l1("the user prefers Rust for systems programming") is True
    assert df.check_l1("  The user prefers Rust for systems programming.  ") is True


def test_dedup_l1_different_facts():
    df = DedupFilter(max_size=100)
    df.add("The user prefers Rust.")
    assert df.check_l1("The user prefers Python.") is False


def test_dedup_invalidate():
    """After invalidation, a fact should be re-learnable."""
    df = DedupFilter(max_size=100)
    fact = "The user prefers Rust."
    df.add(fact)
    assert df.check_l1(fact) is True
    df.invalidate(fact)
    assert df.check_l1(fact) is False


def test_dedup_prune_old_entries():
    """Cache should prune oldest entries when over max_size."""
    df = DedupFilter(max_size=10)
    for i in range(20):
        df.add(f"Fact number {i}")
    # First entries should be evicted (max_size=10 keeps last 10)
    assert df.check_l1("Fact number 0") is False
    assert df.check_l1("Fact number 19") is True


# ── _format_injection ─────────────────────────────────────────────────────


def test_format_injection_empty():
    assert _format_injection([]) is None


def test_format_injection_basic():
    facts = [
        Fact(uuid="1", name="PREFERS", fact="The user prefers concise answers."),
        Fact(uuid="2", name="WORKS_ON", fact="The user works on Icarus."),
    ]
    result = _format_injection(facts)
    assert result is not None
    assert "User Memory" in result
    assert "The user prefers concise answers" in result
    assert "The user works on Icarus" in result


def test_format_injection_truncation():
    """Should truncate to max_facts."""
    facts = [
        Fact(uuid=str(i), name="RELATES_TO", fact=f"Fact {i}")
        for i in range(50)
    ]
    result = _format_injection(facts, max_facts=10)
    assert result is not None
    # Only first 10 facts should be present
    assert "Fact 9" in result
    assert "Fact 10" not in result


# ── Conversation key edge cases ───────────────────────────────────────────


def test_conversation_key_multimodal():
    """Multimodal content (list of parts) should serialize deterministically."""
    msgs1 = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "image_url", "image_url": {"url": "https://example.com/img.png"}},
            ],
        }
    ]
    msgs2 = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "image_url", "image_url": {"url": "https://example.com/img.png"}},
            ],
        }
    ]
    assert conversation_key(msgs1) == conversation_key(msgs2)
    assert conversation_key(msgs1) != "no-user"
