// Human commands on top of the session registry: /stop, /stats, /skills, /clear and /rename.
// No docker or model here: sessions are stubs (see RegistryDeps), while the conversation
// for /clear is a record in chats.json and a file in the person's sessions directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { findChatRecord, ensureChat } from '../src/sessions/chats.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

/** A stub session: the registry needs busy state, interruption and answers to questions from it. */
function fakeSession(overrides: Partial<Record<string, unknown>> = {}) {
  const session = {
    key: 'probe:conv',
    user: { id: 'probe' },
    conversationId: 'conv',
    container: 'stub',
    generation: 0,
    busy: false,
    alive: true,
    lastUsed: Date.now(),
    turns: 0,
    compacting: null as Promise<void> | null,
    disposed: 0,
    aborted: 0,
    cleared: 0,
    /** Whether pi confirms the interruption: a failed abort is also life. */
    abortConfirmed: true,
    stats: { userMessages: 3, tokens: { total: 100 } } as Record<string, unknown> | null,
    commands: [{ name: 'skill:brave-search', description: 'поиск', source: 'skill' }],
    async abort(): Promise<boolean> {
      this.aborted += 1;
      return this.abortConfirmed;
    },
    async compact() {
      return { status: 'nothing' as const };
    },
    async newSession(): Promise<string> {
      this.cleared += 1;
      return 'new-session-id';
    },
    async getStats(): Promise<Record<string, unknown> | null> {
      return this.stats;
    },
    async getCommands() {
      return this.commands;
    },
    dispose(): void {
      this.disposed += 1;
      this.alive = false;
    },
    onEvent: () => () => {},
    async prompt(): Promise<void> {},
    async getMessages(): Promise<Array<Record<string, unknown>>> {
      return [];
    },
  };
  return Object.assign(session, overrides);
}

function makeRegistry(session: ReturnType<typeof fakeSession>, config: IcarusConfig = makeConfig()) {
  return {
    config,
    registry: new SessionRegistry(config, {
      ensureContainer: async () => 'stub',
      createSession: () => session as never,
    }),
  };
}

