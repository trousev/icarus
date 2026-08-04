# Feature: Multi-Tenancy (User-Isolated Knowledge Graphs)

## Problem Statement
Icarus currently operates as a single-tenant proxy — all users share one Graphiti knowledge graph (`GRAPHITI_GROUP_ID`). When deployed inside LibreChat (which serves multiple users), everyone's memories leak into a single shared pool. User A's preferences, projects, and facts get injected into User B's conversations. This makes the memory system unusable in multi-user deployments.

## Goals
- Guaranteed memory isolation between different users
- Single Graphiti instance, separate graphs per user (via `group_id`)
- Integration with LibreChat's user identity forwarding
- Zero configuration per user — automatic graph creation on first use
- Backwards compatible — existing single-user deployments continue to work unchanged

## User Flow
1. LibreChat sends a chat completion request to Icarus with user identity in the request
2. Icarus extracts the user identity from the request
3. Icarus maps the user identity to a deterministic `group_id`
4. All Graphiti operations (read + write) use the user-specific `group_id`
5. Different users get completely separate memory injections
6. Memory management endpoints are scoped to the authenticated user

## Management Endpoint Design
- **User-scoped**: `/memory/facts`, `/memory/forget`, `/memory/purge` derive tenant from `X-User-ID` header. Users can only see/delete/purge their own memory.
- **Admin-scoped** (new): `GET /admin/tenants`, `GET/POST /admin/tenant/{group_id}/...` — require dedicated `ICARUS_ADMIN_API_KEY`. GDPR erasure path with audit trail.
- **Missing identity → 403** in multi-tenant mode. Never falls back to admin or legacy group.
- **`/health`** stays public; **`/memory/status`** becomes tenant-scoped.
- **Backwards compat**: No identity channel configured → legacy `GRAPHITI_GROUP_ID` behavior, all existing curls unchanged.

## Acceptance Tests (T1–T9)
| Test | Description | Verifies |
|------|-------------|----------|
| T1 | Read isolation | Bob's search returns 0 Alice facts |
| T2 | Write isolation | Alice's fact lands in `sha256("alice")[:16]`, not `default` |
| T3 | Forget isolation | Bob's "forget about Rust" leaves Alice's Rust facts intact |
| T4 | Purge isolation | Alice purges → her graph empty, Bob's intact; purge w/o identity → 403 |
| T5 | Impersonation guard | User key + forged header → 403; admin endpoints w/o admin key → 401 |
| T6 | Cache isolation | Same first message ("hi") from 2 users → different snapshots; dedup is tenant-scoped |
| T7 | Determinism | Same identity → same group across restarts |
| T8 | Backwards compat | No identity → legacy behavior; existing test suite passes |
| T9 | GDPR erasure | Admin erases Alice; provable deletion via audit log |

## Success Criteria
1. **Zero** cross-tenant facts returned, **zero** cross-tenant deletions (T1–T6), automated in CI
2. **100%** of destructive admin operations require admin key; **100%** of user operations are tenant-bound
3. **GDPR erasure**: one admin call, verified within 1 minute
4. **Zero-config provisioning**: new identity works on first request — no pre-provisioning
5. **Backwards compatible**: T8 green with zero config changes
6. **Silent hazards closed**: snapshot key = (tenant, message_hash); dedup cache keyed per tenant

## Target Users
- **Household members** (2-10 users): family self-hosting LibreChat + Icarus on a home server
- **Team members** (10-50 users): startup/small company running internal AI chat — GDPR applies
- **Multi-agent operators** (secondary): one human running multiple AI agents needing separate memory
- **Service operators** (future): single Icarus instance serving multiple external clients

## Business Context
- **Urgency**: In shared deployments, the memory feature is currently a liability — cross-user memory leakage makes it unsafe to enable. Multi-tenancy is a prerequisite for deploying Icarus in any multi-user context.
- **Why now**: The codebase already has the isolation seam (`group_id` on every Graphiti call); the work is plumbing, not a rewrite. Delaying means every shared deployment runs with `MEMORY_ENABLED=false`.
- **Constraint**: Single Graphiti instance, multiple graphs via `group_id`. No per-user provisioning — `group_id` is just a string derived from the user identity at request time.

