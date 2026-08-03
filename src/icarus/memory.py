"""MCP client for the Graphiti knowledge graph (zepai/knowledge-graph-mcp).

Provides a MemoryClient that wraps the MCP server's tools for searching
and adding facts to the temporal knowledge graph.
"""

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx
import structlog
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from icarus.config import config

logger = structlog.get_logger("icarus.memory")

# ── Sensitive data patterns (code-enforced, never trust the evaluator LLM) ──

_SENSITIVE_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b"),                # OpenAI/DeepSeek keys
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                      # AWS access key
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),        # PEM private key
    re.compile(r"(?i)\b(password|passwd|pwd)\b\s*[:=]\s*\S{6,}"),  # password=
    re.compile(r"(?i)\b(api[_-]?key|secret|token)\b\s*[:=]\s*\S{8,}"),  # api_key=
    re.compile(r"\b(?:\d[ -]?){15,16}\b"),                     # credit card numbers
    re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),  # email
    re.compile(r"\bghp_[A-Za-z0-9_]{36,}\b"),                  # GitHub PAT
]


def _contains_sensitive(text: str) -> bool:
    """Return True if `text` matches any known secret/PII pattern."""
    for pattern in _SENSITIVE_PATTERNS:
        if pattern.search(text):
            return True
    return False


# ── Data types ──────────────────────────────────────────────────────────────

@dataclass
class Fact:
    """A fact (edge) retrieved from the knowledge graph."""
    uuid: str
    name: str
    fact: str
    valid_at: str | None = None
    invalid_at: str | None = None
    expired_at: str | None = None
    created_at: str = ""


@dataclass
class WriteJob:
    """A pending write to the knowledge graph."""
    episode_name: str
    episode_body: str
    reference_time: datetime
    group_id: str
    request_id: str = ""


# ── Conversation identity ───────────────────────────────────────────────────

def conversation_key(messages: list[dict]) -> str:
    """Derive a stable key from the first user message in the conversation.

    Only the first user message is used; system messages are excluded because
    they are not stable across turns (Claude Code rebuilds its system prompt).
    """
    for msg in messages:
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                # Multimodal content — serialize deterministically
                content = json.dumps(content, sort_keys=True, ensure_ascii=False)
            else:
                content = str(content).strip()
            return hashlib.sha256(content.encode("utf-8")).hexdigest()
    return "no-user"


def is_conversation_start(messages: list[dict]) -> bool:
    """Return True if this request looks like the start of a new conversation.

    A conversation start has no assistant messages — only system and user.
    """
    for msg in messages:
        if msg.get("role") == "assistant":
            return False
    return True


# ── Snapshot store (SQLite-backed, survives process restart) ────────────────

# Fixed query parts for the two-tier search
_PROFILE_QUERY = (
    "the user's stable identity: name, occupation, preferences, "
    "constraints, goals, tools, projects, decisions, expertise"
)
_RECENCY_QUERY = "most recent facts about the user"


