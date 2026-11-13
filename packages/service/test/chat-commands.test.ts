// Web chat commands: same parsing as Telegram, but behind its own route.
// No docker or model here: the registry is a stub, while HTTP and conversation records are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { createChat } from '../src/control/chat.ts';
import { ensureChat } from '../src/sessions/chats.ts';
import type { SessionRegistry } from '../src/sessions/registry.ts';
import type { IcarusConfig, UserConfig } from '../src/config.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

type Call = { method: string; args: unknown[] };
type Stand = {
  base: string;
  headers: Record<string, string>;
  config: IcarusConfig;
  user: UserConfig;
  calls: Call[];
};

function makeRegistry() {
  const calls: Call[] = [];
  const registry = {
    commands: async (...args: unknown[]) => {
      calls.push({ method: 'commands', args });
      return { status: 'ok', commands: [{ name: 'skill:demo', description: 'демо', source: 'skill' }] };
    },
    compact: async (...args: unknown[]) => {
      calls.push({ method: 'compact', args });
      return { status: 'compacted', tokensBefore: 120, tokensAfter: 45 };
    },
    stats: async (...args: unknown[]) => {
      calls.push({ method: 'stats', args });
      return { status: 'ok', stats: { userMessages: 2, tokens: { total: 150 } } };
    },
    clear: async (...args: unknown[]) => {
      calls.push({ method: 'clear', args });
      return { status: 'started' };
    },
    rename: async (...args: unknown[]) => {
      calls.push({ method: 'rename', args });
      const name = String(args[2] ?? '');
      return name.trim() ? { status: 'renamed', title: name.trim() } : { status: 'empty' };
    },
    abort: async (...args: unknown[]) => {
      calls.push({ method: 'abort', args });
      return { status: 'idle' };
    },
    busyConversations: () => [],
    list: () => [],
  };
  return { registry: registry as unknown as SessionRegistry, calls };
}

async function withServer<T>(run: (stand: Stand) => Promise<T>): Promise<T> {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, calls } = makeRegistry();
  const server = createServer(config, registry);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };
  try {
    return await run({ base: `http://127.0.0.1:${port}`, headers, config, user, calls });
  } finally {
    server.close();
  }
}