## Identity Channel Decision
- **Primary**: `X-User-ID` HTTP header, populated by LibreChat's `{{LIBRECHAT_USER_ID}}` placeholder in custom endpoint config. Configurable via env var (default: `X-User-ID`).
- **Fallback**: Body `user` field — but only if it's NOT the LibreChat constant `"LibreChat_User_ID"` (which is LibreChat's default — useless for isolation).
- **Last resort**: Legacy `GRAPHITI_GROUP_ID` config value → single-tenant mode.
- **Precedence**: header → body (validated) → config default.
- **Group ID derivation**: `sha256(tenant_identity)[:16]` for pseudo-anonymization + deterministic mapping.
- **Topology requirement**: Identity is only trustworthy when Icarus is behind LibreChat. Direct exposure requires per-client API key mode (future).

## Key Risks (identified in product scoping)
- **~~Auth channel is undefined~~** → RESOLVED: `X-User-ID` header + `{{LIBRECHAT_USER_ID}}` placeholder
- **Conversation snapshot key collisions**: `conversation_key()` is a hash of first user message — "hi" from two different users produces the same key and leaks snapshots. Must become (tenant_id, message_hash)
- **Management endpoints are globally destructive**: `/memory/purge` and `/memory/forget` operate on the shared group — in multi-tenant mode, one user's purge wipes everyone
- **Silent constant collapse**: If we bet on body `user` field, all users hash to group `"LibreChat_User_ID"` → looks like multi-tenancy but is still shared-graph. Guard: validate body `user` is not the LibreChat constant before using it.

## Risk Assessment (Step 4)
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Chat path unauthenticated in MT mode → LAN attacker forges header | High | High | Add `_check_auth` gate on catch-all route in MT mode (reuses `UPSTREAM_API_KEY`). Startup warning when MT + no HMAC. |
| Cross-tenant delete via forged UUID or `clear_graph` | High | Critical | Verify-before-delete via `get_entity_edge` (group_id check). Replace `clear_graph` with enumerated verified deletion (`purge_tenant`). |
| Purge incomplete — SnapshotStore in-memory cache re-serves erased snapshots | Medium | High | `delete_prefix` sweeps `_cache` + records `purged_at`. Guard `get()` and `upsert()` to drop pre-purge entries. |
| LibreChat placeholder constant silently collapses all users | Low | Critical | `"LibreChat_User_ID"` is rejected at resolution (400). Never used as identity. |
| HMAC mode incompatible with LibreChat `{{LIBRECHAT_USER_ID}}` | Medium | Medium | HMAC is optional defense-in-depth for custom gateway deployments. Chat auth + network isolation cover the default case. |
| SnapshotStore SQLite ops unguarded → 500 on disk full | Low | Medium | Wrap `get`/`upsert` in try/except (inherited bug fix). Get returns None, upsert no-ops. |
| Single uvicorn worker assumption for JSONL append ordering | Low | Low | Document MT mode assumes 1 worker. Multi-worker note in deployment docs. |

## Final Review
- [x] Architecture is sound — ContextVar + explicit seams, two-mode state machine, server-side authenticated identity
- [x] Data model covers all use cases — TenantRegistry (JSONL), per-tenant SnapshotStore keys, lazy DedupFilter instances
- [x] Error states are handled — registry corruption (skip bad lines), disk full (catch OSError), Graphiti unreachable (graceful degradation), missing/invalid identity (401/400)
- [x] Security concerns addressed — chat path authenticated in MT mode (UPSTREAM_API_KEY gate), verify-before-delete for UUID deletes, HMAC optional defense-in-depth, admin key validated ≠ upstream key, `hmac.compare_digest` for auth
- [x] Performance considered — flat ~50ms L2 dedup per tenant, purge uses parallel batched deletes, admin inventory is zero-Graphiti
- [x] Testing strategy defined — T1-T9 acceptance tests, tenant_context() for ContextVar injection, table-driven state machine, per-test singleton isolation

