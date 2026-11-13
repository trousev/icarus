# M1 — the icarus service

> A historical spec for stage M1: back then LibreChat was the front end to the service. Now the main entry point is
> a Telegram bot, while the OpenAI-compatible endpoint remains for future clients; the current
> state is in the [README](../README.md).

## Goal

LibreChat talks to Icarus like any ordinary model: streaming, cancellation, history, attachments. Behind every
conversation is a live pi session inside the user's container. Memory persists between conversations.

## Boundaries

**In scope:** the HTTP facade for OpenAI, the session registry, container management, generation of `AGENTS.md` and `auth.json`,
translation of tool activity into `reasoning_content`, cancellation on disconnect, history reconciliation with a diff log,
the persona extension, contract and integration tests.

**Out of scope:** the memory extractor, the memory core in the prompt, the mini-panel, web search, MCP, egress policy, quotas,
working with code in repositories.

## Repository structure

```
packages/
  service/                     # icarus itself
    src/
      index.ts                 # entry point
      config.ts                # parse config.yaml
      http/server.ts           # http server and authentication
      http/openai.ts           # /v1/models, /v1/chat/completions
      http/sse.ts              # packing into OpenAI chunks
      sessions/registry.ts     # (user, conversation) → session, TTL, queue
      sessions/pi-session.ts   # pi process lifecycle
      sessions/rpc-client.ts   # JSONL over stdio via docker exec
      sessions/divergence.ts   # history reconciliation, diff to log
      reasoning.ts             # tool events → human phrases
      docker/manager.ts        # container per user (dockerode)
      workspace.ts             # AGENTS.md, auth.json, incoming/
  extensions/                  # our pi extensions (persona, …)
docker/
  user/Dockerfile              # already built and verified
specs/M1-service.md            # this file
tools/rpc-probe.mjs            # debug client (already exists)
```

## HTTP contract

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | liveness + container status |
| `GET` | `/v1/models` | a single model, id `icarus` |
| `POST` | `/v1/chat/completions` | the main route, `stream` supported |

**Identity.** Headers from LibreChat: `x-icarus-user-id` ← placeholder `{{LIBRECHAT_USER_*}}`
(the header itself is configurable, so the source depends on how people are set up: prod —
`{{LIBRECHAT_USER_LDAPID}}`, the uid from LDAP; the password-based staging — `{{LIBRECHAT_USER_USERNAME}}`; the spec draft
had `{{LIBRECHAT_USER_ID}}`, but that id is a MongoDB ObjectId, which tells people nothing),
`x-icarus-conversation-id` ← `{{LIBRECHAT_BODY_CONVERSATIONID}}`. Fallbacks: `body.user`, otherwise
`sha1(first message)`. Unknown user → `403` and a log entry.

**Authentication.** A single shared `Bearer` token from the config (the same one we specify in `librechat.yaml`).

**Attachments.** `image_url` parts with data URLs are decoded into `/workspaces/.icarus/incoming/<uuid>.<ext>`; the line
"The user attached a file: <path>" is added to the message text. After that the agent decides for itself — pi can read images too.

## Sessions

- The key is `(user_id, conversation_id)`. One pi process per conversation: `docker exec -i <c> pi --mode rpc
  --session-dir /workspaces/.icarus/sessions/<conversation_id>` — this way the conversation survives a service restart.
