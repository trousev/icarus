// Команды человека поверх реестра сессий: /stop, /stats, /skills, /clear и /rename.
// Докера и модели тут нет: сессии — заглушки (см. RegistryDeps), а разговор
// для /clear — запись в chats.json и файл в каталоге сессий человека.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { findChatRecord, ensureChat } from '../src/sessions/chats.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

/** Сессия-заглушка: реестру от неё нужны занятость, прерывание и ответы на вопросы. */
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
    /** Подтверждает ли pi прерывание: сбойный abort — тоже жизнь. */
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

/** Файл разговора так, как его кладёт pi: `<когда создан>_<id>.jsonl`. */
function putSessionFile(config: IcarusConfig, conversationId: string): string {
  const dir = userPaths(config, probe()).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${sessionIdFor('probe', conversationId)}.jsonl`);
  fs.writeFileSync(file, '{"type":"session"}\n');
  return file;
}

test('/stop прерывает занятую сессию', async () => {
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

test('/stop по молчащей или закрытой сессии — внятный ответ, а не вызов pi', async () => {
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

test('/stop говорит, если pi не подтвердил прерывание', async () => {
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

test('/stats поднимает затихшую сессию: файл разговора на месте, цифры те же', async () => {
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

test('/stats рассказывает про сбой, а не молчит', async () => {
  const session = fakeSession({ stats: null });
  const { registry } = makeRegistry(session);
  try {
    const outcome = await registry.stats(probe(), 'conv');
    assert.equal(outcome.status, 'failed');
  } finally {
    registry.dispose();
  }
});

test('/skills отдаёт то, что собрал pi', async () => {
  const session = fakeSession();
  const { registry } = makeRegistry(session);
  try {
    const outcome = await registry.commands(probe(), 'conv');
    assert.deepEqual(outcome, { status: 'ok', commands: session.commands });
  } finally {
    registry.dispose();
  }
});

test('/clear просит pi начать новую сессию, а не трогает файлы сам', async () => {
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

test('/clear затихшего разговора переводит его на новую сессию pi', async () => {
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

test('/clear без начатого разговора не выдумывает новую сессию', async () => {
  const { registry } = makeRegistry(fakeSession());
  try {
    assert.deepEqual(await registry.clear(probe(), 'conv'), { status: 'empty' });
  } finally {
    registry.dispose();
  }
});

test('/clear во время хода не рвёт разговор: сначала /stop', async () => {
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

test('/clear не трогает чужие разговоры в том же каталоге', async () => {
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

test('/rename меняет имя разговора в реестре и не теряет новую сессию', async () => {
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

test('/rename заводит запись разговора, если её ещё не было', async () => {
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

test('/rename без имени не выдумывает название', async () => {
  const config = makeConfig();
  const { registry } = makeRegistry(fakeSession(), config);
  try {
    assert.deepEqual(await registry.rename(probe(), 'conv', '   '), { status: 'empty' });
    assert.equal(findChatRecord(config, probe(), 'conv'), null);
  } finally {
    registry.dispose();
  }
});