## Known Limitations (v1)
- Entity nodes not enumerated during purge — residual at node/embedding level (M3). Post-purge search verification catches residual facts; node-level cleanup is v2.
- Purge for very large tenants (>10K facts) may exceed 1-minute GDPR time target due to serial MCP round trips. Batched parallel deletes mitigate but don't guarantee.
- Single uvicorn worker assumed for JSONL registry append ordering. Multi-worker deployments: documented, not enforced.
- Body `user` fallback is dead code when chat auth gate is active — kept for custom gateway deployments that bypass the gate.

## Pre-Implementation Verification Required
- [ ] Verify `get_entity_edge` response includes `group_id` field against actual `zepai/knowledge-graph-mcp` container (M2 fail-closed dependency)
- [ ] Verify `get_episodes` filters by `group_ids` parameter (M2 dependency)
- [ ] Verify `add_episode` accepts arbitrary ad-hoc group_ids without provisioning (determines whether "zero-config" holds)
- [ ] Spike: can `search_facts` be called with `include_invalid=true` or similar to enumerate invalidated facts during purge? (H1 mitigation)

## Conversation Transcript (Step 4 — Attack & Challenge)
**Challenge 2 (second adversarial pass): 8 remaining issues found**
**H1:** Purge enumeration via `search_facts` drops invalidated facts (memory.py:480 checks `invalid_at`/`expired_at`) — they can never be enumerated or deleted. **Fix:** Purge path must bypass client-side filtering OR use raw edge enumeration. Post-purge verification: search must return 0 facts, fail loudly otherwise.
**H2:** `_check_auth` with empty UPSTREAM_API_KEY produces expected value `"Bearer "` (trailing space) — trivially bypassable. MT mode broken for keyless upstreams (Ollama/vLLM). **Fix:** MT mode requires non-empty UPSTREAM_API_KEY at startup (fail-fast). Use `hmac.compare_digest` for auth comparison.
**H3:** SnapshotStore `purged_at` marker + cache sweep happens AFTER Graphiti purge — cache leak window is open for minutes during large purges. **Fix:** Set store marker + sweep cache BEFORE Graphiti-side purge. Store purged_at in persistent registry (survives restart).
**H4:** `WriteJob.reference_time` is enqueue time (after evaluator latency), not request time. Pre-erasure conversation can enqueue post-erasure. **Fix:** Capture `request_time` at middleware and thread into WriteJob. Use request_time for drop comparison, not enqueue time.
**M1:** Serial per-fact get+delete MCP calls won't meet "1-minute GDPR erasure" for large tenants. **Fix:** Batch parallel deletes + post-purge completeness verification pass.
**M2:** Verify-before-delete is fail-open if `get_entity_edge` response lacks `group_id`. **Fix:** Fail-closed: missing/unexpected group_id → refuse to delete.
**M3:** Entity nodes never enumerated — residual PII at node/embedding level. **Fix:** Document as known v1 limitation. Post-purge search verification catches residual facts.
**M4:** Crash mid-purge: orphan recovery re-adds purged tenant from snapshot rows. **Fix:** Maintenance skips tenants with purged_at set. Purge is idempotent/resumable.
**M5:** Admin key can equal upstream key (one .env file) → every chat client is admin. README says "any API key accepted" but fix #1 requires exact match. **Fix:** Startup validation: reject `ICARUS_ADMIN_API_KEY == UPSTREAM_API_KEY`. Document that LibreChat endpoint must send Icarus's UPSTREAM_API_KEY as its apiKey. Mention in README.
**Flaw 1:** Chat path has zero client authentication. Anyone on LAN can forge `X-User-ID`. HMAC fix incompatible with LibreChat. **Fix (b):** Add `_check_auth(request)` gate on catch-all `proxy()` route in MT mode — reuses existing `UPSTREAM_API_KEY`. Zero new config, zero LibreChat changes. Startup warning when MT + no HMAC.