class SnapshotStore:
    """SQLite-backed store for conversation→snapshot mappings.

    Persists formatted injection text so re-injection is byte-identical
    across process restarts.
    """

    def __init__(self, db_path: str = config.MEMORY_DB_PATH) -> None:
        self._db_path = db_path
        self._cache: dict[str, dict] = {}  # key → {snapshot, first_seen, last_seen}
        self._init_db()

    def _init_db(self) -> None:
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS conversation_snapshots (
                    key        TEXT PRIMARY KEY,
                    snapshot   TEXT NOT NULL,
                    first_seen REAL NOT NULL,
                    last_seen  REAL NOT NULL
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_last_seen
                ON conversation_snapshots(last_seen)
            """)

    def get(self, key: str) -> dict | None:
        """Return cached entry or load from SQLite."""
        if key in self._cache:
            return self._cache[key]
        with sqlite3.connect(self._db_path) as conn:
            row = conn.execute(
                "SELECT snapshot, first_seen, last_seen "
                "FROM conversation_snapshots WHERE key = ?",
                (key,),
            ).fetchone()
        if row is None:
            return None
        entry = {
            "snapshot": row[0],
            "first_seen": row[1],
            "last_seen": row[2],
        }
        self._cache[key] = entry
        return entry

    def upsert(self, key: str, snapshot: str, first_seen: float, last_seen: float) -> None:
        """Insert or update a snapshot row."""
        self._cache[key] = {
            "snapshot": snapshot,
            "first_seen": first_seen,
            "last_seen": last_seen,
        }
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO conversation_snapshots "
                "(key, snapshot, first_seen, last_seen) VALUES (?, ?, ?, ?)",
                (key, snapshot, first_seen, last_seen),
            )

    def prune(self, max_age_days: int = 7) -> int:
        """Delete entries older than `max_age_days`. Returns deleted count."""
        cutoff = time.time() - (max_age_days * 86400)
        with sqlite3.connect(self._db_path) as conn:
            cursor = conn.execute(
                "DELETE FROM conversation_snapshots WHERE last_seen < ?",
                (cutoff,),
            )
            deleted = cursor.rowcount
        # Also prune cache
        for key in list(self._cache):
            if self._cache[key]["last_seen"] < cutoff:
                del self._cache[key]
        return deleted


# Module-level snapshot store
_snapshot_store = SnapshotStore()


# ── Snapshot building ───────────────────────────────────────────────────────


def _format_injection(facts: list[Fact], max_facts: int | None = None) -> str | None:
    """Format a list of facts into a compact system message."""
    if not facts:
        return None
    if max_facts is None:
        max_facts = config.GRAPHITI_MAX_FACTS

    facts = facts[:max_facts]

    lines = ["## User Memory (from previous conversations)", ""]
    lines.append("### Known Facts")
    for f in facts:
        lines.append(f"- {f.fact}")
    lines.append("")
    lines.append("---")
    lines.append(
        "*This memory is from previous conversations and is frozen for this session. "
        "If the user asks to forget or correct a fact, note it and suggest using "
        "`script/memory forget` or the memory management API.*"
    )
    return "\n".join(lines)


async def build_snapshot(
    client: "MemoryClient", messages: list[dict]
) -> str | None:
    """Build a topic-dependent memory snapshot from the first user message.

    Two-tier search:
    1. Profile tier — stable identity/preferences/constraints (always included)
    2. Topic tier — the first user message as a search query (topic relevance)
    3. Recency fallback — if nothing relevant found (generic openings like "hi")
    """
    first_user = ""
    for msg in messages:
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                first_user = content.strip()
            elif isinstance(content, list):
                # Multimodal — use text parts only
                parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                first_user = " ".join(parts).strip()
            break

    # Run profile + topic queries concurrently
    queries = [_PROFILE_QUERY]
    token_count = len(first_user.split()) if first_user else 0
    if token_count >= 3:
        queries.append(first_user)

    results = await asyncio.gather(
        *(client.search_facts(q, limit=15) for q in queries),
        return_exceptions=True,
    )

    # Merge and deduplicate by fact text
    seen: set[str] = set()
    merged: list[Fact] = []
    for result in results:
        if isinstance(result, Exception):
            continue
        for f in result:
            normalized = f.fact.strip().lower()
            if normalized not in seen:
                seen.add(normalized)
                merged.append(f)

    # If nothing found (generic opening), fall back to recency
    if not merged:
        try:
            merged = await client.search_facts(_RECENCY_QUERY, limit=20)
        except Exception:
            pass

    return _format_injection(merged)


async def memory_for_request(
    client: "MemoryClient", messages: list[dict]
) -> str | None:
    """Return the memory snapshot to inject for this request.

    On conversation start: builds a fresh topic-dependent snapshot and persists it.
    On continuation: returns the cached snapshot (byte-identical for prompt cache).
    Reuse-not-clobber policy: a colliding key from a new conversation reuses
    the existing snapshot if the active conversation is still alive (cooldown).
    """
    if not config.MEMORY_ENABLED:
        return None

    key = conversation_key(messages)
    now = time.time()
    is_start = is_conversation_start(messages)

    existing = _snapshot_store.get(key)

    if existing is None:
        # First time seeing this key — always build fresh
        if not is_start:
            # Continuation without a stored snapshot (e.g., proxy restart during
            # an active conversation). Build fresh — one cache miss, then stable.
            pass
        snapshot = await build_snapshot(client, messages)
        if snapshot is not None:
            _snapshot_store.upsert(key, snapshot, now, now)
        return snapshot

    # Key exists — check cooldown
    cooldown = config.MEMORY_SNAPSHOT_COOLDOWN
    if is_start and (now - existing["last_seen"]) > cooldown:
        # Stale entry + new conversation start → rebuild
        snapshot = await build_snapshot(client, messages)
        if snapshot is not None:
            _snapshot_store.upsert(key, snapshot, now, now)
        return snapshot

    # Reuse existing snapshot (continuation OR collision within cooldown)
    _snapshot_store.upsert(
        key, existing["snapshot"], existing["first_seen"], now
    )
    return existing["snapshot"]


# ── Memory client ───────────────────────────────────────────────────────────

class MemoryClient:
    """Async client for the Graphiti knowledge graph via MCP.

    One instance per process. Created at startup (FastAPI lifespan),
    reconnects lazily on errors.

    All public methods are safe to call when the server is unreachable —
    they return empty results rather than raising.
    """

    def __init__(self) -> None:
        self._url: str = config.GRAPHITI_URL
        self._group_id: str = config.GRAPHITI_GROUP_ID
        self._read_timeout: float = config.GRAPHITI_READ_TIMEOUT_MS / 1000.0
        self._write_timeout: float = config.GRAPHITI_WRITE_TIMEOUT_MS / 1000.0

        # Long-lived MCP transport + session (created in connect, recreated on error)
        self._session: ClientSession | None = None
        self._transport_ctx: object | None = None  # streamable_http_client context
        self._http_client: httpx.AsyncClient | None = None
        self._available: bool = False
        self._lock: asyncio.Lock = asyncio.Lock()

        # Resolved tool names (set by _resolve_tools)
        self._tool_search: str = "search_facts"
        self._tool_add: str = "add_episode"
        self._tool_delete_edge: str = "delete_entity_edge"
        self._tool_delete_episode: str = "delete_episode"
        self._tool_get_edge: str = "get_entity_edge"
        self._tool_clear: str = "clear_graph"

        # Write path
        self._write_queue: asyncio.Queue[WriteJob] = asyncio.Queue(maxsize=100)
        self._write_worker: asyncio.Task[None] | None = None
        self._at_capacity: bool = False

        # Counters (for /health)
        self.writes_total: int = 0
        self.writes_failed: int = 0
        self.writes_last_error: str = ""
        self.writes_rejected_24h: int = 0

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Establish connection and resolve tool names. Non-fatal on error."""
        async with self._lock:
            try:
                await self._do_connect()
                self._available = True
                logger.info(
                    "memory_connected",
                    url=self._url,
                    search_tool=self._tool_search,
                    add_tool=self._tool_add,
                )
            except Exception as exc:
                self._available = False
                logger.warning("memory_connect_failed", url=self._url, error=str(exc))

        # Spawn write worker regardless of initial connection state
        self._start_write_worker()

    async def _do_connect(self) -> None:
        """Create transport + session. Must be called under lock."""
        # Close any existing transport first
        await self._teardown_transport()

        self._http_client = httpx.AsyncClient(timeout=httpx.Timeout(15.0))
        self._transport_ctx = streamable_http_client(
            self._url, http_client=self._http_client,
        )
        read, write, _get_session_id = await self._transport_ctx.__aenter__()
        self._session = ClientSession(read, write)
        await self._session.initialize()
        tools = await self._session.list_tools()
        self._resolve_tools(tools.tools)

    async def _teardown_transport(self) -> None:
        """Close existing session and transport if any."""
        if self._session is not None:
            try:
                await self._session.__aexit__(None, None, None)
            except Exception:
                pass
            self._session = None
        if self._transport_ctx is not None:
            try:
                await self._transport_ctx.__aexit__(None, None, None)
            except Exception:
                pass
            self._transport_ctx = None

    async def close(self) -> None:
        """Release resources."""
        if self._write_worker is not None:
            self._write_worker.cancel()
            try:
                await self._write_worker
            except asyncio.CancelledError:
                pass
        await self._teardown_transport()
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None
        self._available = False

    @property
    def available(self) -> bool:
        return self._available

    # ── Read path ────────────────────────────────────────────────────────

    async def search_facts(
        self, query: str, limit: int | None = None
    ) -> list[Fact]:
        """Search the knowledge graph for facts matching `query`.

        Returns empty list on timeout or error (graceful degradation).
        """
        if limit is None:
            limit = config.GRAPHITI_MAX_FACTS

        try:
            result = await self._call_tool(
                self._tool_search,
                {
                    "query": query,
                    "group_ids": [self._group_id],
                    "max_facts": limit,
                },
                timeout=self._read_timeout,
            )
            raw_facts: list[dict] = result.get("facts", [])
        except Exception:
            return []

        facts: list[Fact] = []
        for f in raw_facts:
            fact = Fact(
                uuid=f.get("uuid", ""),
                name=f.get("name", ""),
                fact=f.get("fact", ""),
                valid_at=f.get("valid_at"),
                invalid_at=f.get("invalid_at"),
                expired_at=f.get("expired_at"),
                created_at=f.get("created_at", ""),
            )
            # Skip facts that Graphiti has already invalidated
            if fact.invalid_at or fact.expired_at:
                continue
            facts.append(fact)

        return facts

    async def search_nodes(
        self, query: str, limit: int = 10
    ) -> list[dict]:
        """Search for entity nodes matching `query`."""
        try:
            result = await self._call_tool(
                "search_nodes",
                {
                    "query": query,
                    "group_ids": [self._group_id],
                    "max_nodes": limit,
                },
                timeout=self._read_timeout,
            )
            return result.get("nodes", [])
        except Exception:
            return []

    # ── Write path ───────────────────────────────────────────────────────

    async def enqueue_write(self, job: WriteJob) -> None:
        """Enqueue a fact episode for background storage.

        Non-blocking — drops the job if the queue is full.
        """
        if self._at_capacity:
            self.writes_rejected_24h += 1
            logger.warning(
                "memory_write_rejected",
                reason="at_capacity",
                request_id=job.request_id,
            )
            return
        try:
            self._write_queue.put_nowait(job)
        except asyncio.QueueFull:
            self.writes_rejected_24h += 1
            logger.error(
                "memory_write_dropped",
                reason="queue_full",
                request_id=job.request_id,
            )

    async def add_memory(
        self, name: str, facts: list[str],
        source_description: str = "icarus evaluator",
        reference_time: datetime | None = None,
    ) -> bool:
        """Store extracted facts as an episode in the knowledge graph.

        Returns True on success, False on failure.
        """
        if not facts:
            return False

        # Security gate: never send raw conversations, and filter secrets
        clean_facts: list[str] = []
        for f in facts:
            if _contains_sensitive(f):
                logger.warning(
                    "memory_secret_flagged",
                    fact_snippet=f[:80],
                )
                continue
            clean_facts.append(f)

        if not clean_facts:
            return False

        episode_body = "\n".join(
            f"{i}. {fact}" for i, fact in enumerate(clean_facts, 1)
        )

        try:
            result = await self._call_tool(
                self._tool_add,
                {
                    "name": name,
                    "episode_body": episode_body,
                    "group_id": self._group_id,
                    "source": "text",
                    "source_description": source_description,
                    "reference_time": (
                        reference_time.isoformat()
                        if reference_time
                        else datetime.now(timezone.utc).isoformat()
                    ),
                },
                timeout=self._write_timeout,
            )
            return "error" not in str(result).lower()
        except Exception:
            return False

    # ── Delete / forget ──────────────────────────────────────────────────

    async def delete_fact(self, uuid: str) -> bool:
        """Delete a single fact (edge) by UUID."""
        try:
            await self._call_tool(
                self._tool_delete_edge,
                {"uuid": uuid},
                timeout=self._write_timeout,
            )
            return True
        except Exception:
            return False

    async def delete_episode(self, uuid: str) -> bool:
        """Delete an episode and its cascade-owned entities/edges."""
        try:
            await self._call_tool(
                self._tool_delete_episode,
                {"uuid": uuid},
                timeout=self._write_timeout,
            )
            return True
        except Exception:
            return False

    async def clear_graph(self) -> bool:
        """Remove all data for the current group_id."""
        try:
            await self._call_tool(
                self._tool_clear,
                {"group_id": self._group_id},
                timeout=self._write_timeout,
            )
            return True
        except Exception:
            return False

    # ── Internals ────────────────────────────────────────────────────────

    def _start_write_worker(self) -> None:
        """Spawn the background FIFO worker for serialized writes."""
        if self._write_worker is not None:
            return
        self._write_worker = asyncio.create_task(self._write_loop())

        def _respawn(_task: asyncio.Task[None]) -> None:
            self._write_worker = None
            if not _task.cancelled():
                self._start_write_worker()

        self._write_worker.add_done_callback(_respawn)

    async def _write_loop(self) -> None:
        """Consume write jobs one at a time (FIFO order for temporal integrity)."""
        while True:
            job = await self._write_queue.get()
            self.writes_total += 1
            logger.info(
                "memory_write_started",
                episode_name=job.episode_name,
                request_id=job.request_id,
            )

            success = False
            last_error = ""
            max_retries = config.GRAPHITI_WRITE_RETRIES

            for attempt in range(max_retries + 1):
                try:
                    success = await self.add_memory(
                        name=job.episode_name,
                        facts=[job.episode_body],
                        reference_time=job.reference_time,
                    )
                    if success:
                        break
                except Exception as exc:
                    last_error = str(exc)
                    if attempt < max_retries:
                        await asyncio.sleep(1.0)

            if success:
                logger.info(
                    "memory_write_succeeded",
                    episode_name=job.episode_name,
                    request_id=job.request_id,
                )
            else:
                self.writes_failed += 1
                self.writes_last_error = last_error
                logger.error(
                    "memory_write_failed",
                    episode_name=job.episode_name,
                    request_id=job.request_id,
                    error=last_error,
                )
                # Dead-letter: write to file for later replay
                self._write_dead_letter(job, last_error)

            self._write_queue.task_done()

    def _write_dead_letter(self, job: WriteJob, error: str) -> None:
        """Append a failed write to the dead-letter file for manual replay."""
        try:
            import os
            dead_letter_path = config.LOG_DIR.rstrip("/") + "/memory_dead_letter.jsonl"
            os.makedirs(os.path.dirname(dead_letter_path), exist_ok=True)
            entry = {
                "episode_name": job.episode_name,
                "episode_body": job.episode_body,
                "group_id": job.group_id,
                "reference_time": job.reference_time.isoformat(),
                "error": error,
                "request_id": job.request_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            with open(dead_letter_path, "a") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:
            pass  # Can't log dead letter — already in bad state

    async def _call_tool(
        self, tool_name: str, arguments: dict, timeout: float
    ) -> dict:
        """Call an MCP tool with timeout and error handling.

        Raises exception on any failure — callers handle graceful degradation.
        """
        await self._ensure_connected()

        try:
            async with asyncio.timeout(timeout):
                result = await self._session.call_tool(tool_name, arguments)
        except asyncio.TimeoutError:
            self._available = False
            raise
        except Exception:
            self._available = False
            raise

        if result.isError:
            raise RuntimeError(
                f"MCP tool '{tool_name}' returned error: {result.content}"
            )

        # FastMCP returns content as a list of text blocks; extract the first one
        for block in result.content:
            if hasattr(block, "text"):
                try:
                    return json.loads(block.text)
                except json.JSONDecodeError:
                    return {"raw": block.text}
        return {}

    async def _ensure_connected(self) -> None:
        """Lazy (re)connect. Called before every MCP operation."""
        if self._available and self._session is not None:
            return

        async with self._lock:
            if self._available and self._session is not None:
                return

            # Backoff between reconnect attempts
            await asyncio.sleep(1.0)

            try:
                await self._do_connect()
                self._available = True
                logger.info("memory_reconnected", url=self._url)
            except Exception as exc:
                self._available = False
                logger.warning(
                    "memory_reconnect_failed", url=self._url, error=str(exc)
                )
                raise

    def _resolve_tools(self, tools: list) -> None:
        """Map tool names with fallbacks for fork compatibility.

        Official zepai/knowledge-graph-mcp uses add_episode/search_facts;
        community forks use add_memory/search_memory_facts.
        """
        tool_names = {t.name for t in tools}

        # Search facts
        for candidate in ("search_memory_facts", "search_facts"):
            if candidate in tool_names:
                self._tool_search = candidate
                break

        # Add episode / memory
        for candidate in ("add_memory", "add_episode"):
            if candidate in tool_names:
                self._tool_add = candidate
                break

        # Delete edge
        for candidate in ("delete_entity_edge",):
            if candidate in tool_names:
                self._tool_delete_edge = candidate
                break

        # Delete episode
        for candidate in ("delete_episode",):
            if candidate in tool_names:
                self._tool_delete_episode = candidate
                break

        # Get edge (for verify-before-delete)
        for candidate in ("get_entity_edge",):
            if candidate in tool_names:
                self._tool_get_edge = candidate
                break

        # Clear graph
        for candidate in ("clear_graph",):
            if candidate in tool_names:
                self._tool_clear = candidate
                break

        logger.debug(
            "memory_tools_resolved",
            search=self._tool_search,
            add=self._tool_add,
            delete_edge=self._tool_delete_edge,
            delete_episode=self._tool_delete_episode,
            get_edge=self._tool_get_edge,
            clear=self._tool_clear,
        )


# ── Evaluator LLM: extraction prompt ───────────────────────────────────────

_EVALUATOR_SYSTEM_PROMPT = """\
You are the memory extraction component of a personal AI assistant. Your job is to
decide whether the LAST USER MESSAGE contains facts worth remembering across future
conversations, and to extract them.

SCOPE
- Extract ONLY from the LAST USER MESSAGE. Earlier messages were already processed
  in previous runs — ignore them.
- Only USER messages are fact sources. The assistant's own answers are never facts.
- Do not re-extract anything already listed under KNOWN FACTS.

DECISION TESTS — a candidate fact qualifies only if it passes BOTH:
1. BRIEFING TEST: if you were briefing a new engineer about this user tomorrow,
   would you include this fact? If not, it is not memory.
2. DURABILITY TEST: will it still be true in 30 days? If it may be stale by then,
   it is not memory.

REMEMBER ONLY (7 categories):
1. identity — who the user is: role, experience, location, background
2. project — projects the user works on and their current state
3. preference — how the user likes to work: tools, languages, formats, style
4. constraint — hard limits of the user's environment: hardware, budget, time
5. decision — settled choices that should not be re-litigated
6. expertise — what the user knows well; and also what they do NOT know
7. operational — standing practices: "Docker for everything", "systemd for services"

NEVER EXTRACT (7 categories):
1. temporary debugging state ("the VPS is timing out right now")
2. the task request itself ("help me refactor this file")
3. transient measurements ("the build takes 40 seconds")
4. sensitive data — passwords, API keys, tokens, secrets, financial, medical, or
   personal identifying data (this is also filtered programmatically; never extract it)
5. mood or venting ("I hate this codebase") — emotion is not a preference
6. the assistant's own statements or conclusions
7. judgments about other people ("my colleague is incompetent")

STYLE
- One fact per sentence, standalone and self-contained, with the user as the subject:
  "The user prefers Rust for systems programming." — not "prefers Rust".
- Write facts in English, regardless of the message language.
- Split compound statements into separate facts; keep each fact under 160 characters.
- Extract only what the user actually said — no inference, no rephrasing.
- Return at most 5 facts per message. Fewer is better; zero is often correct.

CONSERVATISM
A wrong memory pollutes every future conversation; a missed fact costs nothing — the
user simply repeats it. WHEN IN DOUBT, DO NOT REMEMBER.
Returning {"facts": []} is the most common correct answer.

OUTPUT (JSON)
Respond with exactly one JSON object in this shape (the word "json" in this prompt
enables JSON mode):
{"facts": [{"fact": "<standalone sentence>", "category": "<category>"}]}

"category" must be one of: identity, project, preference, constraint, decision,
expertise, operational.
"""


# ── Deduplication ───────────────────────────────────────────────────────────


class DedupFilter:
    """Multi-layer dedup to prevent fact bloat before Graphiti storage.

    L1: Normalized hash (in-memory LRU, ~0ms, $0)
    L2: Embedding cosine similarity (in-memory, ~50ms, ~$0.0000001)
    L3: Graphiti search (only for ambiguous L2 results, ~100ms, $0)

    Dedup is an optimization — Graphiti has its own built-in dedup at ingest,
    but pre-filtering saves LLM extraction cost.
    """

    def __init__(self, max_size: int = 1000) -> None:
        self._hashes: dict[str, float] = {}  # hash → timestamp
        self._embeddings: list[tuple[list[float], str]] = []  # (embedding, hash)
        self._max_size = max_size

    def check_l1(self, fact: str) -> bool:
        """Return True if fact should be SKIPPED (exact duplicate)."""
        h = self._normalize_hash(fact)
        return h in self._hashes

    def check_l2(
        self, embedding: list[float], threshold: float = 0.92
    ) -> tuple[bool, bool]:
        """Return (skip: bool, ambiguous: bool).

        - skip=True, ambiguous=False: cosine > threshold → definite duplicate
        - skip=False, ambiguous=True: 0.85 ≤ cosine ≤ 0.92 → need L3
        - skip=False, ambiguous=False: cosine < 0.85 → definitely new
        """
        low_threshold = config.MEMORY_DEDUP_SIMILARITY_LOW
        for cached_emb, _ in self._embeddings:
            sim = self._cosine_similarity(embedding, cached_emb)
            if sim > threshold:
                return True, False
            if sim >= low_threshold:
                return False, True
        return False, False

    def add(self, fact: str, embedding: list[float] | None = None) -> None:
        """Record a fact as seen."""
        h = self._normalize_hash(fact)
        self._hashes[h] = time.time()
        if embedding:
            self._embeddings.append((embedding, h))
        self._maybe_prune()

    def invalidate(self, fact: str) -> None:
        """Remove a fact from dedup cache (so it can be re-learned after delete)."""
        h = self._normalize_hash(fact)
        self._hashes.pop(h, None)
        self._embeddings = [
            (e, eh) for e, eh in self._embeddings if eh != h
        ]

    @staticmethod
    def _normalize_hash(text: str) -> str:
        normalized = re.sub(r"\s+", " ", text.strip().lower())
        normalized = re.sub(r"[^\w\s]", "", normalized)
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    def _maybe_prune(self) -> None:
        if len(self._hashes) <= self._max_size:
            return
        sorted_hashes = sorted(self._hashes.items(), key=lambda x: x[1])
        to_remove = len(self._hashes) - self._max_size
        for h, _ in sorted_hashes[:to_remove]:
            del self._hashes[h]
        self._embeddings = self._embeddings[-self._max_size:]


# Module-level dedup filter
_dedup_filter = DedupFilter(max_size=config.MEMORY_DEDUP_CACHE_SIZE)


# ── Embedding helper ────────────────────────────────────────────────────────


async def _compute_embedding(text: str) -> list[float] | None:
    """Compute an embedding vector via OpenAI API."""
    if not config.OPENAI_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
                json={
                    "model": config.MEMORY_DEDUP_EMBEDDING_MODEL,
                    "input": text,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["data"][0]["embedding"]
    except Exception:
        pass
    return None


# ── Top-level write pipeline ────────────────────────────────────────────────


async def extract_and_store(
    client: "MemoryClient",
    messages: list[dict],
    conversation_key_str: str,
    known_facts: list[str],
    request_id: str,
) -> None:
    """Full write pipeline: evaluate → dedup → store. Fire-and-forget.

    All errors are swallowed — this runs in the background after the
    response has already been sent to the user.
    """
    if not config.MEMORY_ENABLED:
        return

    # Find the last user message
    last_user = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                last_user = content.strip()
            break

    if not last_user:
        return

    # Format known facts for the data block
    known_block = "\n".join(f"- {f}" for f in known_facts) if known_facts else "(none)"

    data_block = (
        f"LAST USER MESSAGE:\n{last_user}\n\n"
        f"KNOWN FACTS (already in memory — do not extract):\n{known_block}"
    )

    # Step 1: Call evaluator LLM
    start_time = time.monotonic()
    facts: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(
            config.MEMORY_EVALUATOR_TIMEOUT_MS / 1000.0
        )) as http:
            resp = await http.post(
                f"{config.UPSTREAM_BASE_URL}/v1/chat/completions",
                headers={"Authorization": f"Bearer {config.UPSTREAM_API_KEY}"},
                json={
                    "model": config.MEMORY_EVALUATOR_MODEL,
                    "messages": [
                        {"role": "system", "content": _EVALUATOR_SYSTEM_PROMPT},
                        {"role": "user", "content": data_block},
                    ],
                    "response_format": {"type": "json_object"},
                    "thinking": {"type": "disabled"},
                    "temperature": 0.0,
                    "max_tokens": config.MEMORY_EVALUATOR_MAX_TOKENS,
                    "stream": False,
                },
            )
            if resp.status_code == 200:
                body = resp.json()
                content = body["choices"][0]["message"]["content"]
                # Safe JSON parse — strip markdown fences if present
                content = content.strip()
                if content.startswith("```"):
                    content = content.split("\n", 1)[-1].rsplit("\n```", 1)[0]
                result = json.loads(content)
                facts = result.get("facts", [])
    except Exception as exc:
        logger.debug("memory_evaluator_failed", request_id=request_id, error=str(exc))
        return

    if not facts:
        return

    duration_ms = round((time.monotonic() - start_time) * 1000, 1)
    logger.info(
        "memory_extracted",
        request_id=request_id,
        candidates=len(facts),
        duration_ms=duration_ms,
    )

    # Step 2: Dedup (L1 → L2 → L3)
    survivors: list[str] = []
    for f in facts:
        fact_text = f.get("fact", "").strip()
        if not fact_text or len(fact_text) < 10:
            continue

        # Security gate
        if _contains_sensitive(fact_text):
            logger.warning(
                "memory_secret_flagged",
                request_id=request_id,
                fact_snippet=fact_text[:80],
            )
            continue

        # L1: exact hash
        if _dedup_filter.check_l1(fact_text):
            continue

        # L2: embedding similarity (only for non-trivial facts)
        if len(fact_text) >= 30:
            embedding = await _compute_embedding(fact_text)
            if embedding is not None:
                skip, ambiguous = _dedup_filter.check_l2(embedding)
                if skip:
                    continue
                if ambiguous:
                    # L3: Graphiti search
                    try:
                        existing = await client.search_facts(fact_text, limit=3)
                        if existing:
                            # Check if the top result is very similar
                            top_fact = existing[0].fact
                            top_emb = await _compute_embedding(top_fact)
                            if top_emb is not None:
                                sim = DedupFilter._cosine_similarity(
                                    embedding, top_emb
                                )
                                if sim > config.MEMORY_DEDUP_GRAPHITI_SIMILARITY:
                                    continue
                    except Exception:
                        pass  # L3 unavailable → accept the fact

        survivors.append(fact_text)
        # Record in dedup cache
        if embedding is not None:
            _dedup_filter.add(fact_text, embedding)
        else:
            _dedup_filter.add(fact_text)

    if not survivors:
        return

    logger.info(
        "memory_deduped",
        request_id=request_id,
        before=len(facts),
        after=len(survivors),
    )

    # Step 3: Enqueue for background storage
    job = WriteJob(
        episode_name=f"conv-{conversation_key_str[:12]}-{request_id[:8]}",
        episode_body="\n".join(
            f"{i}. {fact}" for i, fact in enumerate(survivors, 1)
        ),
        reference_time=datetime.now(timezone.utc),
        group_id=config.GRAPHITI_GROUP_ID,
        request_id=request_id,
    )
    await client.enqueue_write(job)


# Module-level singleton — one MemoryClient per process
memory_client = MemoryClient()
