// Telegram bot: who gets the reply, what we answer to commands, and how the reply reaches
// the chat. There is no network or Docker here: Bot API, session registry and pi session are stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  KeyedQueue,
  TelegramBot,
  NOTHING_TO_READ,
  VOICE_EMPTY,
  VOICE_NO_SPEECH,
  attachmentFailed,
  compactText,
  conversationIdFor,
  clearText,
  parseCommand,
  skillsText,
  statsText,
  stopText,
  topicThreadId,
  unsupportedText,
  voicePrompt,
  GREETING,
  HELP,
  NO_USERNAME,
  RENAME_NEEDS_NAME,
  UNKNOWN_COMMAND,
  WORKSPACE_PRIVATE_REFUSED,
  workspaceUnknown,
  workspacesText,
} from '../src/telegram/bot.ts';
import {
  TelegramApi,
  TelegramError,
  landedInThread,
  type TelegramPhotoSize,
  type TelegramUpdate,
} from '../src/telegram/api.ts';
import { MESSAGE_LIMIT, splitPoint } from '../src/telegram/reply.ts';
import { userPaths } from '../src/config.ts';
import { ensureChat, findChatRecord, readChats, recordTurn, renameChat, workspaceForConversation } from '../src/sessions/chats.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { broadcast } from '../src/control/chat-live.ts';
import { createWorkspace } from '../src/workspaces.ts';
import { makeConfig, probe } from './fixtures.ts';

/** Bytes that were "downloaded" from Telegram: the content does not matter in tests. */
const JPEG = Buffer.from('не-совсем-jpeg');

// --- Bot API ----------------------------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> };