**Flaw 2 (CRITICAL):** Verified against actual `zepai/knowledge-graph-mcp` source: `delete_entity_edge(uuid)` has no server-side group check (cross-tenant delete succeeds). `clear_graph` doesn't accept `group_id` — requires root-group auth + two-step confirmation and deletes ALL data. Plan's purge-by-clear_graph is WRONG. **Fix:** (A) verify-before-delete: `get_entity_edge` → check `edge["group_id"] == tenant.group_id` → `delete_entity_edge`. (B) `delete_episode`: add `get_episodes` tool, verify uuid ∈ tenant's episodes before delete. (C) Replace `clear_graph` with `purge_tenant(group_id)`: enumerates facts via `search_facts("", limit=<cap>)` + episodes via `get_episodes` → verified delete each → local state purge. Per-tenant purging works for arbitrary ad-hoc group_ids. `clear_graph` kept only as root-level admin tool.

**Flaw 3:** Purge sequence misses `SnapshotStore._cache` in-memory dict. Next continuation within cooldown re-serves + re-persists erased snapshot. **Fix:** `delete_prefix(prefix)` sweeps `_cache` + records `purged_at` timestamp. `get()` returns None for entries with `first_seen < purged_at`. `upsert()` drops writes where `first_seen < purged_at`.

## Conversation Transcript (Step 1)
**Q1: What deployment scenarios drive multi-tenancy? What happens if we don't build it?**
**Q9: Testing strategy, CLI changes, and migration path?**
**A9:** Testing: `tenant_context()` context manager for ContextVar injection in tests. Table-driven state machine tests using a `FakeRequest` with `.headers`. Replace module-level singletons (`_snapshot_store`, `_dedup_filter`) per test via `monkeypatch` — critical for T6 (snapshot isolation). T6 is the trickiest: drive `search_facts` with per-group canned responses, assert different snapshot texts for same opener from different tenants. CLI (`script/memory`): `--user <id>` flag + `ICARUS_USER_ID` env default. `status` split: `/health` stays public, `/memory/status` becomes tenant-scoped. New admin commands: `tenants` and `erase <group_id>` with `ICARUS_ADMIN_API_KEY` header. Migration: one-time idempotent UPDATE on snapshot keys (`key NOT LIKE '%:%'` → prefix with legacy group_id) in `_init_db`. Old facts under `default` group_id are invisible-but-present in MT mode — never auto-migrate. Fix: maintenance tenant enumeration query needs `rsplit(":", 1)` not `instr` (group_ids like `t:<hex>` contain colons).

**Q10: Error handling — Graphiti unreachable, registry corruption, cross-tenant collision, mode toggle, new log lines?**
**A10:** (1) Tenant resolution is pure-local — Graphiti unreachable during resolution is structurally impossible. Registry file failure: catch, log, continue in-memory. (2) Registry corruption: skip bad lines at load (per-line json.loads try/except), never fatal. Disk full: catch OSError, log error, keep operating. Fix inherited bug: SnapshotStore sqlite ops are unguarded — wrap in try/except so disk-full upsert doesn't 500 a chat request. (3) Cross-tenant collision confirmed fixed by tenant-prefixed keys. But: key format must be mode-conditional (bare hash in LEGACY, `{tenant}:{hash}` in MT) to preserve byte-identical backwards compat and existing snapshot rows. (4) Toggle never deletes data. LEGACY→MT: log prominent `tenant_mode_switch` warning — existing facts under legacy group_id are dormant, not leaked. MT→LEGACY: MT-prefixed rows become orphans → 7-day prune. (5) New log lines: `tenant_resolved` on every request (THE traceability line), `tenant_rejected` (canary for misconfig), `tenant_purge_started/completed`, `memory_write_dropped_purged`, `tenant_dedup_evicted`. Thread `group_id` through all existing write-path log lines.