- **Busy:** one turn per session. While a stream is in progress, a second message gets `409` and a log entry.
- **Idle:** the process is shut down after N minutes without requests; the container stays up.
- **History reconciliation (decision 14):** before a turn we compare the submitted history with `get_messages`. If the prefix matches
  we simply feed in the new message. If it diverges, we write a diff to `logs/divergence/<conversation>.log` and continue
  **our own** session (edits and regenerations in the UI do not roll back Icarus's memory — that is deliberate).

## Streaming, cancellation, visibility

- Text: `message_update.text_delta` → `choices[].delta.content`.
- Activity: `tool_execution_start/end` → short phrases in `choices[].delta.reasoning_content`
  ("reading `memory/identity.md`", "editing `preferences.md`", "running a command"). The model's actual reasoning,
  if enabled, goes there too.
- Final: a chunk with `finish_reason: "stop"`, then `data: [DONE]`; `usage` comes from the pi session stats.
- **Cancellation:** `res.on('close')` with `writableEnded === false` → `{"type":"abort"}` to pi (verified in M0).

## Configuration

`config.yaml` at the repository root (a sample is `config.example.yaml`; the working file is not committed to git).
What is common to all people lives at the top level; each person keeps only an id:

```yaml
apiKey: …                                    # Bearer for LibreChat
dataDir: ~/icarus-data
docker: { image: icarus-user:dev, socket: unix:///var/run/docker.sock, network: icarus }

models:
  - { provider: deepinfra, id: deepseek-ai/DeepSeek-V4.1-Flash, thinking: low,    tier: fast }
  - { provider: deepinfra, id: deepseek-ai/DeepSeek-V4.1-Flash, thinking: medium, tier: strong }
auth: { deepinfra: env:DEEPINFRA_API_KEY }
# no custom mounts: the container sees only /workspaces and the Maple installation

users:
  - trousev
  - second
```

From this the service generates `auth.json`, `models.json` and `settings.json` into the mounted `~/.pi/agent`, plus
`AGENTS.md` with a map of the environment. `models.json` is needed by custom providers like `deepinfra`: pi does not
know them by itself, and without the file the model from `models` will not be found in the container. Keys never
end up in logs. Model tiers travel into the container as the variables `ICARUS_MODEL_FAST` / `…_STRONG` / `…_VISION` — read
by the escalation extension. The reasoning level the extension passes through is exactly the one written in the config: pi would
bump an unsupported one up to the nearest available (`medium` for the previous model was marked as absent in the catalog),
while the extension sends `reasoning_effort` as is.

Initially the config was JSON and duplicated models with keys for each person; the format was simplified
(see the commit history) because people's settings were imperceptibly drifting apart, and adding a person
turned into forty lines of copy-paste.

## Done when

1. ✅ LibreChat in the staging environment receives a streaming response from icarus (the echo server is no longer needed).
2. ✅ Two users — two containers, two independent memories; shared memory is shared.
3. ✅ The conversation continues between requests, and editing a message in the UI produces a diff in the log without breaking the session.
4. ✅ Cancellation in the UI actually stops the agent (visible in the log and in the `abort` to pi).
5. ✅ An attachment from the chat ends up in `incoming/`, and the agent can read it.
6. ✅ A service restart does not lose conversations (`--session-id` + `--session-dir`).
7. ✅ `npm test`: 36 tests — the shape contract, history reconciliation, tool phrases, attachments, RPC against a stub, HTTP end to end.

**Clarifications found during implementation** (the spec said otherwise — I'm keeping them as a record of decisions):

- history reconciliation runs over **user** messages, not all of them: pi's replies are split up by tools, LibreChat
  glues them back together, and a line-by-line comparison produced false divergences on every turn;
- `usage` is returned only with `stream_options.include_usage`, the first chunk carries `delta.role`;
- by default identity is taken from the header (`x-icarus-user-id`), not from the session id — that makes
  setting people up easier; the header is configurable anyway. Later it turned out the source of the header matters:
  in prod it is `{{LIBRECHAT_USER_LDAPID}}` (the uid from LDAP, which matches the login), not
  `{{LIBRECHAT_USER_USERNAME}}` — LibreChat builds the username from `givenName` and it does not match the login
  (see the README, the section on `ICARUS_USERS`). The staging config keeps `USERNAME`: staging uses passwords,
  there is no LDAP there and nobody's `ldapId` is filled in.

## Risks

pi's young API (version pins, all the logic lives in extensions and a single `rpc-client` layer); races on disconnect
and concurrent requests (we cover them with stub tests); a memory leak in the process pool (TTL and metrics).
