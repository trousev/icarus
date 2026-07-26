# Feature: OpenAI-Compatible Agent SDK Wrapper (icarus)

## Problem Statement

The user has an OpenAI-compatible chat UI web panel that they prefer over ChatGPT's interface. However, this chat UI only sends prompts to an LLM API and gets text back — it has no agency, no tool use, no filesystem access. Meanwhile, coding agents like Claude Code (via the Agent SDK) and OpenCode are super-optimized harnesses that can read code, execute commands, edit files, and iterate — but they run in a terminal with no web UI.

**The gap:** The chat UI is a beautiful frontend with no backend horsepower; the coding agent is a beast with no good frontend. icarus bridges this gap by wrapping a coding agent behind an OpenAI-compatible API, so any OpenAI-compatible chat UI can use a real coding agent as its backend.

## Goals

- **Primary:** Expose a coding agent (Agent SDK or OpenCode) as an OpenAI-compatible API endpoint (`/v1/chat/completions` or `/v1/responses`)
- **Secondary:** Support DeepSeek as the underlying model (via Anthropic-compatible endpoint) to keep costs manageable — no Opus dependency
- **Tertiary:** Streaming SSE responses that look identical to OpenAI's format, so chat UIs work without modification

## User Flow

1. **Setup (one time):** Start the icarus server from within a project directory. The server launches a coding agent backend, configured with DeepSeek credentials from the environment.
2. **Configure chat UI (one time):** Add a custom provider in the chat UI pointing to `http://localhost:9090/v1` with model name `icarus-agent`.
3. **Daily use:** Type a prompt in the chat UI → icarus receives it as an OpenAI-format request → translates to agent prompt → agent reads files, runs commands, edits code, iterates → icarus streams results back as SSE chunks → chat UI displays tokens just like it would from OpenAI.
4. **The result:** The chat UI shows the conversation normally, but the answer is grounded in real code changes the agent made, tested, and verified.

## Success Metrics (Acceptance Criteria)

1. **End-to-end natural language task:** "Add a logger to main.py" → agent reads the file, edits it, reports "Done: added logger at line 42" → chat UI displays the result. No manual tool execution by the user.
2. **SSE streaming:** Agent actions (searching, reading files, thinking, writing) appear as progressively appearing text in the chat UI. No 30-second silence then a dump.
3. **Multi-turn with preserved context:** "Write a test for class User" → agent does it → "Now run it" → agent runs the test, reports failure, fixes it — all within the same session.
4. **DeepSeek as provider:** `ANTHROPIC_BASE_URL=https://api.deepseek.com` → agent uses DeepSeek (verifiable via debug output or cost). API costs are cents, not Opus dollars.
5. **Zero-config connection:** `icarus serve` → set 3 fields in chat UI → works. No Docker, no provider config, no downloads.

## Failure Modes (Anti-Goals)

1. **Tool call passthrough:** If icarus returns tool call suggestions that the chat UI can't execute, we've built a bridge to nowhere. The agent MUST execute tools server-side.
2. **Silent execution:** If the agent works silently for 45+ seconds and dumps the final answer as one blob, UX is terrible. Must stream intermediate progress.
3. **Surprise Opus billing:** If icarus silently falls back to Opus/Sonnet and runs up a $40 bill, trust is broken. Default cap + DeepSeek-only mode required.
4. **Stateless abstraction:** If each request re-reads the entire project from scratch, context windows are destroyed. Chat sessions MUST map 1:1 to agent sessions.
5. **Fragile setup:** If it requires Python deps + Node.js deps + provider config + API key wiring, users will just open a second terminal with opencode instead.

## Target Users

- **Primary:** The developer who built this (power user with multi-provider AI setup, uses OpenCode daily, has OpenAI-compatible chat UI)
- **Secondary:** Any developer who has an OpenAI-compatible frontend (LibreChat, Open WebUI, LobeChat, NextChat, Big-AGI) and wants to wire a real coding agent behind it

---

## Technical Design

### Architecture Decision: Agent SDK vs OpenCode Server Mode

**Research findings:**