/** The conversation file the way pi lays it down: `<created at>_<id>.jsonl`. */
function putSessionFile(config: IcarusConfig, conversationId: string): string {
  const dir = userPaths(config, probe()).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${sessionIdFor('probe', conversationId)}.jsonl`);
  fs.writeFileSync(file, '{"type":"session"}\n');
  return file;
}

test('/stop interrupts a busy session', async () => {
  const session = fakeSession({ busy: true });
  const { registry } = makeRegistry(session);
  try {
    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.abort(probe(), 'conv'), { status: 'stopped' });
    assert.equal(session.aborted, 1);
  } finally {
    registry.dispose();
  }
});

test('/stop on a silent or closed session is a clear answer, not a call to pi', async () => {
  const session = fakeSession();
  const { registry } = makeRegistry(session);
  try {
    assert.deepEqual(await registry.abort(probe(), 'conv'), { status: 'no-session' });

    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.abort(probe(), 'conv'), { status: 'idle' });
    assert.equal(session.aborted, 0, 'прерывать нечего — pi не дёргаем');
  } finally {
    registry.dispose();
  }
});

test('/stop says so if pi did not confirm the interruption', async () => {
  const session = fakeSession({ busy: true, abortConfirmed: false });
  const { registry } = makeRegistry(session);
  try {
    await registry.acquire(probe(), 'conv');
    const outcome = await registry.abort(probe(), 'conv');
    assert.equal(outcome.status, 'failed');
  } finally {
    registry.dispose();
  }
});

test('/stats brings up a dormant session: the conversation file is in place, the numbers are the same', async () => {
  const session = fakeSession();
  const { registry } = makeRegistry(session);
  try {
    const outcome = await registry.stats(probe(), 'conv');
    assert.equal(outcome.status, 'ok');
    assert.deepEqual(outcome.status === 'ok' ? outcome.stats : null, session.stats);
  } finally {
    registry.dispose();
  }
});

test('/stats reports a failure instead of staying silent', async () => {
  const session = fakeSession({ stats: null });
  const { registry } = makeRegistry(session);
  try {
    const outcome = await registry.stats(probe(), 'conv');
    assert.equal(outcome.status, 'failed');
  } finally {
    registry.dispose();
  }
});

test('/skills returns what pi collected', async () => {
  const session = fakeSession();
  const { registry } = makeRegistry(session);
  try {
    const outcome = await registry.commands(probe(), 'conv');
    assert.deepEqual(outcome, { status: 'ok', commands: session.commands });
  } finally {
    registry.dispose();
  }
});

test('/clear asks pi to start a new session instead of touching files itself', async () => {
  const config = makeConfig();
  const session = fakeSession();
  const { registry } = makeRegistry(session, config);
  const file = putSessionFile(config, 'conv');
  ensureChat(config, probe(), 'conv', 'telegram');

  try {
    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.clear(probe(), 'conv'), { status: 'started' });

    assert.equal(session.cleared, 1, 'контекст чистит pi: RPC new_session');
    assert.equal(session.disposed, 0, 'живой процесс не гасим — он только что начал заново');
    assert.equal(registry.get('probe', 'conv'), session, 'разговор остаётся живым');
    assert.equal(fs.existsSync(file), true, 'файл прошлой сессии остаётся на диске');
  } finally {
    registry.dispose();
  }
});

test('/clear of a dormant conversation moves it to a new pi session', async () => {
  const config = makeConfig();
  const { registry } = makeRegistry(fakeSession(), config);
  const file = putSessionFile(config, 'conv');
  ensureChat(config, probe(), 'conv', 'telegram');

  try {
    assert.deepEqual(await registry.clear(probe(), 'conv'), { status: 'started' });
    const chat = findChatRecord(config, probe(), 'conv');
    assert.equal(chat?.sessions?.length, 2, 'старая сессия осталась, новая добавилась');
    assert.equal(chat?.sessions?.[0]?.sessionId, sessionIdFor('probe', 'conv'), 'первая — исходная');
    assert.notEqual(chat?.sessions?.[1]?.sessionId, sessionIdFor('probe', 'conv'), 'вторая — новая');
    assert.equal(fs.existsSync(file), true, 'архив не перекладываем: файл остаётся историей');
  } finally {
    registry.dispose();
  }
});

test('/clear without a started conversation does not invent a new session', async () => {
  const { registry } = makeRegistry(fakeSession());
  try {
    assert.deepEqual(await registry.clear(probe(), 'conv'), { status: 'empty' });
  } finally {
    registry.dispose();
  }
});

test('/clear during a turn does not tear down the conversation: /stop first', async () => {
  const config = makeConfig();
  const session = fakeSession({ busy: true });
  const { registry } = makeRegistry(session, config);
  const file = putSessionFile(config, 'conv');
  ensureChat(config, probe(), 'conv', 'telegram');

  try {
    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.clear(probe(), 'conv'), { status: 'busy' });
    assert.equal(fs.existsSync(file), true, 'разговор на месте');
    assert.equal(session.cleared, 0, 'pi не дёргаем, пока идёт ход');
  } finally {
    registry.dispose();
  }
});

test('/clear does not touch other conversations in the same directory', async () => {
  const config = makeConfig();
  const { registry } = makeRegistry(fakeSession(), config);
  const mine = putSessionFile(config, 'conv');
  const other = putSessionFile(config, 'другой-разговор');
  ensureChat(config, probe(), 'conv', 'telegram');
  ensureChat(config, probe(), 'другой-разговор', 'telegram');

  try {
    assert.deepEqual(await registry.clear(probe(), 'conv'), { status: 'started' });
    assert.equal(fs.existsSync(other), true, 'чужой файл на месте');
    assert.equal(fs.existsSync(mine), true, 'и свой тоже: мы его не перекладываем');
    assert.equal(findChatRecord(config, probe(), 'conv')?.sessions?.length, 2, 'свой разговор переехал');
    assert.equal(findChatRecord(config, probe(), 'другой-разговор')?.sessions, undefined, 'чужой — нет');
  } finally {
    registry.dispose();
  }
});

test('/rename changes the conversation name in the registry and does not lose the new session', async () => {
  const config = makeConfig();
  const { registry } = makeRegistry(fakeSession(), config);
  ensureChat(config, probe(), 'conv', 'telegram');
  const before = findChatRecord(config, probe(), 'conv');
  assert.ok(before);

  try {
    assert.deepEqual(await registry.rename(probe(), 'conv', 'Налоги'), {
      status: 'renamed',
      title: 'Налоги',
    });
    assert.equal(findChatRecord(config, probe(), 'conv')?.title, 'Налоги');
  } finally {
    registry.dispose();
  }
});

test('/rename creates a conversation record if there was none', async () => {
  const config = makeConfig();
  const { registry } = makeRegistry(fakeSession(), config);
  try {
    assert.deepEqual(await registry.rename(probe(), 'telegram-42', '  Письмо из налоговой  '), {
      status: 'renamed',
      title: 'Письмо из налоговой',
    });
    const chat = findChatRecord(config, probe(), 'telegram-42');
    assert.equal(chat?.title, 'Письмо из налоговой');
    assert.equal(chat?.channel, 'telegram');
  } finally {
    registry.dispose();
  }
});

test('/rename without a name does not invent a title', async () => {
  const config = makeConfig();
  const { registry } = makeRegistry(fakeSession(), config);
  try {
    assert.deepEqual(await registry.rename(probe(), 'conv', '   '), { status: 'empty' });
    assert.equal(findChatRecord(config, probe(), 'conv'), null);
  } finally {
    registry.dispose();
  }
});
