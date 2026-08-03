"""Configuration loaded from environment variables."""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # ── Upstream ──────────────────────────────────────────────────────────
    UPSTREAM_BASE_URL: str = os.getenv("UPSTREAM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    UPSTREAM_API_KEY: str = os.getenv("UPSTREAM_API_KEY", "")

    # ── Proxy ─────────────────────────────────────────────────────────────
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))

    # ── Logging ───────────────────────────────────────────────────────────
    LOG_DIR: str = os.getenv("LOG_DIR", "./logs")
    LOG_PROMPTS: bool = os.getenv("LOG_PROMPTS", "").lower() in ("1", "true", "yes")

    # ── Static memory (fallback when MEMORY_ENABLED=false) ────────────────
    MEMORY_INJECTION: str = os.getenv("MEMORY_INJECTION", "")

    # ── Dynamic memory (Graphiti knowledge graph) ─────────────────────────
    MEMORY_ENABLED: bool = (
        os.getenv("MEMORY_ENABLED", "").lower() in ("1", "true", "yes")
    )

    # Graphiti MCP server
    GRAPHITI_URL: str = os.getenv("GRAPHITI_URL", "http://localhost:8001/mcp")
    GRAPHITI_GROUP_ID: str = os.getenv("GRAPHITI_GROUP_ID", "alex")
    GRAPHITI_MAX_FACTS: int = int(os.getenv("GRAPHITI_MAX_FACTS", "30"))

    # Timeouts: reads are on the hot path (must not block), writes are background
    GRAPHITI_READ_TIMEOUT_MS: int = int(os.getenv("GRAPHITI_READ_TIMEOUT_MS", "500"))
    GRAPHITI_WRITE_TIMEOUT_MS: int = int(os.getenv("GRAPHITI_WRITE_TIMEOUT_MS", "10000"))
    GRAPHITI_WRITE_RETRIES: int = int(os.getenv("GRAPHITI_WRITE_RETRIES", "1"))

    # Model config for Graphiti's internal extraction (runs inside the container,
    # uses OpenAI API — not the upstream DeepSeek proxy)
    GRAPHITI_EXTRACTOR_MODEL: str = os.getenv(
        "GRAPHITI_EXTRACTOR_MODEL", "gpt-4o-mini"
    )
    GRAPHITI_EMBEDDING_MODEL: str = os.getenv(
        "GRAPHITI_EMBEDDING_MODEL", "text-embedding-3-small"
    )

    # ── Evaluator LLM (cheap model that decides "worth remembering?") ─────
    MEMORY_EVALUATOR_MODEL: str = os.getenv(
        "MEMORY_EVALUATOR_MODEL", "deepseek-v4-flash"
    )
    MEMORY_EVALUATOR_TIMEOUT_MS: int = int(
        os.getenv("MEMORY_EVALUATOR_TIMEOUT_MS", "10000")
    )
    MEMORY_EVALUATOR_MAX_TOKENS: int = int(
        os.getenv("MEMORY_EVALUATOR_MAX_TOKENS", "800")
    )

    # ── Deduplication ─────────────────────────────────────────────────────
    MEMORY_DEDUP_CACHE_SIZE: int = int(os.getenv("MEMORY_DEDUP_CACHE_SIZE", "1000"))
    MEMORY_DEDUP_SIMILARITY_HIGH: float = float(
        os.getenv("MEMORY_DEDUP_SIMILARITY_HIGH", "0.92")
    )
    MEMORY_DEDUP_SIMILARITY_LOW: float = float(
        os.getenv("MEMORY_DEDUP_SIMILARITY_LOW", "0.85")
    )
    MEMORY_DEDUP_GRAPHITI_SIMILARITY: float = float(
        os.getenv("MEMORY_DEDUP_GRAPHITI_SIMILARITY", "0.90")
    )
    MEMORY_DEDUP_EMBEDDING_MODEL: str = os.getenv(
        "MEMORY_DEDUP_EMBEDDING_MODEL", "text-embedding-3-small"
    )
    # OpenAI API key for embeddings (DeepSeek has no embeddings API)
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")

    # ── Conversation identity ─────────────────────────────────────────────
    MEMORY_DB_PATH: str = os.getenv("MEMORY_DB_PATH", "./data/memory.db")
    MEMORY_SNAPSHOT_COOLDOWN: int = int(
        os.getenv("MEMORY_SNAPSHOT_COOLDOWN", "1800")
    )

    # ── Lifecycle management ──────────────────────────────────────────────
    MEMORY_MAX_ENTITIES: int = int(os.getenv("MEMORY_MAX_ENTITIES", "5000"))
    MEMORY_MAX_EDGES: int = int(os.getenv("MEMORY_MAX_EDGES", "10000"))
    MEMORY_MAX_EPISODES: int = int(os.getenv("MEMORY_MAX_EPISODES", "2000"))
    MEMORY_TRIM_RATIO: float = float(os.getenv("MEMORY_TRIM_RATIO", "0.8"))
    MEMORY_MAINTENANCE_INTERVAL_HOURS: int = int(
        os.getenv("MEMORY_MAINTENANCE_INTERVAL_HOURS", "24")
    )
    MEMORY_MAINTENANCE_MAX_STALE_HOURS: int = int(
        os.getenv("MEMORY_MAINTENANCE_MAX_STALE_HOURS", "36")
    )
    MEMORY_TRIM_ALERT_PCT: int = int(os.getenv("MEMORY_TRIM_ALERT_PCT", "50"))
    MEMORY_USER_ENTITY: str = os.getenv("MEMORY_USER_ENTITY", "alex")
    MEMORY_EXPIRE_UNCONFIRMED_DAYS: int = int(
        os.getenv("MEMORY_EXPIRE_UNCONFIRMED_DAYS", "0")
    )
    MEMORY_SECRET_SCAN: bool = (
        os.getenv("MEMORY_SECRET_SCAN", "true").lower() in ("1", "true", "yes")
    )
    MEMORY_SECRET_SCAN_AUTODELETE: bool = (
        os.getenv("MEMORY_SECRET_SCAN_AUTODELETE", "").lower() in ("1", "true", "yes")
    )
    MEMORY_REGISTRY_FILE: str = os.getenv(
        "MEMORY_REGISTRY_FILE", "./data/memory_registry.jsonl"
    )


config = Config()