| Dimension | Claude Agent SDK | OpenCode Server Mode |
|-----------|-----------------|---------------------|
| HTTP Server | None — must build from scratch | Built-in (51 REST endpoints + SSE + WebSocket) |
| OpenAI-compatible proxy | None — must implement translation layer | Already exists (`opencode-llm-proxy` plugin) |
| DeepSeek support | Via `ANTHROPIC_BASE_URL` env var | Native, multiple config paths |
| Streaming | SDK yields typed messages; must translate to SSE | Built-in SSE with typed events |
| Model flexibility | Anthropic-compatible endpoints only | 75+ providers, any OpenAI/Anthropic endpoint |
| Tool execution | Built-in (Read, Write, Edit, Bash, etc.) | Built-in (full filesystem + shell) |
| Session management | JSONL files on disk, `SessionStore` adapters | Built-in REST API for sessions |
| Programmatic control | Full — `query()`, hooks, `canUseTool` callbacks | Limited — black-box REST API |
| License | Proprietary | MIT |

**Decision: Start with Agent SDK as primary backend, with OpenCode server mode as a pluggable alternative.**

Rationale:
1. The user explicitly prefers Agent SDK (QUEST.md: "Я бы наверное предпочёл agent SDK")
2. The Agent SDK gives full programmatic control — we own the translation layer
3. The DeepSeek routing mechanism (`ANTHROPIC_BASE_URL`) is already tested and working in the user's `~/.zshrc`
4. OpenCode server mode can be added as a second backend option later

### Architecture

```
┌──────────────────────┐     OpenAI-format      ┌─────────────────────┐     Agent SDK      ┌──────────────────┐
│  OpenAI-compatible   │ ──── SSE stream ──────→ │                     │ ─── query() ─────→ │                  │
│  Chat UI (web panel) │ ←─── POST /v1/... ──── │   icarus server     │                    │  Agent SDK       │
│                      │                        │   (FastAPI/aiohttp) │ ←── tool results ── │  (subprocess)    │
└──────────────────────┘                        │                     │                    │                  │
                                                 └─────────────────────┘                    └────────┬─────────┘
                                                          │                                            │
                                                          │ Reads ANTHROPIC_BASE_URL,                  │
                                                          │ ANTHROPIC_AUTH_TOKEN from env              │
                                                          │                                            │
                                                          ▼                                            ▼
                                                 ┌─────────────────┐                    ┌──────────────────────────┐
                                                 │  Environment    │                    │  DeepSeek API            │
                                                 │  (~/.zshrc)     │                    │  (Anthropic-compatible)  │
                                                 └─────────────────┘                    └──────────────────────────┘
```

### API Surface (What icarus exposes)

**Primary: OpenAI Chat Completions compatibility**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List available models (`icarus-agent-v1`) |
| `/v1/chat/completions` | POST | Main completion endpoint with SSE streaming |

The Chat Completions API is chosen over Responses API because:
1. It's the universal standard for OpenAI compatibility (every provider implements it)
2. The Responses API is OpenAI-specific and almost no third-party implements it
3. The user's existing chat UI almost certainly uses Chat Completions

**Stretch goal:** `/v1/responses` endpoint that maps the Responses API's server-driven state model onto the agent's session model.

### Data Model

```python
# Configuration (loaded from env vars)
@dataclass
class IcarusConfig:
    backend: Literal["agent-sdk", "opencode"]  # Which agent backend
    anthropic_base_url: str  # DeepSeek endpoint
    anthropic_auth_token: str  # DeepSeek API key
    model: str  # e.g., "deepseek-v4-pro[1m]"
    subagent_model: str  # e.g., "deepseek-v4-flash"
    cwd: Path  # Project working directory
    port: int  # Server port
    allowed_tools: list[str]  # Tools to auto-approve
    max_turns: int  # Safety limit
    max_budget_usd: float  # Cost cap

# Conversation mapping
@dataclass
class ConversationState:
    openai_messages: list[dict]  # Accumulated OpenAI-format messages
    sdk_session_id: str | None  # Agent SDK session ID (for resume)
    created_at: datetime
```

### Server Framework: FastAPI

**Why FastAPI:**
- Native async support: `StreamingResponse` accepts `AsyncGenerator` directly — the Agent SDK's `query()` is an async generator
- Pydantic integration: validates incoming OpenAI-format JSON at the boundary (model, messages, stream, temperature)
- Dependency injection: `IcarusConfig` and `SessionStore` injected via `Depends()`, trivially overrideable in tests
- Starlette's `TestClient`: supports `client.stream("POST", ...)` for end-to-end SSE testing
- Lifespan API: clean startup/shutdown with `@asynccontextmanager`

