# 08 — LibreChat and pi skills: why they didn't arrive and how they did

**Status:** a write-up. The implemented variant B1 (sync via the Management API) has been **removed from the code** — the files mentioned here (`packages/service/src/skills/**`, `docker/librechat/oidc-stub`, `script/librechat-skills-bind`, `skills.sync` in the config) are no longer in the repository. The reason is at the end of §7; a skill-editing panel is replacing sync. The rest is the history of the decisions and a map of someone else's API, useful if we ever come back to this. **Date:** 21.09.2026.
**Method.** I traced the chain through our own code (`packages/service/src/**`, `packages/extensions/**`, `docker/librechat/*`) and through the pi 0.85.1 sources in `node_modules/@earendil-works/pi-coding-agent/dist/**`. LibreChat's behaviour is from the official docs and from the LibreChat sources on GitHub (links at the end); anything taken from the sources rather than the docs is marked separately. What exactly was done is in §9.

---

## Short answer

1. **Not only did the system prompt not reach pi — nothing reached it except the text of the user's latest turn** (and images). This is not a breakdown: icarus deliberately takes only the new turn from the LibreChat request, and keeps the whole history, persona, and tools on the pi side.
2. **For a custom endpoint (`Icarus` in `librechat.yaml`) LibreChat doesn't send skills at all.**
   Skills are a capability of the **Agents** endpoint; in a custom chat there's nowhere to take them from.
3. Even if the conversation goes through an Agent, everything a skill carries was discarded at icarus's input:
   the skill catalog travels in the agent's **system** prompt, the body of `SKILL.md` as a separate **user** message
   (`isMeta`) **before** the latest turn, and the `skill` / `read_file` tools in the `tools` field.
   icarus reads only the latest user turn and does not read `system` or `tools` at all.
4. **pi looks for skills in `~/.pi/agent/skills` and `<cwd>/.pi/skills`** (that is, `/home/node/.pi/agent/skills`
   and `/workspace/.pi/skills`), and icarus set up neither of these directories. "pi's built-in skills" are
   literally empty directories — hence "it looks for its skills and doesn't find them".
5. The skill format in LibreChat and in pi is **exactly the same** (`SKILL.md` + Agent Skills frontmatter), so
   the fix isn't a protocol bridge but delivering files to where pi can see them. We did variant B1:
   skills are written in the LibreChat UI and synced into `~/.pi/agent/skills` (see §9).

---

## 1. What Skills are in LibreChat and which endpoint they live on

Skills are "reusable instructions" for **LibreChat Agents**: `SKILL.md` with frontmatter
(`name`, `description`, `always-apply`, `user-invocable`, `disable-model-invocation`, `allowed-tools`),
the body being a procedure/rules. Authorship: the UI (write/upload), runtime authoring by the agent, files from
`DEPLOYMENT_SKILLS_DIR`, sync from GitHub. ([docs][skills], [changelog v0.8.6][v086])

Activation: the capability `skills` on the `agents` endpoint → the agent has **Enable skills** turned on → a scope is chosen (the whole catalog / individual skills / authoring only) → in a conversation a skill can be picked
manually (`$`), chosen by the model (catalog), or always applied (`always-apply`).

An important consequence follows from this: **skills are wired into the Agents chain** (the agnostic catalog in
`api/server/services/Endpoints/agents/initialize.js`, tool and handler registration in
`packages/api/src/agents/*`). A custom endpoint (our `Icarus`) doesn't take part in this chain — skills simply
don't get into its request. *(Inference from the LibreChat sources: PR #12649 changes only the `agents` branch; the docs describe skills exclusively through the Agent Builder. If your chat with
"Icarus" has a Skills panel and `$`, then the conversation goes through an Agent, and §3 applies.)*

That said, **an Agent can use a custom endpoint as its model** — in `initialize.js` the agent's main
config is resolved via `getCustomEndpointConfig` for non-`agents` endpoints, and
"custom-endpoint agents" are mentioned separately in a comment about pricing. So the "Agent with the Icarus model"
scenario is possible, and it is exactly the one in which a system prompt with skills reaches icarus.

## 2. What exactly LibreChat puts into the request