function fakeFetch(responses: Array<Record<string, unknown> | Error>): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next ?? { ok: true, result: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

test('Bot API: long polling confirms updates and fetches only messages', async () => {
  const { calls, fetch } = fakeFetch([{ ok: true, result: [{ update_id: 7, message: { message_id: 1 } }] }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  const updates = await api.getUpdates({ offset: 5, timeoutSeconds: 30 });

  assert.equal(updates.length, 1);
  assert.equal(calls[0]?.url, 'https://tg.test/botTOKEN/getUpdates');
  assert.equal(calls[0]?.body.offset, 5);
  assert.equal(calls[0]?.body.timeout, 30);
  assert.deepEqual(calls[0]?.body.allowed_updates, ['message']);
});

test('Bot API: an error arrives with a code and description', async () => {
  const { fetch } = fakeFetch([{ ok: false, error_code: 400, description: 'chat not found' }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(() => api.sendMessage(1, 'привет'), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.code, 400);
    assert.match(error.message, /chat not found/);
    return true;
  });
});

test('Bot API: the markup mode goes into the request, without it — it does not', async () => {
  const { calls, fetch } = fakeFetch([
    { ok: true, result: { message_id: 1 } },
    { ok: true, result: { message_id: 2 } },
    { ok: true, result: true },
  ]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await api.sendMessage(1, '<b>жирный</b>', null, undefined, { parseMode: 'HTML' });
  await api.sendMessage(1, 'привет');
  await api.editMessageText(1, 2, '<b>жирный</b>', { parseMode: 'HTML' });

  assert.equal(calls[0]?.body.parse_mode, 'HTML');
  // Service messages (greeting, commands) are plain text: nobody cleans markup in them.
  assert.equal(calls[1]?.body.parse_mode, undefined);
  assert.equal(calls[2]?.body.parse_mode, 'HTML', 'правка тоже размеченная');
});

test('Bot API: on 429 we wait and retry instead of losing the reply', async () => {
  const { calls, fetch } = fakeFetch([
    { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } },
    { ok: true, result: { message_id: 3 } },
  ]);
  const waited: number[] = [];
  const api = new TelegramApi('TOKEN', {
    fetch,
    baseUrl: 'https://tg.test',
    sleep: async (ms) => void waited.push(ms),
  });

  const sent = await api.sendMessage(1, 'привет');
  assert.equal(sent.message_id, 3);
  assert.deepEqual(waited, [2000], 'ждём ровно столько, сколько просил Telegram');
  assert.equal(calls.length, 2);
});

test('Bot API: "message is not modified" is not an error', async () => {
  const { fetch } = fakeFetch([{ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });
  await api.editMessageText(1, 2, 'то же самое');
});

test('Bot API: it is visible when a message did not land in the topic', () => {
  // In a private chat with topics Telegram can reply ok and put the message into the general feed:
  // the response reveals it — it has no topic id and no topic flag.
  assert.equal(landedInThread({ message_id: 1, message_thread_id: 17 }, 17), true);
  assert.equal(landedInThread({ message_id: 1, is_topic_message: true }, 17), true);
  assert.equal(landedInThread({ message_id: 1, message_thread_id: null }, 17), false);
  assert.equal(landedInThread({ message_id: 1, message_thread_id: 3 }, 17), false);
  assert.equal(landedInThread({ message_id: 1 }, 17), false);
});

test('Bot API: a rejected topic is retried with an anchor reply', async () => {
  const { calls, fetch } = fakeFetch([
    { ok: false, error_code: 400, description: 'Bad Request: message thread not found' },
    { ok: true, result: { message_id: 5, message_thread_id: 17, is_topic_message: true } },
  ]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  const sent = await api.sendMessage(1, 'привет', 17, 99);

  assert.equal(sent.message_id, 5);
  assert.equal(calls[1]?.body.message_thread_id, undefined, 'якорь вместо номера топика');
  assert.deepEqual(calls[1]?.body.reply_parameters, { message_id: 99 });
});

test('Bot API: without an anchor a rejected topic is an error, not a quiet send to the root', async () => {
  const { fetch } = fakeFetch([{ ok: false, error_code: 400, description: 'Bad Request: message thread not found' }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(() => api.sendMessage(1, 'привет', 17), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.match(error.message, /message thread not found/);
    return true;
  });
});

// --- bot --------------------------------------------------------------------

type Step = Record<string, unknown>;

const ANSWER_STEPS: Step[] = [
  { type: 'tool_execution_start', toolName: 'read', args: { path: '/workspaces/.icarus/memory/identity.md' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Привет' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ', Саня' } },
  { type: 'agent_settled' },
];

function fakeSession(steps: Step[] = ANSWER_STEPS) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  return {
    busy: false,
    prompts: [] as string[],
    /** What went to the model as images: base64 and mime, exactly as pi expects. */
    images: [] as Array<Array<{ data: string; mimeType: string }>>,
    async prompt(text: string, images: Array<{ data: string; mimeType: string }> = []) {
      this.prompts.push(text);
      this.images.push(images);
      for (const step of steps) for (const listener of listeners) listener(step);
    },
    onEvent(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Chat through Telegram's eyes: messages are created by sending and changed by edits. */
function fakeApi(files: Record<string, Buffer> = {}) {
  const state = {
    messages: [] as Array<{
      chatId: number;
      id: number;
      text: string;
      threadId: number | null;
      /** With what markup the message landed in Telegram: null — as plain text. */
      parseMode: string | null;
    }>,
    nextId: 1,
    /** Telegram actions in order: how the bot showed it was busy. */
    actions: [] as Array<{ action: string; threadId: number | null }>,
    files: new Map(Object.entries(files)),
    downloaded: [] as string[],
    /** Threaded Mode: in production these are getMe flags, in tests a toggle. */
    topicsEnabled: false,
    /** Renames: chatId, topic, new name. */
    renames: [] as Array<{ chatId: number; threadId: number; name: string }>,
    /** Deleted topics: this is how archiving takes a conversation out of Telegram. */
    deletedTopics: [] as Array<{ chatId: number; threadId: number }>,
    /** Sent attachments: photos and documents separately, as in Telegram. */
    photos: [] as Array<{ chatId: number; threadId: number | null; name: string; bytes: Buffer; caption?: string }>,
    documents: [] as Array<{ chatId: number; threadId: number | null; name: string; bytes: Buffer; caption?: string }>,
    /** Telegram rejects sending into a topic: this is what a "reply did not arrive" looks like. */
    failTopics: false,
    /** Telegram rejects markup: this is what our HTML mistake looks like. */
    rejectMarkup: false,
  };
  /** Telegram parses markup before saving: if it refused, the message does not exist. */
  const rejectMarkup = (parseMode?: string) => {
    if (!state.rejectMarkup || !parseMode) return;
    throw new TelegramError(`Bad Request: can't parse entities: Unsupported start tag "b" at byte offset 0`, 400);
  };
  const api = {
    async sendMessage(
      chatId: number,
      text: string,
      threadId: number | null = null,
      _anchor?: number,
      options: { parseMode?: string } = {},
    ) {
      if (state.failTopics && threadId !== null) {
        throw new TelegramError('Bad Request: message thread not found', 400);
      }
      rejectMarkup(options.parseMode);
      const message = { chatId, id: state.nextId, text, threadId, parseMode: options.parseMode ?? null };
      state.nextId += 1;
      state.messages.push(message);
      return { message_id: message.id };
    },
    async editMessageText(chatId: number, messageId: number, text: string, options: { parseMode?: string } = {}) {
      const message = state.messages.find((item) => item.id === messageId && item.chatId === chatId);
      if (!message) throw new TelegramError('message to edit not found', 400);
      rejectMarkup(options.parseMode);
      message.text = text;
      message.parseMode = options.parseMode ?? null;
    },
    async sendChatAction(_chatId: number, action = 'typing', threadId: number | null = null) {
      state.actions.push({ action, threadId });
    },
    async setMyCommands() {},
    async getMe() {
      return { id: 1, username: 'the_icarus_bot' };
    },
    async editForumTopic(chatId: number, threadId: number, name: string) {
      if (!state.topicsEnabled) throw new TelegramError('Bad Request: the chat is not a forum', 400);
      state.renames.push({ chatId, threadId, name });
    },
    async deleteForumTopic(chatId: number, threadId: number) {
      if (!state.topicsEnabled) throw new TelegramError('Bad Request: the chat is not a forum', 400);
      state.deletedTopics.push({ chatId, threadId });
    },
    async getFile(fileId: string) {
      if (!state.files.has(fileId)) throw new TelegramError('file not found', 400);
      return { file_id: fileId, file_path: `files/${fileId}`, file_size: state.files.get(fileId)?.length ?? 0 };
    },
    async downloadFile(filePath: string) {
      state.downloaded.push(filePath);
      const file = state.files.get(filePath.replace(/^files\//, ''));
      if (!file) throw new TelegramError('файл не скачался', 404);
      return file;
    },
    /** Attachments: the file goes as bytes, not a string — just like in the Bot API. */
    async sendPhoto(
      chatId: number,
      file: { bytes: Buffer; name: string },
      options: { caption?: string; threadId?: number | null } = {},
    ) {
      const sent = { chatId, threadId: options.threadId ?? null, name: file.name, bytes: file.bytes };
      state.photos.push({ ...sent, ...(options.caption ? { caption: options.caption } : {}) });
      return { message_id: state.nextId++ };
    },
    async sendDocument(
      chatId: number,
      file: { bytes: Buffer; name: string },
      options: { caption?: string; threadId?: number | null } = {},
    ) {
      const sent = { chatId, threadId: options.threadId ?? null, name: file.name, bytes: file.bytes };
      state.documents.push({ ...sent, ...(options.caption ? { caption: options.caption } : {}) });
      return { message_id: state.nextId++ };
    },
  } as unknown as TelegramApi;
  return { api, state };
}

/** What went to the chat root: topic messages do not end up here. */
function chatText(state: ReturnType<typeof fakeApi>['state'], chatId: number): string {
  return state.messages
    .filter((message) => message.chatId === chatId && message.threadId === null)
    .map((message) => message.text)
    .join('\n');
}

/** The last Telegram action: how the bot showed it was busy, most recently. */
function lastAction(state: ReturnType<typeof fakeApi>['state']): { action: string; threadId: number | null } {
  const last = state.actions.at(-1);
  assert.ok(last, 'бот должен показать, что он занят');
  return last;
}

/** Only what went to a specific topic: there must be no reply in the chat root. */
function topicText(state: ReturnType<typeof fakeApi>['state'], chatId: number, threadId: number): string {
  return state.messages
    .filter((message) => message.chatId === chatId && message.threadId === threadId)
    .map((message) => message.text)
    .join('\n');
}

function makeBot(
  options: {
    steps?: Step[];
    config?: ReturnType<typeof makeConfig>;
    compact?: unknown;
    /** How the bot commands ended: all good by default. */
    stop?: unknown;
    stats?: unknown;
    clear?: unknown;
    rename?: unknown;
    skills?: unknown;
    /** What to transcribe voice with: like in production, but without network; null — nothing. */
    transcribe?: ((audio: Uint8Array, mimeType: string) => Promise<string>) | null;
    /** Files "stored" in Telegram: id → bytes. */
    files?: Record<string, Buffer>;
    /** Threaded Mode on the bot: with it /rename changes the topic name, without it only chats.json. */
    topics?: boolean;
    /** How long a "fresh topic" lives (the first message of a topic created from the feed). */
    freshTopicWindowMs?: number;
    /** Custom session: the interruption test needs a long turn, not an instant one. */
    session?: ReturnType<typeof fakeSession>;
    /** What the cheap model answers the title request (the `oneShot` registry). */
    oneShot?: (prompt: string) => Promise<string>;
  } = {},
) {
  const config =
    options.config ??
    makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const session = options.session ?? fakeSession(options.steps ?? ANSWER_STEPS);
  const calls: Array<{ command: string; user: string; conversationId: string; args?: string }> = [];
  const record = (command: string, user: { id: string }, conversationId: string, args?: string) => {
    calls.push({ command, user: user.id, conversationId, ...(args ? { args } : {}) });
  };
  const registry = {
    acquire: async () => session,
    compact: async (user: { id: string }, conversationId: string, customInstructions?: string) => {
      record('compact', user, conversationId, customInstructions);
      return options.compact ?? { status: 'compacted', tokensBefore: 1200, tokensAfter: 300 };
    },
    abort: async (user: { id: string }, conversationId: string) => {
      record('stop', user, conversationId);
      return options.stop ?? { status: 'stopped' };
    },
    interrupt: async (user: { id: string }, conversationId: string) => {
      record('interrupt', user, conversationId);
      const stop = (session as { interrupt?: () => Promise<boolean> }).interrupt;
      if (stop) await stop.call(session);
      return { status: 'stopped' };
    },
    stats: async (user: { id: string }, conversationId: string) => {
      record('stats', user, conversationId);
      return (
        options.stats ?? {
          status: 'ok',
          stats: {
            userMessages: 12,
            toolCalls: 40,
            tokens: { input: 50_000, output: 10_000, cacheRead: 45_000, total: 105_000 },
            cost: 0.45,
            contextUsage: { tokens: 68_000, contextWindow: 200_000, percent: 34 },
          },
        }
      );
    },
    clear: async (user: { id: string }, conversationId: string) => {
      record('clear', user, conversationId);
      return options.clear ?? { status: 'started' };
    },
    rename: async (user: { id: string }, conversationId: string, name: string) => {
      record('rename', user, conversationId, name);
      return options.rename ?? { status: 'renamed', title: name };
    },
    commands: async (user: { id: string }, conversationId: string) => {
      record('skills', user, conversationId);
      return (
        options.skills ?? {
          status: 'ok',
          commands: [
            { name: 'skill:brave-search', description: 'поиск в интернете', source: 'skill' },
            { name: 'fix-tests', description: 'починить тесты', source: 'prompt' },
          ],
        }
      );
    },
    oneShot: async (_user: { id: string }, prompt: string) => {
      if (!options.oneShot) throw new Error('модель не настроена');
      return options.oneShot(prompt);
    },
  };
  const { api, state } = fakeApi(options.files ?? { IMAGE: JPEG, VOICE: JPEG });
  state.topicsEnabled = options.topics ?? false;
  // Transcription works by default: the "no recognition" test sets null explicitly.
  const transcribe =
    'transcribe' in options ? options.transcribe : async () => 'привет из голосового';
  const bot = new TelegramBot(config, registry as never, {
    api,
    editIntervalMs: 0,
    // Show the action right away and repeat at most once an hour: the test does not need ticks.
    actionGapMs: 0,
    actionIntervalMs: 3_600_000,
    transcribe,
    ...(options.freshTopicWindowMs === undefined ? {} : { freshTopicWindowMs: options.freshTopicWindowMs }),
  });
  return { bot, session, state, calls, config };
}

function messageUpdate(
  text: string,
  options: { username?: string; chatId?: number; type?: string; threadId?: number } = {},
): TelegramUpdate {
  const { username = 'trousev', chatId = 42, type = 'private', threadId } = options;
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: chatId, type },
      from: username === '' ? { id: 7 } : { id: 7, username },
      text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
    },
  };
}

/**
 * Service message: the Telegram client created a topic (the "All Messages" button). The bot
 * only uses it to figure out where to put the first message from the general feed.
 */
function topicCreatedUpdate(name: string, threadId: number, chatId = 42): TelegramUpdate {
  return {
    update_id: 2,
    message: {
      message_id: 20,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, username: 'trousev' },
      message_thread_id: threadId,
      is_topic_message: true,
      forum_topic_created: { name, icon_color: 7322096 },
    },
  };
}

/** Photo: Telegram sends one frame as a ladder of sizes, from small to large. */
function photoUpdate(
  options: { caption?: string; sizes?: TelegramPhotoSize[]; fileId?: string; messageId?: number } = {},
): TelegramUpdate {
  const { caption, fileId = 'IMAGE', messageId = 10 } = options;
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      chat: { id: 42, type: 'private' },
      from: { id: 7, username: 'trousev' },
      ...(caption === undefined ? {} : { caption }),
      photo:
        options.sizes ??
        ([
          { file_id: 'small', width: 90, height: 60, file_size: 900 },
          { file_id: fileId, width: 1280, height: 960, file_size: JPEG.length },
        ] as TelegramPhotoSize[]),
    },
  };
}

function voiceUpdate(options: { duration?: number; fileId?: string } = {}): TelegramUpdate {
  const { duration = 7, fileId = 'VOICE' } = options;
  return {
    update_id: 1,
    message: {
      message_id: 11,
      chat: { id: 42, type: 'private' },
      from: { id: 7, username: 'trousev' },
      voice: { file_id: fileId, duration, mime_type: 'audio/ogg', file_size: JPEG.length },
    },
  };
}

/** An attachment the bot does not handle: video, sticker, non-image document. */
function otherUpdate(kind: 'video' | 'sticker' | 'audio' | 'document' | 'video_note'): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 12,
      chat: { id: 42, type: 'private' },
      from: { id: 7, username: 'trousev' },
      [kind]: kind === 'document' ? { file_id: 'DOC', file_name: 'смета.pdf', mime_type: 'application/pdf' } : {},
    },
  };
}

test('the bot listens to a known person and answers in their words', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('привет, Икар'));

  assert.deepEqual(session.prompts, ['привет, Икар']);
  assert.equal(chatText(state, 42), 'Привет, Саня', 'служебных строк в ответе нет — только слова Икара');
  assert.equal(state.messages[0]?.text, 'Привет, Саня', 'ответ менялся правкой одного сообщения');
  assert.deepEqual(
    state.actions.map((item) => item.action),
    ['choose_sticker', 'upload_document', 'typing'],
    'ход показан действиями: думает — стикер, читает файл — файл, ответ поехал — «печатает»',
  );
});

test('an MCP authorization error yields a reconnection link in the reply', async () => {
  const steps: Step[] = [
    {
      type: 'tool_execution_start',
      toolCallId: 'call-mcp',
      toolName: 'mcp_black_forest_get_credits',
      args: {},
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-mcp',
      toolName: 'mcp_black_forest_get_credits',
      isError: true,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'invalid_token',
              reauth_url: 'https://chat.example/panel/mcp?server=black-forest',
            }),
          },
        ],
      },
    },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Не вышло.' } },
    { type: 'agent_settled' },
  ];
  const config = makeConfig({
    url: 'https://chat.example',
    telegram: { token: 'bot-token', mapping: { trousev: 'probe' } },
  });
  const { bot, state } = makeBot({ steps, config });

  await bot.handleUpdate(messageUpdate('сколько кредитов?'));

  const text = chatText(state, 42);
  assert.match(text, /Переподключить/);
  assert.match(text, /https:\/\/chat\.example\/panel\/mcp\?server=black-forest/);
});

