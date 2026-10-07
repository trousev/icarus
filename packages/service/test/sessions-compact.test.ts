// Жизненный цикл сессий: час тишины — это «разговор закончен», значит сжимаем и
// закрываем; занятые сессии не трогаем. Докер и модель тут не нужны: и сессии, и
// поднятие контейнера — заглушки (см. RegistryDeps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { makeConfig, probe } from './fixtures.ts';

type CompactResult = { status: 'compacted'; tokensBefore: number; tokensAfter: number } | { status: 'nothing' };

/** Сессия-заглушка: реестру от неё нужны занятость, время и сжатие. */
function fakeSession(overrides: Partial<Record<string, unknown>> = {}) {
  const session = {
    key: 'probe:conv',
    user: { id: 'probe' },
    container: 'stub',
    generation: 0,
    busy: false,
    alive: true,
    lastUsed: Date.now(),
    turns: 0,
    compacting: null as Promise<void> | null,
    compactCalls: 0,
    disposed: 0,
    result: { status: 'compacted', tokensBefore: 1200, tokensAfter: 300 } as CompactResult,
    failure: null as Error | null,
    async compact(): Promise<CompactResult> {
      this.compactCalls += 1;
      if (this.failure) throw this.failure;
      return this.result;
    },
    dispose(): void {
      this.disposed += 1;
      this.alive = false;
    },
    onEvent: () => () => {},
    async prompt(): Promise<void> {},
    async abort(): Promise<void> {},
    async getMessages(): Promise<Array<Record<string, unknown>>> {
      return [];
    },
    async getStats(): Promise<Record<string, unknown> | null> {
      return null;
    },
  };
  return Object.assign(session, overrides);
}

function makeRegistry(session: ReturnType<typeof fakeSession>) {
  return new SessionRegistry(makeConfig(), {
    ensureContainer: async () => 'stub',
    // Заглушка вместо PiSession: тест про решения реестра, а не про RPC.
    createSession: () => session as never,
  });
}

/** Сессия, к которой не обращались дольше часа. */
function gone(session: ReturnType<typeof fakeSession>, minutes = 61): void {
  session.lastUsed = Date.now() - minutes * 60_000;
}

test('затихшую сессию сжимаем и закрываем, а не просто гасим', async () => {
  const session = fakeSession();
  const registry = makeRegistry(session);
  try {
    assert.equal(await registry.acquire(probe(), 'conv'), session as never);
    gone(session);

    assert.deepEqual(await registry.reapIdle(), ['probe:conv']);
    assert.equal(session.compactCalls, 1, 'итог разговора подведён');
    assert.equal(session.disposed, 1, 'процесс закрыт');
    assert.equal(registry.get('probe', 'conv'), undefined);
  } finally {
    registry.dispose();
  }
});

test('пока человек говорит, сжатия нет', async () => {
  const session = fakeSession({ busy: true });
  const registry = makeRegistry(session);
  try {
    await registry.acquire(probe(), 'conv');
    gone(session);

    assert.deepEqual(await registry.reapIdle(), [], 'занятую сессию уборка пропускает');
    assert.equal(session.compactCalls, 0);
    assert.equal(session.disposed, 0);
  } finally {
    registry.dispose();
  }
});

test('свежую сессию уборка не трогает', async () => {
  const session = fakeSession();
  const registry = makeRegistry(session);
  try {
    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.reapIdle(), []);
    assert.equal(session.compactCalls, 0);
  } finally {
    registry.dispose();
  }
});

test('сбой сжатия не оставляет затихшую сессию висеть', async () => {
  const session = fakeSession({ failure: new Error('модель не ответила за 600000 мс') });
  const registry = makeRegistry(session);
  try {
    await registry.acquire(probe(), 'conv');
    gone(session);

    assert.deepEqual(await registry.reapIdle(), ['probe:conv']);
    assert.equal(session.disposed, 1, 'история лежит в файле сессии — закрываем как есть');
  } finally {
    registry.dispose();
  }
});

test('/compact сжимает живую сессию и рассказывает, что вышло', async () => {
  const session = fakeSession();
  const registry = makeRegistry(session);
  try {
    await registry.acquire(probe(), 'conv');
    assert.deepEqual(await registry.compact(probe(), 'conv'), {
      status: 'compacted',
      tokensBefore: 1200,
      tokensAfter: 300,
    });
    assert.equal(session.compactCalls, 1);
    assert.equal(session.disposed, 0, 'человек тут же — сессию не гасим');
  } finally {
    registry.dispose();
  }
});

test('/compact по закрытому разговору и во время хода — внятные ответы', async () => {
  const session = fakeSession();
  const registry = makeRegistry(session);
  try {
    assert.deepEqual(await registry.compact(probe(), 'conv'), { status: 'no-session' });

    await registry.acquire(probe(), 'conv');
    session.busy = true;
    assert.deepEqual(await registry.compact(probe(), 'conv'), { status: 'busy' });
    assert.equal(session.compactCalls, 0, 'в занятую сессию не лезем');
  } finally {
    registry.dispose();
  }
});

test('/compact рассказывает про сбой, а не молчит', async () => {
  const session = fakeSession({ failure: new Error('pi отказался сжимать: нет ключа') });
  const registry = makeRegistry(session);
  try {
    await registry.acquire(probe(), 'conv');
    const outcome = await registry.compact(probe(), 'conv');
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.status === 'failed' ? outcome.error : '', /нет ключа/);
  } finally {
    registry.dispose();
  }
});

test('ход во время сжатия ждёт и получает уже новую сессию, а не ту, что гасят', async () => {
  const session = fakeSession();
  const fresh = fakeSession();
  let created = 0;
  let release: () => void = () => {};

  const registry = new SessionRegistry(makeConfig(), {
    ensureContainer: async () => 'stub',
    createSession: () => (created++ === 0 ? session : fresh) as never,
  });
  session.compact = async function (): Promise<CompactResult> {
    this.compactCalls += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return this.result;
  };

  try {
    await registry.acquire(probe(), 'conv');
    gone(session);

    const reaping = registry.reapIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(session.compactCalls, 1, 'уборка начала сжимать');

    let acquired: unknown = null;
    const pending = registry.acquire(probe(), 'conv').then((value) => {
      acquired = value;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(acquired, null, 'пока сессию сжимают и закрывают, ход не начинается');

    release();
    await reaping;
    assert.equal(session.disposed, 1);
    assert.equal(await pending, fresh as never, 'человек получает свежую сессию — по сжатой истории');
  } finally {
    registry.dispose();
  }
});
