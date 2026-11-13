// Реестр разговоров: миграция старого chats.json, наполнение из файлов сессий
// и заголовок из первой реплики — один на все каналы.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { SessionRegistry } from '../src/sessions/registry.ts';
import {
  archiveChat,
  backfillChats,
  ensureChat,
  lastTurnOf,
  panelCanWrite,
  readChats,
  recordTurn,
  refreshChatTitle,
  renderSessionsMap,
  sessionIdOf,
  setChatArchived,
  setChatTelegram,
  setChatWorkspace,
  telegramPlaceOf,
  type ChatRecord,
} from '../src/sessions/chats.ts';
import { makeConfig, probe } from './fixtures.ts';

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  fs.mkdirSync(userPaths(config, user).sessions, { recursive: true });
  return { config, user };
}

function putSession(
  config: ReturnType<typeof makeConfig>,
  user: ReturnType<typeof probe>,
  conversationId: string,
  text = 'Собери отчёт',
  createdAt = '2026-11-01T10-00-00-000Z',
): { file: string; sessionId: string } {
  const sessionId = sessionIdFor(user.id, conversationId);
  const file = path.join(userPaths(config, user).sessions, `${createdAt}_${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: 'session', timestamp: '2026-11-01T10:00:00.000Z' },
      { type: 'message', timestamp: '2026-11-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }] } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  return { file, sessionId };
}

function byId(chats: ChatRecord[], id: string): ChatRecord | undefined {
  return chats.find((chat) => chat.id === id);
}

test('старый chats.json: preview и updatedAt выбрасываются, канал и conversationId достраиваются', () => {
  const { config, user } = fixture();
  fs.writeFileSync(
    path.join(userPaths(config, user).root, 'chats.json'),
    JSON.stringify({
      chats: [
        {
          id: 'web-old',
          title: 'План на неделю',
          preview: 'старое превью',
          createdAt: '2026-10-01T10:00:00.000Z',
          updatedAt: '2026-10-02T10:00:00.000Z',
        },
      ],
    }),
  );

  assert.deepEqual(readChats(config, user), [
    {
      id: 'web-old',
      title: 'План на неделю',
      createdAt: '2026-10-01T10:00:00.000Z',
      channel: 'web',
      workspace: 'talk',
      conversationId: 'web-old',
    },
  ]);
});

test('backfill переносит session-index в chats.json, добавляет старые сессии и удаляет второй индекс', () => {
  const { config, user } = fixture();
  const known = putSession(config, user, 'telegram-42', 'Разговор из Telegram');
  const unknown = putSession(config, user, 'telegram-77', 'Старый разговор');
  fs.writeFileSync(
    path.join(userPaths(config, user).root, 'session-index.json'),
    JSON.stringify({ sessions: [{ sessionId: known.sessionId, conversationId: 'telegram-42' }] }),
  );

  backfillChats(config, user);

  const chats = readChats(config, user);
  const telegram = byId(chats, 'telegram-42');
  assert.equal(telegram?.channel, 'telegram');
  assert.equal(telegram?.conversationId, 'telegram-42');

  const legacy = byId(chats, `session:${unknown.sessionId}`);
  assert.equal(legacy?.channel, 'telegram', 'без каталога считаем Telegram: API в бою не используется');
  assert.equal(legacy?.conversationId, undefined);
  assert.equal(legacy?.createdAt, '2026-11-01T10:00:00.000Z', 'createdAt берём из имени файла');

  assert.equal(fs.existsSync(path.join(userPaths(config, user).root, 'session-index.json')), false);

  backfillChats(config, user);
  assert.equal(readChats(config, user).length, 2, 'повторный проход не плодит записи');
});

test('ensureChat добавляет Telegram-разговор один раз и подхватывает старую session-запись', () => {
  const { config, user } = fixture();
  const { sessionId } = putSession(config, user, 'telegram-42', 'Отчёт для мамы');
  backfillChats(config, user);
  assert.ok(byId(readChats(config, user), `session:${sessionId}`), 'сначала разговор известен только по файлу');

  const chat = ensureChat(config, user, 'telegram-42', 'telegram');
  assert.equal(chat.id, 'telegram-42');
  assert.equal(chat.conversationId, 'telegram-42');

  const chats = readChats(config, user);
  assert.equal(chats.length, 1, 'запись обновилась, а не раздвоилась');
  assert.equal(chats[0]?.id, 'telegram-42');
});

test('разговор, поднятый в приватном workspace, остаётся в нём и в реестре', () => {
  const { config, user } = fixture();
  const chat = ensureChat(config, user, 'api-private-1', 'api', 'private');
  assert.equal(chat.workspace, 'private');
  assert.equal(byId(readChats(config, user), 'api-private-1')?.workspace, 'private');
});

test('заголовок Telegram-разговора берётся из первой реплики и сохраняется', () => {
  const { config, user } = fixture();
  putSession(config, user, 'telegram-42', 'Собери отчёт для мамы');
  ensureChat(config, user, 'telegram-42', 'telegram');

  refreshChatTitle(config, user, 'telegram-42');

  const [chat] = readChats(config, user);
  assert.equal(chat?.title, 'Собери отчёт для мамы');
});

test('канал последней реплики пишется по ходу и переживает чтение реестра', () => {
  const { config, user } = fixture();
  ensureChat(config, user, 'telegram-42', 'telegram');

  recordTurn(config, user, 'telegram-42', 'telegram', new Date('2026-11-01T12:04:00.000Z'));
  assert.deepEqual(lastTurnOf(config, user, 'telegram-42'), {
    channel: 'telegram',
    at: '2026-11-01T12:04:00.000Z',
  });
  assert.deepEqual(readChats(config, user)[0]?.lastTurn, {
    channel: 'telegram',
    at: '2026-11-01T12:04:00.000Z',
  });

  // Панель продолжила тот же разговор: шапка должна сказать уже про панель.
  recordTurn(config, user, 'telegram-42', 'web', new Date('2026-11-01T12:10:00.000Z'));
  assert.equal(lastTurnOf(config, user, 'telegram-42')?.channel, 'web');

  // Разговора нет — подписи тоже: реестр не заводит записей задним числом.
  assert.equal(recordTurn(config, user, 'telegram-нет', 'web'), null);
  assert.equal(readChats(config, user).length, 1);
});

test('битый lastTurn не роняет реестр: поле просто не читается', () => {
  const { config, user } = fixture();
  fs.mkdirSync(userPaths(config, user).root, { recursive: true });
  fs.writeFileSync(
    path.join(userPaths(config, user).root, 'chats.json'),
    JSON.stringify({
      chats: [
        {
          id: 'telegram-42',
          title: 'Разговор в Telegram',
          createdAt: '2026-11-01T10:00:00.000Z',
          channel: 'telegram',
          conversationId: 'telegram-42',
          workspace: 'talk',
          lastTurn: { channel: 'телепатия', at: '2026-11-01T12:04:00.000Z' },
        },
      ],
    }),
  );

  const [chat] = readChats(config, user);
  assert.equal(chat?.lastTurn, undefined);
  assert.equal(chat?.channel, 'telegram', 'остальная запись цела');
});

test('из панели пишут в веб и Telegram, а в API — только смотрят', () => {
  const base = { title: 'x', createdAt: '2026-11-01T10:00:00.000Z', workspace: 'talk' } as const;
  assert.equal(panelCanWrite({ ...base, channel: 'web' }), true);
  assert.equal(panelCanWrite({ ...base, channel: 'telegram' }), true);
  assert.equal(panelCanWrite({ ...base, channel: 'api' }), false);
});

test('sessionIdOf знает веб-чат, Telegram и старую session-запись', () => {
  const { user } = fixture();
  const web: ChatRecord = {
    id: 'web-1',
    title: 'Веб',
    createdAt: '2026-11-01T10:00:00.000Z',
    channel: 'web',
    workspace: 'talk',
    conversationId: 'web-1',
  };
  const telegram: ChatRecord = {
    id: 'telegram-42',
    title: 'Телега',
    createdAt: '2026-11-01T10:00:00.000Z',
    channel: 'telegram',
    workspace: 'talk',
    conversationId: 'telegram-42',
  };
  const legacy: ChatRecord = {
    id: 'session:abc',
    title: 'Старый',
    createdAt: '2026-11-01T10:00:00.000Z',
    channel: 'telegram',
    workspace: 'talk',
  };

  assert.equal(sessionIdOf(web, user), sessionIdFor(user.id, 'web-1'));
  assert.equal(sessionIdOf(telegram, user), sessionIdFor(user.id, 'telegram-42'));
  assert.equal(sessionIdOf(legacy, user), 'abc');
});

test('реестр пишет Telegram-разговор в chats.json, когда поднимает сессию', async () => {
  const { config, user } = fixture();
  // Реестру от сессии нужны занятость и dispose: сам pi в тесте не поднимается.
  const session = { alive: true, generation: 0, busy: false, lastUsed: Date.now(), dispose: () => {} };
  const registry = new SessionRegistry(config, {
    ensureContainer: async () => 'stub',
    createSession: () => session as never,
  });

  try {
    await registry.acquire(user, 'telegram-42');
    const [chat] = readChats(config, user);
    assert.equal(chat?.id, 'telegram-42');
    assert.equal(chat?.title, 'Разговор в Telegram');
    assert.equal(chat?.channel, 'telegram');
    assert.equal(chat?.conversationId, 'telegram-42');
    assert.match(chat?.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    registry.dispose();
  }
});

test('переключение workspace: запись живёт в chats.json, а pi поднимается в новой папке', async () => {
  const { config, user } = fixture();
  // Разговора ещё нет: /workspace — законная первая команда в новом чате.
  const chat = setChatWorkspace(config, user, 'telegram-42', 'rabota');
  assert.equal(chat.workspace, 'rabota');
  assert.equal(ensureChat(config, user, 'telegram-42', 'telegram').workspace, 'rabota', 'ensureChat папку не откатывает');

  // Сессия поднимается уже в новой папке: старая ушла вместе с процессом.
  let startedIn = '';
  const session = { alive: true, generation: 0, busy: false, lastUsed: Date.now(), dispose: () => {} };
  const registry = new SessionRegistry(config, {
    ensureContainer: async () => 'stub',
    createSession: (_config, _user, _conversation, _model, _container, _generation, workspace) => {
      startedIn = workspace;
      return session as never;
    },
  });

  try {
    await registry.acquire(user, 'telegram-42');
    assert.equal(startedIn, 'rabota');
  } finally {
    registry.dispose();
  }
});

test('перед миграцией старый chats.json сохраняется как .bak', () => {
  const { config, user } = fixture();
  const root = userPaths(config, user).root;
  const legacy = {
    chats: [
      {
        id: 'web-old',
        title: 'Старый разговор',
        preview: 'превью',
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-02T10:00:00.000Z',
      },
    ],
  };
  fs.writeFileSync(path.join(root, 'chats.json'), JSON.stringify(legacy));

  backfillChats(config, user);

  const backup = JSON.parse(fs.readFileSync(path.join(root, 'chats.json.bak'), 'utf8')) as typeof legacy;
  assert.equal(backup.chats[0]?.preview, 'превью', 'старый файл цел');
  const migrated = readChats(config, user);
  assert.equal(migrated[0]?.channel, 'web');
  assert.deepEqual(Object.keys(migrated[0] ?? {}).sort(), [
    'channel',
    'conversationId',
    'createdAt',
    'id',
    'title',
    'workspace',
  ]);
});

test('битый chats.json откладывается в сторону, а не затирается', () => {
  const { config, user } = fixture();
  const root = userPaths(config, user).root;
  fs.writeFileSync(path.join(root, 'chats.json'), '{"chats": [это не json');

  backfillChats(config, user);

  const broken = fs.readdirSync(root).filter((name) => name.startsWith('chats.json.corrupt-'));
  assert.equal(broken.length, 1, 'битый файл сохранён для разбора');
  assert.ok(fs.existsSync(path.join(root, 'chats.json')), 'реестр собран заново');
});

test('карта разговоров: по ссылке из панели находится файл сессии pi', () => {
  const { config, user } = fixture();
  const telegram = putSession(config, user, 'telegram-473232394-163396', 'Первая реплика из телеги');
  const web = putSession(config, user, 'web-mw2nt32t-f06bd6', 'Первая реплика из панели');
  ensureChat(config, user, 'telegram-473232394-163396', 'telegram');
  ensureChat(config, user, 'web-mw2nt32t-f06bd6', 'web');

  const map = JSON.parse(renderSessionsMap(config, user)) as {
    sessions: Array<{ conversationId: string; sessionId: string; file?: string; channel: string }>;
  };
  const byConversation = new Map(map.sessions.map((entry) => [entry.conversationId, entry]));

  for (const [conversationId, expected] of [
    ['telegram-473232394-163396', telegram],
    ['web-mw2nt32t-f06bd6', web],
  ] as const) {
    const entry = byConversation.get(conversationId);
    assert.ok(entry, `в карте есть ${conversationId}`);
    // Главное: id сессии и файл истории достаются без знания userId, которого
    // в контейнере нет. Файл указываем абсолютным — агент идёт по нему напрямую.
    assert.equal(entry.sessionId, expected.sessionId);
    assert.equal(entry.file, expected.file);
  }

  assert.equal(byConversation.get('telegram-473232394-163396')?.channel, 'telegram');
  assert.equal(byConversation.get('web-mw2nt32t-f06bd6')?.channel, 'web');
});

test('карта разговоров: без файла сессии запись остаётся, но без пути', () => {
  const { config, user } = fixture();
  // Реестр знает о разговоре, а файла истории ещё нет: карта не должна врать,
  // что путь есть, — иначе агент пойдёт открывать несуществующий файл.
  ensureChat(config, user, 'web-no-file-yet', 'web');

  const map = JSON.parse(renderSessionsMap(config, user)) as {
    sessions: Array<{ conversationId: string; file?: string }>;
  };
  const entry = map.sessions.find((item) => item.conversationId === 'web-no-file-yet');
  assert.ok(entry, 'запись есть');
  assert.equal(entry.file, undefined, 'пути нет, пока нет файла');
});

test('карта разговоров: пустой реестр даёт пустую карту, а не падение', () => {
  const { config, user } = fixture();
  const map = JSON.parse(renderSessionsMap(config, user)) as { sessions: unknown[] };
  assert.deepEqual(map.sessions, []);
});

test('архив — это отметка в реестре: файл сессии и запись остаются на месте', () => {
  const { config, user } = fixture();
  const { file } = putSession(config, user, 'telegram-42', 'Отчёт для мамы');
  ensureChat(config, user, 'telegram-42', 'telegram');
  const sessionFile = fs.readdirSync(userPaths(config, user).sessions)[0];
  assert.ok(sessionFile, 'история лежит в общей папке сессий');

  const archived = setChatArchived(config, user, 'telegram-42', true, new Date('2026-11-02T12:00:00.000Z'));
  assert.equal(archived?.archivedAt, '2026-11-02T12:00:00.000Z');
  assert.ok(fs.existsSync(file), 'архив не трогает файл разговора');
  assert.equal(readChats(config, user)[0]?.archivedAt, '2026-11-02T12:00:00.000Z');

  // Повторный уход в архив не двигает отметку: порядок в архиве не прыгает.
  setChatArchived(config, user, 'telegram-42', true, new Date('2026-11-03T12:00:00.000Z'));
  assert.equal(readChats(config, user)[0]?.archivedAt, '2026-11-02T12:00:00.000Z');
});

test('архив переживает пересборку реестра, а возврат снимает отметку', () => {
  const { config, user } = fixture();
  putSession(config, user, 'telegram-42', 'Старый разговор');
  ensureChat(config, user, 'telegram-42', 'telegram');
  setChatArchived(config, user, 'telegram-42', true, new Date('2026-11-02T12:00:00.000Z'));

  backfillChats(config, user);
  assert.equal(readChats(config, user)[0]?.archivedAt, '2026-11-02T12:00:00.000Z', 'backfill не выбрасывает архив');

  const restored = setChatArchived(config, user, 'telegram-42', false);
  assert.equal(restored?.archivedAt, undefined);
  assert.equal(readChats(config, user)[0]?.archivedAt, undefined, 'вернулся в обычный реестр');
  assert.equal(setChatArchived(config, user, 'нет-такого', true), null);
});

test('место разговора в Telegram лежит в chats.json и переживает перезапуск', () => {
  const { config, user } = fixture();
  ensureChat(config, user, 'telegram-42-17', 'telegram', 'talk');

  setChatTelegram(config, user, 'telegram-42-17', 42, 17);
  setChatTelegram(config, user, 'telegram-42-17', 42, 17);

  // Именно в файле: имя топика и удаление темы иначе не пережили бы перезапуск.
  assert.deepEqual(readChats(config, user)[0]?.telegram, { chatId: 42, threadId: 17 });
  assert.deepEqual(telegramPlaceOf(config, user, 'telegram-42-17'), { chatId: 42, threadId: 17 });
});

test('архивация Telegram-разговора удаляет топик и забывает место', async () => {
  const { config, user } = fixture();
  ensureChat(config, user, 'telegram-42-17', 'telegram', 'talk');
  setChatTelegram(config, user, 'telegram-42-17', 42, 17);

  const deleted: Array<{ chatId?: number; threadId?: number | null }> = [];
  const outcome = await archiveChat(config, user, 'telegram-42-17', true, async (chat) => {
    deleted.push(chat.telegram ?? {});
  });

  assert.equal(outcome.chat?.archivedAt !== undefined, true, 'разговор ушёл в архив');
  assert.deepEqual(deleted, [{ chatId: 42, threadId: 17 }]);
  assert.equal(readChats(config, user)[0]?.telegram, undefined, 'топика больше нет — и места нет');

  // Возврат из архива Telegram не воскрешает: померла так померла.
  const restored = await archiveChat(config, user, 'telegram-42-17', false, async () => {
    throw new Error('возврат не должен трогать Telegram');
  });
  assert.equal(restored.chat?.archivedAt, undefined);
});

test('топик не удалился — архив всё равно состоялся, место осталось', async () => {
  const { config, user } = fixture();
  ensureChat(config, user, 'telegram-42-17', 'telegram');
  setChatTelegram(config, user, 'telegram-42-17', 42, 17);

  const outcome = await archiveChat(config, user, 'telegram-42-17', true, async () => {
    throw new Error('не форум');
  });

  assert.equal(outcome.chat?.archivedAt !== undefined, true);
  assert.equal(outcome.topicError, 'не форум');
  assert.deepEqual(readChats(config, user)[0]?.telegram, { chatId: 42, threadId: 17 }, 'топик жив — место нужно');
});

test('без бота архивация панели просто ставит отметку', async () => {
  const { config, user } = fixture();
  ensureChat(config, user, 'telegram-42-17', 'telegram');
  setChatTelegram(config, user, 'telegram-42-17', 42, 17);

  const outcome = await archiveChat(config, user, 'telegram-42-17', true);
  assert.equal(outcome.chat?.archivedAt !== undefined, true);
  assert.deepEqual(readChats(config, user)[0]?.telegram, { chatId: 42, threadId: 17 });
});