**Alternatives considered:** Flask (WSGI blocks async), aiohttp (no Pydantic/DI/validation), Starlette alone (no typed validation). FastAPI = Starlette + the things we need.

### Session Management

```python
@dataclass
class SessionRecord:
    sdk_session_id: str       # Agent SDK's internal session UUID
    openai_messages: list     # Accumulated OpenAI messages for context
    created_at: float
    locked: bool = False      # Concurrency guard

class SessionStore:
    """Maps chat conversation IDs to Agent SDK session IDs."""
    def __init__(self):
        self._sessions: dict[str, SessionRecord] = {}
    
    def get_or_create(self, conversation_id: str) -> SessionRecord:
        if conversation_id not in self._sessions:
            self._sessions[conversation_id] = SessionRecord(
                sdk_session_id=str(uuid.uuid4()),
                openai_messages=[],
                created_at=time.time(),
            )
        return self._sessions[conversation_id]
```

**Conversation ID strategy:** Use OpenAI's `user` field as the conversation/session key. Every chat UI supports this field. On first request with `user="abc"`, icarus creates a new SDK session and stores the mapping. On subsequent requests, the same `user` value maps to the same SDK session for resume. If `user` is absent, generate a server-side UUID and return it in a `X-Icarus-Session-Id` response header for the client to include in future requests.

**Known v1 limitation:** The `user` field is a per-user identifier, not a per-conversation identifier. If a user has two conversations open simultaneously, they will share one SDK session. This is acceptable for the MVP's single-session model. Multi-conversation support (via client-supplied conversation IDs) is v2.

### Concurrency Model

- **Per-session `asyncio.Lock`:** prevents interleaving two requests on the same conversation
- **Global `asyncio.Semaphore(1)`:** MVP single-session guarantee — one agent at a time
- **Request timeout (`ICARUS_REQUEST_TIMEOUT`, default 300s):** if no SSE event for N seconds, stream terminates with error chunk + `[DONE]`
- **Rapid re-requests:** second request silently queues behind the first (the chat UI shows the previous response streaming, user knows to wait)
- **429 Too Many Requests:** polish for v2

### Graceful Shutdown

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield  # Startup: nothing special
    # Shutdown: cancel running agent task, kill subprocess
    if current_task and not current_task.done():
        current_task.cancel()
    await cleanup_agent_subprocess()
```

Uvicorn handles SIGINT/SIGTERM: stops accepting connections, waits for running handlers, fires lifespan shutdown. The Agent SDK subprocess is cleaned up during this window.

### Prompt Construction Strategy

- **`prompt` arg to `query()`:** ONLY the latest user message content. Do NOT concatenate history.
- **`system_prompt` in `ClaudeAgentOptions`:** the single system message from the OpenAI request.
- **History:** handled entirely by the SDK's session mechanism. When `resume=session_id` is set, the SDK replays the full conversation context internally from its JSONL session file. No manual history replay needed.
- **Important:** On first request, we send the initial system message + user message. On subsequent requests, `resume` loads the SDK's own history. The OpenAI `messages` array from the chat UI is metadata — we extract only the latest user message.

### Tool Visibility in Chat Stream

The Agent SDK emits typed events during `query()`. Key event types:
- **AssistantMessage** — agent's text response blocks (narration like "Let me read database.py...")
- **StreamEvent** — raw text deltas when `include_partial_messages=True`
- **UserMessage** — tool results fed back to the model (internal, not streamed to chat UI)
- **ResultMessage** — session complete: `result`, `session_id`, `total_cost_usd`, `num_turns`, `stop_reason`

**MVP streaming strategy:** Stream text from AssistantMessage/StreamEvent as SSE `choices[].delta.content` chunks. Tool calls happen internally — the agent narrates what it's doing, and the narration text reaches the chat UI. The user sees "Let me read database.py first..." then "I've added connection pooling." No structured tool events in v1.

### Permission Mode

**`bypassPermissions`** — tools execute autonomously without interactive prompts. The SDK's permission system is an interactive UX for terminal use (stdin/stdout), NOT a security boundary. In a server context with no TTY, `default` mode deadlocks on the first tool call.

Real safety constraints:
- `max_turns` — hard limit on tool call iterations
- `max_budget_usd` — cost cap
- Project working directory (`cwd`) — limits filesystem scope
- `allowed_tools` whitelist — filter dangerous tools

### Project Structure

```
icarus/
  server.py          — FastAPI app, routes, lifespan
  session.py         — SessionStore, SessionRecord
  translator.py      — OpenAI ChatCompletions <-> Agent SDK message translation
  config.py          — IcarusConfig from env vars
  agent_wrapper.py   — Thin wrapper around Agent SDK's query()
  sse.py             — SSE format helpers (data: ..., [DONE])
  cli.py             — Click/typer CLI: `icarus serve`
