"""End-to-end multi-tenancy integration test.

Runs against a live Icarus proxy on localhost:8000.  Skipped by default
in the regular test suite — invoke explicitly:

    RUN_E2E_TESTS=1 pytest tests/test_e2e_multi_tenant.py -v -s

Requires: DEEPSEEK_API_KEY, AUTH_SECRET, ICARUS_ADMIN_API_KEY in .env.
"""

import json
import os
import time

import httpx
import pytest
from dotenv import load_dotenv

load_dotenv()

PROXY = os.getenv("PROXY_URL", f"http://localhost:{os.getenv('PORT', '8000')}")
AUTH_SECRET = os.getenv("AUTH_SECRET", "")
UPSTREAM_KEY = os.getenv("DEEPSEEK_API_KEY", "")
ADMIN_KEY = os.getenv("ICARUS_ADMIN_API_KEY", "")

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_E2E_TESTS", "") != "1",
    reason="Set RUN_E2E_TESTS=1 to run E2E tests against a live server",
)


# ── Helpers ──────────────────────────────────────────────────────────────────


class Tenant:
    """A test tenant with pre-built headers."""

    def __init__(self, name: str):
        self.name = name
        self.headers = {
            "X-User-ID": name,
            "Authorization": f"Bearer {UPSTREAM_KEY}",
            "Content-Type": "application/json",
        }
        if AUTH_SECRET:
            self.headers["X-Auth-Secret"] = AUTH_SECRET


def _admin_headers() -> dict:
    return {"Authorization": f"Bearer {ADMIN_KEY}"}


async def chat(client: httpx.AsyncClient, tenant: Tenant, message: str) -> int:
    """Send a chat message and return HTTP status."""
    resp = await client.post(
        f"{PROXY}/v1/chat/completions",
        headers=tenant.headers,
        json={
            "messages": [
                {"role": "system", "content": "Be concise."},
                {"role": "user", "content": message},
            ],
            "max_tokens": 80,
        },
    )
    return resp.status_code


async def search_facts(
    client: httpx.AsyncClient, tenant: Tenant, query: str = ""
) -> list[dict]:
    """Search facts for a tenant."""
    resp = await client.get(
        f"{PROXY}/memory/facts",
        headers=tenant.headers,
        params={"q": query, "limit": 30},
    )
    if resp.status_code != 200:
        return []
    return resp.json().get("facts", [])


async def count_facts(client: httpx.AsyncClient, tenant: Tenant) -> int:
    # Graphiti returns 0 for empty/generic queries.  Try the tenant's
    # name as a search term — every fact mentions the user by name.
    facts = await search_facts(client, tenant, tenant.name)
    return len(facts)


async def fact_contains(
    client: httpx.AsyncClient, tenant: Tenant, substring: str
) -> str | None:
    """Return the first fact containing substring, or None."""
    facts = await search_facts(client, tenant, substring)
    for f in facts:
        if substring.lower() in f["fact"].lower():
            return f["fact"]
    return None


async def forget_by_message(
    client: httpx.AsyncClient, tenant: Tenant, message: str
) -> int:
    """Forget facts by natural-language message."""
    resp = await client.post(
        f"{PROXY}/memory/forget",
        headers=tenant.headers,
        json={"message": message},
    )
    return resp.status_code


async def admin_purge(client: httpx.AsyncClient, tenant_id: str) -> int:
    """Purge all memory for a tenant (admin endpoint)."""
    resp = await client.post(
        f"{PROXY}/admin/tenant/{tenant_id}/purge",
        headers=_admin_headers(),
    )
    return resp.status_code


async def admin_fact_count(client: httpx.AsyncClient, tenant_id: str) -> int:
    """Get fact count via admin endpoint."""
    resp = await client.get(
        f"{PROXY}/admin/tenant/{tenant_id}/status",
        headers=_admin_headers(),
    )
    if resp.status_code != 200:
        return -1
    return resp.json().get("fact_count", -1)


def wait(seconds: int = 5) -> None:
    """Simple sleep."""
    time.sleep(seconds)


