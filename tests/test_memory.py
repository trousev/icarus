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


# ── SnapshotStore._fact_hash ─────────────────────────────────────────────


def test_fact_hash_deterministic():
    """Same text produces same hash."""
    from icarus.memory import SnapshotStore
    h1 = SnapshotStore._fact_hash("The user prefers Rust.")
    h2 = SnapshotStore._fact_hash("The user prefers Rust.")
    assert h1 == h2
    assert len(h1) == 16


def test_fact_hash_normalizes():
    """Whitespace, case, and punctuation should normalize to same hash."""
    from icarus.memory import SnapshotStore
    h1 = SnapshotStore._fact_hash("The user prefers Rust for systems programming.")
    h2 = SnapshotStore._fact_hash("the user prefers rust for systems programming")
    h3 = SnapshotStore._fact_hash("  The user prefers Rust for systems programming.  ")
    assert h1 == h2 == h3


def test_fact_hash_different():
    """Different facts produce different hashes."""
    from icarus.memory import SnapshotStore
    h1 = SnapshotStore._fact_hash("The user prefers Rust.")
    h2 = SnapshotStore._fact_hash("The user prefers Python.")
    assert h1 != h2


# ── fact_owners: record → own → drop round-trip ───────────────────────────


def test_own_facts_filters_by_tenant():
    """own_facts returns only facts belonging to the given tenant."""
    from icarus.memory import Fact, SnapshotStore, _snapshot_store

    # Record ownership for tenant-A facts
    _snapshot_store.record_fact_owner(
        SnapshotStore._fact_hash("The user prefers Rust."), "tenant-A"
    )
    _snapshot_store.record_fact_owner(
        SnapshotStore._fact_hash("The user lives in Dublin."), "tenant-A"
    )
    # Record ownership for tenant-B fact
    _snapshot_store.record_fact_owner(
        SnapshotStore._fact_hash("The user uses Figma daily."), "tenant-B"
    )

    facts = [
        Fact(uuid="1", name="PREFERS", fact="The user prefers Rust."),
        Fact(uuid="2", name="LIVES_IN", fact="The user lives in Dublin."),
        Fact(uuid="3", name="USES", fact="The user uses Figma daily."),
    ]

    # Tenant A should see only their 2 facts
    result = _snapshot_store.own_facts(facts, "tenant-A")
    assert len(result) == 2
    assert all("Rust" in f.fact or "Dublin" in f.fact for f in result)

    # Tenant B should see only their 1 fact
    result = _snapshot_store.own_facts(facts, "tenant-B")
    assert len(result) == 1
    assert "Figma" in result[0].fact

    # Tenant C should see nothing
    result = _snapshot_store.own_facts(facts, "tenant-C")
    assert len(result) == 0

    # Cleanup
    for f in facts:
        _snapshot_store.drop_fact_owner(SnapshotStore._fact_hash(f.fact), "tenant-A")
    _snapshot_store.drop_fact_owner(
        SnapshotStore._fact_hash("The user uses Figma daily."), "tenant-B"
    )


def test_own_facts_empty_list():
    """Empty input returns empty list."""
    from icarus.memory import _snapshot_store
    result = _snapshot_store.own_facts([], "any-tenant")
    assert result == []


def test_record_and_drop_fact_owner():
    """Record then drop should make the fact invisible."""
    from icarus.memory import Fact, SnapshotStore, _snapshot_store

    fact = Fact(uuid="99", name="TEST", fact="Test fact for ownership.")
    fact_hash = SnapshotStore._fact_hash(fact.fact)

    # Record
    _snapshot_store.record_fact_owner(fact_hash, "test-tenant")
    result = _snapshot_store.own_facts([fact], "test-tenant")
    assert len(result) == 1

    # Drop
    _snapshot_store.drop_fact_owner(fact_hash, "test-tenant")
    result = _snapshot_store.own_facts([fact], "test-tenant")
    assert len(result) == 0


# ── require_tenant ────────────────────────────────────────────────────────


def test_require_tenant_raises_when_unset(monkeypatch):
    """require_tenant raises TenantIsolationError when no tenant is set."""
    from icarus.tenant import require_tenant, TenantIsolationError
    from icarus import tenant as tenant_mod

    # Ensure the ContextVar is empty
    token = tenant_mod._current_tenant.set(None)
    try:
        import pytest
        with pytest.raises(TenantIsolationError, match="Tenant context required"):
            require_tenant()
    finally:
        tenant_mod._current_tenant.reset(token)


def test_require_tenant_returns_tenant_when_set():
    """require_tenant returns the tenant when ContextVar is set."""
    from icarus.tenant import require_tenant, Tenant, tenant_context

    tenant = Tenant.from_identity("alice", via="test")
    with tenant_context(tenant):
        result = require_tenant()
        assert result.id == "alice"
        assert result.group_id == "alice"


# ── search_facts requires group_id ────────────────────────────────────────


def test_search_facts_requires_group_id():
    """search_facts(group_id) is required — TypeError if missing."""
    import inspect
    from icarus.memory import MemoryClient

    sig = inspect.signature(MemoryClient.search_facts)
    params = list(sig.parameters.keys())
    # query, group_id are positional; limit, include_invalid have defaults
    assert "group_id" in params
    param = sig.parameters["group_id"]
    assert param.default is inspect.Parameter.empty, \
        "group_id must be required (no default value)"