| What | How it travels in `POST /v1/chat/completions` | Documented by |
|---|---|---|
| Skill catalog (model-invoked) | the `## Available Skills` section appended to the agent's `additional_instructions` → a **system message**; only `name` + `description` (≤100 skills, ~250 characters per entry) | `injectSkillCatalog` in [packages/api/src/agents/skills.ts][skills-src] |
| Manual (`$`) and `always-apply` invocation | the **full body of `SKILL.md`** as a `HumanMessage` with `additional_kwargs.isMeta = true`, inserted **before the user's latest turn** (`injectSkillPrimes`, `insertIdx = length - 1`) → in the request this is a **user message** before the real turn | same place, `injectSkillPrimes` |
| Skill tools | `tools`: `skill` (always when skills are on), `read_file` (always), `bash_tool` (if a code env is configured) | PR #12649 |
| Bundle files | `references/…`, `scripts/…` in LibreChat's storage under `skills/<name>/…`; with the Code Interpreter they're mounted into `/mnt/data/skills/<name>/…` | [docs][skills] |

Useful limits: prime bodies — up to 10 manual and 20 always-apply per turn; the catalog — up to 100 entries.
To the model this looks like "a system prompt + a virtual user message + the `skill` tool", not like a file on
disk (the files live in LibreChat's sandbox, not in the person's container).

## 3. What icarus does with this request

`handleChatCompletions` ([openai.ts:223](packages/service/src/http/openai.ts)):

1. `const messages = body.messages` — [openai.ts:246](packages/service/src/http/openai.ts). After that
   `body.tools` is **read nowhere** (I checked with grep: there's no `tools` field in the service code).
2. `extractLatestUserMessage(messages, incoming)` — [openai.ts:264](packages/service/src/http/openai.ts):
   it takes `[...messages].reverse().find(m => m.role === 'user')` — [openai.ts:160](packages/service/src/http/openai.ts) —
   and from it only text blocks and `image_url` with a data URI —
   [openai.ts:170-192](packages/service/src/http/openai.ts). Everything else (`system`, previous
   `user`, `assistant`, `tool`) is unused.
3. The history comparison `compareHistory` also looks only at the `user`/`assistant` roles —
   "we don't count system messages and service stuff" ([divergence.ts:38-49](packages/service/src/sessions/divergence.ts)).
   So the system prompt not only fails to arrive, it doesn't even make it into the diff.
4. The pi session is brought up with the arguments
   `--mode rpc --session-dir /workspace/.sessions --session-id … --model … --thinking …` —
   [pi-session.ts:15-28](packages/service/src/sessions/pi-session.ts). There's no `--system-prompt`,
   no `--append-system-prompt`, no `--skill` there.
5. The person's environment is prepared by `prepareUser` — [workspace.ts:206](packages/service/src/workspace.ts):
   `AGENTS.md`, `icarus.md`, `auth.json`, `settings.json`, `mcp.json`, `models.json`, and the directory
   `extensions` (copied with cleanup, [workspace.ts:253-255](packages/service/src/workspace.ts)).
   **There's no `skills` directory there** — the word `skills` never occurs in the service code (except for
   `--no-skills` in `one-shot.ts:34` and in `memory-extractor.ts:406`).
6. `runtime/users/<id>/pi-agent` is mounted at `/home/node/.pi/agent` —
   [compose.ts:90](packages/service/src/docker/compose.ts), the container's `cwd` is `/workspace`
   ([docker/user/Dockerfile](docker/user/Dockerfile)).

Layer-by-layer summary:

| Came in from LibreChat | What became of it |
|---|---|
| system: agent instructions + `## Available Skills` | discarded (nobody reads `role: "system"`) |
| user (isMeta): the body of `SKILL.md` | discarded (we take only the latest user turn) |
| user: the real turn | went to pi as the `prompt` |
| `tools`: `skill`, `read_file`, `bash_tool` | discarded (pi lives on its own tools and extensions) |
| skill files `/mnt/data/skills/…` | unavailable: this is LibreChat's sandbox, not the person's container |
| attachments (images/files) | images — to the model, files — to `incoming/` (works) |

**The answer to "maybe LibreChat's system prompt doesn't reach pi at all?" is: right, it doesn't, and that's
by design.** Icarus's persona lives in `icarus.md` (+ `AGENTS.md`), the history lives in the pi session, and the
LibreChat prompt is treated as a foreign copy of the conversation, needed only for divergence checking.

