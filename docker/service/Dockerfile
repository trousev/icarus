# Образ самого icarus. Код в него не запекается: ./script/server монтирует репозиторий
# по тому же пути, поэтому node запускает TypeScript напрямую и правки видны после
# `docker compose restart icarus` — без пересборки.
#
# Нужны всего три вещи: node (>= 22.19, чтобы исполнять .ts), git для панели памяти
# и клиент docker — им сервис делает `docker exec` в контейнер человека.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Клиент docker — статический бинарь из официального образа; docker compose сервису не нужен.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /repo
CMD ["node", "packages/service/src/index.ts"]
