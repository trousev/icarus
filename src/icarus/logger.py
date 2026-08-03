"""Request/response logger that saves combined entries to the filesystem."""

import json
import os
import time
import uuid
import structlog
from datetime import datetime, timezone


class RequestLogger:
    """Logs every request/response pair to the filesystem for debugging.

    Each request gets a single .json file with everything:
    original body, modified body (after injection), timing, cache metrics.
    """

    def __init__(self, log_dir: str):
        self.log_dir = log_dir
        self.enabled = bool(log_dir)
        if self.enabled:
            os.makedirs(log_dir, exist_ok=True)
        self._log = structlog.get_logger("icarus.logger")
        # In-memory buffer: request_id -> {request data, start_time}
        self._pending: dict[str, dict] = {}

    def log_request(
        self,
        method: str,
        path: str,
        body: bytes,
        headers: dict,
        modified_body: bytes | None = None,
        injected: bool = False,
    ) -> str:
        """Log an incoming request. Returns a request_id."""
        request_id = uuid.uuid4().hex[:12]
        timestamp = datetime.now(timezone.utc).isoformat()

        original = self._safe_decode(body)
        modified = self._safe_decode(modified_body) if modified_body is not None else None

        entry = {
            "request_id": request_id,
            "timestamp": timestamp,
            "method": method,
            "path": path,
            "headers": self._sanitize_headers(headers),
            "original_body": original,
        }
        if modified is not None:
            entry["modified_body"] = modified
            entry["injected"] = injected

        self._log.info(
            "request",
            request_id=request_id,
            method=method,
            path=path,
            injected=injected,
        )

        # Hold in memory until response arrives
        self._pending[request_id] = {
            "entry": entry,
            "start_time": time.monotonic(),
        }

        return request_id

    def log_response(
        self,
        request_id: str,
        status_code: int,
        body: bytes,
        headers: dict,
    ) -> None:
        """Log the upstream response, merge with request entry, write to disk."""
        duration_ms = 0.0
        pending = self._pending.pop(request_id, None)
        if pending:
            duration_ms = round((time.monotonic() - pending["start_time"]) * 1000, 1)
            entry = pending["entry"]
        else:
            # Response without matching request (shouldn't happen)
            entry = {
                "request_id": request_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

        response_body = self._safe_decode(body)
        cache = self._extract_cache_metrics(body)

        entry["response"] = {
            "status_code": status_code,
            "duration_ms": duration_ms,
            "headers": self._sanitize_headers(headers),
            "body": response_body,
        }
        if cache:
            entry["response"]["cache"] = cache

        self._log.info(
            "response",
            request_id=request_id,
            status_code=status_code,
            duration_ms=duration_ms,
            **(cache or {}),
        )

        if self.enabled:
            self._write_entry(request_id, entry)

    # ── internal ──────────────────────────────────────────────────────────

    def _write_entry(self, request_id: str, entry: dict) -> None:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        dir_path = os.path.join(self.log_dir, date_str)
        os.makedirs(dir_path, exist_ok=True)

        file_path = os.path.join(dir_path, f"{request_id}.json")
        with open(file_path, "w") as f:
            json.dump(entry, f, indent=2, default=str, ensure_ascii=False)

    def _sanitize_headers(self, headers: dict) -> dict:
        sensitive = {"authorization", "api-key", "x-api-key", "cookie"}
        return {
            k: ("***" if k.lower() in sensitive else v)
            for k, v in headers.items()
        }

    def _safe_decode(self, body: bytes) -> str | dict:
        if not body:
            return ""
        try:
            return json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            text = body.decode("utf-8", errors="replace")
            return text[:10_000]

    def _extract_cache_metrics(self, body: bytes) -> dict | None:
        """Pull cache hit/miss token counts from an OpenAI-compatible response."""
        if not body:
            return None
        try:
            data = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Might be SSE stream — scan individual data lines
            return self._extract_cache_from_sse(body)

        usage = data.get("usage", {})
        if not usage:
            return None

        metrics = {}
        for key in (
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "prompt_cache_hit_tokens",
            "prompt_cache_miss_tokens",
            "cached_tokens",
        ):
            if key in usage:
                metrics[key] = usage[key]

        if "prompt_cache_hit_tokens" in metrics or "cached_tokens" in metrics:
            hit = metrics.get("prompt_cache_hit_tokens", metrics.get("cached_tokens", 0))
            miss = metrics.get("prompt_cache_miss_tokens", 0)
            total = metrics.get("prompt_tokens", hit + miss)
            metrics["cache_hit_ratio"] = round(hit / max(total, 1), 3)

        return metrics or None

    def _extract_cache_from_sse(self, body: bytes) -> dict | None:
        """Extract usage from the last SSE data chunk that contains it."""
        text = body.decode("utf-8", errors="replace")
        usage = None
        for line in text.split("\n"):
            if line.startswith("data: ") and line != "data: [DONE]":
                try:
                    chunk = json.loads(line[6:])
                    if "usage" in chunk:
                        usage = chunk["usage"]
                except json.JSONDecodeError:
                    continue
        if not usage:
            return None
        metrics = {}
        for key in (
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "prompt_cache_hit_tokens",
            "prompt_cache_miss_tokens",
            "cached_tokens",
        ):
            if key in usage:
                metrics[key] = usage[key]
        return metrics or None