> **A risk for the future.** What saves us today is that the skill prime (the `isMeta` message) is inserted
> *before* the latest turn. That's not a contract but an implementation detail of LibreChat: if the prime ever
> ends up as the last user message, icarus will take the body of `SKILL.md` for the user's turn and
> "answer the skill". It's worth either pinning this invariant down with a test on our side (ignore
> `isMeta`-like user messages) or not relying on it at all (variant A).

## 4. What pi looks for and why it finds emptiness

pi 0.85.1, config directory `.pi`, agent directory `~/.pi/agent`
(`dist/config.js:403`, `CONFIG_DIR_NAME`/`getAgentDir`):

- by default skills are looked for in **`~/.pi/agent/skills`** (user scope) and **`<cwd>/.pi/skills`**
  (project scope) — `dist/core/resource-loader.js:623,629`;
- project scope is loaded **only if the project is "trusted"** (`dist/core/resource-loader.js:811,822`);
  in RPC mode there's no UI, so `resolveProjectTrusted` with `defaultProjectTrust: "ask"` returns
  `false` (`dist/core/project-trust.js`). So `/workspace/.pi/skills` won't work on its own —
  you need `--approve`, an entry in the trust store, or `defaultProjectTrust: "always"` in pi's settings;
- an explicit flag **`--skill <path>`** (repeatable; a file or directory) and **`--no-skills`** —
  `dist/cli/args.js:142,164`, help at `dist/cli/args.js:295`;
- the model sees skills as `<available_skills>` (name, description, **location**) in the system prompt,
  and **reads `SKILL.md` itself with its own `read` tool** — pi has no separate "skill tool"
  (`formatSkillsForPrompt`, `dist/core/skills.js:275-298`).

In our case `~/.pi/agent` = `runtime/users/<id>/pi-agent`, and there's no `skills` directory there — nor
`/workspace/.pi/skills`. Both sources are empty, so pi honestly answers that there are no skills.
Separately: `one-shot` (titles) and the memory extractor call pi with `--no-skills` — there that's deliberate.

## 5. Why this isn't an "icarus bug"

LibreChat Skills are designed for a **model without hands**: LibreChat itself runs the tool loop (`skill`,
`read_file`, `bash_tool`, code env), itself slips the catalog into the prompt, and itself executes
the skill invocation. pi is **its own agent**: it has its own loop, its own tools, its own memory, its own persona.

If you try to "pass through" LibreChat skills into pi as they are, you get a double agent loop:
LibreChat expects `tool_calls` (`skill`/`read_file`) from icarus, icarus doesn't return them and shouldn't — it
returns pi's finished text. The only thing that physically survives the boundary is **text** (the prompt and the
primes), and that's exactly what icarus deliberately throws away right now.

## 6. Options

### A. File-based skills where pi can see them (I recommend this)

- **A1. A shared directory + copying into pi.** Set up `skills/` in the repository (or `config.skills.dir`),
  and in `prepareUser` copy it into `~/.pi/agent/skills` — using exactly the same trick already applied to
  `extensions` ([workspace.ts:253-255](packages/service/src/workspace.ts)). The LibreChat stand's directory
  gets the same directory via `DEPLOYMENT_SKILLS_DIR` (read-only, requires restarting LibreChat).
  *Pros:* a single source of truth for both sides, zero protocol changes, works even without the
  `agents` endpoint, user scope — no fussing with project trust. *Cons:* authorship in git rather than in the UI;
  a new skill is picked up on the next start of the pi session (sessions live up to `sessionIdleMinutes`,
  30 minutes by default; restart — `docker compose restart`/rebuilding the environment).
- **A2. `--skill /opt/icarus/skills` without copying.** We mount the shared directory ro into the person's
  container and add the flag in `piArgsFor`. *Pros:* cheaper (no per-person copy).
  *Cons:* the directory must exist (otherwise pi complains with a path error), the contents don't change
  without a restart; each person still gets their own mount anyway.

### B. Syncing skills written in the LibreChat UI

- **B1. Management API (chosen and implemented — see §7).** v0.8.6 has `GET /api/agents/v1/skills`,
  `GET /api/agents/v1/skills/{id}`, `GET …/{id}/files[/{path}]`; authentication is an OIDC machine token
  bound to a user ([docs][agents-api]). The sync (on a schedule or at startup) pulls
  `SKILL.md` and the bundle files and lays them out in pi's directory. *Pros:* the UI remains the place of
  authorship, ACLs and versions are respected. *Cons:* you need an OIDC provider and `endpoints.agents.managementApi` in the LibreChat config;
  a client, credentials, a schedule; for a remote instance — outbound network.
