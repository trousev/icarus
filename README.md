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
script/memory status                        # Health + counters
script/memory search "rust"                 # Search stored facts
script/memory forget <uuid>                 # Delete a fact
script/memory --user alice search "rust"    # Multi-tenant: search as user 'alice'
script/memory --admin tenants               # Admin: list all tenants
script/memory --admin erase t:<group_id>    # Admin: GDPR erasure
script/memory purge                         # Wipe all memory for current user
```

Or via HTTP API (requires `Authorization: Bearer $UPSTREAM_API_KEY`; multi-tenant adds `X-User-ID` header):

```bash
# Single-tenant / legacy mode
curl -H "Authorization: Bearer sk-..." http://localhost:8000/memory/status
curl -H "Authorization: Bearer sk-..." "http://localhost:8000/memory/facts?q=rust"
curl -X POST -H "Authorization: Bearer sk-..." \
  -d '{"fact_uuid": "..."}' http://localhost:8000/memory/forget

# Multi-tenant mode
curl -H "Authorization: Bearer sk-..." -H "X-User-ID: alice" \
  http://localhost:8000/memory/status
```

### Disabling

Set `MEMORY_ENABLED=false` (or omit it) to fall back to static `MEMORY_INJECTION`.

## How It Works (core proxy)

The proxy intercepts `/v1/chat/completions` requests, parses the messages array, and injects a second system message (after any existing system message) containing the configured memory text. This simulates cache-safe memory injection without breaking the prompt structure.

Any API key is accepted by the proxy in single-user mode. In multi-tenant mode the proxy requires the configured `UPSTREAM_API_KEY`.

## Multi-Tenancy (User-Isolated Memory)

When `MEMORY_MULTI_TENANT=true`, Icarus isolates memory per user using Graphiti's `group_id` namespacing. Each user gets their own knowledge graph — facts, preferences, and projects are never shared between users.

### How It Works

1. LibreChat sends the user identity via the `X-User-ID` header (configured with `{{LIBRECHAT_USER_ID}}` placeholder)
2. Icarus maps the identity to a deterministic `group_id` = `sha256(identity)[:16]`
3. All Graphiti operations (read + write) use the user-specific `group_id`
4. Memory management endpoints are scoped to the requesting user

### Configuration

```bash
MEMORY_MULTI_TENANT=true           # Enable multi-tenant mode
MEMORY_TENANT_HEADER=X-User-ID     # Identity header name (default)
ICARUS_ADMIN_API_KEY=sk-admin-...  # Admin key for GDPR erasure (must differ from UPSTREAM_API_KEY)
```

### LibreChat Integration

Add Icarus as a custom endpoint in `librechat.yaml`:

```yaml
endpoints:
  custom:
    - name: "Icarus"
      baseURL: "http://icarus:8000/v1"
      apiKey: "${ICARUS_UPSTREAM_KEY}"
      headers:
        X-User-ID: "{{LIBRECHAT_USER_ID}}"
      models:
        default: ["deepseek-v4-flash"]
```

### Security

- In MT mode the chat path requires `UPSTREAM_API_KEY` — only trusted clients can reach the memory system.
- The admin key for GDPR operations (`ICARUS_ADMIN_API_KEY`) must differ from the upstream key.
- Optional HMAC-SHA256 header signing (`MEMORY_TENANT_HMAC_SECRET`) provides defense-in-depth when Icarus sits behind a custom gateway.
- **Network isolation**: Icarus should only be reachable by LibreChat. Direct LAN exposure without HMAC allows header forgery.

### Admin Endpoints

```bash
# List all tenants (requires ICARUS_ADMIN_API_KEY)
curl -H "Authorization: Bearer $ICARUS_ADMIN_API_KEY" \
  http://localhost:8000/admin/tenants

# GDPR erasure — purge all memory for a tenant
curl -X POST -H "Authorization: Bearer $ICARUS_ADMIN_API_KEY" \
  http://localhost:8000/admin/tenant/t:3f2a9c1e8b47d602/purge
```

## Docker

```bash
docker compose up -d                # Start infrastructure (graphiti)
docker compose --profile full up -d # Start everything (graphiti + icarus)
```

## Logging

Requests and responses are logged to `./logs/` for debugging.