test('Telegram warns: the context contains utterances from the panel', async () => {
  // This is what "started in the panel → continued in Telegram" looks like: one session, shared
  // history. Silently mixing panel utterances into the reply is not allowed, otherwise Telegram
  // quietly becomes a window into personal files, — so the bot says this before the reply.
  const { bot, state, config } = makeBot();
  ensureChat(config, probe('probe'), 'telegram-42', 'telegram');
  recordTurn(config, probe('probe'), 'telegram-42', 'web', new Date('2026-11-01T12:04:00.000Z'));

  await bot.handleUpdate(messageUpdate('а что там по отчёту?'));

  const text = chatText(state, 42);
  assert.match(text, /Продолжаю разговор, который шёл в панели/);
  assert.match(text, /эти реплики уже в контексте/);
  assert.match(text, /\/clear/, 'человеку сразу видно, как начать заново');
  assert.match(text, /Привет, Саня/, 'ответ модели тоже на месте');
  assert.ok(text.indexOf('Продолжаю') < text.indexOf('Привет'), 'отбивка стоит до ответа');
});

test('no warning if the conversation happens only in Telegram', async () => {
  const { bot, state, config } = makeBot();
  ensureChat(config, probe('probe'), 'telegram-42', 'telegram');
  recordTurn(config, probe('probe'), 'telegram-42', 'telegram', new Date('2026-11-01T12:04:00.000Z'));

  await bot.handleUpdate(messageUpdate('привет'));

  assert.doesNotMatch(chatText(state, 42), /Продолжаю разговор/);
});

test('the bot does not open someone else\'s memory to a stranger', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('привет', { username: 'чужой' }));

  assert.deepEqual(session.prompts, []);
  assert.match(chatText(state, 42), /Не знаю тебя: @чужой/);
});

test('without a username in Telegram a person cannot be identified — so we say', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('привет', { username: '' }));

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), NO_USERNAME);
});

test('a photo goes to pi natively, and the file itself lands in incoming', async () => {
  const { bot, session, config } = makeBot();

  await bot.handleUpdate(photoUpdate({ caption: 'что на фото?' }));

  assert.equal(session.images.length, 1, 'картинка ушла одним вложением');
  assert.deepEqual(session.images[0]?.map((image) => image.mimeType), ['image/jpeg']);
  assert.equal(session.images[0]?.[0]?.data, JPEG.toString('base64'), 'модель видит сами байты, а не путь');
  assert.match(session.prompts[0] ?? '', /что на фото\?/);
  assert.match(session.prompts[0] ?? '', /\/workspaces\/\.icarus\/incoming\/telegram-42-10\.jpg/);

  const saved = fs.readdirSync(userPaths(config, probe()).incoming);
  assert.deepEqual(saved, ['telegram-42-10.jpg']);
  assert.deepEqual(fs.readFileSync(path.join(userPaths(config, probe()).incoming, saved[0] ?? '')), JPEG);
});