**Q8: Exact signatures for Tenant, TenantMiddleware, MemoryClient, TenantRegistry, and current_tenant()?**
**A8:** New file `src/icarus/tenant.py` containing: `Tenant(id, group_id, via)` dataclass, `current_tenant()` → ContextVar reader (MT mode: RuntimeError if called outside request; LEGACY: falls back to GRAPHITI_GROUP_ID), `resolve_tenant(request)` → state machine (pure, testable), `TenantRegistry` (JSONL append-only, 7-field records, `record_seen`/`record_write`/`record_purge`/`is_purged_after`/`merge_orphans`), `tenant_context()` context manager for tests. `src/icarus/proxy.py`: `TenantMiddleware` (registered via `app.add_middleware`), `/health` and `/admin/*` exempt from middleware, `get_current_tenant()` FastAPI dependency, `require_admin` dependency gate. `MemoryClient` 4 methods gain optional `group_id: str | None = None` parameter — resolves to `current_tenant().group_id` when None. `_write_loop` passes `job.group_id` explicitly; `extract_and_store` captures tenant at entry. `DedupFilter` registry: `_get_dedup_filter(group_id)` with lazy creation + LRU eviction; `_drop_dedup_filter(group_id)` for admin purge. `SnapshotStore.delete_prefix(prefix)` for purge. Full purge sequence: `record_purge` → `is_purged_after` (worker drops) → `clear_graph` → `delete_prefix` → `_drop_dedup_filter`. 401 vs 403: chat path gets 401; management path gets 403 (API key authenticated but no tenant). HMAC wire format: `{id}.{sig}` where sig = HMAC-SHA256(secret, id) hex[:32].
**A6:** Tenant enumeration from tenant registry (JSONL, activates existing `MEMORY_REGISTRY_FILE` config), NOT from snapshot table (under-counts, 7-day eviction). Stale tenants: skip-if-idle > `MEMORY_MAINTENANCE_MAX_STALE_HOURS` (36h, activates dead config). Never auto-delete — retention is operator policy. Admin inventory (`GET /admin/tenants`): local data only, zero Graphiti round trips. Admin mutations vs write worker: per-tenant `purged_at` marker — worker drops queued jobs where `job.group_id == purged_group AND job.reference_time < purged_at`. Full purge sequence: mark purged_at → drop queued jobs → clear_graph → delete snapshot rows → drop DedupFilter instance → audit record. This is the correctness-critical sequence — otherwise byte-identical injection cache keeps serving erased snapshots.

**Q7: What new config/env vars? How does the FastAPI dependency resolve tenants? Single-tenant vs multi-tenant mode?**
**A7:** Five new env vars: `MEMORY_MULTI_TENANT` (mode switch, default false), `MEMORY_TENANT_HEADER` (header name, default X-User-ID), `MEMORY_TENANT_HMAC_SECRET` (optional HMAC for header auth), `MEMORY_BODY_USER_FALLBACK` (body fallback gate, default false), `ICARUS_ADMIN_API_KEY` (admin key, empty → admin routes 404). Architecture: middleware (authoritative resolver, sets ContextVar once per request) + FastAPI dependency (typed consumer, validates ContextVar is set). Auth and tenant are orthogonal: management endpoints use `Depends(get_current_tenant)` + `Depends(require_operator)`; admin endpoints use `Depends(require_admin)` + explicit group_id. Two-mode state machine: LEGACY (header absent → use GRAPHITI_GROUP_ID, header present → ignore with warning) vs MULTI_TENANT (header absent → 401, never falls back to legacy group). The invariant: in MT mode there is NO path to `config.GRAPHITI_GROUP_ID`. Asyncio gotchas: write worker must not read ContextVar (created at startup); `asyncio.create_task` copies context for extraction task as convenience, but WriteJob.group_id is the authority.

**Q5: How do we partition SnapshotStore and DedupFilter per tenant? Does tenant-prefixing change cooldown logic?**
**A5:** SnapshotStore key = `{tenant}:{content_hash}` — cooldown untouched, just narrows collision domain to same-user-same-opener (fixes cross-user leak where "hi" collides globally). DedupFilter: lazy per-tenant instances (not tagged entries) — tagged entries would still suppress cross-tenant facts (B's "I use Linux" silently dropped because A already has it). Per-tenant L2 scan latency is flat ~50ms regardless of tenant count. Memory: L1 ~0.2 MB/tenant, L2 ~6 MB/tenant (float32). LRU eviction: idle >24h, cap 500 tenants. Tenant churn: losing dedup cache is harmless (Graphiti's own ingest dedup catches it). Both keyed off same `current_tenant()` resolution so key prefix, dedup registry, and Graphiti group_id can never diverge.

