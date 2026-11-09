// Telegram-бот: кто получает ответ, что отвечаем на команды и как ответ доезжает
// до чата. Сети и докера тут нет: Bot API, реестр сессий и сессия pi — заглушки.
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
} from '../src/telegram/bot.ts';
import {
  TelegramApi,
  TelegramError,
  landedInThread,
  type TelegramPhotoSize,
  type TelegramUpdate,
} from '../src/telegram/api.ts';
import { MESSAGE_LIMIT, PLACEHOLDER, splitPoint } from '../src/telegram/reply.ts';
import { userPaths } from '../src/config.ts';
import { ensureChat, recordTurn } from '../src/sessions/chats.ts';
import { makeConfig, probe } from './fixtures.ts';

/** Байты, которые «скачались» из Telegram: содержимое в тестах не важно. */
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

test('Bot API: длинный опрос подтверждает апдейты и забирает только сообщения', async () => {
  const { calls, fetch } = fakeFetch([{ ok: true, result: [{ update_id: 7, message: { message_id: 1 } }] }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  const updates = await api.getUpdates({ offset: 5, timeoutSeconds: 30 });

  assert.equal(updates.length, 1);
  assert.equal(calls[0]?.url, 'https://tg.test/botTOKEN/getUpdates');
  assert.equal(calls[0]?.body.offset, 5);
  assert.equal(calls[0]?.body.timeout, 30);
  assert.deepEqual(calls[0]?.body.allowed_updates, ['message']);
});

test('Bot API: ошибка приезжает с кодом и описанием', async () => {
  const { fetch } = fakeFetch([{ ok: false, error_code: 400, description: 'chat not found' }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(() => api.sendMessage(1, 'привет'), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.code, 400);
    assert.match(error.message, /chat not found/);
    return true;
  });
});

test('Bot API: режим разметки уезжает в запрос, без него — не уезжает', async () => {
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
  // Сообщения служебок (приветствие, команды) — голый текст: разметку в них никто не чистил.
  assert.equal(calls[1]?.body.parse_mode, undefined);
  assert.equal(calls[2]?.body.parse_mode, 'HTML', 'правка тоже размеченная');
});

test('Bot API: 429 ждём и повторяем, а не теряем ответ', async () => {
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

test('Bot API: «message is not modified» — не ошибка', async () => {
  const { fetch } = fakeFetch([{ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });
  await api.editMessageText(1, 2, 'то же самое');
});

test('Bot API: видно, когда сообщение легло не в топик', () => {
  // В личке с топиками Telegram умеет ответить ok и положить сообщение в общую ленту:
  // это выдаёт ответ — в нём нет номера топика и флага топика.
  assert.equal(landedInThread({ message_id: 1, message_thread_id: 17 }, 17), true);
  assert.equal(landedInThread({ message_id: 1, is_topic_message: true }, 17), true);
  assert.equal(landedInThread({ message_id: 1, message_thread_id: null }, 17), false);
  assert.equal(landedInThread({ message_id: 1, message_thread_id: 3 }, 17), false);
  assert.equal(landedInThread({ message_id: 1 }, 17), false);
});

test('Bot API: отбитый топик повторяем ответом-якорем', async () => {
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

test('Bot API: без якоря отбитый топик — ошибка, а не тихая отправка в корень', async () => {
  const { fetch } = fakeFetch([{ ok: false, error_code: 400, description: 'Bad Request: message thread not found' }]);
  const api = new TelegramApi('TOKEN', { fetch, baseUrl: 'https://tg.test' });

  await assert.rejects(() => api.sendMessage(1, 'привет', 17), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.match(error.message, /message thread not found/);
    return true;
  });
});

// --- бот --------------------------------------------------------------------

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
    /** Что уехало модели картинками: base64 и mime, ровно как ждёт pi. */
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

/** Чат глазами Telegram: сообщения заводятся отправкой и меняются правками. */
function fakeApi(files: Record<string, Buffer> = {}) {
  const state = {
    messages: [] as Array<{
      chatId: number;
      id: number;
      text: string;
      threadId: number | null;
      /** С какой разметкой сообщение легло в Telegram: null — как голый текст. */
      parseMode: string | null;
    }>,
    nextId: 1,
    typing: 0,
    /** Куда ушло последнее «печатает…»: в топике это должно быть то же место. */
    typingThreadId: null as number | null,
    files: new Map(Object.entries(files)),
    downloaded: [] as string[],
    /** Threaded Mode: в бою это флаги getMe, в тестах — переключатель. */
    topicsEnabled: false,
    /** Переименования: chatId, топик, новое имя. */
    renames: [] as Array<{ chatId: number; threadId: number; name: string }>,
    /** Telegram отбивает отправку в топик: так выглядит «ответ не доехал». */
    failTopics: false,
    /** Telegram отбивает разметку: так выглядит наш промах в HTML. */
    rejectMarkup: false,
  };
  /** Разметку Telegram разбирает до сохранения: отказал — значит, сообщения нет. */
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
    async sendChatAction(_chatId: number, _action = 'typing', threadId: number | null = null) {
      state.typing += 1;
      state.typingThreadId = threadId;
    },
    async setMyCommands() {},
    async getMe() {
      return { id: 1, username: 'the_icarus_bot' };
    },
    async editForumTopic(chatId: number, threadId: number, name: string) {
      if (!state.topicsEnabled) throw new TelegramError('Bad Request: the chat is not a forum', 400);
      state.renames.push({ chatId, threadId, name });
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
  } as unknown as TelegramApi;
  return { api, state };
}

/** Что уехало в корень чата: сообщения топиков сюда не попадают. */
function chatText(state: ReturnType<typeof fakeApi>['state'], chatId: number): string {
  return state.messages
    .filter((message) => message.chatId === chatId && message.threadId === null)
    .map((message) => message.text)
    .join('\n');
}

/** Только то, что уехало в конкретный топик: в корне чата ответа быть не должно. */
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
    /** Чем кончились команды бота: по умолчанию всё хорошо. */
    stop?: unknown;
    stats?: unknown;
    clear?: unknown;
    rename?: unknown;
    skills?: unknown;
    /** Чем расшифровывать голосовые: как в бою, но без сети; null — нечем. */
    transcribe?: ((audio: Uint8Array, mimeType: string) => Promise<string>) | null;
    /** Файлы, которые «лежат» в Telegram: id → байты. */
    files?: Record<string, Buffer>;
    /** Threaded Mode у бота: с ним /rename правит имя топика, без него — только chats.json. */
    topics?: boolean;
    /** Сколько живёт «свежий топик» (первое сообщение заведённого из ленты топика). */
    freshTopicWindowMs?: number;
    /** Своя сессия: тесту про прерывание нужен долгий ход, а не мгновенный. */
    session?: ReturnType<typeof fakeSession>;
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
  };
  const { api, state } = fakeApi(options.files ?? { IMAGE: JPEG, VOICE: JPEG });
  state.topicsEnabled = options.topics ?? false;
  // Расшифровка по умолчанию рабочая: тест про «распознавания нет» задаёт null явно.
  const transcribe =
    'transcribe' in options ? options.transcribe : async () => 'привет из голосового';
  const bot = new TelegramBot(config, registry as never, {
    api,
    editIntervalMs: 0,
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
 * Служебное сообщение: топик завёл клиент Telegram (кнопка «All Messages»). Бот
 * по нему только понимает, куда отнести первое сообщение из общей ленты.
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

/** Фото: Telegram шлёт один кадр лестницей размеров, от мелкого к крупному. */
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

/** Вложение, которое бот не разбирает: видео, стикер, документ не-картинка. */
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

test('знакомого человека бот слушает и отвечает его словами', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('привет, Икар'));

  assert.deepEqual(session.prompts, ['привет, Икар']);
  assert.equal(chatText(state, 42), 'Привет, Саня', 'служебная строка «⚙ читаю…» в ответ не попала');
  assert.equal(state.messages[0]?.text, 'Привет, Саня', 'ответ менялся правкой одного сообщения');
  assert.ok(state.typing > 0, 'человек видит «печатает»');
});

test('ошибка авторизации MCP даёт в ответе ссылку на переподключение', async () => {
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

test('Telegram предупреждает: в контексте есть реплики из панели', async () => {
  // Так выглядит «начал в панели → продолжил в телеге»: сессия одна, история
  // общая. Молча подмешивать панельные реплики в ответ нельзя, иначе Telegram
  // тихо становится окном в личные файлы, — поэтому бот говорит об этом до ответа.
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

test('отбивки нет, если разговор идёт только в Telegram', async () => {
  const { bot, state, config } = makeBot();
  ensureChat(config, probe('probe'), 'telegram-42', 'telegram');
  recordTurn(config, probe('probe'), 'telegram-42', 'telegram', new Date('2026-11-01T12:04:00.000Z'));

  await bot.handleUpdate(messageUpdate('привет'));

  assert.doesNotMatch(chatText(state, 42), /Продолжаю разговор/);
});

test('незнакомцу бот не открывает чужую память', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('привет', { username: 'чужой' }));

  assert.deepEqual(session.prompts, []);
  assert.match(chatText(state, 42), /Не знаю тебя: @чужой/);
});

test('без username в телеграме человека не узнать — так и говорим', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('привет', { username: '' }));

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), NO_USERNAME);
});

test('фото уезжает в pi нативно, а сам файл ложится в incoming', async () => {
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

test('из лестницы размеров берём самый крупный кадр', async () => {
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

test('фото без подписи всё равно доезжает — с одним лишь путём', async () => {
  const { bot, session } = makeBot();

  await bot.handleUpdate(photoUpdate());

  assert.equal(session.prompts.length, 1);
  assert.doesNotMatch(session.prompts[0] ?? '', /^\s*$/, 'реплика не пустая: в ней есть путь к файлу');
  assert.match(session.prompts[0] ?? '', /\/workspaces\/\.icarus\/incoming\/telegram-42-10\.jpg/);
  assert.equal(session.images[0]?.length, 1, 'картинка при этом уехала');
});

test('картинка документом — тоже картинка, с человеческим именем файла', async () => {
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

test('голосовое расшифровывается и уезжает репликой с пометкой', async () => {
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
  assert.equal(chatText(state, 42), 'Привет, Саня');
});

test('распознавания нет — говорим об этом, а не молчим', async () => {
  const { bot, session, state } = makeBot({ transcribe: null });

  await bot.handleUpdate(voiceUpdate());

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), VOICE_NO_SPEECH);
});

test('пустая расшифровка не превращается в ход', async () => {
  const { bot, session, state } = makeBot({ transcribe: async () => '   ' });

  await bot.handleUpdate(voiceUpdate());

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), VOICE_EMPTY);
});

test('сбой распознавания человек видит ответом', async () => {
  const { bot, session, state } = makeBot({
    transcribe: async () => {
      throw new Error('распознавание не удалось (код 401)');
    },
  });

  await bot.handleUpdate(voiceUpdate());

  assert.deepEqual(session.prompts, []);
  assert.match(chatText(state, 42), /Не разобрал голосовое: распознавание не удалось \(код 401\)/);
});

test('пометка о голосовом: с длительностью и без', () => {
  assert.equal(voicePrompt('привет', 12), '[голосовое, 12 с] привет');
  assert.equal(voicePrompt('привет', null), '[голосовое] привет');
});

test('видео, стикер и документ бот честно не разбирает', async () => {
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

test('вложение не скачалось — человек видит причину, а не тишину', async () => {
  const { bot, session, state } = makeBot({ files: {} });

  await bot.handleUpdate(photoUpdate());

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), attachmentFailed('telegram: file not found (код 400)'));
});

test('слишком большой файл не качаем вовсе', async () => {
  const { bot, state } = makeBot({ files: { IMAGE: JPEG } });

  await bot.handleUpdate(
    photoUpdate({ sizes: [{ file_id: 'IMAGE', width: 9999, height: 9999, file_size: 30 * 1024 * 1024 }] }),
  );

  assert.deepEqual(state.downloaded, [], 'и не пытались');
  assert.match(chatText(state, 42), /не больше 20 МБ/);
});

test('пустое сообщение разбирать нечего — так и говорим', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate({ update_id: 1, message: { message_id: 30, chat: { id: 42, type: 'private' }, from: { id: 7, username: 'trousev' } } });

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), NOTHING_TO_READ);
});

test('подпись к фото может быть командой', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(photoUpdate({ caption: '/compact' }));

  assert.deepEqual(calls, [{ command: 'compact', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /Подвёл итог/);
});

test('/start и /help рассказывают, что бот умеет, и в разговор не лезут', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('/start'));
  assert.equal(chatText(state, 42), GREETING);

  await bot.handleUpdate(messageUpdate('/help'));
  assert.match(chatText(state, 42), /\/stop — остановиться/);
  assert.match(chatText(state, 42), /\/stats —/);
  assert.equal(HELP.includes('/clear'), true);
  assert.deepEqual(session.prompts, [], 'команды в разговор не уезжают');
});

test('незнакомая команда без аргументов — подсказка, с аргументами — реплика для pi', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('/summarize'));
  assert.match(chatText(state, 42), new RegExp(UNKNOWN_COMMAND));
  assert.deepEqual(session.prompts, [], 'выдуманную команду модели не показываем');

  // У pi есть свои команды (шаблоны, скиллы) — их бот не отбирает.
  await bot.handleUpdate(messageUpdate('/fix-tests прогони'));
  assert.deepEqual(session.prompts, ['/fix-tests прогони']);
});

