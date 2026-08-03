# Icarus Memory — Technical Design Document

**Status:** Draft  
**Date:** 2026-08-03  
**Author:** Alexander Trousevich & Claude

---

## Table of Contents

1. [Overview & Goals](#1-overview--goals)
2. [Architecture](#2-architecture)
3. [Infrastructure: Docker Compose & Neo4j](#3-infrastructure-docker-compose--neo4j)
4. [Graphiti Service: REST API Wrapper](#4-graphiti-service-rest-api-wrapper)
5. [Memory Manager: Core Logic in Icarus Proxy](#5-memory-manager-core-logic-in-icarus-proxy)
6. [Memory Extraction: LLM Evaluation Pipeline](#6-memory-extraction-llm-evaluation-pipeline)
7. [Deduplication Strategy](#7-deduplication-strategy)
8. [Memory Injection at Conversation Start](#8-memory-injection-at-conversation-start)
9. [Custom Entity & Relationship Types](#9-custom-entity--relationship-types)
10. [Configuration Reference](#10-configuration-reference)
11. [Logging & Observability](#11-logging--observability)
12. [Implementation Plan](#12-implementation-plan)
13. [Open Questions & Risks](#13-open-questions--risks)
14. [Appendix: Graphiti Internals Quick Reference](#14-appendix-graphiti-internals-quick-reference)

---

## 1. Overview & Goals

### Current State

Icarus injects a **static** `MEMORY_INJECTION` string into every `/v1/chat/completions` request. The string is hand-written in `.env` and never changes. There is no learning, no accumulation, and no structure.

### Target State

Replace static injection with a **dynamic, self-improving memory** built on [Graphiti](https://github.com/getzep/graphiti) — a temporal knowledge graph engine by Zep. Memory grows automatically: after every AI response, a cheap evaluator LLM decides what's worth remembering, deduplicates against existing facts, and pushes episodes into Graphiti. At conversation start, the full memory snapshot is queried once and injected as a system message, remaining frozen for the conversation lifetime.

### Design Principles

1. **Cheap extraction, rich retrieval.** Extraction uses deepseek-v4-flash (no thinking) to keep costs near zero. Retrieval at conversation start is a single Graphiti search — fast and comprehensive.
2. **Graph, not bag-of-facts.** Entities (user, projects, tools) are connected by typed relationships. Queries traverse the graph, not just keyword-match.
3. **Resource-frugal.** Neo4j heap/pagecache are pinned to 256–384 MB. Graphiti runs in the same Docker network but can be scaled independently.
4. **No duplicate facts.** A multi-layer dedup (hash filter → embedding similarity → Graphiti built-in) prevents bloat.
5. **Conversation-stable memory.** Memory is fetched once at dialog start and frozen — even if new facts are added mid-conversation, they won't perturb the current context.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Docker Network                             │
│                                                                   │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────┐      │
│  │  Neo4j   │   │   Graphiti   │   │  Icarus Proxy        │      │
│  │  :7687   │◄──│   Service    │◄──│  :8000                │      │
│  │  :7474   │   │   :8001      │   │                       │      │
│  │          │   │              │   │  ┌─────────────────┐  │      │
│  │  (graph  │   │  REST API:   │   │  │ Memory Manager  │  │      │
│  │   store) │   │  POST /ep    │   │  │                 │  │      │
│  │          │   │  GET /search │   │  │ - extractor     │  │      │
│  └──────────┘   │  GET /health │   │  │ - dedup filter  │  │      │
│                 └──────────────┘   │  │ - injector      │  │      │
│                                    │  └─────────────────┘  │      │
│                                    └──────────────────────┘      │
│                                              │                    │
│                                              ▼                    │
│                                    ┌──────────────────────┐      │
│                                    │  Upstream LLM API    │      │
│                                    │  (DeepSeek)          │      │
│                                    └──────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow: Write Path (after each AI response)

```
AI response arrives at Icarus
  │
  ▼
Memory Manager extracts conversation text from request/response pair
  │
  ▼
Evaluator LLM (deepseek-v4-flash, no thinking) judges:
  "Any facts worth remembering from the LAST message?"
  │
  ├── No → skip (cost: ~100 input tokens)
  │
  └── Yes → returns list of {fact, category, entities}
        │
        ▼
      Dedup Filter:
        1. Normalize + hash → check in-memory LRU cache
        2. Embedding similarity search against Graphiti
        3. If similarity > threshold → skip
        │
        ▼
      POST /episodes to Graphiti Service
        │
        ▼
      Graphiti: extract entities → resolve duplicates → extract edges
        → detect contradictions → persist to Neo4j
```

### Data Flow: Read Path (conversation start)

```
First user message arrives (new conversation)
  │
  ▼
Memory Manager queries Graphiti:
  GET /search?query=tell me everything about this user&limit=20
  GET /entities?type=Person,Preference,Project,Knowledge
  │
  ▼
Results assembled into a compact system message:
  "## User Memory (from previous conversations)\n
   - Alex is a senior software engineer\n
   - Alex prefers concise technical answers\n
   - Alex works on Icarus (a proxy for LLM APIs)\n
   ..."
  │
  ▼
Injected as system message into the messages array (after existing system messages)
  │
  ▼
Frozen for the entire conversation — even if new facts are added, this injection never updates mid-conversation
```

### Component Ownership

| Component | Language | Runtime | Location |
|---|---|---|---|
| Icarus Proxy | Python 3.12+ | uvicorn (local or Docker) | `src/icarus/` |
| Memory Manager | Python | Inside Icarus process | `src/icarus/memory.py` |
| Graphiti Service | Python 3.12+ | uvicorn (Docker) | `src/graphiti_service/` |
| Neo4j | Java | Docker | `neo4j:5.26` image |
| Evaluator LLM | — | HTTP → DeepSeek API | External |

---

## 3. Infrastructure: Docker Compose & Neo4j

### 3.1 docker-compose.yml Restructure

Use **Docker Compose profiles** so that `docker compose up -d` starts everything *except* icarus, and `docker compose --profile full up -d` starts all three.

```yaml
# docker-compose.yml
services:
  neo4j:
    image: neo4j:5.26
    ports:
      - "7474:7474"   # HTTP / Browser
      - "7687:7687"   # Bolt
    volumes:
      - neo4j_data:/data
      - neo4j_logs:/logs
    environment:
      - NEO4J_AUTH=neo4j/${NEO4J_PASSWORD:-password}
      # ── Memory constraints for small VPS ──
      - NEO4J_server_memory_heap_initial__size=256M
      - NEO4J_server_memory_heap_max__size=256M
      - NEO4J_server_memory_pagecache_size=256M
      # Disable things we don't need
      - NEO4J_dbms_security_procedures_unrestricted=apoc.*
      - NEO4J_server_metrics_enabled=false
      - NEO4J_dbms_usage__report_enabled=false
    healthcheck:
      test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "$${NEO4J_PASSWORD:-password}", "RETURN 1"]
      interval: 5s
      timeout: 10s
      retries: 30
      start_period: 10s
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M

  graphiti:
    build:
      context: .
      dockerfile: Dockerfile.graphiti
    ports:
      - "${GRAPHITI_PORT:-8001}:8001"
    environment:
      - NEO4J_URI=bolt://neo4j:7687
      - NEO4J_USER=neo4j
      - NEO4J_PASSWORD=${NEO4J_PASSWORD:-password}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - GRAPHITI_PORT=8001
      # Use a cheap model for extraction
      - EXTRACTOR_MODEL=${GRAPHITI_EXTRACTOR_MODEL:-gpt-4o-mini}
      - EMBEDDING_MODEL=${GRAPHITI_EMBEDDING_MODEL:-text-embedding-3-small}
    depends_on:
      neo4j:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M

  # Only started with: docker compose --profile full up
  icarus:
    profiles: ["full"]
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${PORT:-8000}:8000"
    env_file:
      - .env
    environment:
      - GRAPHITI_URL=http://graphiti:8001
    volumes:
      - ./logs:/app/logs
    depends_on:
      graphiti:
        condition: service_started
    restart: unless-stopped

volumes:
  neo4j_data:
  neo4j_logs:
```

### 3.2 ./script/server Modifications

When `./script/server` starts without Docker, it must:

1. Start `docker compose up -d` (neo4j + graphiti, **not** icarus due to profile)
2. Wait for both services to be healthy
3. Start the local icarus via uvicorn (pointing `GRAPHITI_URL=http://localhost:8001`)
4. On SIGTERM/SIGINT, stop local uvicorn but **leave Docker services running** (they may be shared)

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Ensure infra is running ──────────────────────────────────────────────
echo "=== Ensuring infrastructure is up ==="
docker compose up -d --wait 2>/dev/null || true

# If neo4j/graphiti aren't healthy yet, wait
echo "Waiting for Graphiti service..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${GRAPHITI_PORT:-8001}/health" > /dev/null 2>&1; then
    echo "Graphiti is ready."
    break
  fi
  sleep 1
done

# ── Load .env ────────────────────────────────────────────────────────────
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# ── Start local proxy ────────────────────────────────────────────────────
export GRAPHITI_URL="${GRAPHITI_URL:-http://localhost:8001}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

echo "=== Icarus Proxy (local) ==="
echo "Upstream:    ${UPSTREAM_BASE_URL:-https://api.deepseek.com}"
echo "Graphiti:    ${GRAPHITI_URL}"
echo "Listening:   http://${HOST}:${PORT}"
echo ""

exec uv run uvicorn icarus.proxy:app \
  --host "$HOST" --port "$PORT" --log-level "${LOG_LEVEL:-info}"
```

### 3.3 Neo4j Memory Analysis

Based on `neo4j-admin server memory-recommendation --memory=512m --docker`:

| Parameter | Value | Rationale |
|---|---|---|
| Heap initial | 256M | Must equal max to avoid resize thrash |
| Heap max | 256M | 50% of container limit; leaves room for pagecache + off-heap |
| Pagecache | 256M | Remaining memory after heap + OS overhead |
| Container limit | 512M | Docker `--memory` limit |
| Total on host | ~600M | Container + small Docker overhead |

For 10,000 nodes + 20,000 edges (estimated upper bound):

- **Node storage**: ~10,000 × (name + summary + attributes + embeddings) ≈ 10,000 × 5 KB = ~50 MB
- **Edge storage**: ~20,000 × (fact + attributes + embeddings) ≈ 20,000 × 3 KB = ~60 MB
- **Indexes**: vector index + fulltext + btree ≈ 30–50 MB
- **Total on disk**: ~150–200 MB
- **Working set in pagecache**: ~100 MB (hot data only)

**Verdict**: 256M heap + 256M pagecache is comfortable for our scale. If the graph grows beyond estimates, pagecache can be bumped to 384M with a 640M container limit.

---

## 4. Graphiti Service: REST API Wrapper

A thin FastAPI service wrapping `graphiti-core`. Lives in `src/graphiti_service/`.

### 4.1 Why Not the Graphiti MCP Server?

The official [Graphiti MCP Server](https://github.com/getzep/graphiti/tree/main/mcp_server) uses the MCP protocol (JSON-RPC over stdio/SSE). While functional, MCP adds protocol complexity, requires an MCP client library in Icarus, and makes direct `curl`-based debugging harder. A plain REST API is:

- **Simpler**: ~150 lines of Python, no protocol dependencies
- **Debuggable**: `curl localhost:8001/search?query=...` just works
- **Familiar**: Same FastAPI patterns as Icarus itself

### 4.2 API Endpoints

```
POST   /episodes          Add an episode for entity/edge extraction
GET    /search            Hybrid search (facts)
GET    /search/nodes      Search for entity nodes
GET    /entities/{name}   Get entity by name (fuzzy)
GET    /health            Health check + Neo4j connectivity
```

#### `POST /episodes`

```json
// Request
{
  "name": "conv-abc123-turn-5",
  "episode_body": "Alex prefers Rust over Python for systems programming but uses Python for AI work.",
  "source": "text",
  "reference_time": "2026-08-03T15:30:00Z",
  "group_id": "user-alex"
}

// Response 201
{
  "status": "ok",
  "episode_uuid": "uuid-here",
  "entities_extracted": 3,
  "edges_extracted": 2
}
```

#### `GET /search?query=...&limit=...&group_id=...`

```json
// GET /search?query=what does alex prefer&limit=5
// Response 200
{
  "results": [
    {
      "uuid": "edge-uuid",
      "fact": "Alex prefers concise technical answers",
      "source_node": "Alex",
      "target_node": "concise technical answers",
      "valid_at": "2026-08-03T15:30:00Z",
      "score": 0.95
    }
  ]
}
```

#### `GET /search/nodes?query=...&limit=...`

```json
// GET /search/nodes?query=alex&limit=5
// Response 200
{
  "nodes": [
    {
      "uuid": "node-uuid",
      "name": "Alex",
      "labels": ["Entity", "Person"],
      "summary": "Senior software engineer, user of the Icarus system",
      "attributes": {
        "occupation": "senior software engineer",
        "location": null
      }
    }
  ]
}
```

#### `GET /health`

```json
// Response 200
{
  "status": "ok",
  "neo4j": "connected",
  "graphiti_ready": true
}
```

### 4.3 Implementation Outline

```python
# src/graphiti_service/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from graphiti_core import Graphiti
from graphiti_core.nodes import EpisodeType
from datetime import datetime, timezone
import os

_graphiti: Graphiti | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _graphiti
    _graphiti = Graphiti(
        os.environ["NEO4J_URI"],
        os.environ["NEO4J_USER"],
        os.environ["NEO4J_PASSWORD"],
    )
    await _graphiti.build_indices_and_constraints()
    yield
    await _graphiti.close()


app = FastAPI(lifespan=lifespan)


@app.post("/episodes")
async def add_episode(req: EpisodeRequest):
    await _graphiti.add_episode(
        name=req.name,
        episode_body=req.episode_body,
        source=EpisodeType.text,
        source_description=req.get("source_description", "icarus-memory"),
        reference_time=req.reference_time or datetime.now(timezone.utc),
        group_id=req.group_id,
    )
    return {"status": "ok"}


@app.get("/search")
async def search(q: str, limit: int = 10, group_id: str | None = None):
    results = await _graphiti.search(query=q, num_results=limit)
    return {
        "results": [
            {
                "uuid": r.uuid,
                "fact": r.fact,
                "source_node_uuid": r.source_node_uuid,
                "target_node_uuid": r.target_node_uuid,
                "valid_at": r.valid_at.isoformat() if r.valid_at else None,
                "score": getattr(r, "score", None),
            }
            for r in results
        ]
    }
```

Required dependencies (`pyproject.toml` addition for the graphiti service):

```toml
graphiti-core>=0.5.0,<1.0.0
```

And a dedicated `Dockerfile.graphiti`:

```dockerfile
FROM python:3.12-slim

WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock* ./
# graphiti-core pulls neo4j driver, openai, pydantic, etc.
RUN uv sync --frozen --no-dev

COPY src/graphiti_service/ ./src/graphiti_service/

EXPOSE 8001
CMD ["uv", "run", "uvicorn", "graphiti_service.main:app", "--host", "0.0.0.0", "--port", "8001"]
```

---

## 5. Memory Manager: Core Logic in Icarus Proxy

### 5.1 Module Structure

New file: `src/icarus/memory.py`

```
src/icarus/
  __init__.py
  config.py        # + new memory config vars
  logger.py         # unchanged
  proxy.py          # + memory hooks (after response, before injection)
  memory.py         # NEW — all memory logic
```

### 5.2 MemoryManager Class

```python
# src/icarus/memory.py (pseudocode)

class MemoryManager:
    """Orchestrates memory extraction, dedup, storage, and injection."""

    def __init__(self, config: Config):
        self.graphiti_url = config.GRAPHITI_URL
        self.enabled = config.MEMORY_ENABLED
        self.dedup_cache = DedupFilter(max_size=1000)
        self._conversation_memory: str | None = None  # frozen per conversation
        self._http = httpx.AsyncClient(timeout=30.0)

    # ── Read path ──────────────────────────────────────────────────

    async def get_memory_for_conversation(self, user_id: str) -> str:
        """Fetch everything we know about the user. Called once per conversation."""
        if not self.enabled:
            return ""
        if self._conversation_memory is not None:
            return self._conversation_memory  # already frozen

        # Query 1: search for facts mentioning the user
        facts = await self._search(
            query=f"everything about user {user_id}",
            limit=20,
        )

        # Query 2: get entity summaries
        entities = await self._search_nodes(
            query=user_id,
            limit=10,
        )

        memory_text = self._format_memory_injection(facts, entities)
        self._conversation_memory = memory_text
        return memory_text

    # ── Write path ─────────────────────────────────────────────────

    async def maybe_remember(
        self,
        conversation: list[dict],  # full message history
        user_id: str,
        conversation_id: str,
    ) -> None:
        """Evaluate the conversation and push memorable facts to Graphiti."""
        if not self.enabled:
            return

        # Step 1: ask the cheap evaluator LLM
        candidates = await self._extract_facts(conversation)

        # Step 2: dedup against cache + Graphiti
        new_facts = await self._dedup(candidates)

        # Step 3: push episodes to Graphiti
        for fact in new_facts:
            await self._add_episode(
                name=f"{conversation_id}-{fact['hash']}",
                episode_body=fact["episode_text"],
                user_id=user_id,
            )
            self.dedup_cache.add(fact["hash"])

    # ── Helpers ────────────────────────────────────────────────────

    async def _extract_facts(self, conversation: list[dict]) -> list[dict]:
        """Call evaluator LLM to extract facts from the last message only."""
        ...

    async def _dedup(self, candidates: list[dict]) -> list[dict]:
        """Filter candidates: hash check → embedding similarity → Graphiti search."""
        ...

    async def _add_episode(self, name: str, episode_body: str, user_id: str) -> None:
        """POST to Graphiti service."""
        ...

    async def _search(self, query: str, limit: int = 10) -> list[dict]:
        """GET /search from Graphiti service."""
        ...

    async def _search_nodes(self, query: str, limit: int = 10) -> list[dict]:
        """GET /search/nodes from Graphiti service."""
        ...

    def _format_memory_injection(self, facts: list, entities: list) -> str:
        """Format facts + entities into a compact system message."""
        ...
```

### 5.3 Hook Points in proxy.py

The existing `proxy` function in `proxy.py` needs two hooks:

```python
# At module level (alongside `logger`)
from icarus.memory import MemoryManager
memory_manager = MemoryManager(config)


@app.api_route("/{path:path}", ...)
async def proxy(request: Request, path: str):
    ...
    # ── HOOK 1: Before forwarding request, inject memory ──
    # (replaces the static inject_memory)
    if path == "v1/chat/completions" and body:
        modified_body = await inject_dynamic_memory(
            body, memory_manager, request_id
        )
        injected = modified_body != body
    ...

    # ── HOOK 2: After response is received, evaluate for memory ──
    # This runs AFTER the response is sent to the client (fire-and-forget)
    # by scheduling it as a background task
    background_tasks.add(
        remember_from_response,
        body, response_body, memory_manager, request_id,
    )
```

### 5.4 Conversation Detection

A key challenge: Icarus is stateless — it proxies individual HTTP requests without sessions. We need to detect "conversation start" vs "continuation" for memory injection.

**Strategy: Use message count as a heuristic.**

If the incoming `messages` array has exactly 1 user message (or 1 user + 1 system), this is likely a new conversation → inject memory. If there are many messages, memory was already injected earlier in this conversation → skip.

```python
async def inject_dynamic_memory(body: bytes, mm: MemoryManager, rid: str) -> bytes:
    data = json.loads(body)
    messages = data.get("messages", [])

    # Heuristic: < 3 messages = new conversation
    # (system prompt + first user message = 2)
    if len(messages) <= 3:
        memory_text = await mm.get_memory_for_conversation(user_id="default")
        if memory_text:
            # Insert after last system message (same logic as current inject_memory)
            insert_at = 0
            for i, msg in enumerate(messages):
                if msg.get("role") == "system":
                    insert_at = i + 1
            messages.insert(insert_at, {"role": "system", "content": memory_text})
            data["messages"] = messages
    return json.dumps(data).encode("utf-8")
```

**Why not use session IDs?** Clients (Claude Code, Continue, etc.) don't consistently send session identifiers. The message-count heuristic is simple and works for the dominant use case: each new conversation starts fresh with a small message array.

### 5.5 Fire-and-Forget Memory Extraction

The memory write path must **not** block the response to the client. We use FastAPI's `BackgroundTasks`:

```python
from fastapi import BackgroundTasks

@app.api_route("/{path:path}", ...)
async def proxy(request: Request, path: str, background_tasks: BackgroundTasks):
    ...
    # After response is sent
    if path == "v1/chat/completions" and body:
        background_tasks.add(
            memory_manager.maybe_remember,
            conversation=build_conversation_snapshot(body, response_body),
            user_id="default",
            conversation_id=request_id,
        )
    ...
```

If `response_body` is not yet available (streaming), we capture it from the accumulated chunks in `_proxy_streaming` and trigger the background task there.

---

## 6. Memory Extraction: LLM Evaluation Pipeline

### 6.1 Evaluator LLM Choice

**Model:** `deepseek-chat` (deepseek-v4-flash — the cheapest DeepSeek model)  
**No thinking mode:** Set `thinking: {type: "disabled"}` in the API call  
**Cost estimate:** ~$0.14/M input tokens, ~$0.28/M output tokens. A typical evaluation prompt is ~2000 input tokens → ~$0.00028 per evaluation. Across 1000 conversations/day → $0.28/day.

### 6.2 Extraction Prompt

The prompt must be carefully tuned to:
- Only extract from the **last** message (assuming previous ones were already processed)
- Only extract **user-specific** facts (not general knowledge, not the AI's own statements)
- Return structured, granular facts suitable for graph storage
- Return empty array when nothing is worth remembering

```
You are a memory extraction system. Your job is to read the LAST message in a
conversation and identify factual information about the USER that is worth
remembering for future conversations.

PREVIOUS MESSAGES (already processed — do NOT extract from these):
{previous_messages}

LAST MESSAGE (extract facts from THIS ONE ONLY):
{last_message}

Extract only facts that are:
1. ABOUT THE USER — their preferences, knowledge, projects, tools, personal info,
   opinions, habits, constraints, or goals.
2. LIKELY TO BE USEFUL IN FUTURE CONVERSATIONS — not trivial, not temporary.
3. NOT ALREADY OBVIOUS from the context (e.g., "the user is asking a question"
   is not a fact worth remembering).

DO NOT extract:
- General knowledge or facts about the world
- The AI assistant's own statements or responses
- Questions the user asked (unless the question reveals something about them)
- Temporary or one-off information (e.g., "the user is currently debugging X"
  vs "the user works on project X")

For each fact, provide:
- "fact": A clear, standalone English sentence (e.g., "Alex prefers Rust for
  systems programming")
- "category": One of [preference, knowledge, project, tool, personal_info,
  constraint, goal, relationship]

Return a JSON object with a "facts" array:
{"facts": [{"fact": "...", "category": "..."}]}

If nothing is worth remembering, return: {"facts": []}
```

### 6.3 Example Extraction

**Input:**
```
User: I've been rewriting the auth service from Python to Rust.
The performance improvement is massive — from 200ms to 5ms p99.
I think we should use Rust for all new microservices going forward.
```

**Output:**
```json
{
  "facts": [
    {
      "fact": "Alex is rewriting the auth service from Python to Rust",
      "category": "project"
    },
    {
      "fact": "Alex observed a performance improvement from 200ms to 5ms p99 after rewriting in Rust",
      "category": "knowledge"
    },
    {
      "fact": "Alex prefers Rust over Python for new microservices",
      "category": "preference"
    }
  ]
}
```

### 6.4 API Call

```python
async def _extract_facts(self, conversation: list[dict]) -> list[dict]:
    """Call evaluator LLM to extract facts from the last message only."""
    if len(conversation) < 1:
        return []

    previous = conversation[:-1]
    last = conversation[-1]

    prompt = EXTRACTION_PROMPT.format(
        previous_messages=json.dumps(previous, indent=2),
        last_message=json.dumps(last, indent=2),
    )

    response = await self._http.post(
        f"{config.UPSTREAM_BASE_URL}/v1/chat/completions",
        headers={"Authorization": f"Bearer {config.UPSTREAM_API_KEY}"},
        json={
            "model": "deepseek-chat",  # deepseek-v4-flash
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
            "max_tokens": 500,
        },
    )

    data = response.json()
    content = data["choices"][0]["message"]["content"]
    result = json.loads(content)
    return result.get("facts", [])
```

### 6.5 Latency Budget

| Step | Expected Latency |
|---|---|
| Evaluator LLM call (deepseek-v4-flash, no thinking) | 200–500ms |
| Dedup search against Graphiti | 50–100ms |
| Graphiti add_episode (includes LLM extraction!) | 500–2000ms |
| **Total write path (fire-and-forget)** | **~1–3 seconds** |

The write path runs in the background after the response is sent, so users never wait for it.

---

## 7. Deduplication Strategy

### 7.1 Why We Need Pre-Dedup

Graphiti has built-in deduplication (3-tier for nodes: exact → fuzzy → LLM; contradiction detection for edges). However:

1. Each `add_episode` call triggers an **LLM extraction** (costs money). If we push near-duplicate content, we pay for extraction that produces no new facts.
2. The evaluator LLM might extract the same fact from slightly different phrasings across conversations.

A pre-filter saves money and keeps the graph clean.

### 7.2 Three-Layer Filter

```
Candidate fact from evaluator LLM
  │
  ▼
Layer 1: In-Memory Hash Cache
  - Normalize fact text (lowercase, strip punctuation, collapse whitespace)
  - SHA256 hash
  - Check LRU cache (max 1000 entries, TTL 24h)
  - If exact match → SKIP
  │
  ▼
Layer 2: Embedding Similarity
  - Compute embedding via OpenAI text-embedding-3-small
  - Cosine similarity against cached embeddings of recently added facts
  - If similarity > 0.92 → SKIP
  │
  ▼
Layer 3: Graphiti Search (semantic)
  - Search Graphiti for top-3 similar facts
  - If any result has score > 0.95 → SKIP
  │
  ▼
PASS → push episode to Graphiti
```

### 7.3 Implementation

```python
class DedupFilter:
    """Multi-layer deduplication to prevent fact bloat."""

    def __init__(self, max_size: int = 1000):
        self._hashes: dict[str, float] = {}  # hash → timestamp
        self._embeddings: list[tuple[list[float], str]] = []  # (embedding, hash)
        self._max_size = max_size

    def check_hash(self, fact: str) -> bool:
        """Return True if fact should be SKIPPED (already known)."""
        h = self._normalize_hash(fact)
        if h in self._hashes:
            return True
        return False

    def check_similarity(self, embedding: list[float], threshold: float = 0.92) -> bool:
        """Check cosine similarity against cached embeddings."""
        for cached_emb, _ in self._embeddings:
            if cosine_similarity(embedding, cached_emb) > threshold:
                return True
        return False

    def add(self, fact: str, embedding: list[float] | None = None):
        """Record a fact as seen."""
        h = self._normalize_hash(fact)
        self._hashes[h] = time.time()
        if embedding:
            self._embeddings.append((embedding, h))
        # Prune if over max_size
        if len(self._hashes) > self._max_size:
            self._prune()

    @staticmethod
    def _normalize_hash(text: str) -> str:
        import hashlib, re
        normalized = re.sub(r'\s+', ' ', text.strip().lower())
        normalized = re.sub(r'[^\w\s]', '', normalized)
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    def _prune(self):
        """Remove oldest entries to stay under max_size."""
        sorted_hashes = sorted(self._hashes.items(), key=lambda x: x[1])
        to_remove = len(self._hashes) - self._max_size
        for h, _ in sorted_hashes[:to_remove]:
            del self._hashes[h]
        self._embeddings = self._embeddings[-self._max_size:]
```

### 7.4 Cost-Benefit of Layer 2 vs Layer 3

| Layer | Latency | Cost | Catches |
|---|---|---|---|
| L1 (hash) | ~0ms | $0 | Exact duplicates |
| L2 (embedding) | ~50ms | $0.00002/call | Near-duplicates, rephrasing |
| L3 (Graphiti search) | ~100ms | $0 (just Neo4j I/O) | Semantic duplicates across different wording |

**Recommendation**: Always run L1. Run L2 only for facts that pass L1 and are non-trivial (len > 30 chars). Run L3 only if L2 is ambiguous (similarity 0.85–0.92).

---

## 8. Memory Injection at Conversation Start

### 8.1 Format

The injected memory should be **compact**, **structured**, and placed **after** the primary system prompt (so it augments rather than overrides it).

```markdown
## User Memory (from previous conversations)

### About the User
- Alex is a senior software engineer
- Alex prefers concise, technical answers with code examples
- Alex works primarily in Python, Rust, and TypeScript
- Alex is building Icarus, a proxy for LLM APIs with memory injection

### Current Projects
- Icarus: a transparent proxy for OpenAI-compatible APIs
- Auth service rewrite: Python → Rust (p99 latency: 200ms → 5ms)

### Preferences
- Prefers Rust for new microservices
- Prefers Python for AI/ML work
- Dislikes verbose documentation; prefers code examples
- Uses Neo4j for graph workloads

### Tools & Environment
- Runs code on a small VPS with limited RAM
- Uses DeepSeek as the primary LLM provider
- Uses Claude Code as the primary coding assistant

---
*This memory is from previous conversations and is frozen for this session.*
```

### 8.2 Formatting Logic

```python
def _format_memory_injection(
    self, facts: list[dict], entities: list[dict]
) -> str:
    """Format facts and entities into a compact, readable system message."""
    if not facts and not entities:
        return ""

    # Group facts by category
    by_category: dict[str, list[str]] = {}
    for f in facts:
        cat = f.get("category", "other")
        by_category.setdefault(cat, []).append(f" - {f['fact']}")

    lines = ["## User Memory (from previous conversations)", ""]

    category_labels = {
        "personal_info": "### About the User",
        "project": "### Current Projects",
        "preference": "### Preferences",
        "tool": "### Tools & Environment",
        "knowledge": "### Knowledge & Expertise",
        "constraint": "### Constraints",
        "goal": "### Goals",
    }

    for cat, label in category_labels.items():
        items = by_category.pop(cat, [])
        if items:
            lines.append(label)
            lines.extend(items)
            lines.append("")

    # Any uncategorized
    for cat, items in by_category.items():
        if items:
            lines.append(f"### {cat.replace('_', ' ').title()}")
            lines.extend(items)
            lines.append("")

    lines.append("---")
    lines.append("*This memory is from previous conversations and is frozen for this session.*")

    return "\n".join(lines)
```

### 8.3 Frozen Memory — Rationale

Once memory is injected at conversation start, it **never changes** for that conversation — even if new facts are added mid-conversation.

**Why:**

1. **Prompt cache stability.** Changing the system message mid-conversation would invalidate the prompt cache on every turn, negating the cache-safe design of Icarus.
2. **Consistency.** The AI's "knowledge about the user" should be stable within a conversation. Changing it mid-stream could produce jarring behavior ("Wait, you just learned that 2 messages ago...").
3. **Simplicity.** No need for a session store to track which facts were already injected.

New facts learned during a conversation will be available in the **next** conversation.

### 8.4 Alternative: Progressive Injection

An alternative design would inject **new** facts learned during the conversation into subsequent turns, without changing the initial injection. This is more complex (requires tracking which facts were already shown) and the benefit is marginal — within a single conversation, the AI already has the conversation itself as context. The frozen approach is the right tradeoff for v1.

---

## 9. Custom Entity & Relationship Types

### 9.1 Entity Types

Custom Pydantic models guide Graphiti's LLM extraction toward domain-specific entities:

```python
from pydantic import BaseModel, Field


class Person(BaseModel):
    """A person mentioned in conversations. Extract when the user talks about
    themselves or someone they know."""
    occupation: str | None = Field(None, description="Job title or profession")
    expertise: str | None = Field(None, description="Area of expertise (e.g., 'backend', 'ML')")


class Preference(BaseModel):
    """A preference or opinion the user holds. Extract when the user expresses
    liking, disliking, or preferring something."""
    strength: str | None = Field(None, description="How strongly held: 'strong', 'moderate', 'weak'")


class Project(BaseModel):
    """A project the user is working on or has worked on."""
    status: str | None = Field(None, description="active, completed, paused, planned")
    description: str | None = Field(None, description="Brief description of the project")


class Tool(BaseModel):
    """A tool, technology, library, or service the user uses or mentions."""
    category: str | None = Field(None, description="language, framework, database, service, editor, other")
    version: str | None = Field(None, description="Version or model if specified")


class Constraint(BaseModel):
    """A constraint or limitation the user operates under. Extract when the user
    mentions resource limits, requirements, or restrictions."""
    constraint_type: str | None = Field(None, description="e.g., 'memory', 'budget', 'time', 'compatibility'")


class Goal(BaseModel):
    """A goal the user has expressed, short-term or long-term."""
    timeframe: str | None = Field(None, description="short-term, medium-term, long-term")
    completed: bool = Field(False, description="Whether the goal has been achieved")


# Bundle for passing to Graphiti
MEMORY_ENTITY_TYPES = {
    "Person": Person,
    "Preference": Preference,
    "Project": Project,
    "Tool": Tool,
    "Constraint": Constraint,
    "Goal": Goal,
}
```

### 9.2 Relationship (Edge) Types

```python
class Prefers(BaseModel):
    """The user prefers one thing over another or has a stated preference."""

class WorksOn(BaseModel):
    """The user works on or contributes to a project."""

class Uses(BaseModel):
    """The user uses a tool, technology, or service."""

class Knows(BaseModel):
    """The user has knowledge or expertise in an area."""

class HasConstraint(BaseModel):
    """The user is operating under a constraint."""

class HasGoal(BaseModel):
    """The user has stated a goal."""

class CollaboratesWith(BaseModel):
    """The user collaborates with another person."""


MEMORY_EDGE_TYPES = {
    "PREFERS": Prefers,
    "WORKS_ON": WorksOn,
    "USES": Uses,
    "KNOWS": Knows,
    "HAS_CONSTRAINT": HasConstraint,
    "HAS_GOAL": HasGoal,
    "COLLABORATES_WITH": CollaboratesWith,
}
```

### 9.3 Edge Type Mapping

```python
MEMORY_EDGE_TYPE_MAP = {
    ("Person", "Preference"): ["PREFERS"],
    ("Person", "Project"): ["WORKS_ON"],
    ("Person", "Tool"): ["USES"],
    ("Person", "Person"): ["COLLABORATES_WITH"],
    ("Person", "Entity"): ["KNOWS", "HAS_GOAL"],
    ("Person", "Constraint"): ["HAS_CONSTRAINT"],
    # Fallback: any entity pair can have a generic RELATES_TO
}
```

### 9.4 Why Custom Types Matter

Without custom types, Graphiti extracts everything as generic "Entity" nodes with `RELATES_TO` edges. The knowledge graph becomes a flat bag of facts. Custom types enable:

- **Structured queries**: "Find all Preferences of Alex" → traverses `(Person)-[PREFERS]->(Preference)` edges
- **Better extraction**: The LLM is guided by type descriptions to extract domain-relevant detail
- **Temporal reasoning**: Graphiti's bi-temporal model tracks when facts changed (e.g., "Alex preferred Python in January, switched to Rust in March")

---

## 10. Configuration Reference

### 10.1 New Environment Variables

```bash
# .env additions

# ── Memory System ────────────────────────────────────────────────────────────
# Enable/disable the dynamic memory system entirely
MEMORY_ENABLED=true

# URL of the Graphiti REST service
GRAPHITI_URL=http://localhost:8001

# Model used for entity/edge extraction inside Graphiti
# Use a cheap model since extraction runs on every add_episode
GRAPHITI_EXTRACTOR_MODEL=gpt-4o-mini

# Embedding model used by Graphiti for vector search
GRAPHITI_EMBEDDING_MODEL=text-embedding-3-small

# Maximum facts to inject at conversation start
MEMORY_INJECTION_MAX_FACTS=20

# Minimum confidence threshold for evaluator LLM extraction (0.0–1.0)
MEMORY_EXTRACTION_CONFIDENCE=0.7

# Dedup: embedding similarity threshold above which facts are considered duplicates
MEMORY_DEDUP_SIMILARITY_THRESHOLD=0.92

# Dedup: size of in-memory hash cache
MEMORY_DEDUP_CACHE_SIZE=1000

# Neo4j credentials (for Docker Compose)
NEO4J_PASSWORD=password
```

### 10.2 Deprecated Configuration

When `MEMORY_ENABLED=true`, the static `MEMORY_INJECTION` env var is **ignored**. It can be removed from `.env` after migration.

### 10.3 Config Class Updates

```python
# src/icarus/config.py additions

class Config:
    # ... existing ...

    # Memory system
    MEMORY_ENABLED: bool = os.getenv("MEMORY_ENABLED", "true").lower() in ("1", "true", "yes")
    GRAPHITI_URL: str = os.getenv("GRAPHITI_URL", "http://localhost:8001")
    GRAPHITI_EXTRACTOR_MODEL: str = os.getenv("GRAPHITI_EXTRACTOR_MODEL", "gpt-4o-mini")
    GRAPHITI_EMBEDDING_MODEL: str = os.getenv("GRAPHITI_EMBEDDING_MODEL", "text-embedding-3-small")
    MEMORY_INJECTION_MAX_FACTS: int = int(os.getenv("MEMORY_INJECTION_MAX_FACTS", "20"))
    MEMORY_EXTRACTION_CONFIDENCE: float = float(os.getenv("MEMORY_EXTRACTION_CONFIDENCE", "0.7"))
    MEMORY_DEDUP_SIMILARITY_THRESHOLD: float = float(os.getenv("MEMORY_DEDUP_SIMILARITY_THRESHOLD", "0.92"))
    MEMORY_DEDUP_CACHE_SIZE: int = int(os.getenv("MEMORY_DEDUP_CACHE_SIZE", "1000"))
    NEO4J_PASSWORD: str = os.getenv("NEO4J_PASSWORD", "password")
```

---

## 11. Logging & Observability

### 11.1 Structured Log Events

Add to the existing structlog setup:

```python
# Memory-related log events

# When memory is injected
log.info("memory_injected", request_id=..., facts_count=..., injection_length=...)

# When evaluator returns facts
log.info("memory_extracted", request_id=..., candidates=..., duration_ms=...)

# When facts pass dedup
log.info("memory_deduped", request_id=..., before=..., after=..., filtered_out=...)

# When episode is pushed to Graphiti
log.info("memory_stored", request_id=..., episode_name=..., entities=..., edges=...)

# When Graphiti service is unreachable
log.error("graphiti_unreachable", request_id=..., error=..., url=...)
```

### 11.2 Health Endpoint Update

```python
@app.get("/health")
async def health():
    graphiti_ok = False
    try:
        resp = await http_client.get(f"{config.GRAPHITI_URL}/health")
        graphiti_ok = resp.status_code == 200
    except Exception:
        pass

    return {
        "status": "ok",
        "upstream": config.UPSTREAM_BASE_URL,
        "memory_enabled": config.MEMORY_ENABLED,
        "graphiti": "connected" if graphiti_ok else "unreachable",
    }
```

### 11.3 Monitoring Considerations

- **Graphiti extraction latency**: track p50/p95 of `add_episode` calls. If p95 exceeds 5s, consider switching to an even cheaper extractor model.
- **Dedup effectiveness**: track `before` vs `after` counts. If >50% of candidates are filtered, the evaluator prompt may be too loose.
- **Neo4j memory**: `docker stats neo4j` periodically. If heap usage consistently near 256M, bump to 384M.
- **Fact accumulation rate**: track `entities_extracted` + `edges_extracted` per episode. If each episode adds <1 entity on average, the evaluator prompt may be too strict or Graphiti's extractor model may be underpowered.

---

## 12. Implementation Plan

### Phase 1: Infrastructure (Day 1)

**Goal:** Graphiti service running in Docker, reachable from local icarus.

1. Create `Dockerfile.graphiti` — thin Python image with graphiti-core + FastAPI
2. Create `src/graphiti_service/main.py` — REST API wrapper with `/health`, `/episodes`, `/search`, `/search/nodes`
3. Update `docker-compose.yml` — add `neo4j` and `graphiti` services with profiles
4. Update `script/server` — `docker compose up -d --wait` + health check loop
5. Add `graphiti-core` to `pyproject.toml` optional dependencies
6. Test: `curl localhost:8001/health` returns `{"status": "ok", "neo4j": "connected"}`

**Deliverable:** `docker compose up -d` starts neo4j + graphiti. `./script/server` starts them + local proxy.

### Phase 2: Read Path (Day 1–2)

**Goal:** Dynamic memory injection replaces static `MEMORY_INJECTION`.

1. Implement `MemoryManager.get_memory_for_conversation()` — query Graphiti, format injection
2. Implement `inject_dynamic_memory()` — replace `inject_memory()` in proxy.py
3. Add conversation-start detection (message count heuristic)
4. Add `MEMORY_ENABLED` flag — when false, fall back to static `MEMORY_INJECTION`
5. Test: start a conversation, verify memory is injected as a system message

**Deliverable:** Memory is fetched from Graphiti and injected at conversation start.

### Phase 3: Write Path — Extraction (Day 2–3)

**Goal:** Evaluator LLM extracts facts after each AI response.

1. Implement extraction prompt (tune against real conversations)
2. Implement `_extract_facts()` — call DeepSeek API with structured output
3. Implement Fire-and-forget via `BackgroundTasks`
4. Handle streaming responses (capture response body, then trigger extraction)
5. Log extraction results
6. Test: send a message, verify evaluator returns facts (or empty array)

**Deliverable:** After each AI response, the evaluator runs and logs candidate facts.

### Phase 4: Write Path — Dedup & Storage (Day 3–4)

**Goal:** Deduplicated facts are pushed to Graphiti.

1. Implement `DedupFilter` — hash cache + embedding similarity
2. Implement `_dedup()` — L1 → L2 → L3
3. Implement `_add_episode()` — POST to Graphiti service
4. Wire up the full write path: extract → dedup → store
5. Integration test: run multiple conversations, verify no duplicate facts in Neo4j

**Deliverable:** Facts are extracted, deduplicated, and stored in the knowledge graph.

### Phase 5: Custom Types (Day 4)

**Goal:** Structured entity/edge types for richer memory.

1. Define custom entity types (Person, Preference, Project, Tool, etc.)
2. Define custom edge types and edge type map
3. Pass them to Graphiti via `add_episode(entity_types=..., edge_types=..., edge_type_map=...)`
4. Update search to filter by entity/edge types
5. Test extraction quality — verify Person/Preference/Project entities are created

**Deliverable:** The knowledge graph has typed entities and relationships, not just generic nodes.

### Phase 6: Polish & Edge Cases (Day 4–5)

1. **Error handling**: Graceful degradation when Graphiti is unreachable (skip memory, log warning, don't block requests)
2. **Neo4j backup/restore**: Document how to back up the Neo4j data volume
3. **Memory reset**: Add `MEMORY_RESET=true` env var that clears the graph on startup (for debugging)
4. **Testing**: Unit tests for DedupFilter, MemoryManager formatting, injection logic
5. **Documentation**: Update README with memory system overview

### Phase 7: Tuning (Ongoing)

1. Tune extraction prompt based on real conversations — too many false positives? Make it stricter. Too few facts? Loosen.
2. Tune dedup thresholds — too aggressive? Lower similarity threshold. Too many duplicates? Raise.
3. Tune injection format — is the system message too long? Shorten. Not informative enough? Add more detail.
4. Monitor Neo4j memory usage — bump heap/pagecache if near limits

---

## 13. Open Questions & Risks

### 13.1 Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Neo4j OOM on small VPS | Medium | High — graphiti becomes unavailable | Conservative heap/pagecache (256M each); Docker memory limit; monitoring |
| Graphiti extraction is too slow | Low | Medium — write path latency | Use gpt-4o-mini (cheap + fast); fire-and-forget so users don't wait |
| Evaluator LLM extracts too many facts | Medium | Low — cost, noise | Tuned prompt; confidence threshold; dedup filter catches noise |
| Evaluator LLM extracts too few facts | Medium | Medium — memory stays sparse | Prompt tuning; lower confidence threshold; manual review of extraction logs |
| Graphiti API changes (pre-1.0) | High | Medium — breaking changes | Pin `graphiti-core` version; our REST wrapper isolates us from most API churn |
| User ID ambiguity (multi-user proxy) | Low | Low — Icarus is single-user today | `group_id` parameter in Graphiti; can add user detection via API key or header later |
| Embedding costs add up | Low | Low — text-embedding-3-small is $0.02/1M tokens | Vector search is only for dedup L2 (~1 embedding per new fact, not per message) |

### 13.2 Open Questions

1. **Should we ever delete or expire old facts?** Graphiti's temporal model handles this — when a fact changes, old edges are invalidated rather than deleted. For facts that are just "stale" (e.g., a project that was completed), we might want explicit expiration. **Decision for v1**: No automatic expiration. Let the graph grow. Revisit when graph exceeds 10K edges.

2. **What about multi-user?** Icarus currently proxies for a single user. If it ever becomes multi-tenant, we'd use Graphiti's `group_id` for isolation. The `user_id` parameter in MemoryManager is already plumbed but hardcoded to `"default"`.

3. **Should memory injection include "recent conversations" summaries?** In addition to facts, we could inject a one-paragraph summary of the last conversation. This adds context ("last time we discussed X") that structured facts don't capture. **Decision**: Out of scope for v1. Can be added as a separate episode type.

4. **What if the evaluator LLM returns malformed JSON?** We use `response_format: {type: "json_object"}` on DeepSeek which guarantees valid JSON. But the schema might not match. **Mitigation**: Wrap in try/except; log and skip on parse failure.

5. **Should the evaluator prompt include the AI's response?** Yes — the user's message may contain facts, but the AI's response may also reveal things the user confirmed or elaborated on. Wait, actually — we only extract from the LAST message, which is typically the user's new message. The AI's response to the PREVIOUS user message was already processed in the previous turn. But what about the case where the AI's response contains something the user confirmed? The user's confirmation would be in the NEXT message they send. **Decision**: Extract from the last user message only. The AI's responses don't contain new information about the user.

---

## 14. Appendix: Graphiti Internals Quick Reference

### 14.1 Key Concepts

- **Episode**: A chunk of text (message, document, conversation) ingested into Graphiti. Contains raw content.
- **Entity (EntityNode)**: A node in the knowledge graph — a person, project, tool, concept. Has name, summary, attributes, labels.
- **Edge (EntityEdge)**: A relationship between two entities — a fact. Has `fact` (natural language), `valid_at`, `invalid_at`, `expired_at`.
- **Bi-temporal**: Every edge has `valid_at` (when the fact became true) and `invalid_at` (when it stopped being true). Old facts are invalidated, not deleted.
- **Hybrid Search**: Combines vector similarity (embedding), BM25 full-text, and graph traversal for retrieval.
- **Dedup**: Nodes are deduplicated at 3 tiers (exact, fuzzy, LLM). Edges are checked for contradictions.

### 14.2 Data Model (Simplified)

```
EntityNode
├── uuid: str
├── name: str           # e.g., "Alex", "Rust", "Icarus"
├── group_id: str       # tenant isolation
├── summary: str        # LLM-generated description
├── attributes: dict    # custom fields (occupation, version, etc.)
├── labels: list[str]   # ["Entity", "Person"]
└── name_embedding: list[float]

EntityEdge
├── uuid: str
├── source_node_uuid: str
├── target_node_uuid: str
├── name: str           # e.g., "PREFERS", "WORKS_ON"
├── fact: str           # "Alex prefers Rust for systems programming"
├── valid_at: datetime
├── invalid_at: datetime | None
├── expired_at: datetime | None
├── group_id: str
└── fact_embedding: list[float]
```

### 14.3 API Methods We Use

```python
# Initialize (once per process)
graphiti = Graphiti(neo4j_uri, neo4j_user, neo4j_password)
await graphiti.build_indices_and_constraints()

# Ingest
await graphiti.add_episode(
    name=str,                   # unique episode name
    episode_body=str,           # raw text
    source=EpisodeType.text,   # or .message, .json
    source_description=str,
    reference_time=datetime,
    group_id=str | None,
    entity_types=dict | None,  # custom Pydantic models
    edge_types=dict | None,    # custom edge definitions
    edge_type_map=dict | None, # allowed edge types per entity pair
)

# Search facts (edges)
results = await graphiti.search(
    query=str,
    num_results=int,            # default 10
    group_ids=[str] | None,
)

# Search nodes (entities)
from graphiti_core.search.search_config_recipes import NODE_HYBRID_SEARCH_RRF
results = await graphiti._search(
    query=str,
    config=NODE_HYBRID_SEARCH_RRF,
    group_ids=[str] | None,
)

# Cleanup
await graphiti.close()
```

### 14.4 Graphiti Version Constraints

- `graphiti-core` is pre-1.0. Pin to `>=0.5.0,<0.8.0` and test upgrades manually.
- Requires Neo4j 5.26+. The Docker Compose file uses `neo4j:5.26`.
- Requires Python 3.10+ (we use 3.12).
- Default LLM client is OpenAI. Can be overridden but we use the default (gpt-4o-mini for extraction, text-embedding-3-small for embeddings).

---

## Summary

This design replaces Icarus's static memory injection with a self-improving knowledge graph. The system is:

- **Cheap**: Extraction uses deepseek-v4-flash without thinking (~$0.0003/evaluation). Graphiti uses gpt-4o-mini for extraction (~$0.15/1M tokens).
- **Resource-aware**: Neo4j constrained to 256MB heap + 256MB pagecache (~512MB total container).
- **Simple**: Graphiti service is ~150 lines of FastAPI. Memory Manager is ~300 lines.
- **Graph-native**: Custom entity/edge types create a structured, queryable memory — not a flat bag of facts.

The phased implementation plan delivers value incrementally: infrastructure first, then read path (immediate benefit), then write path (learning), then structure (custom types), then polish.