- **B2. Reading Mongo** (`skills` + `skillfiles`). No OIDC, but tightly coupled to LibreChat's schema and
  to access to its DB; for an external instance (memory/prod) — the most fragile path.

### C. Passing LibreChat's system context through to pi (an icarus patch)

Collect from the incoming request what isn't turns (`system` messages; optionally
`isMeta` user primes) and give it to pi:
- the stable part — `--append-system-prompt` at session start (the session is brought up once per
  conversation, so the contents of the first request get fixed until the end of the conversation);
- the unstable part — as a prefix to the next turn ("context from LibreChat: …").

*Pros:* fixes not only skills — right now `modelSpecs.promptPrefix` and the agent instructions (everything
LibreChat put into system) are silently lost. *Cons:* LibreChat's primes repeat every turn
(sticky semantics), a catalog in the prompt without a tool loop is useless anyway, confusion is possible
between the `icarus.md` persona and a foreign prompt, and this should be done behind a config flag, not by default.

### D. Deliberately not supporting LibreChat Skills

LibreChat = UI + history + the memory panel, the agent and its skills = pi. The cheapest option, but skill
authorship stays with git.

**We chose B1** — skills are written in the LibreChat UI, icarus pulls them via the Management API and
lays them out in pi's directory. Below is how it was done and what was verified.

## 7. How it was done (B1)

### The icarus side