test('from the ladder of sizes we take the largest frame', async () => {
  const { bot, session, state } = makeBot({ files: { small: JPEG, big: JPEG } });

  await bot.handleUpdate(
    photoUpdate({
      fileId: 'big',
      sizes: [
        { file_id: 'small', width: 90, height: 60 },
        { file_id: 'big', width: 1280, height: 960 },
      ],
    }),
  );

  assert.deepEqual(state.downloaded, ['files/big']);
  assert.equal(session.images[0]?.length, 1);
});

test('a photo without a caption still arrives — with just a path', async () => {
  const { bot, session } = makeBot();

  await bot.handleUpdate(photoUpdate());

  assert.equal(session.prompts.length, 1);
  assert.doesNotMatch(session.prompts[0] ?? '', /^\s*$/, 'реплика не пустая: в ней есть путь к файлу');
  assert.match(session.prompts[0] ?? '', /\/workspaces\/\.icarus\/incoming\/telegram-42-10\.jpg/);
  assert.equal(session.images[0]?.length, 1, 'картинка при этом уехала');
});

test('an image sent as a document is still an image, with a human file name', async () => {
  const { bot, session, config } = makeBot({
    files: { SHOT: JPEG },
    steps: ANSWER_STEPS,
  });

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 21,
      chat: { id: 42, type: 'private' },
      from: { id: 7, username: 'trousev' },
      document: { file_id: 'SHOT', file_name: 'скриншот.png', mime_type: 'image/png' },
    },
  });

  assert.deepEqual(session.images[0]?.map((image) => image.mimeType), ['image/png']);
  assert.deepEqual(fs.readdirSync(userPaths(config, probe()).incoming), ['telegram-42-21-скриншот.png']);
});

test('a voice message is transcribed and goes as an utterance with a marker', async () => {
  const heard: Array<{ bytes: number; mime: string }> = [];
  const { bot, session, state } = makeBot({
    transcribe: async (audio, mimeType) => {
      heard.push({ bytes: audio.length, mime: mimeType });
      return 'напомни купить молоко';
    },
  });

  await bot.handleUpdate(voiceUpdate({ duration: 7 }));

  assert.deepEqual(heard, [{ bytes: JPEG.length, mime: 'audio/ogg' }]);
  assert.deepEqual(state.downloaded, ['files/VOICE']);
  assert.deepEqual(session.prompts, ['[голосовое, 7 с] напомни купить молоко']);
  assert.deepEqual(session.images, [[]], 'голосовое картинкой не считается');
  assert.equal(state.actions[0]?.action, 'record_voice', 'пока идёт расшифровка — «записывает голосовое»');  assert.equal(chatText(state, 42), 'Привет, Саня');
});

test('no recognition — we say so instead of staying silent', async () => {
  const { bot, session, state } = makeBot({ transcribe: null });

  await bot.handleUpdate(voiceUpdate());

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), VOICE_NO_SPEECH);
});

test('an empty transcript does not become a turn', async () => {
  const { bot, session, state } = makeBot({ transcribe: async () => '   ' });

  await bot.handleUpdate(voiceUpdate());

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), VOICE_EMPTY);
});

test('a recognition failure is shown to the person as a reply', async () => {
  const { bot, session, state } = makeBot({
    transcribe: async () => {
      throw new Error('распознавание не удалось (код 401)');
    },
  });

  await bot.handleUpdate(voiceUpdate());

  assert.deepEqual(session.prompts, []);
  assert.match(chatText(state, 42), /Не разобрал голосовое: распознавание не удалось \(код 401\)/);
});

test('the voice marker: with and without duration', () => {
  assert.equal(voicePrompt('привет', 12), '[голосовое, 12 с] привет');
  assert.equal(voicePrompt('привет', null), '[голосовое] привет');
});

test('the bot honestly does not handle video, stickers and documents', async () => {
  for (const [kind, name] of [
    ['video', 'видео'],
    ['video_note', 'видеосообщение'],
    ['sticker', 'стикер'],
    ['audio', 'аудиофайл'],
    ['document', 'документ'],
  ] as const) {
    const { bot, session, state } = makeBot();
    await bot.handleUpdate(otherUpdate(kind));

    assert.deepEqual(session.prompts, [], `${kind} в разговор не уезжает`);
    assert.equal(chatText(state, 42), unsupportedText(name));
  }
});

test('an attachment failed to download — the person sees the reason, not silence', async () => {
  const { bot, session, state } = makeBot({ files: {} });

  await bot.handleUpdate(photoUpdate());

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), attachmentFailed('telegram: file not found (код 400)'));
});

test('we do not download a too-large file at all', async () => {
  const { bot, state } = makeBot({ files: { IMAGE: JPEG } });

  await bot.handleUpdate(
    photoUpdate({ sizes: [{ file_id: 'IMAGE', width: 9999, height: 9999, file_size: 30 * 1024 * 1024 }] }),
  );

  assert.deepEqual(state.downloaded, [], 'и не пытались');
  assert.match(chatText(state, 42), /не больше 20 МБ/);
});

test('an empty message has nothing to parse — so we say', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate({ update_id: 1, message: { message_id: 30, chat: { id: 42, type: 'private' }, from: { id: 7, username: 'trousev' } } });

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), NOTHING_TO_READ);
});

test('a photo caption can be a command', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(photoUpdate({ caption: '/compact' }));

  assert.deepEqual(calls, [{ command: 'compact', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /Подвёл итог/);
});

test('/start and /help tell what the bot can do and do not intrude into the conversation', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('/start'));
  assert.equal(chatText(state, 42), GREETING);

  await bot.handleUpdate(messageUpdate('/help'));
  assert.match(chatText(state, 42), /\/stop — остановиться/);
  assert.match(chatText(state, 42), /\/stats —/);
  assert.equal(HELP.includes('/clear'), true);
  assert.match(HELP, /\/workspace <имя> — переключить разговор в другую папку/, 'команда видна в /help');
  assert.deepEqual(session.prompts, [], 'команды в разговор не уезжают');
});

test('an unknown command without arguments is a hint, with arguments it is an utterance for pi', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('/summarize'));
  assert.match(chatText(state, 42), new RegExp(UNKNOWN_COMMAND));
  assert.deepEqual(session.prompts, [], 'выдуманную команду модели не показываем');

  // pi has its own commands (templates, skills) — the bot does not take them away.
  await bot.handleUpdate(messageUpdate('/fix-tests прогони'));
  assert.deepEqual(session.prompts, ['/fix-tests прогони']);
});