```

### Translation Layer (Core)

**Prompt construction:**
- First request: serialize ALL non-system messages with `<role>` XML tags as the `prompt` string; extract system message as `system_prompt` in `ClaudeAgentOptions`
- Follow-up (resume): ONLY the latest user message as `prompt`; `system_prompt=None` (session already has it)
- Conversation ID from `user` field (stable across turns, survives message edits)

**SDK event → SSE mapping:**

| SDK Event | SSE Output |
|-----------|-----------|
| `StreamEvent` (text delta) | `data: {"choices":[{"delta":{"content":"token"}}]}` |
| `StreamEvent` (tool_use start) | `data: {"choices":[{"delta":{"content":"\n\n[Calling Read...]\n\n"}}]}` |
| `AssistantMessage` (streaming) | Only `finish_reason` delta (text already streamed) |
| `AssistantMessage` (non-streaming) | Full `delta: {"role":"assistant", "content":"..."}` at once |
| `UserMessage` | **Skipped** (SDK internal tool results) |
| `SystemMessage` | **Skipped** (MVP) |
| `ResultMessage` | `finish_reason` + `data: [DONE]`; capture `session_id` for resume |

**Key `ClaudeAgentOptions`:**
- `system_prompt` — set only on first request; `None` on resume
- `allowed_tools=["Read","Edit","Write","Glob","Grep","Bash","WebFetch"]`
- `permission_mode="bypassPermissions"` — no interactive prompts (no TTY in server mode). All safety comes from `max_turns`, `max_budget_usd`, localhost binding, and the `--readonly` flag.
- `max_turns=50` — runaway loop protection
- `cwd=os.getcwd()` — session files stored keyed by working directory
- `include_partial_messages=True` when `stream: true`
- `resume=session_id` on follow-up requests

### Error Handling

| Scenario | HTTP Status | OpenAI Error Type |
|----------|------------|-------------------|
| Invalid API key (DeepSeek rejects) | `401` | `invalid_request_error` / `invalid_api_key` |
| Rate limited by DeepSeek | `429` | `rate_limit_error` + `Retry-After` header forwarded |
| Agent hits `max_turns` limit | `200` | Partial result with `finish_reason: "length"` |
| Agent exceeds `max_budget_usd` | `200` | Partial result with note in content |
| SDK subprocess crash | `500` | `server_error` / `internal_error` |
| SDK timeout | `504` | `server_error` / `upstream_timeout` |
| `stream: false` request | `400` | `invalid_request_error` / `stream_required` |
| Invalid model name | `400` | `invalid_request_error` / `model_not_found` |
| Agent error during streaming | `200` (already committed) | SSE error chunk with `finish_reason: "error"` + `[DONE]` |
| Client disconnects mid-stream | Graceful cancel | Cancel SDK task, log |

### Health & Discovery Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/models` | GET | OpenAI-standard model list (`[{"id":"icarus-agent-v1","object":"model",...}]`) |
| `/health` | GET | Liveness probe (`{"status":"ok","active_sessions":N,"sdk_connected":true}`); 503 if SDK init failed |
| `/docs` | GET | Auto-generated OpenAPI (FastAPI built-in) |

### Logging Strategy

Structured JSON lines to stderr. Key events: `incoming_request` (info), `agent_start` (info), `agent_tool_call` (info), `agent_complete` (info), `agent_error` (error), `sse_sent` (debug), `client_disconnect` (warn). Shared `request_id` across all events per request. Debug mode via `ICARUS_LOG_LEVEL=debug`.

### Integration Points

- Reads `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` etc. from environment
- Inherits the same env vars from `~/.zshrc` that Claude Code CLI uses
- No separate config file needed — environment-driven configuration

### Edge Cases

- Agent gets stuck in a loop (tool calls without progress) → `max_turns` limit
- Agent exceeds cost budget → `max_budget_usd` cap
- Concurrent requests from multiple chat UI tabs → queue or separate sessions
- Agent modifies files the user didn't expect → `allowed_tools` whitelist
- Chat UI sends multimodal content (images) → may not work through DeepSeek endpoint
- Session files accumulate on disk → cleanup strategy needed
- Client disconnects mid-stream → `asyncio.CancelledError` → cancel SDK subprocess
- Server killed during agent run → lifespan shutdown → cleanup subprocess