| Place | What it does |
|---|---|
| `packages/service/src/skills/librechat.ts` | Management API client: `GET /api/agents/v1/skills`, `/{id}`, `/{id}/files[/{path}]`; the token either static (`token`) or via client_credentials (`tokenUrl`+`clientId`+`clientSecret`) with a cache until `exp`. |
| `packages/service/src/skills/sync.ts` | Materialisation: `SKILL.md` (frontmatter from `name`/`description`/foreign keys + `disable-model-invocation`) and the text bundle files; the manifest `.icarus-skills.json` stores `id`/`version`/`updatedAt`/`hash` and acts as a cache: bodies are re-read only for skills whose version or date changed, so **an ordinary pass is exactly one request to LibreChat, for the list**; deletion of what was removed in LibreChat; idempotent — an identical set writes nothing. |
| `packages/service/src/skills/service.ts` | The schedule (immediately at startup and once per `intervalSeconds`, 300 s by default), per-person authorisation (`accounts`), logging, and most importantly `registry.bumpResources(user)` only when the set has actually changed. |
| `packages/service/src/sessions/registry.ts` + `pi-session.ts` | Resource generation: a session has a `generation`; on `acquire` a stale (and not busy) session is recreated. We don't cut off an in-flight turn — it finishes on the old directory, and the next request brings up a fresh pi. The history isn't lost: it's in `/workspace/.sessions` and is opened via `--session-id`. |
| `packages/service/src/config.ts` | The `skills.sync` section (`url`, `intervalSeconds`, `audience`, `token`/`tokenUrl`/`clientId`/`clientSecret`, `accounts`). An empty `url` (a variable didn't get substituted) = sync is off. |
| `packages/extensions/persona.ts` + `lib/skills-core.ts` | **Important.** The persona replaces pi's system prompt entirely, and pi only adds the skill catalog in its own prompt builder — that is, before the fix the catalog was lost. Now the persona appends the `<available_skills>` block itself (the same format as pi: name, description, path; only if `read`/`bash` are available). |

### The stand's side

- `docker/librechat/librechat.yaml`: `endpoints.agents.managementApi` is enabled (OIDC `http://localhost:9100`, audience `icarus-skills`, binding `clientId: icarus-sync` → the stand user's `userId`/`tenantId`).
  The block itself is **not our invention**: LibreChat validates it (`packages/data-provider/src/config.ts`,
  `managementApiSchema` → `managementApiAuthSchema` → `managementClientBindingSchema`), reads it in
  `packages/api/src/middleware/management.ts` (`config.endpoints?.agents?.managementApi?.auth`),
  and the fields `userId` (ObjectId), `tenantId` (not `__SYSTEM__`), `subject`, `enabled` are its schemas, and both
  schemas are `.strict()`, i.e. a typo in a key isn't "silently ignored" but fails validation.
  All ours here is the contents: the stub's address, the `audience`, and the person's ObjectId.
- `docker/librechat/oidc-stub/server.mjs`: an OIDC stub for the local stand (JWKS + discovery +
  `POST /token` via client_credentials, the key is generated by itself in `docker/librechat/oidc-data/`).
  In production a real provider takes its place.
- `compose.ts`: the stub is brought up as two instances with a single signing key — inside the LibreChat
  container (which sees it as `http://localhost:9100`: over http LibreChat only reaches localhost,
  and the stub also survives LibreChat being recreated) and as an ordinary `oidc` service on the compose network
  (from which icarus gets the token). The icarus service receives the variables `ICARUS_LIBRECHAT_URL`,
  `ICARUS_SKILLS_*`, which `skills.sync` in `config.yaml` refers to.
- `script/librechat-skills-bind`: substitutes the stand user's ObjectId and tenant into the working copy of the
  config; it's called on its own from `./script/server --with-librechat` before `up` and after it (only the
  template with a placeholder is in git — the ObjectId lives in the Mongo volume).
- `script/server`: creates `docker/librechat/oidc-data` in advance (otherwise docker would make the directory
  root-owned) and warns while the binding isn't filled in.

### How to check on the stand

1. `./script/server --with-librechat -d` — the stack together with the stand and the stub.
2. Create a LibreChat user (register in the UI or `POST /api/auth/register`), optionally
   change the password: `./script/regenerate_user_passwords <password>`.
3. Nothing needs to be bound by hand: `./script/server --with-librechat` does it itself.
   The stand mounts not the template `docker/librechat/librechat.yaml` but its working copy
   `librechat.local.yaml` (not committed to git): `compose-write` creates it from the template, and the script
   `script/librechat-skills-bind` substitutes `userId`/`tenantId` into it — taking the first person
   from `users` in `config.yaml` (you can also call it by hand: `./script/librechat-skills-bind [name|ObjectId]`,
   flags `--file/--ensure/--quiet/--no-restart`). The binding is set before `up`, and if Mongo isn't
   up at that moment — right after: LibreChat restarts because it reads the config only
   at startup (otherwise the binding sits in the file while the old one stays in memory, and the Management API answers 401).
   The `__SYSTEM__` tenant is explicitly forbidden by the Management API, and `${VAR}` isn't
   substituted in `managementApi` — only a literal ObjectId, which is also why there's a working copy rather than variables.
4. Write a skill in the UI (Skills → "+" → Write skill instructions) or via the API
   `POST /api/skills` with a browser JWT (`POST /api/auth/login`).
5. After one pass (up to 5 minutes by default; after a failed pass the service retries in
   15 seconds, so the race at stack startup resolves itself) `skills updated` appears in the icarus log, and on the host —
   `runtime/users/<id>/pi-agent/skills/<name>/SKILL.md`. After that Icarus reads the skill itself.

### What was verified live (21.09.2026, the stand in this worktree)

- A skill created in LibreChat reached `~/.pi/agent/skills` inside the person's container
  (and reached `pi.getSkills()` — with no diagnostics).
- The cache works as intended: a pass with no changes writes neither skill files nor the manifest
  (checked by mtime and md5), a skill edit in the UI (`version` 2 → 3 → 4) is re-read and
  arrives, and a `SKILL.md` that vanished from disk is restored even if the version didn't change.
- The block `<available_skills>` with name, description, and path appeared in pi's system prompt.
- Asked "what's the codeword for the pirate-mode skill", Icarus read `SKILL.md`
  (`read` on `/home/node/.pi/agent/skills/pirate-mode/SKILL.md` is visible in the pi session) and answered
  with the codeword that exists only inside the file; the skill's requirement to "end the reply
  with the line 🏴☠️ Yo-ho-ho, landlubber!" was met.
- A skill edit in the UI (version 1 → 2) arrived and restarted the session; deleting the skill removed
  the directory from pi; a repeated pass with the same set rewrites nothing (sessions aren't disturbed).
- `./script/test` — 284 tests, including `skills-sync.test.ts` and `skills-prompt.test.ts`;
  `./script/lint` (tsc + eslint) clean.

### Why it was ultimately removed (07.10.2026)

The analysis on the stand was correct, but on the production host the sync couldn't work, and this only came out
during a live analysis of prod:

- **The Management API accepts only OIDC machine tokens** (`getEnabledAuth` requires
  `managementApi.auth.oidc.enabled` + `issuer` + `audience`; management routes don't look at API keys at all).
  So you need a real OIDC provider with a client bound to the user and tenant.
- **The issuer must be `https://`**; over http LibreChat only reaches `localhost`, `127.0.0.1`, `[::1]`,
  and `*.localhost`. Our stand trick (a stub inside the LibreChat container, issuer `http://localhost:9100`)
  in production would have meant editing its compose and putting our homemade thing in the provider role.
- **Tenant.** The prod users and the skill had no `tenantId`, and the binding requires a non-empty tenant,
  forbids `__SYSTEM__`, and looks up the user as `findUser({_id, tenantId})`; a skill is returned only
  if `skill.tenantId === req.user.tenantId`.
- **Version.** Prod was running `v0.8.6-rc1`, where `managementApi` and the `/api/agents/v1/skills` route don't
  exist at all; the feature only appeared in v0.8.8 (`#15545` contract, `#15555` M2M authentication,
  `#15561` read, `#15642` skills).
- **Silence.** A pass with an empty skill list wrote nothing to the log: from the outside this looked like
  "sync is broken", and that's exactly how it looked.

Plus the network: `icarus`, `LibreChat`, and `authelia` live on different docker networks, and public https out of
containers on this host doesn't work (hairpin, `unsafe legacy renegotiation disabled`) — routes would have been needed as well. The cost of the whole contraption turned out to be higher than the benefit, so sync was removed along with the
stand OIDC stub, `script/librechat-skills-bind`, and the `skills.sync` section; pi's skills remain
files in `~/.pi/agent/skills`, and editing will come via a panel.

## 8. What was left out of scope

- **Production LibreChat.** You need a `managementApi` with a real OIDC provider (issuer/audience + binding
  the client to the LibreChat user). Skills appear in the UI starting with v0.8.6; the stand runs `v0.8.8-rc3`.
- **One token = one set of skills.** If `accounts` is empty, everyone gets the set of that
  LibreChat user the machine client is bound to. Personal sets — via `accounts`.
- **`always-apply` doesn't carry over.** In LibreChat it means "prime the skill every turn"; in pi the catalog
  works differently — the model reads `SKILL.md` when the task matches the description. The key
  `always-apply` stays in the frontmatter as a reference but doesn't change behaviour.
- **Bundle files** are carried over only if textual: the API doesn't return binary ones (`assets/*.png`),
  and sync skips them with a warning in the log.
- **Hot reload** is done by restarting the pi session (see `generation`), not by re-reading the
  directory on the fly: pi reads skills at process start.
- The exact version and layout of your production LibreChat (Agents enabled? tenancy present?) —
  is checked on site per §7.

## Sources

- [LibreChat Skills (docs)][skills] — invocation modes, frontmatter, limits, deployment skills, sync.
- [LibreChat v0.8.6 changelog][v086] — "Agent Skills" in the release.
- [PR #12649, Skill runtime integration][pr] — the catalog in `additional_instructions`, the
  `skill`/`read_file`/`bash_tool` tools, primes as `isMeta` HumanMessage, files in the code env.
- [Agent Management API][agents-api] — the skill routes `GET /api/agents/v1/skills…`.
- [LibreChat Agents (docs)][agents] — skills are enabled on the agent; [Compatibility Matrix][compat] —
  "Agents" as the most complete endpoint.
- pi 0.85.1 (`node_modules/@earendil-works/pi-coding-agent/dist/**`) — skill search paths,
  `--skill`/`--no-skills`, project trust, `formatSkillsForPrompt`.

[skills]: https://www.librechat.ai/docs/features/skills
[skills-src]: https://github.com/danny-avila/LibreChat/blob/main/packages/api/src/agents/skills.ts
[v086]: https://www.librechat.ai/changelog/v0.8.6
[pr]: https://github.com/danny-avila/LibreChat/pull/12649
[agents-api]: https://www.librechat.ai/docs/features/agents_api
[agents]: https://www.librechat.ai/docs/features/agents
[compat]: https://www.librechat.ai/docs/compatibility