test('/compact compacts this chat\'s conversation and reports the numbers', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/compact'));

  assert.deepEqual(calls, [{ command: 'compact', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /Подвёл итог: 1[\s\u00a0]?200 → 300 токенов/);
});

test('/compact with a wish passes it to pi: the person decides what is important to keep', async () => {
  const { bot, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/compact сохрани про математику'));

  assert.deepEqual(calls, [
    { command: 'compact', user: 'probe', conversationId: 'telegram-42', args: 'сохрани про математику' },
  ]);
});

test('/stop interrupts the turn and says so', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/stop'));

  assert.deepEqual(calls, [{ command: 'stop', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /Остановился/);
});

test('/stop, when the bot is already silent, does not pretend it stopped something', async () => {
  const { bot, state } = makeBot({ stop: { status: 'idle' } });

  await bot.handleUpdate(messageUpdate('/stop'));

  assert.match(chatText(state, 42), /ничего не делаю/);
});

test('/stop bypasses the queue: the turn it cancels is still running', async () => {
  const { bot, session, calls } = makeBot();
  let release: () => void = () => {};
  const answer = session.prompt.bind(session);
  // A turn that "thinks" until a special permission: exactly what a person wants to interrupt.
  session.prompt = async (text: string) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await answer(text);
  };

  let turnFinished = false;
  const turn = bot.enqueue(messageUpdate('привет')).then(() => {
    turnFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await bot.enqueue(messageUpdate('/stop'));

  assert.equal(turnFinished, false, 'ход всё ещё идёт');
  assert.deepEqual(calls, [{ command: 'stop', user: 'probe', conversationId: 'telegram-42' }], 'стоп дошёл до реестра');

  release();
  await turn;
});

test('/stats reports the conversation numbers, not pi\'s raw output', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/stats'));
  const text = chatText(state, 42);

  assert.deepEqual(calls, [{ command: 'stats', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(text, /Твоих реплик: 12, шагов с инструментами: 40/);
  assert.match(text, /Токенов всего: 105[\s\u00a0]000 \(вход 50[\s\u00a0]000, выход 10[\s\u00a0]000, из кэша 45[\s\u00a0]000\)/);
  assert.match(text, /Занято в контексте: 34% \(68[\s\u00a0]000 из 200[\s\u00a0]000\)/);
  assert.match(text, /Потрачено: \$0\.450/);
});

test('/clear starts the conversation over and honestly mentions memory', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/clear'));

  assert.deepEqual(calls, [{ command: 'clear', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /с чистого листа/);
  assert.match(chatText(state, 42), /Память не трогал/);
});

test('/skills lists what can be invoked in the chat', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/skills'));
  const text = chatText(state, 42);

  assert.deepEqual(calls, [{ command: 'skills', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(text, /\/skill:brave-search — поиск в интернете/);
  assert.match(text, /\/fix-tests — починить тесты/);
});

test('/workspace shows the current folder and the list, and private is not in the list', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const { bot, state } = makeBot({ config });
  createWorkspace(config, probe(), 'Работа');

  await bot.handleUpdate(messageUpdate('/workspace'));

  const text = chatText(state, 42);
  assert.match(text, /^Сейчас: Разговор$/m);
  assert.match(text, /^Разговор$/m);
  assert.match(text, /^Работа$/m);
  assert.doesNotMatch(text, /Приватный/, 'приватный в переключателе не участвует');
});

test('/workspace switches the conversation and remembers the folder in chats.json', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const { bot, state, calls, session } = makeBot({ config });
  const work = createWorkspace(config, probe(), 'Работа');

  await bot.handleUpdate(messageUpdate('/workspace Работа'));

  assert.equal(chatText(state, 42), 'Переключил на «Работа».');
  assert.equal(workspaceForConversation(config, probe(), 'telegram-42'), work.slug, 'папка разговора — в реестре');
  assert.deepEqual(calls, [], 'переключение не тратит ход модели');
  assert.deepEqual(session.prompts, [], 'и не уезжает в pi репликой');

  // By slug works too: in the panel the folder is called "Работа" but on disk it is rabota.
  await bot.handleUpdate(messageUpdate('/workspace talk'));
  assert.equal(chatText(state, 42), ['Переключил на «Работа».', 'Переключил на «Разговор».'].join('\n'));
  assert.equal(workspaceForConversation(config, probe(), 'telegram-42'), 'talk');
});

test('the workspace binding survives a bot restart: it is read from chats.json', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  createWorkspace(config, probe(), 'Работа');

  const first = makeBot({ config });
  await first.bot.handleUpdate(messageUpdate('/workspace Работа'));

  // A new process remembers only chats.json: it has no queues or live sessions.
  const second = makeBot({ config });
  await second.bot.handleUpdate(messageUpdate('/workspace'));

  assert.match(chatText(second.state, 42), /^Сейчас: Работа$/m);
});

test('in topics each conversation has its own folder, and the chat root does not switch', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  createWorkspace(config, probe(), 'Работа');
  const { bot } = makeBot({ config });

  await bot.handleUpdate(messageUpdate('/workspace Работа', { threadId: 17 }));

  assert.equal(workspaceForConversation(config, probe(), 'telegram-42-17'), 'rabota');
  assert.equal(workspaceForConversation(config, probe(), 'telegram-42'), undefined, 'корень живёт своей папкой');
});

test('you cannot switch to the private workspace — neither by slug nor by name', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const { bot, state } = makeBot({ config });

  await bot.handleUpdate(messageUpdate('/workspace private'));
  await bot.handleUpdate(messageUpdate('/workspace Приватный'));

  assert.equal(
    chatText(state, 42),
    [WORKSPACE_PRIVATE_REFUSED, WORKSPACE_PRIVATE_REFUSED].join('\n'),
  );
  assert.deepEqual(readChats(config, probe()), [], 'неприкосновенный workspace не заводит привязку');
});

test('/workspace with an unknown name does not invent a folder', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const { bot, state } = makeBot({ config });

  await bot.handleUpdate(messageUpdate('/workspace Луна'));

  assert.equal(chatText(state, 42), workspaceUnknown('Луна'));
  assert.deepEqual(readChats(config, probe()), []);
});

test('/workspace with no folders at all says so instead of showing emptiness', () => {
  assert.equal(workspacesText('Разговор', []), 'Переключать некуда: рабочих папок нет.');
});

test('in a group each person has their own conversation', () => {
  const group = messageUpdate('привет', { chatId: 99, type: 'supergroup' });
  assert.equal(conversationIdFor(group.message!, 'probe'), 'telegram-99-probe');
  const priv = messageUpdate('привет', { chatId: 99, type: 'private' });
  assert.equal(conversationIdFor(priv.message!, 'probe'), 'telegram-99');
});

test('a command is "/word [arguments]", not "/etc/hosts"', () => {
  assert.deepEqual(parseCommand('/compact'), { name: 'compact', args: '' });
  assert.deepEqual(parseCommand('/compact@the_icarus_bot'), { name: 'compact', args: '' });
  assert.deepEqual(parseCommand('/compact сохрани про математику'), {
    name: 'compact',
    args: 'сохрани про математику',
  });
  assert.equal(parseCommand('/etc/hosts'), null);
  assert.equal(parseCommand('а /compact потом'), null);
  assert.equal(parseCommand('/skill:brave-search'), null, 'команды pi бот не разбирает');
});

test('what we reply to each compaction outcome', () => {
  assert.match(compactText({ status: 'nothing' }), /нечего/);
  assert.match(compactText({ status: 'no-session' }), /уже сжат/);
  assert.match(compactText({ status: 'busy' }), /когда договорю/);
  assert.match(compactText({ status: 'failed', error: 'нет ключа' }), /нет ключа/);
});

test('what we reply to the /stop, /clear and /skills outcomes', () => {
  assert.match(stopText({ status: 'stopped' }), /Остановился/);
  assert.match(stopText({ status: 'idle' }), /ничего не делаю/);
  assert.match(stopText({ status: 'no-session' }), /нечего/);
  assert.match(stopText({ status: 'failed', error: 'таймаут' }), /таймаут/);

  assert.match(clearText({ status: 'started' }), /с чистого листа/);
  assert.match(clearText({ status: 'empty' }), /и так с чистого листа/);
  assert.match(clearText({ status: 'busy' }), /сначала \/stop/);

  assert.match(skillsText({ status: 'ok', commands: [] }), /ничего нет/);
  assert.match(
    skillsText({ status: 'ok', commands: [{ name: 'fix-tests', description: 'починить', source: 'prompt' }] }),
    /\/fix-tests — починить/,
  );
  assert.match(skillsText({ status: 'failed', error: 'нет связи' }), /нет связи/);
});

test('/stats without numbers does not invent them', () => {
  assert.match(statsText({ status: 'ok', stats: {} }), /пустой/);
  assert.match(statsText({ status: 'failed', error: 'pi молчит' }), /pi молчит/);
});

test('a long reply arrives in full and along boundaries', async () => {
  const paragraph = 'Слово '.repeat(200).trim();
  const long = `${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
  const { bot, state } = makeBot({
    steps: [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: long } },
      { type: 'agent_settled' },
    ],
  });

  await bot.handleUpdate(messageUpdate('расскажи подлиннее'));

  const messages = state.messages.filter((message) => message.chatId === 42);
  assert.ok(messages.length > 1, 'длинный ответ разрезан на несколько сообщений');
  for (const message of messages) {
    assert.ok(message.text.length <= MESSAGE_LIMIT, `сообщение длиннее предела: ${message.text.length}`);
  }
  const joined = messages.map((message) => message.text).join('');
  assert.equal(joined.replace(/\s+/g, ' '), long.replace(/\s+/g, ' '), 'ни один кусок не потерялся');
});

test('the split point is sought in the second half, not in the first paragraph', () => {
  const text = `${'a'.repeat(50)}\n\n${'b'.repeat(3000)}`;
  const cut = splitPoint(text, 1000);
  assert.ok(cut > 500 && cut <= 1000, `cut=${cut}`);
  assert.equal(splitPoint('безграниц'.repeat(200), 100), 100, 'нет границ — режем по пределу');
});

test('the reply goes with HTML markup: the model writes markdown, the person sees bold', async () => {
  const { bot, state } = makeBot({
    steps: [
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '**Токены** в `client_uid`' },
      },
      { type: 'agent_settled' },
    ],
  });

  await bot.handleUpdate(messageUpdate('как там токены?'));

  const message = state.messages.find((item) => item.chatId === 42);
  assert.equal(message?.parseMode, 'HTML', 'без parse_mode Telegram покажет звёздочки как есть');
  assert.equal(message?.text, '<b>Токены</b> в <code>client_uid</code>');
});

test('Telegram did not accept the markup — the reply arrives, just without it', async () => {
  const { bot, state } = makeBot({
    steps: [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '**Токены** и `код`' } },
      { type: 'agent_settled' },
    ],
  });
  // This is how Telegram replies when it did not understand the markup: our mistake must not eat the reply.
  state.rejectMarkup = true;

  await bot.handleUpdate(messageUpdate('как там токены?'));

  const message = state.messages.find((item) => item.chatId === 42);
  assert.equal(message?.text, 'Токены и код', 'разметка снята, текст остался');
  assert.equal(message?.parseMode, null);
});

test('an empty reply does not leave a dangling ellipsis', async () => {
  const { bot, state } = makeBot({
    steps: [
      { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolName: 'bash', isError: false },
      { type: 'agent_settled' },
    ],
  });

  await bot.handleUpdate(messageUpdate('посмотри, что там'));

  const text = chatText(state, 42);
  assert.equal(text, 'Готово.', 'молчаливый ход закрыт коротким словом, а не пустым сообщением');
});

test('what the turn is busy with is visible as a Telegram action, not a line in the reply', async () => {
  const { bot, state } = makeBot({
    steps: [
      {
        type: 'tool_execution_start',
        toolCallId: 'call-read',
        toolName: 'read',
        args: { path: '/workspaces/talk/смета.pdf' },
      },
      { type: 'tool_execution_end', toolCallId: 'call-read', toolName: 'read', isError: false },
      { type: 'tool_execution_start', toolCallId: 'call-sub', toolName: 'subagent', args: { tasks: [{}, {}] } },
      { type: 'tool_execution_end', toolCallId: 'call-sub', toolName: 'subagent', isError: false },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Смета на месте' } },
      { type: 'agent_settled' },
    ],
  });

  await bot.handleUpdate(messageUpdate('глянь смету'));

  assert.deepEqual(
    state.actions.map((item) => item.action),
    ['choose_sticker', 'upload_document', 'choose_sticker', 'find_location', 'choose_sticker', 'typing'],
    'каждая фаза хода получила своё действие из списка Bot API',
  );
  assert.equal(chatText(state, 42), 'Смета на месте', 'служебных строк в ответе нет');
});

test('a turn failure is shown to the person as a reply, not silence', async () => {
  const { bot, state, session } = makeBot();
  session.prompt = async () => {
    throw new Error('pi завершился');
  };

  await bot.handleUpdate(messageUpdate('привет'));

  assert.match(chatText(state, 42), /Ход сорвался: pi завершился/);
});

test('queue: messages of one chat go in order, while different chats do not wait', async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];
  const task = (name: string, ms: number) => async () => {
    order.push(`начал ${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`кончил ${name}`);
  };

  await Promise.all([
    queue.add('a', task('a1', 20)),
    queue.add('a', task('a2', 1)),
    queue.add('b', task('b1', 1)),
  ]);

  assert.ok(order.indexOf('начал b1') < order.indexOf('кончил a1'), 'чужой чат не ждёт');
  assert.ok(order.indexOf('начал a2') > order.indexOf('кончил a1'), 'свои сообщения — строго по очереди');
  assert.equal(order.at(-1), 'кончил a2');
});

test('queue: a failure of one task does not break the next ones', async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];

  await assert.rejects(
    queue.add('c', async () => {
      throw new Error('сбой');
    }),
    /сбой/,
  );
  await queue.add('c', async () => {
    order.push('после сбоя');
  });

  assert.deepEqual(order, ['после сбоя']);
});