## Implementation Details

### Dependencies (pyproject.toml)

```toml
[build-system]
requires = ["setuptools>=75.0"]
build-backend = "setuptools.build_meta"

[project]
name = "icarus"
version = "0.1.0"
description = "OpenAI-compatible API wrapper around the Claude Agent SDK"
requires-python = ">=3.10"
dependencies = [
    "fastapi>=0.115.0",        # Async web framework, Pydantic validation, OpenAPI
    "uvicorn[standard]>=0.32", # ASGI server (httptools + uvloop)
    "claude-agent-sdk",        # Agent SDK: query(), ClaudeAgentOptions, events
    "click>=8.1.0",            # CLI framework for `icarus serve`
    "structlog>=24.0.0",       # Structured JSON logging to stderr
    "httpx>=0.27.0",           # FastAPI TestClient backend
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "ruff>=0.7.0",             # Linter + formatter
    "mypy>=1.12.0",            # Static type checking
]

[project.scripts]
icarus = "icarus.cli:main"

[tool.setuptools.packages.find]
where = ["src"]
```

### CLI Interface

```
icarus serve [OPTIONS]

Options:
  -p, --port INTEGER        Port to bind to           [default: 9090]
  -H, --host TEXT           Host address               [default: 127.0.0.1]
  -d, --cwd DIRECTORY       Agent working directory    [default: current dir]
  -m, --model TEXT          Model name in chat UI      [default: icarus-agent]
  -t, --max-turns INTEGER   Max tool-call iterations   [default: 50]
  -b, --max-budget FLOAT    Cost cap per session (USD) [default: 0.50]
  -l, --log-level TEXT      debug|info|warning|error   [default: info]
  --reload                  Dev mode auto-reload
```

### Configuration (Env Vars)

| Env Var | Default | Required | Purpose |
|---------|---------|----------|---------|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | No | Set to `https://api.deepseek.com` for DeepSeek |
| `ANTHROPIC_AUTH_TOKEN` | — | **Yes** | API key (Bearer token) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | No | Model to request from provider |
| `ICARUS_HOST` | `127.0.0.1` | No | Server bind address |
| `ICARUS_PORT` | `9090` | No | Server port |
| `ICARUS_MAX_TURNS` | `50` | No | Max tool-call iterations before forced stop |
| `ICARUS_MAX_BUDGET_USD` | `0.50` | No | Cost cap per session |
| `ICARUS_CWD` | `os.getcwd()` | No | Working directory for agent |
| `ICARUS_LOG_LEVEL` | `info` | No | Log verbosity |
| `ICARUS_ALLOWED_TOOLS` | all built-in | No | Comma-separated tool whitelist |

CLI flags override env vars. The user's `~/.zshrc` already exports `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` — icarus inherits them automatically.

### Package File Tree

```
src/icarus/
  __init__.py       # __version__ = "0.1.0"
  __main__.py       # python -m icarus entry point
  py.typed          # PEP 561 marker (empty file)
  cli.py            # Click CLI group + `serve` command (~40 lines)
  config.py         # IcarusConfig dataclass + load_config() (~50 lines)
  server.py         # FastAPI app, lifespan, routes (~150 lines)
  session.py        # SessionStore with asyncio.Lock (~40 lines)
  translator.py     # OpenAI messages → SDK prompt/options (~80 lines)
  agent_wrapper.py  # Async generator wrapping Agent SDK query() (~100 lines)
  sse.py            # SSE line formatting helpers (~30 lines)
tests/
  test_config.py
  test_translator.py
  test_session.py
  test_agent_wrapper.py
  test_server.py
```

Estimated total: ~500 lines of package code + ~300 lines of tests.

### Testing Strategy

**Mock approach:** Patch `claude_agent_sdk.query` at the `agent_wrapper` boundary. Replace with an async generator that yields synthetic events (`StreamEvent`, `AssistantMessage`, `ResultMessage`). Tests control the exact event sequence.

**Key fixtures:**
- `mock_query` — patches `query()` with controllable async generator
- `happy_path_events` — realistic sequence: text deltas → assistant finish → result
- `error_path_events` — auth failure sequence → error ResultMessage
- `client` — FastAPI `TestClient` with overridden `SessionStore` dependency
- `tmp_workspace` — temp directory with a dummy `main.py`

