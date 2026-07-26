# ── icarus — OpenAI-compatible Agent SDK wrapper ──────────────────────────
# Development:  docker compose up
# Rebuild:      docker compose up --build

FROM python:3.12-slim

LABEL org.opencontainers.image.title="icarus"
LABEL org.opencontainers.image.description="OpenAI-compatible API wrapper around the Claude Agent SDK"
LABEL org.opencontainers.image.version="0.1.0"

# ── system dependencies ──────────────────────────────────────────────────────
# git is required by the Agent SDK (it shells out to the claude CLI).
# ca-certificates for TLS to DeepSeek / Anthropic API.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# ── install dependencies (cached layer) ──────────────────────────────────────
WORKDIR /app

# Copy just the build config first so pip install is cached unless deps change.
COPY pyproject.toml ./

# Create a stub package so setuptools can satisfy `where = ["src"]`.
RUN mkdir -p src/icarus \
    && echo '__version__ = "0.1.0"' > src/icarus/__init__.py \
    && touch src/icarus/py.typed

# Install all dependencies from pyproject.toml (the stub icarus is installed
# too, but will be overwritten by the real source in the next step).
RUN pip install --no-cache-dir .

# ── install icarus source ────────────────────────────────────────────────────
COPY src/ src/
# Reinstall with the real package code (--no-deps keeps the cached deps).
RUN pip install --no-cache-dir --no-deps .

# ── runtime ──────────────────────────────────────────────────────────────────
# The agent working directory is mounted at runtime.  Default to the project
# root of whatever volume the user attaches.
WORKDIR /workspace

EXPOSE 9090

# Bind to 0.0.0.0 so the host (and any chat UI) can reach the server.
# All other settings are picked up from environment variables.
ENTRYPOINT ["icarus", "serve", "--host", "0.0.0.0"]
