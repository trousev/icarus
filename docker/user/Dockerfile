# User container: the sandbox in which pi lives.
# Model keys lie inside (~/.pi/agent/auth.json) — that is what was decided at the interview.
FROM node:24-bookworm-slim

ARG PI_VERSION=0.85.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      ca-certificates \
      curl \
      jq \
      less \
      procps \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# We install pi without lifecycle scripts: this is the mode recommended by pi itself
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

# The node:24-slim image already has a node user with uid/gid 1000 — we reuse it,
# so that files of the mounted memory do not become root-owned on the host.
# .icarus — a service directory: memory, sessions and prompts live in it, and it
# is not part of any workspace. The service creates the working folders.
RUN mkdir -p /home/node/.pi/agent /workspaces/.icarus \
    && chown -R node:node /home/node /workspaces

USER node
ENV HOME=/home/node
WORKDIR /workspaces

# Test MCP server: we use it to test the pi → MCP bridge without external services
COPY --chown=node:node mcp/ /opt/icarus/mcp/

# The service lays down AGENTS.md and icarus.md
CMD ["sleep", "infinity"]