**Minimum Viable Test Suite (10 tests):**

| # | Test | Coverage |
|---|------|----------|
| 1 | `test_chat_completions_streams_sse` | Happy-path SSE end-to-end: role delta, content deltas, finish_reason, [DONE] |
| 2 | `test_chat_completions_non_stream_rejected` | `stream: false` → 400 |
| 3 | `test_chat_completions_auth_error` | SDK auth failure → 401 error response |
| 4 | `test_chat_completions_rate_limit` | SDK rate-limit → 429 with Retry-After |
| 5 | `test_chat_completions_invalid_model` | Unknown model → 400 model_not_found |
| 6 | `test_conversation_resume` | Second request with same `user` → reuses session (verifies `resume` set) |
| 7 | `test_conversation_new_user_creates_session` | New `user` → fresh session |
| 8 | `test_models_endpoint` | GET /v1/models → 200 with model list |
| 9 | `test_health_endpoint` | GET /health → 200 with status + session count |
| 10 | `test_translator_system_and_latest_user` | System → `system_prompt`, last user → `prompt` |

### `agent_wrapper.py` — Key Design

```python
async def stream_agent(
    *,
    prompt: str,
    config: IcarusConfig,
    session_id: str | None = None,
    system_prompt: str | None = None,
    include_partial: bool = True,
) -> AsyncIterator[str]:
```

- Sets up `ClaudeAgentOptions` with `permission_mode="bypassPermissions"`, `setting_sources=[]`
- `async for` loop over `sdk_query()` dispatches by `isinstance()`: StreamEvent → text delta, AssistantMessage → finish_reason, ResultMessage → [DONE]
- Two error paths: `ResultMessage.is_error` + `AssistantMessage.error` literal
- `except asyncio.CancelledError` → log + re-raise (client disconnect)
- `except Exception` → error chunk + [DONE] (avoids hanging the SSE stream)

## MVP Scope (v1)

### In Scope
- **Agent SDK backend only** — OpenCode backend is v2
- **Single concurrent session** per server instance — one agent working on one task
- **All built-in tools:** Read, Write, Edit, Bash, Glob, Grep — shipped by the SDK, no reason to exclude
- **Server-side tool execution** — the agent does the work autonomously; the chat UI only displays results
- **`/v1/models` endpoint** — returns a single hardcoded model entry (`icarus-agent-v1`) for chat UI discovery
- **`pip install icarus` + `icarus serve`** — no Docker required, reads API keys from environment
- **SSE streaming** — plain text deltas; rich tool annotations are v2

### Out of Scope (v2+)
- OpenCode server mode backend
- Multi-session / multi-tenant
- `/v1/responses` endpoint (Responses API compatibility)
- Rich streaming annotations (tool progress, structured events)
- Session persistence across server restarts (in-memory store lost on restart)
- Docker-based deployment
- Web UI / management dashboard

## Risk Assessment (Adversarial Review)

### Critical Risks Addressed

**Risk 1: DeepSeek compatibility is untested (CRITICAL)**
- **Likelihood:** Medium — the user's `~/.zshrc` already uses `ANTHROPIC_BASE_URL=https://api.deepseek.com` with Claude Code CLI successfully. The same mechanism underpins the SDK. However, SDK-internal features (extended thinking, prompt caching, specific tool-call schema) may diverge from what DeepSeek's Anthropic-compatible endpoint supports.
- **Impact:** High — if DeepSeek doesn't work, the cost model collapses (Opus pricing).
- **Mitigation:**
  - Add `icarus doctor` command that sends a test prompt to the configured endpoint and validates: auth, text streaming, tool definitions accepted, tool execution works. Run before `icarus serve` starts.
  - Start `icarus serve` in a mode that validates the provider on first request and fails fast with a clear error if incompatible.
  - Document known limitations: MCP tools and vision input do not work through third-party providers.
  - If DeepSeek proves incompatible, fall back to the OpenCode server mode backend (v2 plan) which natively supports DeepSeek.