// --- topics: conversation = chat + topic ------------------------------------

test('a conversation is a chat and a topic: each topic has its own session', () => {
  assert.equal(conversationIdFor(messageUpdate('привет').message!, 'probe'), 'telegram-42');
  assert.equal(
    conversationIdFor(messageUpdate('привет', { threadId: 1 }).message!, 'probe'),
    'telegram-42',
    'General — тот же корень чата',
  );
  assert.equal(conversationIdFor(messageUpdate('привет', { threadId: 17 }).message!, 'probe'), 'telegram-42-17');
});

test('in a group the topic separates people too', () => {
  const topic = messageUpdate('привет', { chatId: 99, type: 'supergroup', threadId: 5 });
  assert.equal(conversationIdFor(topic.message!, 'probe'), 'telegram-99-probe-5');
  assert.equal(conversationIdFor(messageUpdate('привет', { chatId: 99, type: 'supergroup' }).message!, 'probe'), 'telegram-99-probe');
});

test('topicThreadId: root and General are the same place, a topic is a different one', () => {
  assert.equal(topicThreadId(messageUpdate('привет').message!), null);
  assert.equal(topicThreadId(messageUpdate('привет', { threadId: 1 }).message!), null);
  assert.equal(topicThreadId(messageUpdate('привет', { threadId: 17 }).message!), 17);
});

test('we parse a command with a remainder, while "а /rename" is not a command', () => {
  assert.deepEqual(parseCommand('/rename Письмо из налоговой'), {
    name: 'rename',
    args: 'Письмо из налоговой',
  });
  assert.deepEqual(parseCommand('/rename@the_icarus_bot Налоги'), { name: 'rename', args: 'Налоги' });
  assert.equal(parseCommand('а /rename'), null);
});


test('the removed /topic and /topics explain it instead of going to pi', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('/topic Работа'));
  await bot.handleUpdate(messageUpdate('/topics'));

  assert.equal(session.prompts.length, 0, 'модель эти команды не видит');
  assert.match(chatText(state, 42), /больше нет/);
});