**Q4: What's the right architecture for threading tenant identity through the codebase?**
**A4:** Approach (c): `ContextVar` for the request chain + explicit `group_id` at three boundaries. Reasoning: the codebase has two async topologies. Topology 1 (request chain): proxy → inject → memory_for_request → build_snapshot → search_facts — one coroutine tree per request, `asyncio.create_task` copies ContextVar into fire-and-forget extraction. Topology 2 (long-lived tasks): `_write_loop` and `MaintenanceWorker._loop` — ContextVar is invisible here, so `group_id` must be explicit from the job/enumeration. Per-tenant MemoryClient instances (option b) multiplies MCP sessions per user — wrong for this codebase. Parameter-through-everything (option a) is ceremony where tenant is constant, and still insufficient at the long-lived boundaries. Explicit seams: (1) write worker uses `job.group_id` (field already exists), (2) maintenance loops tenants explicitly, (3) admin endpoints take explicit group_id — never from ContextVar.

## Technical Design

### Architecture Decision: ContextVar + Explicit Seams
- **Middleware**: `TenantMiddleware` — authoritative resolver, runs once per request, sets ContextVar, fail-closes on bad identity
- **Dependency**: `get_current_tenant` — typed consumer, validates ContextVar is set, returns `Tenant(id, group_id, via)`
- **Request chain** (read path): `current_tenant()` helper reads ContextVar, falls back to `config.GRAPHITI_GROUP_ID`
- **Write worker**: explicit `job.group_id` passed to `add_memory()` — field already exists on `WriteJob`
- **Maintenance worker**: enumerate tenants from tenant registry (JSONL), run per-tenant
- **Admin endpoints**: `Depends(require_admin)` + explicit `group_id` from params, NOT ContextVar
- **SnapshotStore**: key = `f"{tenant}:{content_hash}"` (PK stays TEXT, no migration needed)
- **DedupFilter**: lazy per-tenant instances with LRU eviction (24h idle / 500 cap)
- **Single MemoryClient singleton**: 4 x `self._group_id` → `current_tenant()`; MCP call sites accept optional `group_id` param
- **Backwards compat**: `MEMORY_MULTI_TENANT=false` → byte-identical to today

### New Configuration
| Var | Default | Purpose |
|-----|---------|---------|
| `MEMORY_MULTI_TENANT` | `false` | Mode switch. `false` = today's behavior exactly |
| `MEMORY_TENANT_HEADER` | `X-User-ID` | Name of the identity header |
| `MEMORY_TENANT_HMAC_SECRET` | `""` | Optional HMAC-SHA256 for signed headers |
| `MEMORY_BODY_USER_FALLBACK` | `false` | Allow `body["user"]` fallback (constant rejected) |
| `ICARUS_ADMIN_API_KEY` | `""` | Admin key. Empty → admin routes 404 |

### Tenant Resolution State Machine
| Mode | Header | Result |
|------|--------|--------|
| LEGACY | absent | `Tenant(group_id=GRAPHITI_GROUP_ID, via="legacy_default")` |
| LEGACY | present | Same legacy tenant, `via="legacy_header_ignored"`, warning log |
| MT | absent | Phase 2 (body fallback if enabled + chat route), else 401 |
| MT | present, empty/whitespace/>128 chars | 400 (malformed) |
| MT | present, `"LibreChat_User_ID"` | 400 (placeholder constant rejected) |
| MT | present, HMAC mismatch | 401 (unverifiable) |
| MT | present, valid | `Tenant(id, "t:"+sha256(id)[:16], via="header")` |

**Invariant**: In MT mode there is NO path to `config.GRAPHITI_GROUP_ID`. Absence is an error, not a fallback.

### Data Model