**Risk 2: `bypassPermissions` with unrestricted Bash = host compromise (CATASTROPHIC)**
- **Likelihood:** Low-Medium — requires a malicious or severely hallucinated prompt.
- **Impact:** Catastrophic — credential theft, data exfiltration, code corruption.
- **Mitigation:**
  - **Bind to localhost only** (`127.0.0.1` by default) — no network exposure.
  - **Add `--readonly` flag and `ICARUS_READONLY=1` env var** — disables Write, Edit, and write-mode Bash. Agent can only read and search.
      - **No denylist-based command filtering** — denylists are trivially bypassed (e.g. `rm --no-preserve-root`, `python -c "import shutil; shutil.rmtree("/")"`, `find -delete`). The real defense is localhost binding + readonly mode.
  - **Set `ICARUS_MAX_BUDGET_USD=0.50` by default** — limits financial blast radius.
      - Document: "icarus runs with full filesystem access when not in readonly mode. Run it in a container or dedicated project directory. The `--readonly` flag is recommended for untrusted prompts."

**Risk 3: Conversation ID strategy is self-contradictory (HIGH)**
- **Likelihood:** Certain — the spec had both `user` field and SHA256 hash approaches.
- **Impact:** Medium-High — silent session breaks, agent "forgets" context.
- **Mitigation:**
  - **USE ONLY the `user` field as conversation ID.** Drop the SHA256 hash approach entirely. The `user` field is stable across message edits, survives client reconnections, and is supported by every OpenAI-compatible chat UI.
  - **Fallback:** if `user` is absent, generate a server-side UUID and return it in a response header (`X-Icarus-Session-Id`). The chat UI can include it in subsequent requests.
  - **Session recovery:** if the SDK session file is missing/corrupted on resume, create a fresh session and replay the full message history as the initial prompt (not just the latest message).

**Risk 4: Mid-stream subprocess death produces a hang, not an error (HIGH)**
- **Likelihood:** Low-Medium — OOM, network partition, DeepSeek returning unexpected format.
- **Impact:** High — "spinner of death" in chat UI, wasted user time, potential double-charges on retry.
- **Mitigation:**
  - **Add `ICARUS_REQUEST_TIMEOUT` (default 300s)** — if no SSE event emitted for N seconds, emit error chunk + `[DONE]`. This ensures the client always sees the stream terminate.
  - **Wrap the SDK async generator with `asyncio.wait_for`** on each iteration, not the whole stream.
  - **Error table correction:** mid-stream errors emit an error chunk with `finish_reason: "error"` + `[DONE]` (not HTTP 500, since status is already 200 committed).

**Risk 5: SSE format drift breaks specific chat UIs (MEDIUM)**
- **Likelihood:** Medium — different UIs have different parser strictness.
- **Impact:** Medium — silent rendering failures, "works on my machine" bugs.
- **Mitigation:**
  - **Always emit initial `delta: {"role": "assistant"}` chunk** before any content.
  - **Include `"object": "chat.completion.chunk"`** in every SSE payload.
  - **Include `"usage"` in the final delta** (with null/zero tokens if unavailable from SDK).
  - **Test against at least 3 target UIs:** NextChat, LibreChat, Open WebUI.

### Minor Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Global Semaphore DoS | Low (single-user MVP) | Medium | Per-session locking replaces global semaphore; configurable request timeout |
| Tool execution invisible to user | Medium (by design) | Low | Accept as MVP trade-off; tool start/stop markers in narration text provide minimal visibility |
| Session JSONL grows unbounded | Low (short sessions) | Low | SDK auto-compaction handles this; add `ICARUS_MAX_SESSION_AGE` for cleanup |
| System prompt changed mid-conversation | Low | Low | Known limitation: SDK session keeps original system prompt from first request |
| `ICARUS_ALLOWED_TOOLS` not wired | Low (pre-launch) | Low | Wire env var into translator's `ClaudeAgentOptions.allowed_tools` construction |

## Final Review

- [x] Architecture is sound — FastAPI + Agent SDK, with identified risks mitigated
- [x] Data model covers all use cases — SessionStore maps conversation IDs to SDK sessions
- [x] Error states are handled — comprehensive error mapping table with HTTP codes and OpenAI error types
- [x] Security concerns addressed — localhost-only, readonly mode, budget cap
- [x] Performance considered — subprocess overhead accepted for MVP; watchdog timer prevents hangs
- [x] Testing strategy defined — 10-test suite with mock SDK, SSE streaming assertions
- [x] Rollback plan exists — sessions are isolated per-conversation; server restart loses in-memory state only
- [x] DeepSeek compatibility — validated via startup probe (`icarus doctor`); documented limitations
- [x] SSE format compliance — role delta, object field, usage in final chunk
