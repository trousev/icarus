"""Request/response logger that saves to the filesystem."""

import json
import os
import uuid
import structlog
from datetime import datetime, timezone


class RequestLogger:
    """Logs every request/response pair to the filesystem for debugging."""

    def __init__(self, log_dir: str):
        self.log_dir = log_dir
        self.enabled = bool(log_dir)
        if self.enabled:
            os.makedirs(log_dir, exist_ok=True)
        self._log = structlog.get_logger("icarus.logger")

    def log_request(self, method: str, path: str, body: bytes, headers: dict) -> str:
        """Log an incoming request. Returns a request_id for pairing with the response."""
        request_id = uuid.uuid4().hex[:12]
        timestamp = datetime.now(timezone.utc).isoformat()

        entry = {
            "request_id": request_id,
            "timestamp": timestamp,
            "method": method,
            "path": path,
            "headers": self._sanitize_headers(headers),
            "body": self._safe_decode(body),
        }

        self._log.info("request", request_id=request_id, method=method, path=path)

        if self.enabled:
            self._write_entry(request_id, "request", entry)

        return request_id

    def log_response(self, request_id: str, status_code: int, body: bytes, headers: dict) -> None:
        """Log the upstream response paired with a request_id."""
        timestamp = datetime.now(timezone.utc).isoformat()

        entry = {
            "request_id": request_id,
            "timestamp": timestamp,
            "status_code": status_code,
            "headers": self._sanitize_headers(headers),
            "body": self._safe_decode(body),
        }

        self._log.info("response", request_id=request_id, status_code=status_code)

        if self.enabled:
            self._write_entry(request_id, "response", entry)

    def _write_entry(self, request_id: str, kind: str, entry: dict) -> None:
        """Write a log entry to a date-based directory."""
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        dir_path = os.path.join(self.log_dir, date_str)
        os.makedirs(dir_path, exist_ok=True)

        file_path = os.path.join(dir_path, f"{request_id}_{kind}.json")
        with open(file_path, "w") as f:
            json.dump(entry, f, indent=2, default=str)

    def _sanitize_headers(self, headers: dict) -> dict:
        """Remove sensitive header values."""
        sensitive = {"authorization", "api-key", "x-api-key", "cookie"}
        return {
            k: ("***" if k.lower() in sensitive else v)
            for k, v in headers.items()
        }

    def _safe_decode(self, body: bytes) -> str | dict:
        """Try to decode body as JSON, fall back to truncated string."""
        if not body:
            return ""
        try:
            return json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            text = body.decode("utf-8", errors="replace")
            return text[:10_000]  # Truncate large bodies
