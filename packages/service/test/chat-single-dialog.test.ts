// One conversation for Telegram and the panel: the transport is a pipe, the conversation lives with us.
//
// A conversation has a single pi session, its key is (human, conversationId), not the channel.
// Here we check that the panel writes to the same session as the bot, does not create
// a second one and does not start a second turn while Telegram is answering in the conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths } from '../src/config.ts';
import { SessionRegistry, type SessionFactory } from '../src/sessions/registry.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { ensureChat, lastTurnOf, readChats, recordTurn } from '../src/sessions/chats.ts';
import { readHistory } from '../src/control/chat.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

type Listener = (event: Record<string, unknown>) => void;

/**
 * pi stub per conversation: it remembers how many replies were sent to it and from which entry point.
 * A turn hangs until the test releases it (`autoRelease: false`) — this way one can see that
 * a second entry point does not start a second turn.
 */
class StubSession {
  alive = true;
  busy = false;
  lastUsed = Date.now();
  generation = 0;
  workspace = 'talk';
  artifact: { slug: string } | undefined = undefined;
  readonly prompts: string[] = [];
  readonly conversationId: string;
  readonly release: () => void;
  private readonly gate: Promise<void>;
  private readonly autoRelease: boolean;
  private listeners = new Set<Listener>();

  constructor(conversationId: string, autoRelease: boolean) {
    this.conversationId = conversationId;
    this.autoRelease = autoRelease;
    let open: () => void = () => {};
    this.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.release = open;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.busy = true;
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: `ответ ${this.prompts.length}` },
    });
    if (!this.autoRelease) await this.gate;
    this.busy = false;
    this.lastUsed = Date.now();
    this.emit({ type: 'agent_settled' });
  }

  async abort(): Promise<boolean> {
    this.busy = false;
    this.emit({ type: 'agent_settled' });
    return true;
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const CONVERSATION = 'telegram-4242';

/** A conversation started in Telegram: an entry in the registry and a history file on disk. */
function fixture(options: { autoRelease?: boolean } = {}) {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = sessionIdFor(user.id, CONVERSATION);
  fs.writeFileSync(
    path.join(dir, `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: 'session', timestamp: '2026-11-01T10:00:00.000Z' },
      {
        type: 'message',
        timestamp: '2026-11-01T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Собери отчёт для мамы' }] },
      },
      {
        type: 'message',
        timestamp: '2026-11-01T10:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Готово: отчёт в incoming/otchet.md' }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  ensureChat(config, user, CONVERSATION, 'telegram');

  const created: StubSession[] = [];
  const createSession: SessionFactory = (_config, _user, conversationId) => {
    const session = new StubSession(conversationId, options.autoRelease ?? true);
    created.push(session);
    return session as never;
  };
  const registry = new SessionRegistry(config, {
    createSession,
    ensureContainer: async () => 'stub-container',
  });
  return { config, user, registry, created };
}

/** The panel's HTTP server on a random port: the routes and the turn are real. */
async function withServer<T>(
  fixtureValue: ReturnType<typeof fixture>,
  run: (base: string, send: (body: unknown) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const server = createServer(fixtureValue.config, fixtureValue.registry);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };
  const send = (body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/panel/api/chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  try {
    return await run(`http://127.0.0.1:${port}`, send);
  } finally {
    fixtureValue.registry.dispose();
    server.close();
  }
}

/** Reads the NDJSON stream of a turn line by line until the server closes it. */
async function lines(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const out: Array<Record<string, unknown>> = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) out.push(JSON.parse(line) as Record<string, unknown>);
      cut = buffer.indexOf('\n');
    }
  }
  return out;
}

