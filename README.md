# Icarus

An agent for a family of 2–5 people: **good at ordinary conversation**, but capable of everything grown-up — reading and editing files,
searching the internet, calling MCP tools, and **remembering**. The entrances are a Telegram bot and a web panel
(`chat.trousev.pro`); the OpenAI-compatible endpoint stays in the service for future clients and debugging.
All entrances lead to one person's memory.

It's built as a thin service on top of [pi](https://github.com/earendil-works/pi) — an open agent harness.
We don't write our own agent loop: pi lives in the user's container, and icarus only turns a conversation
(Telegram, web chat, OpenAI client) into a live pi session and back.

## What it looks like

```
Telegram / web chat ──► icarus ──docker exec + JSONL──► pi in the person's container
                          │                                  │
                          │                                  ├─ persona          (icarus.md)
                          │                                  ├─ memory core      (memory always at hand)
                          │                                  ├─ extraction       (facts → shelves → git)
                          │                                  ├─ web search       (web_search, web_fetch)
                          │                                  ├─ subagents        (subagent: queue, up to 4 at once)
                          │                                  ├─ MCP              (pi-mcp-extension)
                          │                                  ├─ skills           (SKILL.md in ~/.pi/agent/skills)
                          │                                  └─ escalation       (fast / strong / vision)
                          ├─ control panel (chat: dialogs, images, tracing, workspace files; memory and skills — via settings)
                          └─ OpenAI-compatible API (/v1) — kept for future clients
```

## What already works

- conversation in Telegram (text, photos, voice messages), in the web panel (dialogs, streaming, markdown, images),
  and via `POST /v1/chat/completions` with streaming and cancellation;
- memory between conversations: the core in the prompt, background parsing after a lull, a git commit on every parse;
- isolation: its own container, its own memory, its own key per person; shared memory — only on an explicit request;
- workspaces: a person has several working folders (`/workspaces/<name>`), each with its own `AGENTS.md`;
  the service stuff — memory, sessions, attachments, persona — sits alongside, in `/workspaces/.icarus`, and doesn't enter any
  folder. A "private" workspace is read-only: memory isn't updated from it;
- attachments from chat: images go to the model natively, files land in `incoming/`;
- web search and MCP servers without touching code; in the panel there's an **MCP** section: a person adds
  their own server, enables it for themselves, and optionally shares it with the others;
- **artifacts**: a shared library `/artifacts` with artifact folders, "me/family" rights, and
  none/read/write/admin levels (family access is off by default); every artifact has an
  internal link in the panel, and a public one is created on request and opens with or without the panel
  (see "Artifacts");
- subagents: the model hands out tasks to separate pi processes — with their own context, queue, and
  a ban on nesting; the children return only the output, and the turn waits for all of them;
- model escalation: chatter, search, and reading — on the fast one; hands-on work (bash, edits, MCP) — on the strong one; images — on the sighted one;
- web panel (Icarus Control Panel): chat with dialogs, streaming, step tracing, images,
  and a file panel for the working folder;
  behind an SSO proxy. Memory and skills open via settings on top of the chat: view, search, roll back
  a commit, forget a line, delete a whole file — and your own skills: write, edit, delete,
  enable or disable, share with others, and bring back by rollback (skills are under git too, and
  a saved skill reaches Icarus on the next turn);
  MCP — as a separate section: add a server, enable it for yourself, share it, and configure access;
  installation keys are edited by the admin right in the panel — without `ssh`, manual `.env` edits, and a rebuild;
- pi skills: a `SKILL.md` in a person's `~/.pi/agent/skills` works like a native pi skill — the model sees
  the catalog in the prompt and reads the body on demand. Authoring is in the panel (or via the `skill_writer` tool),
  there's no synchronization with an external chat. An enabled skill is visible to Icarus, a disabled one sits in the panel and under
  git, but doesn't make it into pi's catalog; a skill can be shared — for the others it arrives disabled;
- Telegram: the bot answers to acquaintances from `telegram.mapping`, understands text, photos, and voice messages (an image
  goes to the model natively, a voice message is transcribed by Whisper) — the answer arrives via live message edits;
  the commands `/compact`, `/stop`, `/stats`, `/clear`, `/rename`, `/archive`, and `/skills` the bot handles itself, without
  sending them as a reply to the model. `/archive` is the same as the archive button in the panel: the conversation goes
  to the archive and in Telegram, where the topic is deleted together with the messages (Telegram can't bring it back —
  a conversation returns from the archive only in the panel). The conversation's location in Telegram (`chatId` and `threadId`)
  the bot stores in `chats.json`, so archiving from the panel removes the topic even after a service restart.
  An hour of silence — and Icarus himself sums it up and closes the pi session; the next reply raises it again
  from the compressed history (see "Sessions and compaction").

## Launch

```bash
# 1. dependencies and local configs (run after clone and after every git pull)
./script/update
# it will create config.yaml from config.example.yaml — edit people, models and paths;
# provider keys go into .env (sample .env.example, not committed to git)

# 2. the user container image (./script/server can build it too)
docker build -t icarus-user:dev docker/user/

# 3. the stack: ./script/server builds docker-compose.yml from config.yaml and brings it up
./script/server                     # icarus on :8081, logs in the console (Ctrl-C takes the stack down)
./script/server -d                  # same in the background: survives both the terminal and a reboot
./script/server --down              # take the stack down

# the control panel is the domain root (in prod https://chat.trousev.pro/):
# sign-in is ordinary, through the SSO proxy, and it opens only the logged-in person's memory.
# Locally without a proxy, tell config.yaml who to pretend to be: panel.devUser: <id>
```

`./script/server` doesn't start a process — it **builds `docker-compose.yml`** from `config.yaml`:
the icarus service and one container per person. Icarus itself also runs
in a container (the `icarus-service:dev` image from `docker/service/`, built automatically).
The lifecycle is owned by docker, not by the service: `restart: unless-stopped` brings containers back
both after a crash and after a machine reboot, and a change of image, mounts, or environment
recreates them on the next launch. The generated `docker-compose.yml` doesn't make it into git;
code edits arrive after `docker compose restart icarus` — the repository is mounted.

The launch order was chosen for less downtime during an update: first `docker compose build`
and building the user's image — **while the old containers are still running** — and only then `up`,
which only has to recreate what changed. That's why building the image by hand (step 2) isn't mandatory:
`./script/server` does it itself, and `--build` repeats the build without cache.

First launch after migrating from the old scheme: shut down icarus running as an ordinary process on
the host (`node packages/service/src/index.ts …`) — it holds :8081 and recreates containers past
compose. `./script/server` will once remove containers without the project label and bring them up again.
## Config

The config is `config.yaml` in the root (a sample is `config.example.yaml`, the working file never lands in git):

```yaml
apiKey: icarus-local-token      # Bearer for the OpenAI-compatible endpoint (/v1)
# url: https://chat.trousev.pro/     # external address of the control panel: the one Icarus names in chat
                                    # (locally defaults to http://localhost:8081)
dataDir: ~/icarus-data          # memory, sessions and people's directories
sessionIdleMinutes: 60          # an hour of silence: Icarus sums up and shuts down the pi session

panel:                          # control panel: who to let in
  userHeader: Remote-User       # SSO proxy header it uses to name the logged-in person
  # devUser: probe              # local run without a proxy; do not set in prod

models:                         # shared models: escalation hands out the tier
  - { provider: deepinfra, id: deepseek-ai/DeepSeek-V4.1-Flash, thinking: low, tier: fast }
# auth: { deepinfra: env:DEEPINFRA_API_KEY }   # usually unnecessary: the key is picked up from .env
env: { TZ: Europe/Dublin }      # the person's timezone: Icarus uses it to compute the date and date memory
# no custom mounts: the container only sees /workspaces and the Maple install
mcp: {}                         # shared MCP servers; personal and shared ones are in the panel

users:                          # people: ids only
  - probe
  - probe2

# telegram:                     # bot: telegram username → id from users (token is in .env)
#   mapping:
#     '@trousev': trousev       # in yaml the "@" must be quoted: otherwise it won't be parsed
#     '@vita': vita
# speech:                       # voice messages from Telegram: what to transcribe with (key is in .env)
#   language: ru                # Whisper at DeepInfra by default; `speech: none` disables it
```

The `deepinfra` provider is not built into pi, so its description (base address, protocol, key,
model metadata) lives in `packages/service/src/providers.ts` and travels into the container's
`models.json`. All that's left in `config.yaml` is the choice: provider, model id, thinking
level and tier.

Keys live in `.env` in the root (a sample is `.env.example`, the working file never lands in git
and is created by `./script/update`):

