// Telegram-бот: кто получает ответ, что отвечаем на команды и как ответ доезжает
// до чата. Сети и докера тут нет: Bot API, реестр сессий и сессия pi — заглушки.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KeyedQueue,
  TelegramBot,
  compactText,
  conversationIdFor,
  isCommand,
  GREETING,
  NO_USERNAME,
  TEXT_ONLY,
  UNKNOWN_COMMAND,
} from '../src/telegram/bot.ts';
import { TelegramApi, TelegramError, type TelegramUpdate } from '../src/telegram/api.ts';
import { MESSAGE_LIMIT, PLACEHOLDER, splitPoint } from '../src/telegram/reply.ts';
import { makeConfig } from './fixtures.ts';

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
    async prompt(text: string) {
      this.prompts.push(text);
      for (const step of steps) for (const listener of listeners) listener(step);
    },
    onEvent(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Чат глазами Telegram: сообщения заводятся отправкой и меняются правками. */
function fakeApi() {
  const state = { messages: [] as Array<{ chatId: number; id: number; text: string }>, nextId: 1, typing: 0 };
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
  } as unknown as TelegramApi;
  return { api, state };
}

function chatText(state: ReturnType<typeof fakeApi>['state'], chatId: number): string {
  return state.messages
    .filter((message) => message.chatId === chatId)
    .map((message) => message.text)
    .join('\n');
}

function makeBot(options: { steps?: Step[]; config?: ReturnType<typeof makeConfig>; compact?: unknown } = {}) {
  const config =
    options.config ??
    makeConfig({ telegram: { token: 'bot-token', mapping: { trousev: 'probe' } } });
  const session = fakeSession(options.steps ?? ANSWER_STEPS);
  const compactCalls: Array<{ user: string; conversationId: string }> = [];
  const registry = {
    acquire: async () => session,
    compact: async (user: { id: string }, conversationId: string) => {
      compactCalls.push({ user: user.id, conversationId });
      return options.compact ?? { status: 'compacted', tokensBefore: 1200, tokensAfter: 300 };
    },
  };
  const { api, state } = fakeApi();
  const bot = new TelegramBot(config, registry as never, { api, editIntervalMs: 0 });
  return { bot, session, state, compactCalls };
}

function messageUpdate(text: string, options: { username?: string; chatId?: number; type?: string } = {}): TelegramUpdate {
  const { username = 'trousev', chatId = 42, type = 'private' } = options;
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: chatId, type },
      from: username === '' ? { id: 7 } : { id: 7, username },
      ...(text === '' ? { photo: [{}] } : { text }),
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

test('фото и голосовые бот пока не разбирает — просит словами', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate(''));

  assert.deepEqual(session.prompts, []);
  assert.equal(chatText(state, 42), TEXT_ONLY);
});

test('/start здоровается, незнакомая команда — подсказка', async () => {
  const { bot, session, state } = makeBot();

  await bot.handleUpdate(messageUpdate('/start'));
  assert.equal(chatText(state, 42), GREETING);

  await bot.handleUpdate(messageUpdate('/help'));
  assert.match(chatText(state, 42), new RegExp(UNKNOWN_COMMAND));
  assert.deepEqual(session.prompts, [], 'команды в разговор не уезжают');
});

test('/compact сжимает разговор этого чата и рассказывает цифры', async () => {
  const { bot, state, compactCalls } = makeBot();

  await bot.handleUpdate(messageUpdate('/compact'));

  assert.deepEqual(compactCalls, [{ user: 'probe', conversationId: 'telegram-42' }]);
  assert.match(chatText(state, 42), /Подвёл итог: 1[\s\u00a0]?200 → 300 токенов/);
});

test('в группе у каждого человека свой разговор', () => {
  const group = messageUpdate('привет', { chatId: 99, type: 'supergroup' });
  assert.equal(conversationIdFor(group.message!, 'probe'), 'telegram-99-probe');
  const priv = messageUpdate('привет', { chatId: 99, type: 'private' });
  assert.equal(conversationIdFor(priv.message!, 'probe'), 'telegram-99');
});

test('командой считаем только «/слово», а не «/etc/hosts»', () => {
  assert.equal(isCommand('/compact'), true);
  assert.equal(isCommand('/compact@the_icarus_bot'), true);
  assert.equal(isCommand('/etc/hosts'), false);
  assert.equal(isCommand('а /compact потом'), false);
});

test('что отвечаем на каждый исход сжатия', () => {
  assert.match(compactText({ status: 'nothing' }), /нечего/);
  assert.match(compactText({ status: 'no-session' }), /уже сжат/);
  assert.match(compactText({ status: 'busy' }), /когда договорю/);
  assert.match(compactText({ status: 'failed', error: 'нет ключа' }), /нет ключа/);
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
