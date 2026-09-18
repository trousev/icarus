# Контейнер пользователя: песочница, в которой живёт pi.
# Ключи моделей лежат внутри (~/.pi/agent/auth.json) — так решили в интервью.
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

# pi ставим без lifecycle-скриптов: это рекомендованный самим pi режим
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

# В образе node:24-slim уже есть пользователь node с uid/gid 1000 — переиспользуем его,
# чтобы файлы примонтированной памяти не становились root-овыми на хосте.
RUN mkdir -p /home/node/.pi/agent /workspace \
    && chown -R node:node /home/node /workspace

USER node
ENV HOME=/home/node
WORKDIR /workspace

# Проверочный MCP-сервер: им тестируем мост pi → MCP без внешних сервисов
COPY --chown=node:node mcp/ /opt/icarus/mcp/

# AGENTS.md и icarus.md подкладывает сервис
CMD ["sleep", "infinity"]