test('a reply in a topic goes to the topic, not to the root', async () => {
  const { bot, session, state } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));

  assert.equal(session.prompts.length, 1);
  assert.equal(chatText(state, 42), '', 'в корне чата пусто');
  assert.match(topicText(state, 42, 17), /Привет, Саня/);
  assert.equal(lastAction(state).threadId, 17, 'действие — в том же топике');
});

test('the first message of a topic from the general feed goes to the topic, not to the root', async () => {
  const { bot, state } = makeBot({ topics: true });

  // The person started typing in the general feed: Telegram created a topic and sent the service message...
  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  // ...and the message itself arrived as a root message: it has no topic id.
  await bot.enqueue(messageUpdate('привет из нового топика'));

  assert.equal(chatText(state, 42), '', 'в корне чата пусто');
  assert.match(topicText(state, 42, 17), /Привет, Саня/);
  assert.equal(lastAction(state).threadId, 17, 'действие — в том же топике');
});

test('a fresh topic\'s conversation is counted by the topic id, not by the root', async () => {
  const { bot, calls } = makeBot({ topics: true });

  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  await bot.enqueue(messageUpdate('/stats'));

  assert.deepEqual(calls, [{ command: 'stats', user: 'probe', conversationId: 'telegram-42-17' }]);
});

test('a fresh topic lives for a window, not forever', async () => {
  const { bot, state } = makeBot({ topics: true, freshTopicWindowMs: -1 });

  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  await bot.enqueue(messageUpdate('привет'));

  assert.match(chatText(state, 42), /Привет, Саня/);
  assert.equal(topicText(state, 42, 17), '', 'опоздавшее сообщение в топик не тащим');
});

test('a real topic id clears the fresh slot: the root stays the root', async () => {
  const { bot, state } = makeBot({ topics: true });

  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  // The client handled it itself: the message came with a topic id — the fresh slot is no longer needed.
  await bot.enqueue(messageUpdate('в топике', { threadId: 17 }));
  await bot.enqueue(messageUpdate('а это уже в корне'));

  assert.equal(topicText(state, 42, 17), 'Привет, Саня', 'в топике один ответ');
  assert.match(chatText(state, 42), /Привет, Саня/, 'и в корне свой');
});



test('if a reply did not reach the topic, the bot says so in the root', async () => {
  const { bot, state } = makeBot({ topics: true });
  state.failTopics = true;

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));

  assert.equal(topicText(state, 42, 17), '', 'в топике пусто: отправку отбило');
  assert.match(chatText(state, 42), /Не смог ответить в топик/);
  assert.match(chatText(state, 42), /message thread not found/);
});

test('a reply to a command in a topic is not lost silently either', async () => {
  const { bot, state } = makeBot({ topics: true });
  state.failTopics = true;

  await bot.handleUpdate(messageUpdate('/stats', { threadId: 17 }));

  assert.equal(topicText(state, 42, 17), '');
  assert.match(chatText(state, 42), /Не смог ответить в топик/);
});

test('/compact compacts the conversation of the topic where it was written', async () => {
  const { bot, calls } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/compact', { threadId: 17 }));

  assert.deepEqual(calls, [{ command: 'compact', user: 'probe', conversationId: 'telegram-42-17' }]);
});



test('/rename renames the conversation and the topic it runs in', async () => {
  const { bot, state, calls } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/rename Налоги', { threadId: 17 }));

  assert.deepEqual(state.renames, [{ chatId: 42, threadId: 17, name: 'Налоги' }]);
  assert.deepEqual(calls, [
    { command: 'rename', user: 'probe', conversationId: 'telegram-42-17', args: 'Налоги' },
  ]);
  assert.match(topicText(state, 42, 17), /называется «Налоги»/);
});

test('/rename from the root changes the conversation name in the registry without touching the topic', async () => {
  const { bot, state, calls } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/rename Налоги'));

  assert.deepEqual(state.renames, [], 'топика в корне нет');
  assert.deepEqual(calls, [{ command: 'rename', user: 'probe', conversationId: 'telegram-42', args: 'Налоги' }]);
  assert.match(chatText(state, 42), /называется «Налоги»/);
});


test('/rename without a name suggests the form', async () => {
  const { bot, state } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/rename', { threadId: 17 }));

  assert.deepEqual(state.renames, []);
  assert.equal(topicText(state, 42, 17), RENAME_NEEDS_NAME);
});


test('an utterance on top of a running turn interrupts it and becomes a new turn', async () => {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let release: () => void = () => {};

  const session = Object.assign(fakeSession([]), {
    interrupts: 0,
    async interrupt(): Promise<boolean> {
      session.interrupts += 1;
      session.busy = false;
      release();
      return true;
    },
  });
  session.onEvent = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  // The first turn hangs until it is interrupted: exactly like a real one holding
  // subagents. The second answers immediately.
  session.prompt = async (text) => {
    session.prompts.push(text);
    session.busy = true;
    if (session.prompts.length === 1) await new Promise<void>((resolve) => {
      release = resolve;
    });
    session.busy = false;
    for (const listener of listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'готово' } });
      listener({ type: 'agent_settled' });
    }
  };

  const { bot, calls, state } = makeBot({ session });
  const first = bot.enqueue(messageUpdate('первое'));
  for (let i = 0; i < 100 && session.prompts.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(session.prompts, ['первое'], 'первый ход должен начаться');

  // The second message is a skill with arguments: for the bot it is not a command but an utterance,
  // and it must also interrupt the turn rather than queue behind it.
  const second = bot.enqueue(messageUpdate('/skill:demo второе'));
  await Promise.all([first, second]);

  assert.equal(session.interrupts, 1, 'идущий ход прерывается, а не дожидается очереди');
  assert.equal(session.prompts.length, 2);
  assert.match(session.prompts[1] ?? '', /\/skill:demo второе/);
  assert.ok(
    calls.some((call) => call.command === 'interrupt'),
    'прерывание идёт через реестр, а не мимо него',
  );
  // There are no buttons in Telegram, so there is one operation — "now". But a person must
  // see that the previous reply was cut off rather than lost.
  assert.match(chatText(state, 42), /Прервал прошлый ответ/, 'об прерывании сказано честно');
});

test('a file link in the reply goes as an attachment, and the path disappears from the text', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const talk = path.join(userPaths(config, probe()).workspaces, 'talk');
  fs.mkdirSync(talk, { recursive: true });
  fs.writeFileSync(path.join(talk, 'chart.png'), Buffer.from('PNG-байты'));
  fs.writeFileSync(path.join(talk, 'смета.pdf'), Buffer.from('PDF-байты'));
  const steps: Step[] = [
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'Готово!\n\n![график цен](/workspaces/talk/chart.png)\n\n[смета за март](/workspaces/talk/смета.pdf)',
      },
    },
    { type: 'agent_settled' },
  ];
  const { bot, state } = makeBot({ steps, config });

  await bot.handleUpdate(messageUpdate('построй график и приложи смету'));

  const text = chatText(state, 42);
  assert.doesNotMatch(text, /\/workspaces\//, 'локальный путь в тексте не остался');
  assert.equal(text.trim(), 'Готово!', 'ссылки отдельными строками ушли во вложения целиком');

  assert.equal(state.photos.length, 1, 'картинка ушла фотографией');
  assert.equal(state.photos[0]?.name, 'график цен.png', 'имя человеческое и с расширением');
  assert.equal(state.photos[0]?.caption, 'график цен');
  assert.equal(state.photos[0]?.bytes.toString(), 'PNG-байты');

  assert.equal(state.documents.length, 1, 'PDF ушёл документом');
  assert.equal(state.documents[0]?.name, 'смета за март.pdf');
  assert.equal(state.documents[0]?.bytes.toString(), 'PDF-байты');
});

