# The icarus image itself. Code is not baked into it: ./script/server mounts the repository
# at the same path, so node runs TypeScript directly and edits are visible after
# `docker compose restart icarus` — without a rebuild.
#
# Only three things are needed: node (>= 22.19, to execute .ts), git for the memory panel
# and the docker client — the service uses it to `docker exec` into a person's container.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The docker client — a static binary from the official image; the service does not need docker compose.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /repo
CMD ["node", "packages/service/src/index.ts"]
