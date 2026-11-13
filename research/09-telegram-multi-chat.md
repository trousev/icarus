# 09 — Icarus multi-chat in Telegram: Mini App or native topics

**Status:** analysis for decision, nothing done. **Date:** 08.10.2026.
**Question.** I want multi-chat in Telegram for Icarus (a list of conversations, like in ChatGPT/LibreChat),
and I heard about Telegram Apps — apps that open right inside Telegram. Is that real?
**Method.** Telegram primary sources: Bot API reference (v10.3, 24.08.2026), `bots/features`,
`bots/webapps`, `bots/api-changelog`, `bots/faq`, the telegram.org blog. My own code:
`packages/service/src/**` (current branch). Others' experience: hermes-agent (NousResearch) — a direct
analog of our task, nekoclaw (same `pi`, Docker per person), tg-llm-router (Mini App for
LLM). Where the source is not documentation but someone else's code/community, that is stated explicitly. What to check
by hand — §10.

---

## Short answer

1. **Yes, Mini App is a real thing**, and you can build multi-chat in it: Telegram gives you a webview,
   signed data about the person, and launch in one tap. But it is **not the best tool specifically for
   chat**: a Mini App has no access to the conversation (except in attachment-menu mode), can't
   push, lives only while open, and the entire UI — including the chat list, history and streaming —
   would have to be written and hosted by us.

