# Icarus

Transparent proxy for OpenAI-compatible APIs with cache-safe memory injection.

## Quick Start

```bash
./script/setup    # Install dependencies, create .env
./script/update   # Sync dependencies
./script/server   # Start the proxy
```

## Configuration

Copy `.env.example` to `.env` and edit:

- `UPSTREAM_BASE_URL` — upstream OpenAI-compatible API (default: DeepSeek)
- `UPSTREAM_API_KEY` — API key forwarded to upstream
- `MEMORY_INJECTION` — static memory text injected as a second system message
- `HOST` / `PORT` — proxy listen address

## How It Works

The proxy intercepts `/v1/chat/completions` requests, parses the messages array, and injects a second system message (after any existing system message) containing the configured memory text. This simulates cache-safe memory injection without breaking the prompt structure.

Any API key is accepted by the proxy — authentication is passed through to the upstream service.

## Docker

```bash
docker compose up --build
```

## Logging

Requests and responses are logged to `./logs/` for debugging.
