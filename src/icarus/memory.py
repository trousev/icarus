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


# Module-level singleton — one MemoryClient per process
memory_client = MemoryClient()