2. **Multi-chat in Telegram already exists natively, and it's exactly our case.** Bot API 9.3
   (31.12.2025) and 9.4 (09.02.2026) added **topics in private chats with a bot**: the bot and the person create
   separate topics inside one private chat, each with its own history. Telegram's documentation
   itself sells this as a replacement for web AI chats: *«Topics in Private Chats keep separate projects
   or support cases organized — improving on established web-based AI chat UIs»*
   ([features#ai-agents](https://core.telegram.org/bots/features#ai-agents)).
   It's enabled by one checkbox in BotFather, not by development.

3. **For Icarus this costs almost zero changes.** Our session key is already `(person, conversation)`
   (`sessions/registry.ts`), and `conversationId` for a private chat is `telegram-<chat_id>`
   (`telegram/bot.ts:conversationIdFor`). It's enough to add `thread_id` to the key, and each
   topic automatically gets its own pi process, its own history in `/workspace/.sessions`
   (`sessions/pi-session.ts:sessionIdFor`) and its own `/compact`. No DB needed: the
   topic→conversation binding is derived from the message itself.

4. **The right role for the Mini App in our case is a panel, not a chat.** The panel already exists
   (`control/ui.ts`, `control/identity.ts`), it has a section architecture (`SECTIONS` in
   `control/index.ts`), and a Mini App is the natural way to open it from a phone in one tap,
   with authorization via `initData` instead of the SSO proxy. A chat client in a webview is a second,
   far more expensive story, with notifications that a Mini App simply doesn't have.

5. **As of 2026, what Icarus needs is not Mini Apps but three things from the Bot API:** `sendMessageDraft`
   (native streaming of the answer + a Stop button instead of our editing the message once every 1.2 s),
   rich messages (tables and LaTeX — directly relevant to Maple) and, if we want it, guest mode
   (invite `@icarus` into any chat without adding the bot). Details — §6.

**Bottom line:** "Telegram Apps" is real, but multi-chat should not be built in them. First §2 (topics),
then §5 (Mini App as a panel), Mini App as a chat client — only if the first two aren't enough.

---

## 1. What happened in Telegram during 2026 (timeline for us)

Everything below is from the Bot API changelog and `bots/features`; the API version at the date of this analysis is **10.3
(24.08.2026)**.

| Date | Version | What appeared | How it helps Icarus |
|---|---|---|---|
| 31.12.2025 | 9.3 | **Topics in private chats**: `has_topics_enabled` in `getMe`, `message_thread_id`/`is_topic_message` in private chats | A list of conversations inside a private chat |
| 09.02.2026 | 9.4 | The bot itself creates topics in private chats (`createForumTopic`), `allows_users_to_create_topics` | `/topic` creates a topic from the bot |
| 01.03.2026 | 9.5 | `sendMessageDraft` allowed for all bots, emoji on buttons | — |
| 03.04.2026 | 9.6 | Managed bots, `WebApp.requestChat` | Not needed |
| 08.05.2026 | 10.0 | **Guest mode** (the bot replies in chats where it isn't a member), business bots without Premium | Invite Icarus into any chat |
| 11.06.2026 | 10.1 | **Rich messages** + `sendRichMessage`, `sendRichMessageDraft`, join-request Mini Apps | Tables/formulas, streaming |
| 14.07.2026 | 10.2 | **Ephemeral messages** in groups, Communities; closing of Mini App methods for foreign origins (from 20.07.2026) | A private reply in a shared chat |
| 24.08.2026 | 10.3 | Fixes to rich/ephemeral, `can_stop`/`keep_on_stop`, `MessageGenerationStopped` | Stop for a stream |

The main takeaway from the table: **while we were thinking about a Mini App, Telegram closed off our task
with built-in tools.** What follows — by option.

---

## 2. Option A (recommended): topics in private chats — native multi-chat

### 2.1 What it looks like for the person

In a private chat with a bot, the same interface appears as a forum in a supergroup: a list of topics
at the top, and inside — a separate message feed. A person can create topics themselves — via the
**All Messages** button in the header of the bot chat: a message sent there creates a new topic (that's how it's
described in the [hermes-agent docs](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md);
Telegram's Bot API doesn't spell out the user scenario). The bot creates topics by calling the API.
The documentation's phrasing:
*«Bots and users can organize long-running private conversations into separate topics — for
example, one topic for an order, another for technical support and a third for a recurring
task»* ([features#topics-in-private-chats](https://core.telegram.org/bots/features#topics-in-private-chats)).

It's literally a ChatGPT-like sidebar, but native: no markup, no hosting, no onboarding.

### 2.2 What needs to be enabled (and where people usually stumble)

The setting is **on the bot owner's side, in the BotFather Mini App**, not in the chat:

1. Open the **BotFather Mini App**: in Telegram search, type `botfather` and tap the blue
   **Open** button on the result (direct link — <https://t.me/BotFather?startapp>). The text menu
   `/mybots` does **not** show this item — that's where everyone stumbles;
2. `My bots → <bot> → Bot Settings →` scroll down to **Threads Settings**;
3. **Threaded Mode** — enable; **«Disallow users to create new threads»** — leave
   off (otherwise the person can't create a topic themselves, `allows_users_to_create_topics: false`).

An illustrative screenshot of the path is in hermes-agent:
`gateway/assets/telegram-botfather-threads-settings.jpg`
([file](https://github.com/NousResearch/hermes-agent/blob/main/gateway/assets/telegram-botfather-threads-settings.jpg)),
and the story of "couldn't find the checkbox" is analyzed in
[issue #48811](https://github.com/NousResearch/hermes-agent/issues/48811) — closed as a navigation
problem, not a rollout problem.

Verification — `getMe`:

* `has_topics_enabled` — *«True, if the bot has forum topic mode enabled in private chats»*;
* `allows_users_to_create_topics` — *«True, if the bot allows users to create and delete
  topics in private chats»*.

If the mode is off, `createForumTopic` returns `400 the chat is not a forum`. That's why our
bot reads the flags from `getMe` (lazily, on the first `/topic` or `/start`) and, when the mode is off,
shows an instruction instead of Telegram's error. In a private chat with a bot there's no "Topics" checkbox — it exists
only for groups; a live bug report about this:
[hermes-agent#115019](https://github.com/NousResearch/hermes-agent/issues/115019).

### 2.3 API: what you can and can't do

| Method | In a private chat with a bot | Note |
|---|---|---|
| `createForumTopic` | yes | *«Use this method to create a topic in a forum supergroup chat **or a private chat with a user**»*; `name` 1-128, `icon_color` from 6 values, `icon_custom_emoji_id` |
| `editForumTopic` | yes | Renaming and changing the icon, `message_thread_id` required |
| `deleteForumTopic` | yes | Deletes the topic together with its messages |
| `unpinAllForumTopicMessages` | yes | — |
| `closeForumTopic` / `reopenForumTopic` | probably not | In the docs as of 10.3 — only "forum supergroup chat"; not mentioned for private chats. Looks like un-updated text rather than a prohibition — **UNVERIFIED**, verify by calling it |
| `message_thread_id` in `send*`, `sendChatAction`, `copy*`, `forward*` | yes | `sendChatAction` explicitly states: *«for supergroups and private chats of bots with forum topic mode enabled only»* |
| `getForumTopicIconStickers` | yes | Emoji icons for the topic |

How the bot learns about a topic created by a person: a service message arrives,
`forum_topic_created` (`ForumTopicCreated`) with the field `is_name_implicit` — *«True, if the name
of the topic wasn't specified explicitly by its creator and likely needs to be changed by the
bot»*. That is, Telegram itself hints: the name "New Topic" needs to be rewritten with something meaningful. For this we already have
a title generator (`http/title.ts`) — and the `oneShot` in the registry, which is what titles are made with.

An important routing detail: the **General topic** (pinned at the top) in a private chat is the root of the
chat, and its messages can arrive either with `message_thread_id=1` or without any
`thread_id` at all. Both cases must be handled, otherwise the root and General will split into two conversations
(that's how hermes-agent solved it, see §7).

### 2.4 What's not in the documentation

* **The limit on the number of topics in a private chat** — not documented. For supergroups, clients can
  paginate (`getForumTopics` in TDLib), and there's no hard "maximum N" in the Bot API. **UNVERIFIED**,
  verify on the stand (§10).
* **Client version requirements** (from which release Telegram on iOS/Android/Desktop shows the
  list of topics in a private chat with a bot) — not specified in the Bot API. In practice: the feature is from 31.12.2025,
  any 2026 client supports it; older clients will show a feed without topics. **UNVERIFIED.**
* The behavior of `sendMessageDraft` inside a private-chat topic: the `message_thread_id` parameter is
  present in the method, but there are no examples in the docs. **UNVERIFIED**, verifiable with one call.

### 2.5 What this means for our code

The good news: there's almost nothing to change, because we already have multi-conversation support.

* `telegram/bot.ts:conversationIdFor(message, userId)` → add `thread_id`:
  private chat without a topic — `telegram-<chat_id>`, with a topic — `telegram-<chat_id>-<thread_id>`.
* `sessions/registry.ts` already holds `Map<"<user>:<conversationId>", PiSession>` — topics
  will split on their own, each with its own container/session.
* `sessions/pi-session.ts:sessionIdFor(user, conversationId)` → SHA1 → its own history file in
  `/workspace/.sessions`. Per-topic history appears for free.
* `/compact` already works by `conversationId` — in a topic it will compact only that conversation.
* New commands: `/topic [name]` (create a topic), `/topics` (list + binding), `/rename`, and
  if desired `/close` — the latter only for supergroups.
* Auto-renaming: `forum_topic_created` with `is_name_implicit` + our `title.ts` → the topic
  turns itself into «Разбор письма из налоговой» [“Parsing a letter from the tax office”].

Estimate: **1-2 days** of work with tests, of which half a day — for BotFather, the flags and handling the
`General` topic. No DB schema, no migrations, no new infrastructure.

---

## 3. Option B: Mini App as a chat client — real, but expensive and flawed

### 3.1 What it gives

Full control over the UI: your own chat list, search through history, folders, custom streaming,
attachments, settings. Launch — by a menu button, an inline button under a message, from the bot's profile
(main Mini App), a direct link `t.me/<bot>/<app>?startapp=...`. Inside — `initData` with
signed data about the person, the Telegram theme, safe-area, BackButton, haptics. There's already
`fetch`, so our SSE streaming (`http/sse.ts`) plugs in as is.

### 3.2 What it doesn't give (and this is the main thing)

| Limitation | Wording/source |
|---|---|
| No access to chats | *«Mini Apps opened from a direct link have **no access** to the chat – they can't read messages or send new ones on behalf of the user»*; same for inline mode ([webapps](https://core.telegram.org/bots/webapps)) |
| No push | A Mini App can't wake a person. The only notification channel is a bot message; to bring the person back into the app, you need a `web_app` button in that message |
| Lives only while open | The webview closes — no process, no background work; background tasks are on the server anyway |
| Separate hosting | HTTPS URL, domain, binding in BotFather; as of Bot API 10.2, Mini App methods are forbidden from foreign origins (enabled for everyone from 20.07.2026) |
| Its own authorization | `initData` + HMAC, not our SSO header (see 3.3) |
| The entire UI on us | History, scroll, keyboard, iOS specifics — all on us; there's no native message list in a webview |

Chat access exists only for a Mini App launched from the **attachment menu**, and that path is
closed to us: *«Attachment menu integration is currently only available for major advertisers on the
Telegram Ad Platform. However, all bots can use it in the test server environment»*
([webapps](https://core.telegram.org/bots/webapps#adding-bots-to-the-attachment-menu)). Plus
`query_id` gives the right to send a message on behalf of the person, but `answerWebAppQuery` at the same time
**closes** the app — as a transport that's no good, it's "return the result to the chat".

To be fair: **the lack of access to chats is not a death sentence for our idea.** Conversation
history lives with us anyway (`/workspace/.sessions`), not in Telegram, and a Mini App opened by an
inline button or a menu button gets `initData` and `query_id` — that's enough to
work with our own backend over HTTPS. What kills it is not this, but notifications and lifecycle: from a
webview you can't write to a person, and a "background" Mini App doesn't exist.

### 3.3 Authorization: `initData` instead of the SSO proxy

The rule from the docs: *«Validate data from this field before using it on the bot's server»*.
Algorithm: `secret_key = HMAC_SHA256(bot_token, "WebAppData")`,
`hex(HMAC_SHA256(data_check_string, secret_key)) == hash`, where `data_check_string` is all fields
except `hash`, sorted by name, `key=value` separated by `\n`; plus an `auth_date` check against
expiry ([webapps#validating-data](https://core.telegram.org/bots/webapps)).

For us this maps onto `control/identity.ts`: right now the person is named by the SSO proxy via a header
(`panel.userHeader`), and the Mini App must be able to take a second path — "valid `initData` → telegram id →
`telegram.mapping` → person from `users`". Then the panel opens from Telegram without login.
A subtlety to check on live clients: the Telegram webview is a separate cookie store, and the browser's SSO
session probably won't carry over (that is, you can't count on the proxy header). Worse: if the app's URL
answers with a redirect to login, an empty shell opens — *«the Mini App itself opens successfully: initData is received correctly…
However, all WebApp API methods stop working»*
([Telegram-Mini-Apps#85](https://github.com/Telegram-Mini-Apps/issues/issues/85), community,
**UNVERIFIED**). That is, the panel behind SSO and the Mini App are **two different entry hosts**: facing outward
is a public HTTPS without redirects, and the person is named by `initData`. It's verified by the very first
launch; the `initData` path is more reliable in any case. And remember that our `telegram.mapping` is
keyed by username, while `initData` returns both the id and the username.

### 3.4 Cost and risks

* Frontend: a single-file app in the style of our panel (`ui.ts` — one HTML without a build)
  is feasible, but a chat client is not a memory panel: list virtualization, streaming, scroll anchors,
  attachments. Realistically **1-2 weeks** to "not embarrassing to use", and after that it lives on.
* The Mini Apps catalog (Apps tab) we don't need and it doesn't threaten us: to get in you need a Main Mini App +
  >1000 DAU + >1000 Stars/day; an ordinary launch from the profile/button/link works without the catalog
  and without moderation ([breakdown of the requirements](https://kak-v-telegramme.ru/boty-mini-apps/kak-razmeshhat-mini-app-v-kataloge-telegram-2/),
  secondary source).
* Storages (if needed): CloudStorage — 1024 keys per person, value ≤4096
  characters; DeviceStorage — 5 MB per person; SecureStorage — 10 elements (Keychain/Keystore).
* Priority: while topics give 80% of the result in 1 day, a Mini App chat is 20% more for two
  weeks. Doing it first means paying for what Telegram already gave away for free.

### 3.5 What specifically breaks for people (and what to know before starting)

Everything below is from the community and the Telegram-Mini-Apps tracker, not documentation; marked as **UNVERIFIED**,
but it's precisely these rakes that determine the scope of work:

* **The webview reloads itself.** On Android there's an open bug: the client reloads the Mini App
  every 5-10 seconds (*«12 full page loads in 6 minutes»* on a real device,
  [#86](https://github.com/Telegram-Mini-Apps/issues/issues/86), OPEN). When minimized to the
  tray, the connection drops with code 1006 ([#78](https://github.com/Telegram-Mini-Apps/issues/issues/78)).
  Conclusion: a long pi turn lives on the server and is keyed by conversation, while the UI is a reconnectable
  view of server state, not the owner of the process. Our `SessionRegistry` already knows how to do this, and the Mini App is obliged to simply reconnect to the SSE.
* **Minimizing ≠ background.** Since 2024 a Mini App can be collapsed into a strip at the bottom of the screen and restored
  without reloading, and on desktop there are tabs
  ([announcement](https://telegram.org/blog/mini-app-bar-paid-media-and-more#mini-app-bar)), but
  there's no background execution and no guarantees for the webview's life.
* **A deep link doesn't switch the conversation.** If an instance is already open, new `startapp` parameters
  are ignored ([#44](https://github.com/Telegram-Mini-Apps/issues/issues/44)), and there can be several
  instances ([#70](https://github.com/Telegram-Mini-Apps/issues/issues/70)). So
  "the notification opens chat #123" doesn't work by itself: you need routing inside
  the app and an "active conversation" from the server.
* **`ready()` and client version.** Without `ready()` the placeholder is removed only after full loading;
  older clients expose an older Bot API, so everything new — via `isVersionAtLeast()`
  ([#55](https://github.com/Telegram-Mini-Apps/issues/issues/55)). There's no official repository for
  `telegram-web-app.js`: the file is served minified from telegram.org and
  cache-busted manually (`?64`) — vendor and pin it ourselves.
* **iOS/Android specifics:** wrong `viewportHeight` when the keyboard is open
  ([#14](https://github.com/Telegram-Mini-Apps/issues/issues/14)), jumping bottom panels due to
  safe-area ([#39](https://github.com/Telegram-Mini-Apps/issues/issues/39)), Service Workers don't
  work on iOS ([#27](https://github.com/Telegram-Mini-Apps/issues/issues/27), OPEN),
  `ClosingConfirmation` lies and there's no reliable close event
  ([#1](https://github.com/Telegram-Mini-Apps/issues/issues/1),
  [#69](https://github.com/Telegram-Mini-Apps/issues/issues/69)) — that is, "save the draft
  on close" won't work with an asynchronous request.
* **There's no review at publication.** Created a bot → `/newapp` → specified the HTTPS URL, and that's it; the catalog
  (Apps tab) is a separate story about featured and Stars. For a personal Icarus this isn't needed at all.
* **Chat history doesn't fit into Telegram's storages:** CloudStorage — 4096 characters per key
  (1024 keys), that is ~4 KB; DeviceStorage — 5 MB; SecureStorage — 10 elements. History
  stays on our server; we put only the UI state into the cloud (cursor, active conversation).

---

## 4. Option C: a supergroup with topics (the old path, before 9.3)

The classic: a forum supergroup, the bot an admin with `can_manage_topics`, each topic a conversation, different
people in one group. It has worked since 2022, there are almost no limitations, topics can be closed
(`closeForumTopic`). But: the person has to join the group, the group has members and rules,
Icarus's personal memory gets mixed with group visibility, and "just talk to Icarus"
turns into "go into a room". For a family/team — yes; for a personal multi-chat — no.

---

## 5. Option D (second in priority): Mini App as a panel

Here the Mini App is in its element: configuration, approvals, dashboards — in the words of the docs
themselves: *«Mini Apps provide a richer workspace for configuration, approvals and dashboards»*
([features#ai-agents](https://core.telegram.org/bots/features#ai-agents)).

What it gives us: the panel (`/panel`, memory, git history, Maple charts) is already written and already
split into `SECTIONS`. The bot's menu button (`setChatMenuButton` with `MenuButtonWebApp`:
`type: web_app`, `text`, `web_app: WebAppInfo`; can be set as the default or only for the
private chat with a person) → the panel opens in one tap from the chat, `initData` names the
person, no long login needed. After that, naturally asking to go there too are:
* the list of conversations and their `/compact`/deletion (things that in the chat live as commands);
* memory (already there);
* status: live sessions, containers, spend (`registry.list()` and `/healthz` already return this).

Estimate: **1-2 days** for the "chats" section + the initData path in `identity.ts`. This is exactly how a Mini App
strengthens the chat without trying to replace it.

---

## 6. What else from 2026 is worth taking (regardless of the option)

1. **Streaming: `sendMessageDraft` / `sendRichMessageDraft`.** *«stream a partial message to a
   user while the message is being generated… the streamed draft is ephemeral and acts as a
   temporary 30-second preview — once the output is finalized, you must call sendMessage»*.
   Empty text = the placeholder "Thinking…". `draft_id` — one per generation, changes with the same
   id are animated. `can_stop: true` shows the person a Stop button, the bot receives the update
   `MessageGenerationStopped` (`chat`, `message_thread_id`, `draft_id`) and can interrupt the turn.
   This is a direct replacement for our `EDIT_INTERVAL_MS = 1200` and the texts «Ещё думаю над прошлым
   сообщением» [“Still thinking about the previous message”]: right now we edit one message and pray against 429, now we can emit
   partials natively, and the final one — with a regular `sendMessage`.
   **Caveat:** the method's `chat_id` is described as "Unique identifier for the target **private**
   chat" — that is, in groups, streaming by drafts is unavailable, and there our
   `editMessageText` remains. In a private chat (and in private-chat topics) it works, `message_thread_id` is
   among the parameters.
   **Risk:** the FAQ still requires "no more than one message per second per chat"; how this
   relates to the frequency of drafts — not documented. **UNVERIFIED**, measure on the stand.
2. **Rich messages (`sendRichMessage`).** Headings, lists, tables, collapsible blocks,
   LaTeX (inline and block), media, buttons inside the message. For Icarus this is the answer about Maple:
   formulas and tables will render natively, not as an image via `/maple/`.
3. **Ephemeral messages (10.2).** In a group, the bot can reply so that only one
   person sees it (and the bot): *«let bots send private responses inside group chats – visible only to a
   specific user and the bot»*. Scenario: someone asks something personal in a shared chat — Icarus answers in a
   whisper rather than staying silent.
4. **Guest mode (10.0).** *«allowing bots to receive certain messages and issue replies within
   chats they are not a member of»*: a person writes `@icarus_bot <question>` in any chat, the bot
   receives this message (and the one being replied to) and can reply once, without being added to the
   chat. Access to history and members is not granted in this case. This is exactly "Icarus is around when you need him",
   and it's cheaper than adding him to every chat.
5. **Secretary mode / business bots (10.0).** The bot connects to an account and replies in private
   chats on behalf of the person; the owner grants the rights (`can_reply`, `can_read_messages`, deletion),
   and Premium is no longer required. For Icarus this is a separate decision about privacy, not
   about multi-chat; we don't consider it in this analysis.
6. **Bot-to-bot (10.0/10.1).** If helper bots ever appear (a Maple bot, an
   archivist bot), they'll be able to talk to each other directly. Not needed yet.

---

## 7. Others' experience: how it's already been done

* **hermes-agent (NousResearch)** — an agent platform that has both config-driven topics
  (`extra.dm_topics`) and a **user-driven `/topic` mode**: *«A ChatGPT-style multi-session DM —
  one bot, many parallel conversations… The end user flips it on with /topic, then taps the
  Telegram + button to create as many topics as they want, each one a fully independent
  session»* ([telegram.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md)).
  Useful bits from there:
  * the isolation key is `chat_id + thread_id` (ours will be the same in `conversationId`);
  * the root of the private chat is turned into a "lobby": ordinary messages are rejected with a hint, system
    commands work (in our case the root stays a conversation — that's for us to decide);
  * auto-renaming the topic to the generated session title (and a flag to turn it off);
  * the `General` topic is treated as the root regardless of whether `thread_id=1` arrived or nothing;
  * topics created by a person are picked up via `forum_topic_created`, without a restart;
  * reminders in the root — with a rate limit, so the person doesn't get ten "you're in the lobby" replies.
  * Implementation: commit [5506139](https://github.com/NousResearch/hermes-agent/commit/55061390fc726c08975456e7f3bef1d56b90e5fc)
    (`_create_dm_topic`, `_setup_dm_topics`, `_persist_dm_topic_thread_id`,
    `_cache_dm_topic_from_message`) — 290 lines per adapter. The scale of the change shows that this is
    a small task, not a project.
* **nekoclaw** ([github](https://github.com/oines/nekoclaw)) — an architectural neighbor: the same
  `pi-coding-agent`, a Docker container per agent, memory in Markdown, Telegram via grammy. There's
  neither a Mini App nor topics for multi-chat — that is, "multi-chat" is not a mandatory
  attribute of a mature AI bot in Telegram.
* **tg-llm-router** ([github](https://github.com/x100Value/tg-llm-router)) — an example of a Mini App
  on top of an LLM (a model router, BYOK, TON Connect). Useful as a reference of "what a TMA for an
  LLM looks like", but it's specifically a client app, not multi-chat in a bot chat.
* **hermes-miniapp** ([github](https://github.com/jessicarust/hermes-miniapp)) — the closest
  analog of option B: *«full-screen mobile chat interface… Streaming chat — responses appear
  token-by-token… Persistent sessions — conversation history survives app restarts… The mini
  app authenticates via Telegram WebApp initData»*; endpoints `/v1/webapp/auth` (initData →
  session token) and `/v1/webapp/chat` (SSE), HTTPS via a tunnel. The repository is fresh and
  low-star — quality **UNVERIFIED**, but the architecture is exactly what's described in §3:
  initData authorization, SSE streaming, sessions tied to the telegram id.
* **The `web_app` button as a notification** — this is also how it's done in hermes-agent itself: a separate PR
  adds *«an optional `web_app_button` payload for Telegram private chats»*
  ([PR #67864](https://github.com/NousResearch/hermes-agent/pull/67864)). This confirms
  the only working scheme: the bot = the notification channel, the Mini App = the reading surface.
* **notepher-bot** ([github](https://github.com/deptyped/notepher-bot)) — an example of a Mini App with a
  list and a detail view, offline-first, synchronization via CloudStorage: useful as a reference for
  storing UI state, if it ever comes to option B.
* **An honest summary on prior art:** there's no mature open "chat list + conversation window" on a Mini App;
  the mainstream of LLM bots in Telegram is plain bot messages. I couldn't find a single case where an
  LLM's answer streaming goes through a webview with a reliable completion notification: this is
  **UNVERIFIED** territory, and it must be designed with reconnection in mind.

---

## 8. What not to do

* **Don't write your own Telegram client** and don't try to read other people's chats: the Bot API has no such
  thing, and a userbot (MTProto/TDLib on behalf of a person) is a different class of risks (ToS, bans) and
  a separate discussion, not for multi-chat.
* **Don't set up a DB for topic bindings** as long as `conversationId` is derived from the message. Our
  session files are append-only in `/workspace/.sessions` anyway.
* **Don't drag in a Mini App chat "because you can"**: there are no notifications in it, and it's precisely notifications that are
  the reason Icarus lives in Telegram and not in a browser.
* **Don't enable topics silently**: if the person is used to a single feed, enabling Threaded Mode
  changes their interface. It's a toggle, not a default (and it's on the BotFather side, that is,
  it requires a manual step by the bot owner).

---

## 9. Bottom line on the options

| Option | What it gives | Cost | Verdict |
|---|---|---|---|
| A. Topics in a private chat | A native conversation list, context isolation, `/compact` per conversation | 1-2 days, `conversationId` key + commands | **Do first** |
| B. Mini App chat | Its own UI, search, folders | 1-2 weeks + hosting/domain + initData authorization, no push and no background, webview reloads, a deep link doesn't switch the conversation | Later, if A isn't enough |
| C. Forum supergroup | A shared multi-chat for a family/team | Onboarding into the group, shared visibility | When "for everyone" appears |
| D. Mini App panel | Chats/memory/status from a phone in one tap | 1-2 days on top of the existing panel | **Do second** |

---

## 10. What to check by hand on the stand (spike, half a day)

1. BotFather (Mini App) → Bot Settings → **Threads Settings → Threaded Mode**; `getMe` →
   `has_topics_enabled: true`, `allows_users_to_create_topics: true`. Turn it back off →
   make sure `createForumTopic` gives `400 the chat is not a forum` (this is our understandable
   error for the person, not a stack trace).
2. `createForumTopic` from the bot → send a message to the topic → get a reply in the topic.
3. Create a topic manually in the client → check that `forum_topic_created` arrived and that
   `is_name_implicit=true` (so it can be renamed to the conversation title).
4. Root of the private chat vs General: see which `message_thread_id` the messages arrive with
   (1 or nothing) — `conversationIdFor` depends on this.
5. `sendMessageDraft` in a topic: animation, "Thinking…" on empty text, `can_stop` → the update
   `stopped_message_generation`; measure how many updates per second Telegram holds before 429.
6. `/compact` inside a topic — only that conversation is compacted, neighbors are untouched.
7. Clients: iOS, Android, Desktop, Web — is the topic list visible and what do older
   versions show; check that the conversation at the root doesn't get mixed with topics.
8. Separately — how well `rich messages` render in our clients (LaTeX/tables), before
   promising Maple output in the chat.

**If we do decide on a Mini App (option B/D)** — verify before the code, not after:
9. Public HTTPS without redirects: open the URL from an inline button behind our SSO proxy and
   make sure the WebApp methods work (and not just that the page opens).
10. A deep link into an already open instance: `?startapp=<conversation>` while the app is alive —
    see with your own eyes that the parameters are ignored, and decide how to work around it.

---

## Sources

**Telegram primary sources**
* Bot API 10.3 and the method/class reference: <https://core.telegram.org/bots/api> (checked 08.10.2026)
* Changelog by version (9.3 — 31.12.2025, 9.4 — 09.02.2026, 10.0 — 08.05.2026, 10.1 — 11.06.2026, 10.2 — 14.07.2026, 10.3 — 24.08.2026): <https://core.telegram.org/bots/api-changelog>
* Bot features: topics in private chats, streaming, ephemeral, rich messages, guest bots, business/secretary, AI agents: <https://core.telegram.org/bots/features>
* Mini Apps: launch methods, chat access, `initData` and its validation, storages: <https://core.telegram.org/bots/webapps>
* Limits (1 message/sec per chat, 20/min in a group, ~30/sec for broadcast): <https://core.telegram.org/bots/faq>
* Announcement of AI features (guest bots, bot-to-bot, streaming, chat automation): <https://telegram.org/blog/ai-bot-revolution-11-new-features>
* Announcement of the Mini App Bar (collapsing apps into a strip, restoring without reload): <https://telegram.org/blog/mini-app-bar-paid-media-and-more>
* Telegram-Mini-Apps tracker (webview reloads, deep links, SSO redirects, iOS/Android bugs): <https://github.com/Telegram-Mini-Apps/issues/issues>

**Others' experience and secondary sources**
* hermes-agent: Telegram docs (including Private Chat Topics and `/topic`): <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md>
* Bug report about BotFather Threaded Mode and `has_topics_enabled`: <https://github.com/NousResearch/hermes-agent/issues/115019>
* Implementation of DM topics (commit): <https://github.com/NousResearch/hermes-agent/commit/55061390fc726c08975456e7f3bef1d56b90e5fc>
* The `web_app` button as a "notification → app" channel: <https://github.com/NousResearch/hermes-agent/pull/67864>
* hermes-miniapp — a Mini App as an agent chat client (initData + SSE, fresh, quality unchecked): <https://github.com/jessicarust/hermes-miniapp>
* notepher-bot — a Mini App list+detail with CloudStorage: <https://github.com/deptyped/notepher-bot>
* Community guides on Mini Apps (initData, creating an app): <https://docs.telegram-mini-apps.com/platform/init-data>
* nekoclaw — an AI agent on `pi` + Docker in Telegram: <https://github.com/oines/nekoclaw>
* tg-llm-router — a Mini App for an LLM: <https://github.com/x100Value/tg-llm-router>
* Mini Apps catalog requirements (secondary source): <https://kak-v-telegramme.ru/boty-mini-apps/kak-razmeshhat-mini-app-v-kataloge-telegram-2/>

**Our code that this analysis relies on**
* `packages/service/src/telegram/bot.ts` — `conversationIdFor`, `/compact`, `EDIT_INTERVAL_MS`, polling and the per-chat queue
* `packages/service/src/sessions/registry.ts` — sessions by `(person, conversation)`, compaction of idle ones
* `packages/service/src/sessions/pi-session.ts` — `sessionIdFor` → the history file in `/workspace/.sessions`
* `packages/service/src/http/sse.ts`, `http/title.ts` — streaming and conversation titles
* `packages/service/src/control/{index,identity,ui}.ts` — the panel, SSO identification, single-file UI
* `config.example.yaml`, the `telegram:` section — username → person mapping, speech
