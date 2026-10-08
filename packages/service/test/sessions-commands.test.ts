// Команды человека поверх реестра сессий: /stop, /stats, /skills и /new.
// Докера и модели тут нет: сессии — заглушки (см. RegistryDeps), а разговор
// для /new — обычный файл в каталоге сессий человека.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
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

test('/new убирает файл разговора в архив и гасит процесс', async () => {
  const config = makeConfig();
  const session = fakeSession();
  const { registry } = makeRegistry(session, config);
  const file = putSessionFile(config, 'conv');

  try {
    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.reset(probe(), 'conv'), { status: 'started' });

    assert.equal(fs.existsSync(file), false, 'pi больше не найдёт этот разговор');
    assert.deepEqual(fs.readdirSync(path.join(path.dirname(file), 'archive')), [path.basename(file)]);
    assert.equal(session.disposed, 1, 'процесс, державший разговор в памяти, закрыт');
    assert.equal(registry.get('probe', 'conv'), undefined);
  } finally {
    registry.dispose();
  }
});

test('/new без начатого разговора не выдумывает архив', async () => {
  const { registry } = makeRegistry(fakeSession());
  try {
    assert.deepEqual(await registry.reset(probe(), 'conv'), { status: 'empty' });
  } finally {
    registry.dispose();
  }
});

test('/new во время хода не рвёт разговор: сначала /stop', async () => {
  const config = makeConfig();
  const session = fakeSession({ busy: true });
  const { registry } = makeRegistry(session, config);
  const file = putSessionFile(config, 'conv');

  try {
    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.reset(probe(), 'conv'), { status: 'busy' });
    assert.equal(fs.existsSync(file), true, 'разговор на месте');
    assert.equal(session.disposed, 0);
  } finally {
    registry.dispose();
  }
});

test('/new не трогает чужие разговоры в том же каталоге', async () => {
  const config = makeConfig();
  const { registry } = makeRegistry(fakeSession(), config);
  const mine = putSessionFile(config, 'conv');
  const other = putSessionFile(config, 'другой-разговор');

  try {
    assert.deepEqual(await registry.reset(probe(), 'conv'), { status: 'started' });
    assert.equal(fs.existsSync(other), true);
    assert.equal(fs.existsSync(mine), false);
  } finally {
    registry.dispose();
  }
});
