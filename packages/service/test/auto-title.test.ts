// Живой заголовок разговора: модель называет разговор по первым репликам,
// эвристика из первой фразы остаётся фолбэком, а имя, выбранное человеком,
// не переписывается ни моделью, ни ходом разговора.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths } from '../src/config.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { askModelTitle, titleFromText } from '../src/http/title.ts';
import { applyAutoTitle, isAutoTitle, readChats, renameChat, setChatArchived } from '../src/sessions/chats.ts';
import { createChat, finishChat, refineChatTitle } from '../src/control/chat.ts';
import { watchAll, type BulletinEvent } from '../src/control/chat-live.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  return { config, user };
}

/** Файл сессии pi: `<когда создан>_<id>.jsonl`, как его кладёт pi. */
function putSessionFile(
  config: ReturnType<typeof makeConfig>,
  user: ReturnType<typeof probe>,
  conversationId: string,
  entries: unknown[],
  createdAt = '2026-11-01T10-00-00-000Z',
): { file: string; sessionId: string } {
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = sessionIdFor(user.id, conversationId);
  const file = path.join(dir, `${createdAt}_${sessionId}.jsonl`);
  const header = { type: 'session', timestamp: createdAt.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z') };
  fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n'));
  return { file, sessionId };
}

function dialog(userText: string, assistantText: string, at = '2026-11-01T10:00:01.000Z'): unknown[] {
  return [
    { type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
  ];
}

test('модель называет разговор по смыслу, а не по обрывку фразы', async () => {
  const asked: string[] = [];
  const result = await askModelTitle({
    ask: async (prompt) => {
      asked.push(prompt);
      return 'Настройка памяти Икара\n';
    },
    conversation: 'User: Привет, Икар! Помоги разобраться, как настроить память\nAI: Смотри, память лежит в …',
    fallback: titleFromText('Привет, Икар! Помоги разобраться, как настроить память'),
  });

  assert.equal(result.source, 'model');
  assert.equal(result.title, 'Настройка памяти Икара');
  assert.equal(asked.length, 1, 'модель спрашиваем ровно один раз');
  assert.match(asked[0] ?? '', /настроить память/, 'в промпт едет разговор');
  assert.match(asked[0] ?? '', /Смотри, память лежит/, 'и ответ Икара тоже');
});

test('таймаут модели откатывает на эвристику из первой фразы', async () => {
  const result = await askModelTitle({
    ask: async () => {
      throw new Error('модель не ответила за 8000 мс');
    },
    conversation: 'User: Почему не стартует docker compose?',
    fallback: titleFromText('Почему не стартует docker compose?'),
  });

  assert.equal(result.source, 'heuristic');
  assert.equal(result.title, 'Почему не стартует docker compose');
});

test('мусорный ответ модели — тоже фолбэк, а не заголовок', async () => {
  for (const raw of ['<think>сейчас придумаю имя</think>\n', '   ', 'Заголовок:']) {
    const result = await askModelTitle({
      ask: async () => raw,
      conversation: 'User: что-то',
      fallback: 'Что-то',
    });
    assert.equal(result.source, 'heuristic', `ответ ${JSON.stringify(raw)} не должен стать именем`);
    assert.equal(result.title, 'Что-то');
  }
});

test('отмена вместе с ходом не считается поломкой и даёт эвристику', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await askModelTitle({
    ask: async () => {
      throw new Error('запрос отменён');
    },
    conversation: 'User: что-то',
    fallback: 'Что-то',
    signal: controller.signal,
  });

  assert.equal(result.title, 'Что-то');
  assert.equal(result.source, 'heuristic');
});

test('живой заголовок: модель называет разговор по первым репликам', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, dialog('привет', 'Привет! Чем помочь?'));
  finishChat(config, user, chat.id, 'привет');

  // Сразу после хода имя уже есть — хоть какое-то, из первой фразы.
  assert.equal(readChats(config, user)[0]?.title, 'Привет', 'эвристика не ждёт модель');
  assert.equal(isAutoTitle(readChats(config, user)[0]!), true, 'это наше имя, его можно уточнить');

  const events: BulletinEvent[] = [];
  const off = watchAll((event) => events.push(event));
  let prompt = '';
  const title = await refineChatTitle(
    config,
    user,
    async (asked) => {
      prompt = asked;
      return 'Знакомство с Икаром';
    },
    chat.id,
  );
  off();

  assert.equal(title, 'Знакомство с Икаром');
  assert.equal(readChats(config, user)[0]?.title, 'Знакомство с Икаром');
  assert.match(prompt, /User: привет/, 'модель видит первую реплику');
  assert.match(prompt, /AI: Привет! Чем помочь\?/, 'и первый ответ Икара');
  const last = events.at(-1);
  assert.equal(last?.type, 'title', 'имя приезжает отдельным событием сводки');
  assert.equal(last?.chatId, chat.id);
  assert.equal((last?.chat as { title?: string })?.title, 'Знакомство с Икаром');
});

