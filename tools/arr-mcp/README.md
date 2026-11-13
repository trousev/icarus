# arr-mcp

MCP server (stdio) for the **home cinema**: Radarr (movies) and Sonarr (TV
shows). No external dependencies — just Node.js and the `*arr` HTTP API.

The server's main idea is that it doesn't "download on a whim". Search, collection,
queue, disks, quality profiles and root folders are **read-only**. Ordering a file
is one separate tool, `arr_add`, and it only runs with `confirm: true`, that is,
after an explicit "add/order/download" from the human.

## Tools (8)

| Tool | What it does |
|---|---|
| `arr_status` | whether Radarr/Sonarr is configured, whether they respond, which version |
| `arr_lookup` | search the catalog: year, rating, description, "already in collection"; orders nothing |
| `arr_collection` | what's already added: size, whether the file exists or is only monitored |
| `arr_queue` | download queue: percentages, remaining, errors |
| `arr_disk` | free space on the server's disks |
| `arr_quality_profiles` | quality profiles, read from the server |
| `arr_root_folders` | root folders, read from the server |
| `arr_add` | **ORDER A FILE**: add + search for a download, only with `confirm: true` |

The server doesn't invent profiles and folders: it takes them from `/api/v3/qualityprofile` and
`/api/v3/rootfolder` of the already-configured Radarr/Sonarr. If there's exactly one profile or folder,
it takes it; if there are several, it honestly asks you to pick an id/path rather than guessing.

## Configuration

Keys come **only from the environment**, not from a config file and not from git:

| Variable | Meaning |
|---|---|
| `ARR_RADARR_URL` | Radarr address, e.g. `http://192.168.1.10:7878` |
| `ARR_RADARR_KEY` | API Key: Radarr → Settings → General → API Key |
| `ARR_SONARR_URL` | Sonarr address, e.g. `http://192.168.1.10:8989` |
| `ARR_SONARR_KEY` | API Key: Sonarr → Settings → General → API Key |
| `ARR_TIMEOUT_MS` | timeout of a single request, default 8000, from 200 to 60000 |

You can configure only Radarr or only Sonarr: an unconfigured server is not a
crash, but a clear "not configured" response.

### In the Icarus panel — via a recipe

You don't need to configure anything by hand: **panel → MCP → Recipes → "Home cinema
(Radarr/Sonarr)" → "Add"**. The recipe fills in the command
(`node /opt/icarus/tools/arr-mcp/server.mjs`), the transport and the names of the four
variables; the human only enters the addresses and keys. You can fill in only the
Radarr pair or only the Sonarr pair — the second service will respond "not configured".

The server is personal, not shared: it arrives lazy (`lifecycle: lazy`), is turned on
for yourself with a single toggle and stores keys in `dataDir/mcp/credentials.json`
(0600), not in the server description. There's no longer a shared `mcp.arr` block in
`config.yaml`: the recipe replaces manual configuration.

### Where the server lives

The code is mounted into the agent container from the repository:
`tools/arr-mcp` → `/opt/icarus/tools/arr-mcp` (read-only). Radarr/Sonarr remain
separate services: this MCP is a client, not another container.
The address in `ARR_RADARR_URL` must be reachable **from the agent container**; if Radarr
runs on the host, that's the host's address on the docker network, not `127.0.0.1`.

## Two ways to run

**stdio** — the main one: pi itself starts the server inside the agent container, keys
come from the recipe in the panel (where they live in the 0600 credentials file).

**HTTP (Streamable HTTP)** — if it's more convenient to keep the server as a separate container
next to the arr stack:

```bash
ARR_RADARR_URL=http://radarr:7878 ARR_RADARR_KEY=... \
  node server.mjs --http 8799
# http://127.0.0.1:8799/mcp
```

By default only `127.0.0.1` is listened on. Exposing it is only deliberate
(`--host 0.0.0.0`) and necessarily with a token: `ARR_HTTP_TOKEN` makes the server
require `Authorization: Bearer <token>`. Otherwise anyone who can reach the port
can call `arr_add` — that is, order files.

## Verification

```bash
node tools/arr-mcp/test.mjs      # 17 checks against a fake Radarr/Sonarr on node:http
```

The tests don't go on the network and don't need a real Radarr: a local
HTTP server is started, `X-Api-Key`, `/api/v3/...` routes, refusal without
`confirm`, ordering with `confirm`, reading profiles/folders, 401, timeout and "not configured"
are checked.

The request shapes are verified against the Radarr/Sonarr OpenAPI (`src/Radarr.Api.V3/openapi.json`,
`src/Sonarr.Api.V3/openapi.json` in their repositories): `GET movie/lookup`,
`GET movie/lookup/tmdb`, `GET series/lookup`, `POST movie`, `POST series`,
`GET queue`, `GET diskspace`, `GET qualityprofile`, `GET rootfolder`,
`GET system/status`, with the key in the `X-Api-Key` header.

## Gotchas

- When adding, Radarr itself pulls metadata from TMDB by `tmdbId`, Sonarr — from
  TVDB by `tvdbId`. Without access to these databases, Radarr/Sonarr itself will make `arr_add`
  return a server error — that's its configuration, not the MCP's.
- `arr_add` with `search: false` only adds monitoring: the file is not ordered,
  and this is stated plainly in the response.
- On errors, `*arr` responses are sometimes an array `{propertyName, errorMessage}` and
  sometimes an object `{message}` — the server parses both and shows the service's text as is.