#### Tenant Registry (new, activates existing `MEMORY_REGISTRY_FILE` config)
- **Format**: Append-only JSONL file at `data/memory_registry.jsonl`
- **Schema per record**: `{group_id, identity_hash, first_seen, last_seen, last_write, purged_at, event_type}`
- **Writes at**: (1) request-entry tenant resolution, (2) write enqueue, (3) admin purge
- **Startup**: Load into in-memory dict; merge snapshot-table tenants as orphans (recovery from lost registry)
- **Doubles as**: GDPR audit ledger for T9 erasure verification

#### SnapshotStore Changes
- Key: `{resolved_tenant}:{content_hash}` (was: `{content_hash}`)
- No schema migration needed (TEXT PK)
- Cooldown logic unchanged, now per-tenant
- Maintenance: enumerate via `key.rsplit(":", 1)[0]` (group_ids like `t:<hex>` contain colons; `rsplit` grabs the tenant prefix). Skip keys with no colon (legacy rows in MT mode).

#### DedupFilter Changes
- Module-level registry: `dict[group_id, DedupFilter]` with lazy `get_or_create`
- LRU eviction: idle > 24h, cap 500 tenants
- L2 embeddings: float32 (was Python float list) — ~6 MB/tenant at capacity
- On admin purge: drop entire per-tenant DedupFilter instance

#### WriteJob Changes
- `group_id` field already exists (memory.py:68) — now used by `_write_loop`
- Worker drops jobs where `job.group_id == purged_group AND job.reference_time < purged_at`

#### MaintenanceWorker Changes
- Enumerate tenants from registry (primary) + snapshot table (orphan recovery)
- Per-tenant sweep: pass explicit `group_id` to search/delete
- Skip tenants idle > `MEMORY_MAINTENANCE_MAX_STALE_HOURS` (36h, activates dead config)
- Never auto-delete graphs — retention is operator policy
**A3:** Users get full destructive power over their own graph and none over anyone else's. Missing tenant identity → 403 (never admin, never fallback). Dedicated `ICARUS_ADMIN_API_KEY` for admin surface (`/admin/tenants`, `/admin/tenant/{group_id}/...`). The upstream chat key is NOT the admin key. 9 acceptance tests (T1–T9): read/write/forget/purge isolation, impersonation guard, cache isolation (snapshot key + dedup), determinism, backwards compat, GDPR erasure. New silent hazard identified: the module-level `_dedup_filter` singleton suppresses Bob's fact because Alice said it first — must also be tenant-scoped.

**Q2: How does user identity reach Icarus from LibreChat? Which mechanism do we bet on?**
**A2:** Primary bet: `X-User-ID` HTTP header populated via LibreChat's `{{LIBRECHAT_USER_ID}}` placeholder — the only documented channel carrying the real authenticated user ID. LibreChat's body `user` field defaults to literal constant `"LibreChat_User_ID"` (not a real ID, not configurable per-user, not sent by agents). Precedence: header → body (rejected if constant) → legacy `GRAPHITI_GROUP_ID`. Group ID = `sha256(tenant_id)[:16]` for pseudo-anonymization. Failure mode if we guess wrong: silent constant collapse (everyone → "LibreChat_User_ID" → shared graph while appearing multi-tenant — the catastrophic failure). Guard: validate body `user` against the known LibreChat constant.

**Q8: Exact signatures for Tenant, TenantMiddleware, MemoryClient, TenantRegistry, and current_tenant()?**: (1) family/household — most common, (2) internal team — GDPR risk, makes this a legal requirement, (3) shared infrastructure operator — business requirement, (4) power user with multiple personas — nice side benefit. If not built: cross-user memory leakage (facts injected into wrong prompts), cross-user deletion (one user's "forget" removes another's facts), capacity exhaustion (global caps shared N ways, oldest-first eviction is unfair), snapshot key collisions (same first message → same key → cross-user snapshot leak), graph model breakdown (contradictory facts about "the user" entity). **The memory feature is a liability in shared deployments — only safe with `MEMORY_ENABLED=false`.** Graphiti already supports per-group_id isolation, so the work is plumbing the group_id through Icarus's read path, write path, snapshot store, dedup cache, and management endpoints.
