// Каталог разговоров: из файла сессии обратно в Telegram-разговор.
// Панель показывает Telegram-чаты только для чтения, и ей нужно знать канал.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { channelForConversation, readSessionCatalog, rememberTelegramSession } from '../src/sessions/catalog.ts';
import { makeConfig, probe } from './fixtures.ts';

test('каталог помнит Telegram-разговор и не плодит дубли', () => {
  const config = makeConfig();
  const user = probe();
  const sessionId = sessionIdFor(user.id, 'telegram-42');

  rememberTelegramSession(config, user, 'telegram-42', sessionId);
  assert.deepEqual(readSessionCatalog(config, user), [{ sessionId, conversationId: 'telegram-42' }]);

  rememberTelegramSession(config, user, 'telegram-42', sessionId);
  assert.equal(readSessionCatalog(config, user).length, 1);
});

test('веб-разговоры в каталог не едут: они и так лежат в chats.json', () => {
  const config = makeConfig();
  const user = probe();

  rememberTelegramSession(config, user, 'web-1', sessionIdFor(user.id, 'web-1'));
  assert.deepEqual(readSessionCatalog(config, user), []);
});

test('канал разговора виден по префиксу id', () => {
  assert.equal(channelForConversation('web-abc'), 'web');
  assert.equal(channelForConversation('telegram-42'), 'telegram');
  assert.equal(channelForConversation('telegram--100500-7'), 'telegram');
  assert.equal(channelForConversation('какой-то-api'), 'api');
});

test('реестр запоминает Telegram-разговор при подъёме сессии', async () => {
  const config = makeConfig();
  const user = probe();
  // Реестру от сессии нужны занятость и dispose: сам pi в тесте не поднимается.
  const session = { alive: true, generation: 0, busy: false, lastUsed: Date.now(), dispose: () => {} };
  const registry = new SessionRegistry(config, {
    ensureContainer: async () => 'stub',
    createSession: () => session as never,
  });

  try {
    await registry.acquire(user, 'telegram-4242');
    assert.deepEqual(readSessionCatalog(config, user), [
      { sessionId: sessionIdFor(user.id, 'telegram-4242'), conversationId: 'telegram-4242' },
    ]);
  } finally {
    registry.dispose();
  }
});