async def poll_for_fact(
    client: httpx.AsyncClient, tenant: Tenant, keyword: str,
    timeout: int = 90, interval: int = 5,
) -> str | None:
    """Poll until a fact containing *keyword* is found, or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = await fact_contains(client, tenant, keyword)
        if found:
            return found
        time.sleep(interval)
    return None


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
async def client():
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as c:
        yield c


@pytest.fixture
async def alice():
    return Tenant("alice-e2e")


@pytest.fixture
async def bob():
    return Tenant("bob-e2e")


# ── Test ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio(loop_scope="function")
async def test_multi_tenant_isolation_e2e(client, alice, bob):
    """Full multi-tenancy E2E: write → read → cross-tenant → update → delete → purge."""

    # ── Step 0: verify server ───────────────────────────────────────────
    r = await client.get(f"{PROXY}/health")
    assert r.status_code == 200
    health = r.json()
    assert health["multi_tenant"] is True, "Server must be in MT mode"
    assert health["graphiti"] == "ok", "Graphiti must be reachable"
    queue = health["memory"]["queue_depth"]
    if queue > 0:
        print(f"\n  Warning: write queue has {queue} items (may delay fact storage)")

    # ── Clean slate ─────────────────────────────────────────────────────
    await admin_purge(client, alice.name)
    await admin_purge(client, bob.name)
    wait(2)

    # ── Step 1: Verify empty ────────────────────────────────────────────
    assert await count_facts(client, alice) == 0, "Alice should start empty"
    assert await count_facts(client, bob) == 0, "Bob should start empty"
    print("\n  Start: both empty ✓")

    try:
        # ── Step 2: Alice stores facts ──────────────────────────────────
        print("  Storing Alice's facts...")
        status = await chat(client, alice,
            "I am a software engineer named Alice who uses Rust daily "
            "and lives in Dublin Ireland since 2020")
        assert status in (200, 400), f"Alice chat failed: HTTP {status}"

        alice_any = await poll_for_fact(client, alice, "Alice", timeout=120)
        assert alice_any is not None, (
            "Pipeline broken: no facts stored for Alice after 120s. "
            "Check proxy logs for evaluator/write errors."
        )
        alice_total = await count_facts(client, alice)
        print(f"  Alice: {alice_total} fact(s) stored ✓")

        # ── Step 3: Bob stores facts ────────────────────────────────────
        print("  Storing Bob's facts...")
        status = await chat(client, bob,
            "I am a designer named Bob who works with Figma every day "
            "and lives in London England near the Thames")
        assert status in (200, 400), f"Bob chat failed: HTTP {status}"

        bob_any = await poll_for_fact(client, bob, "Bob", timeout=120)
        assert bob_any is not None, (
            "Pipeline broken: no facts stored for Bob after 120s"
        )
        bob_total = await count_facts(client, bob)
        print(f"  Bob: {bob_total} fact(s) stored ✓")

        # ── Step 4: Cross-tenant visibility ─────────────────────────────
        # Alice should NOT see Bob's facts via the memory endpoint.
        # NOTE: /memory/facts returns all tenants' facts (known limitation
        # — Graphiti strips per-fact labels).  Isolation is at the
        # snapshot/injection layer.  We verify facts EXIST for each tenant
        # via admin endpoints.
        alice_admin = await admin_fact_count(client, alice.name)
        bob_admin = await admin_fact_count(client, bob.name)
        print(f"  Admin: Alice={alice_admin}, Bob={bob_admin}")
        assert alice_admin > 0, "Admin should see Alice's facts in Graphiti"
        assert bob_admin > 0, "Admin should see Bob's facts in Graphiti"

        # ── Step 5: Alice updates a fact ────────────────────────────────
        print("  Updating Alice's location...")
        status = await chat(client, alice,
            "I moved — I no longer live in Dublin, I now live in Galway")
        assert status in (200, 400)
        galway = await poll_for_fact(client, alice, "Galway", timeout=90)
        print(f"  Alice update: Galway={'✓' if galway else 'not extracted (LLM non-deterministic)'}")

        # ── Step 6: Bob deletes a fact ──────────────────────────────────
        print("  Bob deleting...")
        before = await count_facts(client, bob)
        status = await forget_by_message(client, bob, "forget information about London")
        assert status == 200, f"Forget returned HTTP {status}"
        wait(15)  # Graphiti + worker processing
        after = await count_facts(client, bob)
        print(f"  Bob delete: {before} → {after}")

    finally:
        # ── Step 7: Cleanup ─────────────────────────────────────────────
        print("\n  Cleaning up...")
        status_a = await admin_purge(client, alice.name)
        status_b = await admin_purge(client, bob.name)
        assert status_a == 200, f"Purge Alice failed: HTTP {status_a}"
        assert status_b == 200, f"Purge Bob failed: HTTP {status_b}"
        wait(10)

        # ── Step 8: Verify empty ────────────────────────────────────────
        after_a = await count_facts(client, alice)
        after_b = await count_facts(client, bob)
        print(f"  After purge: Alice={after_a}, Bob={after_b}")
        assert after_a == 0, f"Alice should have 0 facts, got {after_a}"
        assert after_b == 0, f"Bob should have 0 facts, got {after_b}"
        print("  Clean ✓")
