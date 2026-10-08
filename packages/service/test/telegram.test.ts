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
  unsupportedText,
  voicePrompt,
  GREETING,
  HELP,
  NO_USERNAME,
  UNKNOWN_COMMAND,
} from '../src/telegram/bot.ts';
import {
  TelegramApi,
  TelegramError,
  type TelegramPhotoSize,
  type TelegramUpdate,
} from '../src/telegram/api.ts';
import { MESSAGE_LIMIT, PLACEHOLDER, splitPoint } from '../src/telegram/reply.ts';
import { userPaths } from '../src/config.ts';
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

// --- бот --------------------------------------------------------------------

type Step = Record<string, unknown>;

const ANSWER_STEPS: Step[] = [
  { type: 'tool_execution_start', toolName: 'read', args: { path: '/workspace/memory/identity.md' } },
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
    messages: [] as Array<{ chatId: number; id: number; text: string }>,
    nextId: 1,
    typing: 0,
    files: new Map(Object.entries(files)),
    downloaded: [] as string[],
  };
  const api = {
    async sendMessage(chatId: number, text: string) {
      const message = { chatId, id: state.nextId, text };
      state.nextId += 1;
      state.messages.push(message);
      return { message_id: message.id };
    },
    async editMessageText(chatId: number, messageId: number, text: string) {
      const message = state.messages.find((item) => item.id === messageId && item.chatId === chatId);
      if (!message) throw new TelegramError('message to edit not found', 400);
      message.text = text;
    },
    async sendChatAction() {
      state.typing += 1;
    },
    async setMyCommands() {},
    async getMe() {
      return { id: 1, username: 'the_icarus_bot' };
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

function chatText(state: ReturnType<typeof fakeApi>['state'], chatId: number): string {
  return state.messages
    .filter((message) => message.chatId === chatId)
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
    skills?: unknown;
    /** Чем расшифровывать голосовые: как в бою, но без сети; null — нечем. */
    transcribe?: ((audio: Uint8Array, mimeType: string) => Promise<string>) | null;
    /** Файлы, которые «лежат» в Telegram: id → байты. */
    files?: Record<string, Buffer>;
  } = {},
) {
  const config =
    options.config ??
    makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const session = fakeSession(options.steps ?? ANSWER_STEPS);
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
  // Расшифровка по умолчанию рабочая: тест про «распознавания нет» задаёт null явно.
  const transcribe =
    'transcribe' in options ? options.transcribe : async () => 'привет из голосового';
  const bot = new TelegramBot(config, registry as never, { api, editIntervalMs: 0, transcribe });
  return { bot, session, state, calls, config };
}

function messageUpdate(text: string, options: { username?: string; chatId?: number; type?: string } = {}): TelegramUpdate {
  const { username = 'trousev', chatId = 42, type = 'private' } = options;
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: chatId, type },
      from: username === '' ? { id: 7 } : { id: 7, username },
      text,
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
  assert.match(session.prompts[0] ?? '', /\/workspace\/incoming\/telegram-42-10\.jpg/);

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
  assert.match(session.prompts[0] ?? '', /\/workspace\/incoming\/telegram-42-10\.jpg/);
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

  assert.match(clearText({ status: 'started' }), /в архив/);
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