```bash
DEEPINFRA_API_KEY=...     # provider key from models: besides the environment, it goes into auth.json
TAVILY_API_KEY=...        # web-search key: DeepInfra has no server-side search
BRAVE_API_KEY=...         # optional alternative: ICARUS_SEARCH_PROVIDER=brave
```

Search also works with no keys at all: You.com has a free MCP profile without
registration — 100 requests a day. The router calls it on its own, like a regular provider
(`you-free`); it can only search, and reading pages (`web_fetch`) needs a key.
To turn it off — `ICARUS_SEARCH_FREE=off`.

The provider key from `models` for which a value was found in `.env` is substituted automatically:
there's no need to duplicate it in `config.yaml`. The `auth:` and `env:` blocks remain for overriding
and for providers that aren't in the known list (`PROVIDER_ENV` in
`packages/service/src/config.ts`). The environment beats the file: `export DEEPINFRA_API_KEY=…`
overrides the line in `.env`. After editing `.env`, `./script/server` is enough — compose recreates
the containers; the values themselves aren't written into `docker-compose.yml`, only the path to the file goes there.

### Keys in the panel

Раздел **«Ключи»** (`/panel/keys`) правит те же секреты без `ssh` и пересборки стека:
провайдеры моделей, поиск, Telegram и любые свои переменные. Ключей MCP здесь нет:
у каждого MCP своя коллекция секретов, ей рулит раздел **MCP** (см. ниже). Видят и открывают его
только админы — люди с `admin: true` в `users:`:

```yaml
users:
  - id: trousev
    admin: true      # can edit the keys of the whole installation
  - id: vita         # a regular person: she has no "Keys" section
```

An old config without objects keeps working: by migration, `trousev` alone counts as admin,
the rest are regular people. An explicit `admin: false` takes the flag away from him too.

How it works:

- values are **not shown** in the browser: the panel only returns "set / not set" and the last
  four characters, and accepts a new value;
- the panel rewrites `.env`, preserving comments and others' lines, and puts its own edits in
  **`keys.json`** next to it (never lands in git, mode 600). `keys.json` beats `.env`: the deploy
  pours GitHub secrets back into `.env`, and the panel's settings must survive that;
- "Remove" is a `removed` in `keys.json`, not a hope that the deploy won't bring the line back:
  a removed key is no longer picked up, even if the value remains in `.env`;
- after saving, the service **re-reads** `.env`, `keys.json` and `config.yaml`, rewrites
  `auth.json`/`mcp.json` for people and marks the next pi session as new. So a new
  key works from the next reply, not from the next deploy; the Telegram bot token is
  the exception — it needs a service restart;
- fresh values travel into the pi process via `docker exec -e`, so there's no need to recreate
  containers after a key change;
- above the key list is a summary of search and extraction routing, and in each row
  are counters for seven days: how much the provider returned and how many times it refused. These are **router
  attempts**, not a person's requests: a fallback Linkup → Tavily is two attempts. The counters
  live in `search-usage.json` next to `search-router.json`, one per day per record; the eighth
  day is erased on the next write, so the file doesn't grow.

People are described by id and an admin flag: from the id are derived the container name (`icarus-user-probe`),
the directories `dataDir/users/probe` and the pi session id. In Telegram the same id comes from
`telegram.mapping`, and the HTTP client sends it in the `x-icarus-user-id` header. Models
and keys are shared; MCP is the shared ones from `config.yaml` plus personal and shared ones from the panel, so
a new person is one line.

Variables for extensions travel into `env:`: `ICARUS_EXTRACT_AFTER_MS` and `ICARUS_EXTRACT_MODEL` —
parsing the conversation into memory, `ICARUS_SWEEP_AFTER_HOURS` — the memory cleanup interval (by default
a day after the conversation, `0` disables cleanup entirely). Cleanup tidies the shelves: it merges
twin files about the same thing into one, splits overgrown files by topic, moves closed things out of
`identity.md` into projects. It doesn't touch the logs and doesn't put them in the prompt — only their presence:
a log is a feed of events, not a memory shelf.

### MCP on demand

MCP servers are lazy by default: `lifecycle: lazy` — the server doesn't connect at startup, and its
tools don't go into every conversation's prompt. In `AGENTS.md`, for each such server a hint with
`mcp_connect` is generated, and the `description` explains to the model when the server is needed.
`lifecycle: eager` is a deliberate choice for servers that are always needed; their tools
hang in the prompt permanently. `hidden: true` is a service server: it exists for everyone and is always on,
and it isn't in the panel, because there's nothing for a person to turn off.

The bridge connects via the `pi-mcp-extension@1.8.0` package: it's precisely from this version that the agentic
`mcp_connect`/`mcp_status` appeared; without them a lazy server can't be brought up from a conversation. In 1.5.0 there was only
the manual `/mcp:start`, and a lazy server's tools remained invisible.

```yaml
mcp:
  homeassistant:
    url: http://10.0.0.16/api/mcp
    secrets: [Authorization]                     # только имя: значение вводится в панели
    lifecycle: lazy                              # дефолт; можно не писать
    description: "Умный дом: свет, климат, сцены" # подсказка модели, в mcp.json не едет
```

Секреты у каждого MCP свои — и у общего сервера из `config.yaml` тоже. В конфиге стоит
только **имя** (`secrets`: у HTTP это заголовки, у stdio — переменные окружения);
значение человек вводит сам в панели, кнопкой «Настроить доступ», и оно ложится в
`credentials.json` под его `userId`. Поэтому `headers`/`env` в `mcp:` — это несекретные
настройки (адреса, порты, режимы), а подстановок `${VAR}` и `env:` там больше нет: ключ
из `.env` был бы один на всех. Пока человек не ввёл свой ключ, сервер помечен «ждёт
доступа» и не попадает ни в его `mcp.json`, ни в `AGENTS.md`. Команду и адрес общего
сервера панель не меняет — это config.yaml; своё у него только секреты и включённость.

Так же живут встроенные умения. Артефакты — сервер `artifacts` с `hidden: true` и `lifecycle: lazy`:
полные инструкции лежат в `instructions` MCP-хендшейка и появляются у модели только после
`mcp_connect`, а в промпте всегда есть лишь короткое описание-триггер. Заговорил человек об
артефактах — инструкции «развернулись»; молчит — контекст не занят.

### MCP from the panel: your own server in a couple of minutes

What's in `config.yaml` is the **shared** servers of the stack: echo, Maple, Home Assistant. Maple here
is a service server (`hidden: true`): it isn't in the panel, you can't turn it off for yourself, and it keeps
its computation logs in the conversation's working folder, not in a separate directory. Everything a person added themselves
lives not in the config but in `dataDir/mcp/`:

- `registry.json` — server descriptions, who the owner is and who it's shared with;
- `credentials.json` — keys and OAuth tokens, mode `0600`: these are secrets just like `auth.json`.

The **MCP** section in the panel can do everything needed for "I brought a cool MCP for TODO":

- **добавить** сервер: адрес (streamable HTTP или старый SSE) либо команду stdio, которая
  живёт в контейнере человека;
- **включить / выключить** — это личный переключатель на каждого человека. Выключенный сервер
  не попадает ни в `mcp.json`, ни в `AGENTS.md`: он есть в панели, но в разговоре его нет и
  контекст он не занимает. Включённый остаётся `lifecycle: lazy`, поэтому его инструменты
  не висят в каждом промпте, пока сервер не понадобится;
- **поделиться** или оставить только себе. Расшаренный сервер приезжает остальным
  **выключенным** — включают сами. Ключи и OAuth-доступ при этом не копируются: каждый
  настраивает свой, иначе «поделиться сервером» означало бы «поделиться своим аккаунтом»;
- **проверить** — панель сама делает `initialize` и `tools/list` и показывает, сколько
  инструментов отдал сервер (для stdio честно говорит, что проверка будет при подключении);
- **настроить доступ** — свой ключ к серверу, в том числе к общему из `config.yaml`.
  Ключи не показываются другим и не копируются при шаринге; «Очистить доступ» убирает их.

Один рецепт — сколько угодно серверов: id подбирается по имени (`opds`, `opds-2`), а
несекретные настройки правятся у каждого свои, кнопкой «Изменить». Так можно держать два
OPDS-каталога одновременно — Gutenberg и домашний Calibre — с разными `OPDS_URL`, не
перетирая друг друга ни в `mcp.json`, ни в `AGENTS.md`.