test('a file from the reply is not lost silently: the bot says why it is missing', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  fs.mkdirSync(path.join(userPaths(config, probe()).workspaces, 'talk'), { recursive: true });
  const steps: Step[] = [
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Готово!\n\n![схема](/workspaces/talk/нет-такой.png)' },
    },
    { type: 'agent_settled' },
  ];
  const { bot, state } = makeBot({ steps, config });

  await bot.handleUpdate(messageUpdate('покажи схему'));

  assert.equal(state.photos.length, 0);
  assert.match(chatText(state, 42), /Не смог отправить файл/, 'человек узнал, что вложения не будет');
  assert.match(chatText(state, 42), /файл не найден/);
});

// --- // --- conversation title and topic name --------------------------------------- ----------------------------------------

/** pi session file: `<created when>_<id>.jsonl`, as pi lays it down. */
function putSession(
  config: ReturnType<typeof makeConfig>,
  conversationId: string,
  texts: Array<{ role: 'user' | 'assistant'; text: string }>,
): void {
  const user = probe();
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const entries = [
    { type: 'session', timestamp: '2026-11-13T09:00:00.000Z' },
    ...texts.map((item) => ({
      type: 'message',
      timestamp: '2026-11-13T09:00:01.000Z',
      message: { role: item.role, content: [{ type: 'text', text: item.text }] },
    })),
  ];
  const file = path.join(dir, `2026-11-13T09-00-00-000Z_${sessionIdFor(user.id, conversationId)}.jsonl`);
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n'));
}

/** The title is computed after the reply: let the background work finish. */
async function titlesSettled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Service: a person renamed the topic in the Telegram client. */
function topicEditedUpdate(name: string, threadId: number, chatId = 42): TelegramUpdate {
  return {
    update_id: 3,
    message: {
      message_id: 21,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, username: 'trousev' },
      message_thread_id: threadId,
      is_topic_message: true,
      forum_topic_edited: { name },
    },
  };
}

/** A conversation in a topic — with a registry record and a session file. */
function topicChat(): ReturnType<typeof makeConfig> {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  ensureChat(config, probe(), 'telegram-42-17', 'telegram', 'talk');
  putSession(config, 'telegram-42-17', [
    { role: 'user', text: 'привет' },
    { role: 'assistant', text: 'Привет! Чем помочь?' },
  ]);
  return config;
}

test('the AI names the conversation in the topic and renames the topic itself', async () => {
  const config = topicChat();
  const { bot, state } = makeBot({ config, topics: true, oneShot: async () => 'Знакомство с Икаром' });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));
  await titlesSettled();

  assert.deepEqual(state.renames, [{ chatId: 42, threadId: 17, name: 'Знакомство с Икаром' }]);
  const chat = findChatRecord(config, probe(), 'telegram-42-17');
  assert.equal(chat?.title, 'Знакомство с Икаром');
  assert.equal(chat?.titleSource, 'auto');
  assert.equal(chat?.topicTitle, 'Знакомство с Икаром', 'имя топика записано, чтобы не слать его дважды');
});

test('refining the title does not rename the topic with the same name twice', async () => {
  const config = topicChat();
  const { bot, state } = makeBot({ config, topics: true, oneShot: async () => 'Знакомство с Икаром' });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));
  await titlesSettled();
  await bot.handleUpdate(messageUpdate('и ещё вопрос', { threadId: 17 }));
  await titlesSettled();

  assert.equal(state.renames.length, 1, 'топик переименован один раз');
});

test('a topic name chosen by a person is not overwritten and is carried into the conversation title', async () => {
  const config = topicChat();
  const { bot, state } = makeBot({ config, topics: true, oneShot: async () => 'Знакомство с Икаром' });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));
  await titlesSettled();
  // The person renamed the topic in the client: it is their name, there is nothing to argue with.
  await bot.handleUpdate(topicEditedUpdate('Налоги', 17));

  const renamed = findChatRecord(config, probe(), 'telegram-42-17');
  assert.equal(renamed?.title, 'Налоги');
  assert.equal(renamed?.titleSource, 'manual');
  assert.equal(renamed?.topicTitle, 'Налоги');

  await bot.handleUpdate(messageUpdate('ещё вопрос', { threadId: 17 }));
  await titlesSettled();
  assert.equal(findChatRecord(config, probe(), 'telegram-42-17')?.title, 'Налоги', 'имя человека устояло');
  assert.deepEqual(state.renames, [{ chatId: 42, threadId: 17, name: 'Знакомство с Икаром' }]);
});

test('a name corrected in the panel reaches the Telegram topic', async () => {
  const config = topicChat();
  const { bot, state } = makeBot({ config, topics: true, oneShot: async () => 'Знакомство с Икаром' });
  const off = bot.watchTitles();

  try {
    await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));
    await titlesSettled();

    const updated = renameChat(config, probe(), 'telegram-42-17', 'Налоги из ФНС');
    broadcast({ userId: 'probe', chatId: 'telegram-42-17', type: 'title', chat: updated });
    await titlesSettled();

    assert.deepEqual(state.renames.at(-1), { chatId: 42, threadId: 17, name: 'Налоги из ФНС' });
  } finally {
    off();
  }
});

test('the bot stores the conversation place in Telegram into chats.json, not just memory', async () => {
  const config = topicChat();
  const { bot } = makeBot({ config, topics: true });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));

  assert.deepEqual(
    findChatRecord(config, probe(), 'telegram-42-17')?.telegram,
    { chatId: 42, threadId: 17 },
    'по этому месту панель найдёт топик после перезапуска',
  );
});

test('/archive moves the conversation to the archive and deletes the topic along with its messages', async () => {
  const config = topicChat();
  const { bot, state } = makeBot({ config, topics: true, oneShot: async () => 'Знакомство с Икаром' });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));
  await titlesSettled();
  await bot.handleUpdate(messageUpdate('/archive', { threadId: 17 }));

  assert.deepEqual(state.deletedTopics, [{ chatId: 42, threadId: 17 }]);
  const chat = findChatRecord(config, probe(), 'telegram-42-17');
  assert.equal(chat?.archivedAt !== undefined, true, 'разговор в архиве');
  assert.equal(chat?.telegram, undefined, 'топика больше нет — место забыто');
  // The topic is deleted — the confirmation goes to the chat root, not into the void.
  assert.match(chatText(state, 42), /Убрал «/);
  assert.match(chatText(state, 42), /вернуть его Telegram не умеет/);
});

test('/archive without a topic archives, but there is nothing to delete in Telegram', async () => {
  const config = makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  ensureChat(config, probe(), 'telegram-42', 'telegram', 'talk');
  const { bot, state } = makeBot({ config, topics: true });

  await bot.handleUpdate(messageUpdate('привет'));
  await titlesSettled();
  await bot.handleUpdate(messageUpdate('/archive'));

  assert.deepEqual(state.deletedTopics, [], 'корень чата — не топик, удалять нечего');
  assert.match(chatText(state, 42), /Топика здесь нет/);
});

test('/archive: panel and bot do the same action — the topic leaves along with the archive', async () => {
  const config = topicChat();
  const { bot, state } = makeBot({ config, topics: true, oneShot: async () => 'Знакомство с Икаром' });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));
  await titlesSettled();

  // This is how the panel calls the bot on archiving: with the same removeTopic, without utterances.
  const chat = findChatRecord(config, probe(), 'telegram-42-17');
  assert.ok(chat?.telegram);
  await bot.removeTopic(probe(), chat);

  assert.deepEqual(state.deletedTopics, [{ chatId: 42, threadId: 17 }]);
});
