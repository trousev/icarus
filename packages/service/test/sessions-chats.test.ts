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
  backfillChats,
  ensureChat,
  readChats,
  refreshChatTitle,
  sessionIdOf,
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

test('заголовок Telegram-разговора берётся из первой реплики и сохраняется', () => {
  const { config, user } = fixture();
  putSession(config, user, 'telegram-42', 'Собери отчёт для мамы');
  ensureChat(config, user, 'telegram-42', 'telegram');

  refreshChatTitle(config, user, 'telegram-42');

  const [chat] = readChats(config, user);
  assert.equal(chat?.title, 'Собери отчёт для мамы');
});

test('sessionIdOf знает веб-чат, Telegram и старую session-запись', () => {
  const { user } = fixture();
  const web: ChatRecord = {
    id: 'web-1',
    title: 'Веб',
    createdAt: '2026-11-01T10:00:00.000Z',
    channel: 'web',
    conversationId: 'web-1',
  };
  const telegram: ChatRecord = {
    id: 'telegram-42',
    title: 'Телега',
    createdAt: '2026-11-01T10:00:00.000Z',
    channel: 'telegram',
    conversationId: 'telegram-42',
  };
  const legacy: ChatRecord = {
    id: 'session:abc',
    title: 'Старый',
    createdAt: '2026-11-01T10:00:00.000Z',
    channel: 'telegram',
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
  assert.deepEqual(Object.keys(migrated[0] ?? {}).sort(), ['channel', 'conversationId', 'createdAt', 'id', 'title']);
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