test('чат, названный человеком, модель не переименовывает', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, dialog('привет', 'Привет! Чем помочь?'));
  finishChat(config, user, chat.id, 'привет');
  renameChat(config, user, chat.id, 'Налоги');

  let asked = 0;
  const title = await refineChatTitle(
    config,
    user,
    async () => {
      asked += 1;
      return 'Знакомство с Икаром';
    },
    chat.id,
  );

  assert.equal(title, null);
  assert.equal(asked, 0, 'модель даже не спрашиваем: имя выбрал человек');
  assert.equal(readChats(config, user)[0]?.title, 'Налоги');
  assert.equal(applyAutoTitle(config, user, chat.id, 'Другое имя'), null, 'и напрямую не переписать');
});

test('пока модель думает, человек переименовал — имя человека сильнее', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, dialog('привет', 'Привет! Чем помочь?'));
  finishChat(config, user, chat.id, 'привет');

  const title = await refineChatTitle(
    config,
    user,
    async () => {
      // Человек успевает назвать разговор, пока модель «думает».
      renameChat(config, user, chat.id, 'Налоги');
      return 'Знакомство с Икаром';
    },
    chat.id,
  );

  assert.equal(title, null, 'поздний ответ модели уже не применяется');
  assert.equal(readChats(config, user)[0]?.title, 'Налоги');
});

test('после третьего хода живой заголовок успокаивается', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, [
    ...dialog('первая тема', 'ответ'),
    ...dialog('вторая тема', 'ответ'),
    ...dialog('третья тема', 'ответ'),
    ...dialog('четвёртая тема', 'ответ'),
  ]);
  finishChat(config, user, chat.id, 'первая тема');

  let asked = 0;
  const title = await refineChatTitle(
    config,
    user,
    async () => {
      asked += 1;
      return 'Позднее имя';
    },
    chat.id,
  );

  assert.equal(title, null);
  assert.equal(asked, 0, 'разговор уже устоялся — модель не дёргаем');
  assert.equal(readChats(config, user)[0]?.title, 'Первая тема');
});

test('имя правится из списка чатов и после этого не меняется моделью', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, dialog('привет', 'Привет! Чем помочь?'));
  finishChat(config, user, chat.id, 'привет');

  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${port}`;

  try {
    const renamed = await fetch(`${base}/panel/api/chats`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ id: chat.id, title: '  Налоги   из ФНС ' }),
    });
    assert.equal(renamed.status, 200);
    const payload = (await renamed.json()) as { chat: { id: string; title: string } };
    assert.equal(payload.chat.title, 'Налоги из ФНС', 'пробелы схлопнуты');
    assert.equal(readChats(config, user)[0]?.title, 'Налоги из ФНС');
    assert.equal(readChats(config, user)[0]?.titleSource, 'manual');

    assert.equal(
      await refineChatTitle(config, user, async () => 'Позднее имя', chat.id),
      null,
      'после ручного переименования модель разговор не трогает',
    );

    const empty = await fetch(`${base}/panel/api/chats`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ id: chat.id, title: '   ' }),
    });
    assert.equal(empty.status, 400, 'пустое имя не принимаем');

    const missing = await fetch(`${base}/panel/api/chats`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ id: 'web-нет-такого', title: 'Имя' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('архивный разговор сам не переименовывается', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, dialog('привет', 'Привет! Чем помочь?'));
  finishChat(config, user, chat.id, 'привет');
  setChatArchived(config, user, chat.id, true);

  let asked = 0;
  const title = await refineChatTitle(
    config,
    user,
    async () => {
      asked += 1;
      return 'Знакомство с Икаром';
    },
    chat.id,
  );

  assert.equal(title, null);
  assert.equal(asked, 0, 'модель не зовём: разговор не в списке');
  assert.equal(readChats(config, user)[0]?.title, 'Привет', 'имя в архиве осталось прежним');
  assert.equal(applyAutoTitle(config, user, chat.id, 'Другое имя'), null, 'и напрямую не переписать');
});
