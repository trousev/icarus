# Icarus

Transparent proxy for OpenAI-compatible APIs with dynamic memory injection powered by a temporal knowledge graph.

## Quick Start

```bash
./script/setup    # Install dependencies, create .env
./script/update   # Sync dependencies
./script/server   # Start the proxy (+ background infrastructure)
```

## Configuration

Copy `.env.example` to `.env` and edit:

- `UPSTREAM_BASE_URL` — upstream OpenAI-compatible API (default: DeepSeek)
- `UPSTREAM_API_KEY` — API key forwarded to upstream
- `MEMORY_INJECTION` — static memory text (used as fallback when dynamic memory is disabled)
- `MEMORY_ENABLED` — enable dynamic memory via Graphiti knowledge graph (default: false)
- `HOST` / `PORT` — proxy listen address
- `OPENAI_API_KEY` — OpenAI API key (required for embeddings when MEMORY_ENABLED=true)

## Dynamic Memory (Graphiti)

When `MEMORY_ENABLED=true`, Icarus uses a temporal knowledge graph to remember facts about you across conversations.

### Architecture

```
Claude / chat UI / scripts
  │
  ▼
Icarus Proxy (localhost:8000)
  │  ▲
  │  └── read path: query graph → inject memory (frozen per conversation)
  │
  └── write path: evaluator LLM → dedup → store facts (fire-and-forget)
  │
  ▼
Graphiti MCP Server (localhost:8001, FalkorDB inside)
```

### How It Works

**Read path** — at conversation start, Icarus queries the knowledge graph with your first message as context. The results are injected as a system message and frozen for the entire conversation (never changes mid-conversation, preserving prompt cache).

**Write path** — after each response, a cheap evaluator LLM (deepseek-v4-flash, no thinking) checks the last user message for memorable facts. Extracted facts go through a 3-layer deduplication filter before being stored in the knowledge graph. This runs entirely in the background — you never wait for it.

**Lifecycle** — a maintenance worker prunes dead edges daily. Oldest facts are evicted when the graph exceeds configurable entity/edge caps.

### Memory Management

```bash
script/memory status           # Health + counters
script/memory search "rust"    # Search stored facts
script/memory forget <uuid>    # Delete a fact
script/memory purge            # Wipe all memory
```

Or via HTTP API (requires `Authorization: Bearer $UPSTREAM_API_KEY`):

```bash
curl -H "Authorization: Bearer sk-..." http://localhost:8000/memory/status
curl -H "Authorization: Bearer sk-..." "http://localhost:8000/memory/facts?q=rust"
curl -X POST -H "Authorization: Bearer sk-..." \
  -d '{"fact_uuid": "..."}' http://localhost:8000/memory/forget
```

### Disabling

Set `MEMORY_ENABLED=false` (or omit it) to fall back to static `MEMORY_INJECTION`.

## How It Works (core proxy)

The proxy intercepts `/v1/chat/completions` requests, parses the messages array, and injects a second system message (after any existing system message) containing the configured memory text. This simulates cache-safe memory injection without breaking the prompt structure.

Any API key is accepted by the proxy — authentication is passed through to the upstream service.

## Docker

```bash
docker compose up -d                # Start infrastructure (graphiti)
docker compose --profile full up -d # Start everything (graphiti + icarus)
```

## Logging

Requests and responses are logged to `./logs/` for debugging.
