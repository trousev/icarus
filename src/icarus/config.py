"""Configuration loaded from environment variables."""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    UPSTREAM_BASE_URL: str = os.getenv("UPSTREAM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    UPSTREAM_API_KEY: str = os.getenv("UPSTREAM_API_KEY", "")
    MEMORY_INJECTION: str = os.getenv("MEMORY_INJECTION", "")
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    LOG_DIR: str = os.getenv("LOG_DIR", "./logs")
    LOG_PROMPTS: bool = os.getenv("LOG_PROMPTS", "").lower() in ("1", "true", "yes")


config = Config()