Above the server list is a catalog of **recipes** — ready-made descriptions for the servers that are
needed most often: Proton Mail via Bridge, a calendar over CalDAV, Proton Drive files via
rclone, Obsidian notes, books from an OPDS catalog, RSS, Dublin weather, Kinozal (Radarr/Sonarr),
Video to blog post and Home Assistant. The "Add" button opens
a regular form with the command, transport and non-secret settings already filled in (ports,
addresses): the person only has to enter the keys. Each recipe says when the server is
needed, what must exist outside (a paid plan, a running Bridge, rclone, HA), what to do
step by step and where to look if the server didn't come up. There are no secrets in the recipes — only the names
of variables and hints on where to get them; the names are saved together with the server, so
"Configure access" knows what to ask even after the form is closed. The date the package and
command were checked is next to each recipe.

Kinozal is added the same way: **panel → MCP → Recipes → "Kinozal (Radarr/Sonarr)" →
"Add"** → enter the addresses and API keys (you can fill in only the Radarr pair or only
the Sonarr pair) → save. The server arrives in the container lazily and exposes eight tools:
seven only read (search, collection, queue, disks, quality profiles, root folders,
status), and ordering a file is a separate `arr_add` with `confirm: true`, i.e. after an explicit
"add". No manual `mcp.arr` block in `config.yaml` is needed for this.

