FROM python:3.12-slim

WORKDIR /app

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy project files
COPY pyproject.toml uv.lock* ./
COPY src/ ./src/

# Install dependencies
RUN uv sync --frozen --no-dev

# Expose the proxy port
EXPOSE 8000

# Run the proxy
CMD ["uv", "run", "uvicorn", "icarus.proxy:app", "--host", "0.0.0.0", "--port", "8000"]