async function command(
  stand: Pick<Stand, 'base' | 'headers'>,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${stand.base}/panel/api/chat/command`, {
    method: 'POST',
    headers: stand.headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

test('/compact, /stats and /skills reply with text, not a model turn', async () => {
  await withServer(async (stand) => {
    const chat = createChat(stand.config, stand.user, 'talk');

    const compact = await command(stand, { chatId: chat.id, text: '/compact сохрани про математику' });
    assert.equal(compact.status, 200);
    assert.equal(compact.data.handled, true);
    assert.match(String(compact.data.text), /Подвёл итог: 120 → 45/);
    assert.deepEqual(stand.calls.find((call) => call.method === 'compact')?.args, [
      stand.user,
      chat.id,
      'сохрани про математику',
    ]);

    const stats = await command(stand, { chatId: chat.id, text: '/stats' });
    assert.equal(stats.data.handled, true);
    assert.match(String(stats.data.text), /Токенов всего: 150/);

    const skills = await command(stand, { chatId: chat.id, text: '/skills' });
    assert.equal(skills.data.handled, true);
    assert.match(String(skills.data.text), /\/skill:demo — демо/);
  });
});

test('/clear keeps the old feed and asks to draw a divider', async () => {
  await withServer(async (stand) => {
    const chat = createChat(stand.config, stand.user, 'talk');
    const cleared = await command(stand, { chatId: chat.id, text: '/clear' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.handled, true);
    assert.equal(cleared.data.cleared, true, 'клиент рисует границу контекста');
    assert.equal('reload' in cleared.data, false, 'ленту не перечитываем');
    assert.match(String(cleared.data.text), /с чистого листа/);
  });
});

test('/help replies even without a conversation — before the first message', async () => {
  await withServer(async (stand) => {
    const help = await command(stand, { text: '/help' });
    assert.equal(help.status, 200);
    assert.equal(help.data.handled, true);
    assert.match(String(help.data.text), /\/compact/);
    assert.match(String(help.data.text), /\/skills/);
  });
});

test('we do not intercept pi commands: they go into the conversation as a regular message', async () => {
  await withServer(async (stand) => {
    const chat = createChat(stand.config, stand.user, 'talk');

    for (const text of ['/skill:demo покажи', '/fix-tests прогони', '/etc/hosts']) {
      const result = await command(stand, { chatId: chat.id, text });
      assert.equal(result.data.handled, false, `${text} — реплика для pi, а не команда чата`);
    }

    // An unknown command without arguments is a typo, not a reason to call the model.
    const unknown = await command(stand, { chatId: chat.id, text: '/foo' });
    assert.equal(unknown.data.handled, true);
    assert.match(String(unknown.data.text), /Такой команды не знаю/);
  });
});

test('/rename changes the current conversation name and returns it to the client', async () => {
  await withServer(async (stand) => {
    const chat = createChat(stand.config, stand.user, 'talk');
    const renamed = await command(stand, { chatId: chat.id, text: '/rename Налоги' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.handled, true);
    assert.equal(renamed.data.title, 'Налоги');
    assert.match(String(renamed.data.text), /называется «Налоги»/);
    assert.deepEqual(stand.calls.find((call) => call.method === 'rename')?.args, [
      stand.user,
      chat.id,
      'Налоги',
    ]);
  });
});

test('removed /topic and /topics do not go to pi as a message', async () => {
  await withServer(async (stand) => {
    const chat = createChat(stand.config, stand.user, 'talk');
    const topic = await command(stand, { chatId: chat.id, text: '/topic работа' });
    assert.equal(topic.data.handled, true);
    assert.match(String(topic.data.text), /больше нет/);
  });
});

test('the pi command list is served for web chat and Telegram, but is empty for an API conversation', async () => {
  await withServer(async (stand) => {
    const chat = createChat(stand.config, stand.user, 'talk');
    ensureChat(stand.config, stand.user, 'telegram-4242', 'telegram');
    ensureChat(stand.config, stand.user, 'api-4242', 'api');

    const own = await fetch(`${stand.base}/panel/api/chat/commands?id=${encodeURIComponent(chat.id)}`, {
      headers: stand.headers,
    });
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()) as unknown, {
      commands: [{ name: 'skill:demo', description: 'демо', source: 'skill' }],
    });

    // The panel manages a Telegram conversation the same as its own: it has the same commands.
    const telegram = await fetch(`${stand.base}/panel/api/chat/commands?id=telegram-4242`, {
      headers: stand.headers,
    });
    assert.equal(telegram.status, 200);
    assert.deepEqual((await telegram.json()) as unknown, {
      commands: [{ name: 'skill:demo', description: 'демо', source: 'skill' }],
    });

    const foreign = await fetch(`${stand.base}/panel/api/chat/commands?id=api-4242`, { headers: stand.headers });
    assert.equal(foreign.status, 200);
    assert.deepEqual((await foreign.json()) as unknown, { commands: [] });
  });
});

test('a command from the panel edits a Telegram conversation: it is the same dialog', async () => {
  await withServer(async (stand) => {
    ensureChat(stand.config, stand.user, 'telegram-4242', 'telegram');
    const result = await command(stand, { chatId: 'telegram-4242', text: '/stats' });
    assert.equal(result.status, 200);
    assert.equal(result.data.handled, true);
    // The command goes into the same conversation the bot sees, not into a copy.
    assert.deepEqual(stand.calls.find((call) => call.method === 'stats')?.args, [stand.user, 'telegram-4242']);
  });
});

test('a command from the panel is not written to an API conversation: there the client owns the history', async () => {
  await withServer(async (stand) => {
    ensureChat(stand.config, stand.user, 'api-4242', 'api');
    const result = await command(stand, { chatId: 'api-4242', text: '/stats' });
    assert.equal(result.status, 403);
  });
});