Video to blog post is added the same way: **panel → MCP → Recipes → "Video to blog post" →
"Add"** — and it doesn't ask for keys, because it runs on the same `DEEPINFRA_API_KEY` as
Icarus itself. The server exposes four tools: `video_to_blog` (a link to a video → a Markdown post
with a title and sections), `video_transcribe` (transcription only, into text with timecodes),
`blog_from_transcript` (a ready transcript → a post, without re-transcribing) and `blog_status`
(what's ready to work). A five-minute video costs about $0.002: `yt-dlp` downloads the audio, Whisper
on DeepInfra transcribes for $0.0002 per minute, DeepSeek rewrites it into a post. Audio longer than
24 MB the server splits itself, and a transcript longer than ~45 thousand characters it runs through chunked compression,
so an hour-long talk doesn't blow out the context. The binaries (`yt-dlp`, `ffmpeg`) aren't baked
into the image — the server downloads them into its service directory on the first call.

The criterion by which the catalog is assembled: **MCP makes sense if you use it at least once
a week**. Everything else is tools that hang in every conversation and take up context;
that's why there are no banks and billing here. Recipes are data, not magic:
`packages/service/src/mcp/recipes.ts`. If a server requires someone else's infrastructure, the catalog
says so in words: for example, Proton Bridge only listens on `127.0.0.1` on its own machine,
and Icarus's container sees itself under `127.0.0.1`, so you need the host's address and port forwarding.

All the authorization that modern MCPs come with is supported:

| Method | What the panel does |
|---|---|
| no authorization | just connects |
| key / headers | stores personal `Authorization`/`X-API-Key` and any other headers; for stdio — environment variables |
| OAuth 2.1 | discovery per RFC 9728 / RFC 8414, PKCE S256, `resource` (RFC 8707), refresh token; login — via the "Connect" button in the browser |
| ready-made client_id | uses it, the secret is each person's own |
| Dynamic Client Registration | registers the client itself (RFC 7591), if the server can do it |
| Client ID Metadata Document | if the server supports CIMD and the panel has a public HTTPS address |
| manual endpoints | for stubborn servers: authorization, token, registration, issuer are set in the form |

The OAuth flow is driven by the service, not by pi: pi is in a container without a browser, and its interactive
authorization is designed for the TUI. The service does discovery and exchanges the code for a token, but
**doesn't put the token in `mcp.json`**. What goes there is a reference to the service's local proxy
(`http://icarus:<port>/mcp-proxy/<key>`): on each pi request the service checks the token's expiry,
silently refreshes it via `refresh_token` if needed, and only then goes to the MCP.
That's why a five-minute access token (the kind Black Forest issues, for example) doesn't expire
in the middle of a live thread, and a `401` from the server is cured by a retry with an already fresh token.

The proxy is the same service, so it's reachable by people's containers under the name `icarus` in
the compose network. If the service lives under a different name or outside compose, the base is overridden by the
`ICARUS_MCP_PROXY_BASE` variable (for example, `http://10.0.0.2:8081`). The
"Reconnect" button is needed only if the `refresh_token` itself died.

If that happened, the person isn't left with an `invalid_token` in the trace: the proxy
adds `reauth_url` to the error, the web chat shows a "Reconnect" card, and
Telegram — a line with a link to `/panel/mcp?server=<id>`. The panel highlights
the needed server and scrolls to it.

OAuth needs the panel's public address (`url:` in the config): the callback goes to
`<url>/panel/mcp/oauth/callback`, and the CIMD document — to
`<url>/panel/mcp/oauth/client-metadata.json`. If the panel sits behind an SSO that doesn't let
this path through without login, CIMD servers won't be able to download it; for them DCR and a ready-made
`client_id` remain. Servers that only support CIMD require an exception for this page in the proxy:
in prod it lives in `/etc/nginx/custom/chat.trousev.pro.mcp-oauth.conf` — two `location =`
(metadata and callback) without `auth_request`, while the rest of `/panel/mcp` stays behind the SSO.

### Mimicking Claude: servers with a redirect_uri allowlist

Some authorization servers only accept pre-registered return addresses. That's how
Any.do works: it allows callbacks from Claude, ChatGPT, Antigravity and the local
`http://localhost:<port>/callback`, and rejects `<url>/panel/mcp/oauth/callback` — both in
`/register` and in `/authorize`, even when the client is registered via CIMD. For a web panel that
lives at a public address, this is a dead end: "any OAuth client" from their
documentation actually means "any one from our list".

The **"Mimic Claude"** checkbox in the server form bypasses the list without breaking OAuth:

- the client is registered with the address `http://localhost:47821/callback` — the same loopback that
  Claude Code uses (RFC 8252 allows loopback for native clients, and the port doesn't matter);
- the browser genuinely goes to that address, but nobody is going to listen on it: the person
  sees a connection error, but the address bar keeps `?code=…&state=…`;
- the panel shows a three-step instruction and a field for pasting. The service handles the address itself: it checks that the `state` was started by this person and this server, compares the origin with the
  expected `redirect_uri` and only then exchanges the code for a token. The password doesn't get into the panel
  and isn't forwarded anywhere.

Limitations: it needs dynamic client registration (otherwise a `client_id` registered
for loopback must be entered into the form by hand), and the link lives 10 minutes. The mode also removes
the requirement of a public HTTPS address for the panel to log in. In the card, such a server is marked with a "mimicry" badge.

pi skills live in the person's `~/.pi/agent/skills` (the directory is mounted by the service: `dataDir/users/<id>/pi-agent/skills`).
pi shows the model names and descriptions, and reads the body of `SKILL.md` on demand. They're written in the panel,
in the "Skills" section, or via the `skill_writer` tool from a conversation; the directory is a git repository, so skills have
the same history and the same rollback as memory. There's no sync with an external chat, and that's deliberate.

Skills have the same access model as MCP:

- **enabled / disabled** — a personal toggle. A disabled skill the panel moves to `.disabled/`:
  the file stays in the repository and in plain sight, but pi doesn't find it, so it occupies neither the prompt
  nor the context;
- **sharing** is only for the owner. A snapshot of the skill lands in `dataDir/skills/shared`, is mounted
  for everyone as `/workspaces/.icarus/shared-skills` read-only, and the enabled paths reach pi
  via `settings.json`. The recipient sees someone else's skill **disabled** and enables it themselves; they
  can't edit it — the author makes the edits, and they arrive as a snapshot on save;
- **one's own and shared ones don't mix**: the personal directory `~/.pi/agent/skills` stays personal, shared
  skills are an additional source, not a copy in someone else's directory.

## Control panel
**Icarus Control Panel** lives on icarus itself (`<url>/` redirects to `/panel`, and that one — to `/panel/chat`).
It is first and foremost a chat: conversations on the left, the feed and composer on the right, and behind a button in the header — the files of the current conversation's working folder. Memory, skills, MCP and keys
open in a wide panel over the chat, without leaving the page; the conversations stay
in place. Only the admin can see "Keys" — see the "Keys in the panel" section above.

### Workspaces

A workspace is the agent's working folder: `/workspaces/<name>`, each with its own `AGENTS.md`, so
behavior differs between them. Service data (memory, sessions, attachments, persona) lives nearby, in
`/workspaces/.icarus`, and is not part of any folder — a person's files remain their own.

- **"Talk"** (`talk`) — the default: new chats land here and conversations from a deleted workspace return here too;
- **"Private"** (`private`) — mounted read-only, and pi does not get a single write tool (neither `write`/`edit` nor a shell), and background memory parsing is not loaded in it at all. Memory is **visible** but does not change: a person can talk about something they do not want to leave a record of;
- **your own** — created on the selection screen: name, folder, its own `AGENTS.md`. Deleting removes the
  workspace from the list and returns its conversations to "Talk", but does not touch the folder on disk.
- creating and deleting is `mkdir`/writing the registry: the container is not recreated, live
  sessions are not torn down. For the API, a workspace is selected with the `x-icarus-workspace` header.

### Chat

- conversations are grouped by date, searched by title, paginated with infinite scroll in batches of 30,
  a new chat is created with a button in the sidebar;
- **the model comes up with the conversation name**: after the first turns, a cheap model reads the start
  of the conversation and names it by meaning, rather than a snippet of the first phrase. The heuristic from the first message
  remains as a fallback if the model does not respond; a name chosen by the person (`/rename` or the pencil
  in the list) is never touched again. The new name arrives as a separate summary event, so it does not delay
  the response;
- the response arrives as a stream, tool steps are collected into a collapsible trace (`MEMORY`,
  `SEARCH`, `HOME`, `MCP`…), rather than dumped into the text;
- markdown understands headings, lists, quotes, code, `~~strikethrough~~` and links;
- **attachments**: a paperclip, drag&drop or pasting from the clipboard — up to 8 files and 10 MB total.
  Files land in the person's `incoming/`, the model sees images natively, and they remain in the history
  as chips and thumbnails;
- **images**: the model inserts `![what is on it](/workspaces/.icarus/incoming/file.jpg)`, and the panel renders it.
  Local files are served only from `incoming/` and working folders (`/workspaces/<name>/…`) — that is how
  Maple plots and everything the agent drew itself reach the chat; external `http(s)` images are loaded by the
  browser itself. A link `[file name](…/estimate.pdf)` to a local file becomes a download
  chip — the same path that goes to Telegram as an attachment. If the person asks for a path — the model
  writes the path as text, without an image;
- **files at hand**: a button in the header opens the working folder tree of the current
  conversation on the right. Folders expand on click, a file is shown in a preview below: markdown —
  as markdown, images — as an image, text — as text, the rest is honestly offered for download.
  Next to download is **"To chat"**: it inserts the file's relative path into the input field (at the caret,
  or at the end if the field has not been touched yet) and does not overwrite what has already been typed. The tree
  refreshes itself after the agent's turn, and the panel width, preview height and whether it is
  open are stored in the browser. The panel does not let you go deeper: only one workspace,
  no `..` and no symlinks going outside;
- **deleting from the tree**: a trash icon appears on the row. A file asks for confirmation, a non-empty
  folder too (along with all its contents), but an empty folder is deleted immediately, without a question. The server
  will not delete a non-empty folder without an explicit `force`, it does not touch the workspace root at all, and the root
  `AGENTS.md` is protected: those are the agent's instructions, and without them the workspace loses its rules;
- the channel travels to pi via the `ICARUS_CHANNEL` variable: in the web chat the persona knows about markdown images,
  in Telegram there is no such block — images are not sent there yet;
- the chat uses the same pi sessions as Telegram: the same container, the same memory, its own conversation per dialogue.
- **subagents are visible live**: under the `SUBAGENTS` step there is a list of children — who is working, what they are doing, who
  is queued, who crashed; in the history this list remains after the turn;
- **you can stop the response midway**: while a turn is in progress, "■" takes the place of "send" — it sends
  abort, and the running subagents go down along with the turn;
- **commands — as in Telegram**: type `/` — a palette opens above the field. It contains its own commands
  (`/compact`, `/stop`, `/stats`, `/clear`, `/rename`, `/skills`, `/help`) and pi's commands: skills,
  prompt templates and extension commands. `/compact` and `/clear` are pi RPC (`compact` and `new_session`),
  so pi itself compresses the context and starts over; `/rename` changes the chat name in `chats.json`, and it is
  immediately visible in the header and sidebar. `/clear` does not throw away the feed: old messages remain above
  the "Context cleared" divider, and after a reload they are reassembled from the chain of sessions.
  `/compact` and `/stats` also work in the middle of a response. Selecting from the palette — arrows and Enter (or a click),
  the command name with arguments is appended to the field; a pi command travels into the conversation as an ordinary message.
  The response of the other commands is a service chip in the feed: it is not written to the session file, so after
  a feed reload it is not visible — unlike Telegram, where it remains a separate message;
- **all of a person's conversations are visible**, not only those started in the panel: `chats.json` is the common registry
  of the web chat, Telegram and the API. It contains only `id`, `title`, `createdAt`, `channel`, `conversationId`,
  `sessions` — the chain of pi sessions (appears after `/clear`, so that old messages remain
  history and the new session becomes the current context) — and `lastTurn`, the channel of the last message
  (the session file does not distinguish inputs, so it is written by whoever accepted the message);
  the panel reads the preview and time of the last message from `sessions/*.jsonl` — and only for the
  page of the list that it displayed;
- **pagination**: `GET /panel/api/chats?limit=30&cursor=…` returns a page and `nextCursor`, and the sidebar
  loads the next one on scroll. Sorting is by `createdAt`, so the order does not jump from a new
  message; search goes by the title from the registry, without reading histories;
- the panel **continues** a Telegram conversation: it has the same pi session and the same history file as the bot,
  so a turn from the panel is a turn of the same conversation (the header signs the channel of the last message:
  `lastTurn` in `chats.json`). The response stays in the panel: it is not sent to Telegram, and
  the panel says so. Conversations via the API are **read-only**: their client owns the history
  itself, so `chat/send` and `chat/abort` refuse there;
- **migration of the old format** runs at startup and is idempotent: `chats.json` is normalized
  (`preview`/`updatedAt` are dropped, `channel` and `conversationId` are filled in), the old file
  is saved once as `chats.json.bak`; `session-index.json` is moved into the registry and deleted;
  everything already in `sessions/` is appended to the registry; old sessions without `conversationId`
  land there as `session:<id>`. A corrupt `chats.json` is set aside as `.corrupt-*` rather than overwritten.


### Memory

Memory is edited line by line: you can see which commit each entry came from, superfluous ones are checked off
and leave in a single commit, the file can be deleted entirely or downloaded. History — per file, with a diff and
rollback.

### Skills

A skill is a directory with `SKILL.md` (`pirate-mode/SKILL.md`) and, if needed, bundle files alongside.
In the panel you can see a list of skills with their descriptions, and an open skill is edited in full: name, description,
the instructions themselves and a "hide from the model" checkbox (then pi calls the skill only with the `/skill:name` command).

- **saving is a commit** in the skills repository: the history is visible in the panel, a rollback returns the skill
  along with its bundle, and deletion first commits what has not yet made it into git — otherwise a rollback would return
  a single `SKILL.md` without the files the person added by hand;
- **after saving, the skill reaches Icarus on its own.** pi reads the skills directory once when the process starts,
  so the panel marks the person's resources as updated: the ongoing turn finishes on the old set,
  and the next response brings pi up again (see `SessionRegistry.bumpResources`);
- **enabled / disabled** — a toggle in the list and in the editor. Disabling does not delete the skill:
  it moves to `.disabled/` inside the same repository, remains in the history and is editable, but pi
  does not see it until the person enables it back;
- **share** — a checkbox on your own skill. A snapshot lands in `dataDir/skills/shared` and is mounted
  for the others read-only; for them the skill appears disabled, they enable it themselves, and the
  author's edits arrive as a snapshot on save. Someone else's skill in the panel is read-only. A skill is
  text, so everything written in it will be seen by those who can see it; keys and tokens are not
  put here — for those there is MCP and the "Keys" section;
- **`skill_writer`** — an Icarus tool: the model provides the name, description and instruction, and the tool itself
  creates the canonical `SKILL.md` directory (and bundle files) in the personal directory or in `.pi/skills`
  of the current folder. That is how a skill is created from a conversation, without waiting for the person to open the panel;
- **the name and description are validated against the spec** of Agent Skills: the name — lowercase Latin letters, digits
  and a hyphen, the description is required. Without a description pi would skip the skill silently — the panel will say so
  and will not save;
- **"write it for me"** — you describe the idea in one phrase, the model assembles the name, description and instruction.
  The draft lands in the editor, and the file and commit are made by "Save": the person sees what will travel to Icarus
  before saving. The model responds one-shot, without tools, session and skills (`--no-tools --no-session
  --no-skills`) and in the same place where the keys and pi live — that is, in the person's container. The name from the response
  is reduced to the rules, a taken one gets a number, and if there are no Latin characters in it, the panel
  will leave the field empty with a note — the instruction will not be lost.

The panel also considers flat `*.md` files in the root of the pi directory to be skills: it shows and edits them too, but creates new
ones as directories — a directory can hold scripts and references that a skill points to.

The panel has no password: the person is named by the **SSO proxy** behind which it stands. In prod that is nginx with
Authelia — it substitutes `Remote-User` from the `/api/verify` response and overwrites everything the client sent
itself, and `icarus` reads this header (`panel.userHeader`) and checks that the person is in `users`.
Two consequences follow:

- **the icarus port must not look outside past the proxy.** Whoever reaches it directly can
  name themselves anything: in prod port `8081` listens only on `127.0.0.1`, and nginx with Authelia
  exposes it outward;
- locally, where there is no proxy, the panel will let you in only with `panel.devUser: <id>` in `config.yaml` — the service
  complains in the log about this, because that must not be done in prod.

One-time links and keys are no longer in the panel: old links with `?t=…` work, the parameter is
simply ignored, and the proxy decides entry. The panel names Icarus the tool `get_control_panel_link`.

### Artifacts

Artifacts are a **global library** `<dataDir>/artifacts/`, one for the whole family. It is mounted
into each person's container as `/artifacts`, so the list is shared, rather than "my files in a workspace".
An artifact is a folder `/artifacts/<slug>/` with a single index file:

| File | Type |
|---|---|
| `index.html` | HTML page |
| `index.md` | Markdown document |
| `index.png` / `index.jpg` / `index.svg` | image |

And always `index.ai.md` — a short description for the AI: an H1 heading, what the artifact is about, what is inside,
what can be changed. The other files (styles, images, fonts) lie alongside; links inside HTML are
relative. `index.ai.md`, `.artifact.json` and `.folder-acl.json` are not served outside: the panel
reads them via the API, where permissions have already been checked.

```text
/artifacts/plan-na-chetverg/
  index.md            # what the human sees
  index.ai.md         # what the AI reads
  images/standup.png
  .folder-acl.json    # owner and permissions
  .artifact.json      # publicId, if the link was already requested
```

**pi creates artifacts itself**, but with one caveat: the folder and permissions are created by `artifact_new`, and the files
are written by ordinary `write`. Without this, writing to `/artifacts` is impossible — the generic folder-guard checks
`.folder-acl.json` on every folder and blocks `read`/`write`/`edit`/`grep`/`find`/`ls` where
a person is not allowed, and `bash` with an absolute path to `/artifacts` is forbidden entirely, so that permissions are not bypassed.
The `artifacts` MCP (`tools/artifacts-mcp/`) reads `index.ai.md` instead of HTML and issues a link;
tools: `artifact_list`, `artifact_read`, `artifact_new`, `artifact_link`, `artifact_check`.

**Permissions are a matrix of "subject × level".** A folder has an owner and two subjects:

- **me** (`me`) — the owner of the artifact;
- **family** (`family`) — everyone else.

Levels: **none ⊂ read ⊂ write ⊂ admin**. `none` — the artifact is absent from the panel and MCP lists, it
cannot be read or changed; this is the level for very personal things (the folder name may still be
visible in the shared listing of `/artifacts`, but the contents are inaccessible). `write` can also read, `admin` —
also change permissions, delete the artifact and make a public link. By default `me=admin`,
`family=none`: a new artifact is personal until the owner opens it to the family in the "Share" dialog.
The owner always controls their artifact, even if they set themselves `read` — otherwise one could
lock oneself out forever; they cannot set themselves `none`, otherwise the artifact would disappear from their
list. Permissions are changed in the panel with the "Share" button: in one dialog — my level, the family
level and the public link; the panel, MCP and folder-guard read the same `.folder-acl.json`.

**Version history is transparent but mandatory.** Each artifact is a small git repository
inside its own folder. The person knows nothing about git: in the panel "History" opens as a side panel,
a click on a version shows it in the preview, and "Restore this version" changes the artifact only after
confirmation. Snapshots are made by the imperative layer, not the AI:

- before a `write`/`edit` into the artifact, the pi extension records the "as it was" state (if there is no history yet);
- after a successful `write`/`edit` — a commit with a clear name (`write index.md`, `edit style.css`);
- at the end of each turn, `turn_end` picks up everything that came through MCP or other tools;
- at startup the service creates a history for all existing artifacts.

The service `.folder-acl.json` and `.artifact.json` are not versioned: a content rollback must not change
permissions and the public link. `.git` itself is hidden from the panel, public routes and the agent's file
tools (folder-guard blocks `.git` and service files). "Restore" does not rewrite the history: it makes
a new commit that returns the tree to the selected version, so old versions remain available.

**Artifact edit chat.** Next to "History" is a chat icon button: it opens a side panel with
a conversation about this artifact. This is not a separate agent and not a second kind of chat — the same web conversation with
the same session file, but tagged with the artifact. By this tag the registry launches pi **in the folder
`/artifacts/<slug>`**, not in a workspace, and the persona assembles a prompt about the specific artifact: where its
main file is, that `index.ai.md` is a description for the AI, that the history and permissions are managed by the system, and that other
folders must not be touched. In the general chat list such a conversation appears as "Edit · <title>" and continues
from the same place. The button is available only with the `write` permission: to others it would promise an edit that the
server would reject anyway. One artifact — one conversation; opening it again returns the same one.
The commands in the side panel are the same as in the big chat: a line starting with a slash first goes to
`/panel/api/chat/command`, and only a server refusal sends it to pi as an ordinary message. Therefore
`/clear` here really starts a new context: old turns remain above the "Context cleared" divider,
and the conversation stays with its artifact — `/clear` detaches the context, not the folder.

**Panel.** "Artifacts" is a separate door in the chat sidebar, on the same level as "Settings".
The list is global: all available artifacts with type, size and owner. On the right is a view:
HTML in a sandbox, an image on a dark background, markdown with dark typography. There too are search and a row of
icons: "Share" (permissions and link), "History", the edit chat, full screen without the panel,
download and delete to `artifacts/.trash/` (not forever). There is no workspace switcher anymore:
an artifact does not belong to a workspace.

**Public link** — `/a/<artifact>/<publicId>/`. `publicId` is random 18 bytes in a hidden
`.artifact.json`, not the folder name: someone else's artifact cannot be guessed, and the link can be revoked
by switching public access to "no access" in the "Share" dialog (then `publicId` is deleted). The internal link that Icarus gives by default is —
`/panel/artifacts?artifact=…`; a public one is created only on a direct request and requires `admin`.
By default a public link opens the artifact **inside the panel**; `?bare=1` serves the same
artifact without the panel, and a direct path to `index.html`/`index.png` — the file itself. HTML and SVG are served
with `Content-Security-Policy: sandbox`, so the artifact's code cannot reach the SSO cookie and the panel API.
Old links `/a/<person>/<workspace>/<artifact>/<id>/` redirect to the new address.

For a link to be **truly public**, the SSO proxy must let `/a/` through without
`auth_request`: the service itself does not require entry, but nginx with Authelia closes the whole domain by
default. In prod this is a separate `location /a/` with `auth_request` disabled — like the MCP OAuth callback.
If this is not done, the link will open only for those logged in.

The service moves old artifacts from `workspace/artifacts/` into the shared library on first startup:
the owner becomes the workspace's author, the ACL — `me=admin, family=none`, the publicId is preserved.
The old public address continues to work via a redirect.

It is enabled by a line in `mcp:` — it is already in `config.example.yaml`; in an existing `config.yaml`
it must be added (or update the config from the example). The service mounts the server code into the container
itself, no separate installation is needed.

**Instructions are hidden until first mention.** The MCP is marked `hidden: true` (it is not in the MCP panel,
it cannot be disabled) and `lifecycle: lazy`: its tools and full rules do not hang in every conversation.
Only a short trigger — the server description — travels in `AGENTS.md`. Once a person mentions artifacts,
the model calls `mcp_connect`, gets `instructions` in the MCP handshake and works by them. So "hiding
instructions" does not mean "the model will not learn about them": it learns exactly when it is needed.

### Look locally

`./script/panel` brings up the panel without building the stack: the same code, the same `dataDir`, the same files and git.
The chat in it works if people's containers are already up — the panel talks to the same pi sessions as
the service, but does not create containers itself.

```bash
./script/panel                    # http://127.0.0.1:8099/panel, the first person from users
./script/panel --user probe2      # view another person
./script/panel --with-model       # also "write for me" in the skill editor
./script/panel --port 8099 --config /path/config.yaml
```

The person in the local panel is named by `panel.devUser` (there is no SSO proxy nearby), and it listens only on
the loopback: a panel without entry is not exposed outside. If there is no stack running — the chat will honestly reply that the session is
unavailable, and memory and skills will keep working. The "write it for me" button appears with `--with-model`:
then a one-shot question goes to the person's container, as in the service, and without the flag there is no block in the editor
at all, so as not to promise something that does not exist.

## Subagents

The model can hand out work to separate pi processes — the `subagent` tool. Why: context. Six
search queries of two or three result pages each in one conversation will drown the window; the child reads the pages
itself and returns only the conclusion. The parent pays for the result, not for the road to it.

- **The call is blocking.** The tool does not return until the last task is finished: while
  subagents are working, there is no turn and the response to the person does not leave. No "launched it and ran off" — pi has no
  background tools, and that is rather a good thing here.
- **A queue, not a swarm.** Up to 40 tasks are accepted per call, but `ICARUS_SUBAGENT_CONCURRENCY`
  run at the same time (4 by default, ceiling 8), the rest wait in the order of declaration.
  Four is not from greed: at Anthropic, in their research agent, the lead launches 3–5 subagents
  in parallel, and they call "50 subagents for a simple question" their early mistake; OpenClaw keeps
  the same numbers nearby — 4 on the main line and 8 on children. The ceiling of 8 is counted for the whole process: even
  if the model calls the tool twice in one message, there are still no more than eight children.
- **No nesting.** A child is launched with `ICARUS_SUBAGENT_DEPTH=1`, the tool is not
  registered for it, and `--exclude-tools subagent` and `--no-extensions` are a safety net. A subagent will not
  launch a subagent: that is not "more work" but a bill for tokens.
- **Roles.** `scout` — fast, reads files and looks at directories; `researcher` — web search, reading
  pages and files (`read`, `find`, `ls`); `worker` — everything Icarus has: eight built-in
  pi tools (including `grep`/`find`/`ls`, which are not in pi's default set),
  web search, time and the panel link. MCP tools are deliberately not given to the worker: their names
  come from servers dynamically, and a subagent with access to the home is someone else's buttons, not "another pair of hands".
  The model for a child is taken by level:
  `ICARUS_MODEL_FAST` / `ICARUS_MODEL_STRONG` — the service puts them into the container itself from `models`, so
  the levels do not have to be duplicated in `env`.
- **Everything is visible.** In the web chat, under the `SUBAGENTS` step is a live list of children: who is working, what they are doing, who is
  queued, who crashed and why; after the turn it remains in the history. In Telegram the status line shows
  "⚙ agents 2/5 · researcher: web_search: amazon.ie".
- **You can stop it midway.** In the panel — the "■" button in place of "send", in Telegram — `/stop`.
  The abort reaches the tool, which kills the children's processes (SIGTERM, after 3 s SIGKILL) and the queue.
- **A new message interrupts the turn.** In Telegram nothing stops a person from writing on top: the bot clears
  pi's message queue, sends abort, waits for `agent_settled` and starts a new turn. If the new turn itself
  decides to call subagents — it will.
- **Persona and memory do not concern children.** A child gets its own system prompt and only those
  extensions the role needs (web search for the researcher). The persona, memory parsing and cleanup are not
  loaded in it: otherwise every child would leave a trace in the conversation's memory. Skills do work —
  and they are convenient for handing out tasks like "go through this skill".

The limits live in the container's `env:` in `config.yaml`:

```yaml
env:
  ICARUS_SUBAGENT_CONCURRENCY: '4'        # concurrent children (1–8)
  ICARUS_SUBAGENT_MAX_TASKS: '40'         # tasks per call (queue ceiling)
  ICARUS_SUBAGENT_TASK_TIMEOUT_MS: '300000'  # one task: longer — timeout
  ICARUS_SUBAGENT_BUDGET_MS: '900000'     # whole call: longer — the rest of the queue is skipped
```

The default command for launching a child is `pi` from `PATH`; `ICARUS_SUBAGENT_PI` overrides it if in
the image the binary is named differently. The extension code is `packages/extensions/subagent.ts`; the service copies
it into `~/.pi/agent/extensions` along with the rest, no separate configuration is needed.
## Commands

| command | what it does |
| --- | --- |
| `./script/update` | installs dependencies via pnpm and lays out configs from the examples; in CI — strictly by lockfile |
| `./script/test` | runs tests (`node --test`) across all `packages/**/*.test.ts` — by walking the tree, so a test from a new directory doesn't silently fall out of the run; docker and a model aren't needed, `ICARUS_E2E=1` enables the scenario ones |
| `./script/lint` | `tsc --noEmit` + `eslint` + `shellcheck` over `script/*` (can be run separately: `./script/lint tsc`, `./script/lint eslint`, `./script/lint shell`) |
| `./script/server` | assembles `docker-compose.yml` from `config.yaml`, first rebuilds the images, then brings up the stack via `docker compose up`; `-d` sends it to the background, `--build` builds without cache, `--down` shuts the stack down |
| `./script/panel` | brings up the local control panel (`--user`, `--port`, `--config`); listens only on `127.0.0.1`; chat works if people's containers are already up |
| `./script/redeploy` | production deploy to trousev.pro: the workflow calls it, by hand — already on the host (`--no-cache` builds the images from scratch) |

The same commands are available through pnpm: `pnpm test`, `pnpm lint`, `pnpm start`. Installation is only
`./script/update`: with pnpm, `pnpm update` means something else (updating dependency versions).

## Sessions and compaction

A pi session is one conversation in a person's container. While the person writes, it lives; after
`sessionIdleMinutes` (an hour by default) of silence, icarus considers the conversation finished and does
two things in order:

1. **compacts** the context — `compact` in pi: the model retells the old part of the conversation, and the retelling
   is appended to the session file. After that, it and the recent turns go into the prompt, not the whole history: the conversation
   continues more cheaply and doesn't hit the window;
2. **kills the process** of pi. The person's container stays up, the history — in `/workspaces/.icarus/sessions`.

The next message brings the session back up from the same file — now with the compacted history. While the person
is talking, there is no compaction: the cleanup skips busy sessions, and a window that overflows mid-conversation pi
compacts itself. A compaction failure doesn't leave the session hanging: we close it as is — the history is intact, the session file
is append-only. One rule for all inputs — Telegram and the OpenAI client.

## Telegram

The bot is the main entry to the same Icarus: the same memory, the same container, its own conversation per chat. It doesn't
create people itself: it recognizes a person by username from the message and takes the id from `telegram.mapping` in `config.yaml`
(the very id that's in `users`; the memory directories and the container name depend on it). To a stranger the bot replies
with a hint, not a conversation: without the map it's unclear whose memory and whose container this is.

```yaml
telegram:
  mapping:
    '@trousev': trousev        # telegram username → person id from users
```

There's no need to put the token in the config: it's taken from `.env` (`TELEGRAM_BOT_TOKEN`, sample `.env.example`).
No token or an empty `mapping` — the bot doesn't come up, and the service works as before. The mapping
is also accepted as a separate `telegram_mapping` key — exactly as it reads to the eye. A username in yaml
must be quoted: reserved constructs start with `@`, and `@trousev: trousev` won't
parse ("Plain value cannot start with reserved character @").

The design is simple: long polling with `getUpdates` — no webhook needed, no domain, no certificate. Its own conversation
per chat and topic (`telegram-<chat id>`, in a group — with the person's id: otherwise two people in one group would fight
over one pi session; with topics — also with its number). The reply arrives by editing a single message:
there's no placeholder with an ellipsis, the very first portion of the reply creates the message, and then it's edited until
the end. What Icarus is busy with is no longer written in words in the message — that's shown by the Telegram
"action" (the client's list is closed, see `chat-action.ts`): "choosing a sticker…" while the model thinks,
"sending a file…" on file tools, "sending a location…" when the subagents have scattered
across tasks, and an honest "typing…" as soon as text flows to the person. The action lives in the
client for about five seconds, so the bot repeats it while the turn is going, and falls silent when the turn is waiting
for the person. A reply longer than 4096 characters is cut into several messages. Messages of one
chat (and topic) are processed one at a time, different chats don't wait for each other.

The queue isn't a sentence: if the person writes on top of an ongoing turn, the bot interrupts it. The pi message
queue is cleared, an abort goes out, the bot waits for `agent_settled` and only then sends the new message —
which is why the subagents that held the turn die, and the reply already comes to the new message. While the turn
is coming to a stop, the person sees "typing…", not silence: there's no placeholder with an ellipsis in the chat, and the flowing
text creates the message itself.

### Topics in Telegram

If Threaded Mode is enabled in the bot, the person creates topics themselves — with the "All Messages" button in the chat
header; the bot no longer has a separate command. One topic — one conversation: its own history, its own pi
process and its own `/compact`. The bot learns about a new topic from the service message `forum_topic_created` and
simply assigns messages to it — it no longer needs to create topics for the person.

`/rename Name` renames the current conversation. If it's running in a topic, the topic name in
Telegram changes too; in any case the new name goes into `chats.json`, and the panel shows it in the list of
conversations.

The bot gives the conversation its name itself, just like the panel: after a turn a cheap model names the conversation by the first
turns, and the topic is renamed with the same name (previously Telegram lived off a snippet of the first phrase,
because no one asked the model — now the bot asks). The name chosen by the person in the Telegram
client isn't lost, meanwhile: the bot remembers the service message `forum_topic_edited` as a manual name, and
the conversation in the panel starts being called the same as the topic is named. To avoid sending `editForumTopic` on
every title refinement — Telegram leaves a rename service message in the topic — the bot remembers
the name it set itself in the `topicTitle` field of the `chats.json` record. A name corrected in the panel
reaches the topic by the same route: the panel's title summary for the bot is another source.

The chat root (the general feed) isn't a topic: there the conversation is named only in `chats.json`, there's nothing to change.

With the general feed ("All Messages") there's a subtlety that made conversations get lost: when a person
starts typing **in the feed**, the Telegram client creates a topic itself, and the message itself arrives to the bot as
a root message — without `message_thread_id`. Previously the bot considered such a message root: the reply went to the
feed, and the fresh topic stayed empty, and the conversation split in two. Now the bot remembers the fresh topic
(`FRESH_TOPIC_WINDOW_MS`, a minute) and assigns the first message from the feed to it: the reply, "typing…" and
`conversationId` — like for a topic.

Telegram sometimes rejects sending to a topic ("message thread not found"; in May 2026 this broke topics
in private chats for everyone) or, worse, silently puts the message in the general feed while replying `ok: true`. So the bot
verifies the response (`message_thread_id`/`is_topic_message`), and on refusal repeats it as a reply to the person's
message — the anchor carries the reply into the same topic — and if that didn't work either, it honestly writes to the chat root
that there will be no reply in the topic. A reply isn't silently lost.

**Markup.** The model replies in markdown, and Telegram without `parse_mode` shows it as is —
with asterisks, hashes and backticks. There's only one live mode here: `MarkdownV2` requires
escaping a dozen and a half characters, and one "2+2=4" in the reply takes down the whole send
("can't parse entities"). So the reply goes out as HTML, and the markup for it is assembled by
`packages/service/src/telegram/format.ts`: bold, italic, strikethrough, spoiler, inline code,
code blocks with highlighting, quotes and links. What Telegram doesn't have — headings, lists and tables —
we draw with what it does: a bold line, bullets and a monospaced block with aligned columns.
The reply comes in chunks, so unfinished markup isn't an error: an unclosed pair stays
text, an unclosed code block is closed at the end. And if Telegram did reject the markup after all,
the bot repeats the same message without tags: the reply matters more than italics.

What's under the hood: one conversation (chat root or topic) — one `conversationId`
(`telegram-<chat id>-<thread id>`), and therefore its own pi session with its own process inside the **shared**
person's container and its own history file in `<dataDir>/users/<person>/sessions`. An hour of silence
(`sessionIdleMinutes`) — the session is compacted by the model and the process is killed; the next message brings pi
back up from the same file, and the conversation continues from the retelling. The same mechanism survives a restart of the
service and a re-creation of the container: the history lies on the host, not in the process's memory. Messages of one
conversation go strictly one at a time, different conversations don't wait for each other.

**Photos.** An image goes the same route as an attachment from the OpenAI-compatible chat: the bot fetches the file from Telegram (in
the Bot API that's two requests — `getFile` for the path and the file itself), puts it in the person's `incoming/` and hands it to the
model natively, while the path to the file rides in the message — the tool can find the image by it too. The caption to the photo
becomes the text of the message; a photo without a caption Icarus just sees as an image. An image sent as a document (that's how
screenshots without Telegram's compression are sent) is saved under its own name.

**Voice messages.** The model doesn't hear sound, so a voice message is first transcribed by a separate request
to the provider — the `/audio/transcriptions` method, on DeepInfra that's Whisper — with the same key as the models.
The message goes out with the note "[voice message, 12 s]": Icarus must know this is dictation, not text with
punctuation. While transcription is going, the message shows "🎤 listening to voice message". No provider key —
the bot honestly says it doesn't handle voice messages; to turn it off entirely — `speech: none`.

```yaml
speech:                        # what to transcribe voice messages with; by default Whisper at DeepInfra
  language: ru                 # hint to the recognizer, optional
```

Video, stickers, audio files and documents that aren't images, the bot doesn't handle and says so
in words. A too-large attachment (the Bot API serves no more than 20 MB) it also honestly names as the reason.

**Files from the reply.** Icarus doesn't have a separate "send a file" tool: a link in markdown is itself
a request to show a file. `![graph](/workspaces/talk/chart.png)` goes out as a **photo** (up to 10 MB),
`[estimate](/workspaces/talk/estimate.pdf)` — as a **document** with a human name in the header (up to 50 MB).
An image larger than 10 MB and a GIF go out as a document: as a photo Telegram would recompress them into a static frame.
The link is removed from the text, and the file arrives after it as a separate message; if the file isn't there or is
larger than 50 MB, the person gets "⚠️ Couldn't send the file" with the reason, not silence. The paths are the same as
for images: `incoming/`, `/workspaces/<folder>/…` and `/artifacts/<slug>/…` (according to the artifact's permissions).

The bot has seven commands, and each handles its own thing, without sending the command as a message into the conversation:

- `/compact [wish]` — sum up now: pi compacts the context with its `compact` RPC. The wish
  goes to pi as an instruction for the retelling: "keep the math". It also works in a quieted-down conversation —
  we'll bring the session up;
- `/stop` — abort the turn, along with the running subagents. It goes past the message queue: the turn
  it cancels is in progress right now, and waiting for it to finish would mean cancelling nothing;
- `/stats` — how many messages, tokens and money were spent and how much is occupied in the context;
- `/clear` — start the conversation from a clean slate: pi creates a new session via the `new_session` RPC, and
  the service appends it to the `sessions` chain. Old messages remain in the feed up to the "Context cleared"
  separator, the new context starts after it; memory isn't touched — that's what we tell the person, otherwise he'll decide
  he wiped the memory;
- `/rename <name>` — rename the current chat: the name goes into `chats.json` and is visible in the panel; if
  the conversation is running in a Telegram topic, the topic is renamed too;
- `/skills` — what can be called in the chat: the person's skills, prompt templates and extension commands
  (pi itself serves their list, see `get_commands`);
- `/help` — the same menu that Telegram shows via the button.

`/start`, which Telegram sends itself on the first visit, replies with a greeting. A line with a slash that the bot
doesn't know gets a hint — but only if it's one word: `/fix-tests run it` and
`/skill:brave-search` go to pi as an ordinary message, because pi has its own commands, and there's no reason to take
them away from the person.

In the web chat the same seven commands: the parsing and texts are shared, they live in `sessions/commands.ts`, and they're launched by
`POST /panel/api/chat/command`. `/compact` and `/clear` go to pi with the same RPCs there too, and `/rename`
changes the name in `chats.json`. The palette takes pi's commands from the same `get_commands` as `/skills`.
## Checks

On every PR and on every push to `main`, [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs:
`./script/lint` and `./script/test` on node 22 and 24. Locally it's exactly the same:

```bash
./script/lint && ./script/test
```

`eslint` comes with ESLint's own baseline rule set (`js.configs.recommended`) and with node globals
for `.js`/`.mjs` — otherwise the typescript-eslint rules catch neither `no-duplicate-case` nor
`no-fallthrough` nor `no-useless-assignment`. `shellcheck` is only needed by the `shell` step: a machine
without it gets a warning and a skip, while CI will fail, because the ubuntu image on GitHub has it
out of the box.

`main` is protected by branch settings, not by persuasion:

- direct push is forbidden, including the admin one (`enforce_admins`) — PRs only;
- merging a PR is blocked until all four CI checks go green (the `lint` and `test` jobs
  on node 22 and 24);
- the PR branch is not required to be up to date with `main`: the checks run on the PR itself, and
  catching up with `main` is the author's concern (`strict` in required status checks is off deliberately);
- force-push and deletion of `main` are forbidden.

The job names and the matrix are part of this protection. Change the `name` in `ci.yml` — update the required status
checks in the branch settings, otherwise the PR will hang forever on "Expected — Waiting for status to be
reported".

There is no build: the code runs directly as TypeScript (`node src/index.ts`), so `tsc` works
only as a checker and writes nothing to disk. TypeScript is still 6.x — typescript-eslint doesn't yet
support the 7th branch, so when updating dependencies it's worth keeping this limitation in mind.

## Deploy

Prod is `trousev.pro`: a checkout in `~/deployments/icarus` and a `docker compose` stack that
`./script/server -d` brings up.

A push to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):
GitHub SSHes into `trousev.pro` as `trousev`, updates the checkout (`git fetch` +
`git reset --hard origin/main`) and calls [`./script/redeploy`](script/redeploy). That
installs node if the host's is older than 22.19 (the official build in `~/.local/share/icarus`),
runs `./script/update`, moves the secrets into `.env`, edits `config.yaml` via
`render-config.ts` (people, port, `dataDir`, `apiKey`, Telegram mapping, quiet hour), brings up the stack and fails if
`/healthz` doesn't confirm that the service and the people's containers are in place. By hand it's the same:
`ssh trousev@trousev.pro`, `cd ~/deployments/icarus`, `./script/redeploy` (`--no-cache`
builds the images from scratch).

`config.yaml` and `.env` on the host survive the deploy — they don't make it into git. But
edits to tracked files are wiped by `git reset --hard`: code on prod changes only through PRs.

Keys set in the panel (the "Keys" section, admin only) live in `keys.json` next to
`.env` and are **stronger than it**: the deploy pours the GitHub secrets back into `.env`, but the values
from the panel remain in force. This means that a `DEEPINFRA_API_KEY`
changed in the panel won't be overwritten by the GitHub secret; to get the GitHub secret back, the key in the panel must
be removed. `render-config.ts` preserves the admin flag for those who remain in `ICARUS_USERS`,
and grants it to new people by migration only to `trousev`.

Prod's settings live in GitHub:

| name | where | what |
| --- | --- | --- |
| `ICARUS_USERS` | `production` environment variable | people separated by spaces or commas — from it the `users:` in `config.yaml` is assembled |
| `ICARUS_DNS` | optional `production` environment variable | container DNS servers (`docker.dns`); not set — the default from `script/redeploy`, `none` — remove |
| `ICARUS_URL` | optional `production` environment variable | external address of the control panel (`url`): it's what Icarus tells the person in chat; not set — `script/redeploy` puts `https://chat.trousev.pro/`, locally the default is `http://localhost:8081` |
| `ICARUS_SESSION_IDLE_MINUTES` | optional `production` environment variable | how many minutes of silence mean "the conversation is over", after which icarus compresses the pi session and shuts it down; not set — `script/redeploy` puts 60 (an hour) |
| `ICARUS_MCP_PROXY_BASE` | optional `production` environment variable | base of the local OAuth-MCP proxy, which goes into `mcp.json`; not set — `http://icarus:<port>/mcp-proxy` (the service container's name in compose) |
| `ICARUS_TELEGRAM_MAPPING` | optional `production` environment variable | which Telegram person belongs to whom: `@trousev:trousev,@vita:vita` (the values are ids from `ICARUS_USERS`). From it the `telegram.mapping` in `config.yaml` is assembled; `none` — remove the mapping, empty — don't touch |
| `ICARUS_API_KEY` | `production` environment secret | Bearer for the OpenAI-compatible endpoint (`apiKey` in `config.yaml`) |
| `DEEPINFRA_API_KEY` | `production` environment secret | provider key — goes into `.env` |
| `TAVILY_API_KEY` | `production` environment secret | web search key — also goes into `.env` |
| `TELEGRAM_BOT_TOKEN` | `production` environment secret | bot token from @BotFather — goes into `.env`, from there `config.yaml` reads it |
| `DEPLOY_HOST` | `production` environment secret | `trousev.pro` |
| `DEPLOY_SSH_SECRET` | `production` environment secret | private key `github-actions-deploy@icarus`; its public part is in `~/.ssh/authorized_keys` on the host |

The secrets live specifically in the `production` environment, and it has the rule "only the
`main` branch is allowed": the repository is public, and repository-level secrets would be readable by any branch.

`ICARUS_USERS` is a **person's id**, not a name and not a username. From it are derived the container's name,
the memory directory and the pi session id; in Telegram a person is matched to this id
via `ICARUS_TELEGRAM_MAPPING`, and the HTTP client sends it in the
`x-icarus-user-id` header. On prod these are the logins under which people used to go to chat:
the directories in `runtime/users/<id>` are named by id, so changing an id also means moving the
directory. You can check whom icarus sees via `/healthz`: it returns `users`
and the state of the containers (`missing` should be 0).

After the panel moved to `chat.trousev.pro`, `script/redeploy` sets this address itself.
If `ICARUS_URL` (in variables environment `production`) still holds the old
`memory.trousev.pro`, change or remove it: an explicitly set variable is stronger than the default.

Moving the directory is not enough: **after moving, the containers must be recreated**
(`docker compose -f docker-compose.yml up -d --force-recreate`) — `up -d` won't help here,
compose doesn't see the changes. The bind mount is resolved once at container creation, and the
container keeps seeing the renamed directory as the old (empty) one — `auth.json`
and `models.json`, which icarus writes at startup, are lost, and pi answers "Model … not found",
while the stream breaks with "RPC channel closed". At the same time everything is in place on the host, and `./script/server -d`
by itself is silent too: `Container … Running`. Check with one command:
`docker exec icarus-user-<id> ls /home/node/.pi/agent/` — `auth.json`,
`models.json`, `skills/` should be there.

Prod specifics are substituted by the deploy itself: `dataDir` inside the checkout (`runtime/`, doesn't make it into git).
Port `8081` is the common default (`config.example.yaml` locally and `script/redeploy` on prod): it was chosen
because on the prod host `8080` is taken by jitsi-jvb, and locally it's more convenient to use the same port as in battle.

A separate host gotcha is the resolver. Docker hands the containers the servers from the host's
`/etc/resolv.conf`, and if the local resolver doesn't let the docker subnets in, every external request
first waits for a timeout. Thus, `unbound` with `access-control` only for `127.0.0.0/8` and
`10.0.0.0/8` answers the containers (they're in `172.16.0.0/12`) with `REFUSED`, Docker waits ~4 s and
only then goes to the next server — resolving `api.deepinfra.com` from a container takes
**4 seconds instead of 0.02**, and every pi call to the model pays it (turns 4.8 and 11.2 s versus
1.2 and 1.5 s locally). Check with one command:
`docker exec icarus-user-<someone> getent ahostsv4 api.deepinfra.com` — should be ~20 ms.

The proper treatment is on the host (`access-control` for the docker subnet in unbound + reload,
then the other containers stop lagging too). But `./script/redeploy` just in case
always writes the containers an explicit `docker.dns` — currently `1.1.1.1 8.8.8.8` (the value
arrives in `render-config.ts` via the `ICARUS_DNS` variable, rather than being edited by hand on the host).
The price — the names of other containers and local zones (`*.trousev.pro`) inside the containers
resolve publicly; when the host is fixed, `ICARUS_DNS=none` (in the variables environment or
in the script call) will remove the line from `config.yaml`, and the containers will return to the host's resolver.
The same field also exists in `config.yaml` (`docker.dns`, see `config.example.yaml`) — it can be set
without a deploy too.

## Repository layout

```
script/               developer commands: update, test, lint, server, panel, redeploy
packages/service/     service: HTTP, pi sessions (compression and cleanup), containers, telegram bot,
                      speech recognition, control panel
packages/extensions/  pi extensions that live in the user's container
docker/user/          the user container's image
docker/service/       the icarus image itself: node, git and the docker client
docker-compose.yml    the stack that ./script/server assembles (doesn't make it into git)
specs/                stage specs
tools/rpc-probe.mjs   debug client to pi over RPC
tools/artifacts-mcp/  built-in artifacts MCP (stdio): list, read, links, check
tools/maple-mcp/      built-in Maple MCP (stdio + HTTP)
```

## Documents

- [`PLAN.md`](PLAN.md) — the plan, interview decisions, the results of stages M0–M3 and the gotchas found.
- [`specs/M1-service.md`](specs/M1-service.md) — the service's boundaries and acceptance criteria.
- [`icarus.md`](icarus.md) — Icarus's character, which is also the system prompt.

## License

MIT.