test('/compact сжимает разговор этого чата и рассказывает цифры', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/compact'));

  assert.deepEqual(calls, [{ command: 'compact', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /Подвёл итог: 1[\s\u00a0]?200 → 300 токенов/);
});

test('/compact с пожеланием передаёт его pi: человек решает, что важно сохранить', async () => {
  const { bot, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/compact сохрани про математику'));

  assert.deepEqual(calls, [
    { command: 'compact', user: 'probe', conversationId: 'telegram-42', args: 'сохрани про математику' },
  ]);
});

test('/stop прерывает ход и говорит об этом', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/stop'));

  assert.deepEqual(calls, [{ command: 'stop', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /Остановился/);
});

test('/stop, когда бот и так молчит, не делает вид, что остановил', async () => {
  const { bot, state } = makeBot({ stop: { status: 'idle' } });

  await bot.handleUpdate(messageUpdate('/stop'));

  assert.match(chatText(state, 42), /ничего не делаю/);
});

test('/stop идёт мимо очереди: ход, который он отменяет, ещё в работе', async () => {
  const { bot, session, calls } = makeBot();
  let release: () => void = () => {};
  const answer = session.prompt.bind(session);
  // Ход, который «думает» до особого разрешения: ровно то, что человек хочет прервать.
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

test('/stats рассказывает цифры разговора, а не сырой ответ pi', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/stats'));
  const text = chatText(state, 42);

  assert.deepEqual(calls, [{ command: 'stats', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(text, /Твоих реплик: 12, шагов с инструментами: 40/);
  assert.match(text, /Токенов всего: 105[\s\u00a0]000 \(вход 50[\s\u00a0]000, выход 10[\s\u00a0]000, из кэша 45[\s\u00a0]000\)/);
  assert.match(text, /Занято в контексте: 34% \(68[\s\u00a0]000 из 200[\s\u00a0]000\)/);
  assert.match(text, /Потрачено: \$0\.450/);
});

test('/clear начинает разговор заново и честно говорит про память', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/clear'));

  assert.deepEqual(calls, [{ command: 'clear', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /с чистого листа/);
  assert.match(chatText(state, 42), /Память не трогал/);
});

test('/skills перечисляет, что можно позвать в чате', async () => {
  const { bot, state, calls } = makeBot();

  await bot.handleUpdate(messageUpdate('/skills'));
  const text = chatText(state, 42);

  assert.deepEqual(calls, [{ command: 'skills', user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(text, /\/skill:brave-search — поиск в интернете/);
  assert.match(text, /\/fix-tests — починить тесты/);
});

test('в группе у каждого человека свой разговор', () => {
  const group = messageUpdate('привет', { chatId: 99, type: 'supergroup' });
  assert.equal(conversationIdFor(group.message!, 'probe'), 'telegram-99-probe');
  const priv = messageUpdate('привет', { chatId: 99, type: 'private' });
  assert.equal(conversationIdFor(priv.message!, 'probe'), 'telegram-99');
});

test('команда — это «/слово [аргументы]», а не «/etc/hosts»', () => {
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

test('что отвечаем на каждый исход сжатия', () => {
  assert.match(compactText({ status: 'nothing' }), /нечего/);
  assert.match(compactText({ status: 'no-session' }), /уже сжат/);
  assert.match(compactText({ status: 'busy' }), /когда договорю/);
  assert.match(compactText({ status: 'failed', error: 'нет ключа' }), /нет ключа/);
});

test('что отвечаем на исходы /stop, /clear и /skills', () => {
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

test('/stats без цифр не выдумывает их', () => {
  assert.match(statsText({ status: 'ok', stats: {} }), /пустой/);
  assert.match(statsText({ status: 'failed', error: 'pi молчит' }), /pi молчит/);
});

test('длинный ответ доезжает целиком и по границам', async () => {
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

test('точка разреза ищется во второй половине, а не в первом абзаце', () => {
  const text = `${'a'.repeat(50)}\n\n${'b'.repeat(3000)}`;
  const cut = splitPoint(text, 1000);
  assert.ok(cut > 500 && cut <= 1000, `cut=${cut}`);
  assert.equal(splitPoint('безграниц'.repeat(200), 100), 100, 'нет границ — режем по пределу');
});

test('ответ уезжает с HTML-разметкой: модель пишет markdown, человек видит жирный', async () => {
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

test('Telegram не принял разметку — ответ доезжает, только без неё', async () => {
  const { bot, state } = makeBot({
    steps: [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '**Токены** и `код`' } },
      { type: 'agent_settled' },
    ],
  });
  // Так Telegram отвечает, когда разметку не понял: наш промах не должен съесть ответ.
  state.rejectMarkup = true;

  await bot.handleUpdate(messageUpdate('как там токены?'));

  const message = state.messages.find((item) => item.chatId === 42);
  assert.equal(message?.text, 'Токены и код', 'разметка снята, текст остался');
  assert.equal(message?.parseMode, null);
});

test('пустой ответ не оставляет висящее многоточие', async () => {
  const { bot, state } = makeBot({
    steps: [
      { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolName: 'bash', isError: false },
      { type: 'agent_settled' },
    ],
  });

  await bot.handleUpdate(messageUpdate('посмотри, что там'));

  const text = chatText(state, 42);
  assert.notEqual(text, PLACEHOLDER);
  assert.match(text, /команда отработала/, 'видно, чем закончили');
});

test('сбой хода человек видит ответом, а не тишиной', async () => {
  const { bot, state, session } = makeBot();
  session.prompt = async () => {
    throw new Error('pi завершился');
  };

  await bot.handleUpdate(messageUpdate('привет'));

  assert.match(chatText(state, 42), /Ход сорвался: pi завершился/);
});

test('очередь: сообщения одного чата идут по очереди, а разные чаты не ждут', async () => {
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

test('очередь: сбой одной задачи не рвёт следующие', async () => {
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

// --- топики: разговор = чат + топик -----------------------------------------

test('разговор — это чат и топик: у каждого топика своя сессия', () => {
  assert.equal(conversationIdFor(messageUpdate('привет').message!, 'probe'), 'telegram-42');
  assert.equal(
    conversationIdFor(messageUpdate('привет', { threadId: 1 }).message!, 'probe'),
    'telegram-42',
    'General — тот же корень чата',
  );
  assert.equal(conversationIdFor(messageUpdate('привет', { threadId: 17 }).message!, 'probe'), 'telegram-42-17');
});

test('в группе топик разделяет и людей', () => {
  const topic = messageUpdate('привет', { chatId: 99, type: 'supergroup', threadId: 5 });
  assert.equal(conversationIdFor(topic.message!, 'probe'), 'telegram-99-probe-5');
  assert.equal(conversationIdFor(messageUpdate('привет', { chatId: 99, type: 'supergroup' }).message!, 'probe'), 'telegram-99-probe');
});

test('topicThreadId: корень и General — одно место, топик — другое', () => {
  assert.equal(topicThreadId(messageUpdate('привет').message!), null);
  assert.equal(topicThreadId(messageUpdate('привет', { threadId: 1 }).message!), null);
  assert.equal(topicThreadId(messageUpdate('привет', { threadId: 17 }).message!), 17);
});

test('команду с остатком разбираем, а «а /rename» — не команда', () => {
  assert.deepEqual(parseCommand('/rename Письмо из налоговой'), {
    name: 'rename',
    args: 'Письмо из налоговой',
  });
  assert.deepEqual(parseCommand('/rename@the_icarus_bot Налоги'), { name: 'rename', args: 'Налоги' });
  assert.equal(parseCommand('а /rename'), null);
});


test('убранные /topic и /topics объясняют это, а не уходят в pi', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('/topic Работа'));
  await bot.handleUpdate(messageUpdate('/topics'));

  assert.equal(session.prompts.length, 0, 'модель эти команды не видит');
  assert.match(chatText(state, 42), /больше нет/);
});

test('ответ в топике уезжает в топик, а не в корень', async () => {
  const { bot, session, state } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));

  assert.equal(session.prompts.length, 1);
  assert.equal(chatText(state, 42), '', 'в корне чата пусто');
  assert.match(topicText(state, 42, 17), /Привет, Саня/);
  assert.equal(state.typingThreadId, 17, '«печатает…» — в том же топике');
});

test('первое сообщение топика из общей ленты уезжает в топик, а не в корень', async () => {
  const { bot, state } = makeBot({ topics: true });

  // Человек начал печатать в общей ленте: Telegram завёл топик и прислал служебку…
  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  // …а само сообщение приехало как сообщение корня: номера топика в нём нет.
  await bot.enqueue(messageUpdate('привет из нового топика'));

  assert.equal(chatText(state, 42), '', 'в корне чата пусто');
  assert.match(topicText(state, 42, 17), /Привет, Саня/);
  assert.equal(state.typingThreadId, 17, '«печатает…» — в том же топике');
});

test('разговор свежего топика считается по номеру топика, а не по корню', async () => {
  const { bot, calls } = makeBot({ topics: true });

  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  await bot.enqueue(messageUpdate('/stats'));

  assert.deepEqual(calls, [{ command: 'stats', user: 'probe', conversationId: 'telegram-42-17' }]);
});

test('свежий топик живёт окно, а не вечно', async () => {
  const { bot, state } = makeBot({ topics: true, freshTopicWindowMs: -1 });

  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  await bot.enqueue(messageUpdate('привет'));

  assert.match(chatText(state, 42), /Привет, Саня/);
  assert.equal(topicText(state, 42, 17), '', 'опоздавшее сообщение в топик не тащим');
});

test('настоящий номер топика гасит свежий слот: корень остаётся корнем', async () => {
  const { bot, state } = makeBot({ topics: true });

  await bot.enqueue(topicCreatedUpdate('New Topic', 17));
  // Клиент справился сам: сообщение пришло с номером топика — свежий слот больше не нужен.
  await bot.enqueue(messageUpdate('в топике', { threadId: 17 }));
  await bot.enqueue(messageUpdate('а это уже в корне'));

  assert.equal(topicText(state, 42, 17), 'Привет, Саня', 'в топике один ответ');
  assert.match(chatText(state, 42), /Привет, Саня/, 'и в корне свой');
});



test('если ответ в топик не уехал, бот говорит об этом в корне', async () => {
  const { bot, state } = makeBot({ topics: true });
  state.failTopics = true;

  await bot.handleUpdate(messageUpdate('привет', { threadId: 17 }));

  assert.equal(topicText(state, 42, 17), '', 'в топике пусто: отправку отбило');
  assert.match(chatText(state, 42), /Не смог ответить в топик/);
  assert.match(chatText(state, 42), /message thread not found/);
});

test('ответ на команду в топик тоже не теряется молча', async () => {
  const { bot, state } = makeBot({ topics: true });
  state.failTopics = true;

  await bot.handleUpdate(messageUpdate('/stats', { threadId: 17 }));

  assert.equal(topicText(state, 42, 17), '');
  assert.match(chatText(state, 42), /Не смог ответить в топик/);
});

test('/compact сжимает разговор того топика, где написали', async () => {
  const { bot, calls } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/compact', { threadId: 17 }));

  assert.deepEqual(calls, [{ command: 'compact', user: 'probe', conversationId: 'telegram-42-17' }]);
});



test('/rename переименовывает разговор и топик, в котором он идёт', async () => {
  const { bot, state, calls } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/rename Налоги', { threadId: 17 }));

  assert.deepEqual(state.renames, [{ chatId: 42, threadId: 17, name: 'Налоги' }]);
  assert.deepEqual(calls, [
    { command: 'rename', user: 'probe', conversationId: 'telegram-42-17', args: 'Налоги' },
  ]);
  assert.match(topicText(state, 42, 17), /называется «Налоги»/);
});

test('/rename из корня меняет имя разговора в реестре, не трогая топик', async () => {
  const { bot, state, calls } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/rename Налоги'));

  assert.deepEqual(state.renames, [], 'топика в корне нет');
  assert.deepEqual(calls, [{ command: 'rename', user: 'probe', conversationId: 'telegram-42', args: 'Налоги' }]);
  assert.match(chatText(state, 42), /называется «Налоги»/);
});


test('/rename без имени подсказывает форму', async () => {
  const { bot, state } = makeBot({ topics: true });

  await bot.handleUpdate(messageUpdate('/rename', { threadId: 17 }));

  assert.deepEqual(state.renames, []);
  assert.equal(topicText(state, 42, 17), RENAME_NEEDS_NAME);
});


test('реплика поверх идущего хода прерывает его и становится новым ходом', async () => {
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
  // Первый ход висит, пока его не прервут: ровно как настоящий, который держит
  // субагентов. Второй отвечает сразу.
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

  const { bot, calls } = makeBot({ session });
  const first = bot.enqueue(messageUpdate('первое'));
  for (let i = 0; i < 100 && session.prompts.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(session.prompts, ['первое'], 'первый ход должен начаться');

  // Второе сообщение — скилл с аргументами: для бота это не команда, а реплика,
  // и она тоже должна прервать ход, а не встать за ним.
  const second = bot.enqueue(messageUpdate('/skill:demo второе'));
  await Promise.all([first, second]);

  assert.equal(session.interrupts, 1, 'идущий ход прерывается, а не дожидается очереди');
  assert.equal(session.prompts.length, 2);
  assert.match(session.prompts[1] ?? '', /\/skill:demo второе/);
  assert.ok(
    calls.some((call) => call.command === 'interrupt'),
    'прерывание идёт через реестр, а не мимо него',
  );
});