test('the panel continues a Telegram conversation in the same pi session, not a new one', async () => {
  const value = fixture();
  // The bot lifts the conversation's session — exactly as telegram/bot.ts does.
  await value.registry.acquire(value.user, CONVERSATION);
  assert.equal(value.created.length, 1);

  await withServer(value, async (_base, send) => {
    const response = await send({ chatId: CONVERSATION, text: 'продолжи' });
    assert.equal(response.status, 200, 'в Telegram-разговор из панели теперь можно писать');
    const events = await lines(response);
    assert.equal(events.at(-1)?.type, 'done', 'ход доехал до конца');
  });

  // One session per conversation: the panel took the same one as the bot and did not lift a second.
  assert.equal(value.created.length, 1, 'вторая сессия pi не завелась');
  assert.equal(value.created[0]?.conversationId, CONVERSATION);
  assert.deepEqual(value.created[0]?.prompts, ['продолжи'], 'реплика ушла в общий процесс');
  // A turn from the panel is signed by the panel: the header will say who spoke last.
  assert.equal(lastTurnOf(value.config, value.user, CONVERSATION)?.channel, 'web');

  const history = readHistory(value.config, value.user, CONVERSATION);
  assert.equal(history?.chat.readOnly, false, 'разговор не только для чтения');
  assert.equal(history?.chat.lastTurn?.channel, 'web');
  assert.equal(history?.messages.length, 2, 'история та же, что была в Telegram');
  assert.match(history?.messages[0]?.text ?? '', /отчёт для мамы/);

  // The record remains single: the conversation's channel is not rewritten to "web".
  const [chat] = readChats(value.config, value.user);
  assert.equal(chat?.channel, 'telegram', 'разговор по-прежнему telegram-разговор');
  assert.equal(chat?.conversationId, CONVERSATION);
});

test('a turn in Telegram: a reply from the panel is queued instead of starting a second turn', async () => {
  const value = fixture();
  const session = (await value.registry.acquire(value.user, CONVERSATION)) as unknown as StubSession;
  // The answer is being typed in Telegram right now: the session is busy, and there is no stream in the panel.
  session.busy = true;
  recordTurn(value.config, value.user, CONVERSATION, 'telegram');

  await withServer(value, async (base, send) => {
    const response = await send({ chatId: CONVERSATION, text: 'и ещё' });
    assert.equal(response.status, 202, 'реплика принята в очередь, а не отбита');
    const body = (await response.json()) as { queued?: boolean; position?: number; live?: boolean };
    assert.equal(body.queued, true);
    assert.equal(body.position, 1);
    assert.equal(body.live, false, 'прицепиться к чужому потоку некуда');
    assert.deepEqual(session.prompts, [], 'реплика из панели не ушла вторым ходом');

    // "Stop" removes the queue too: otherwise the reply would arrive unasked.
    const stopped = await fetch(`${base}/panel/api/chat/abort`, {
      method: 'POST',
      headers: { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: CONVERSATION }),
    });
    const cleared = (await stopped.json()) as { ok?: boolean; dropped?: number };
    assert.equal(cleared.ok, true);
    assert.equal(cleared.dropped, 1, 'очередь снята вместе с ходом');
  });

  assert.deepEqual(session.prompts, [], 'второго хода в pi не было');
});

test('two panel windows: the second reply is queued and arrives after the first turn', async () => {
  const value = fixture({ autoRelease: false });

  await withServer(value, async (_base, send) => {
    const first = await send({ chatId: CONVERSATION, text: 'раз' });
    assert.equal(first.status, 200);

    const second = await send({ chatId: CONVERSATION, text: 'два' });
    assert.equal(second.status, 202, 'второй ход поверх первого не начинается');
    const body = (await second.json()) as { queued?: boolean; position?: number; live?: boolean };
    assert.equal(body.queued, true);
    assert.equal(body.position, 1);
    assert.equal(body.live, true, 'ход наш, к нему можно прицепиться в панели');
    assert.deepEqual(value.created[0]?.prompts, ['раз'], 'второй реплики в pi пока не было');

    value.created[0]?.release();
    const events = await lines(first);
    assert.equal(events.at(-1)?.type, 'done');

    // The queue is flushed on its own, without a second HTTP request from the panel.
    for (let i = 0; i < 100 && value.created[0]!.prompts.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(value.created[0]?.prompts, ['раз', 'два'], 'реплика из очереди доехала вторым ходом');
  });
});
