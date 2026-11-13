// A turn that survived a panel reload: F5 in the middle of a reply, catch-up on return.
//
// The live pi process is replaced by a stub here, but the routes, hub and HTTP are real.
// We check the main promise: a closed tab doesn't interrupt the turn, and the returning
// panel receives the same reasoning and steps it would have seen without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { SessionRegistry, type SessionFactory } from '../src/sessions/registry.ts';
import { createChat } from '../src/control/chat.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

type Listener = (event: Record<string, unknown>) => void;

/** pi stub: emits turn events when `prompt` asks for them, and listens for `abort`. */
class StubSession {
  busy = false;
  lastUsed = Date.now();
  aborted = false;
  private listeners = new Set<Listener>();
  private resolveSettled: (() => void) | null = null;
  /** The resolve by which the test releases the turn: imitates the end of pi's reply. */
  finish: () => void = () => {};
  readonly done = new Promise<void>((resolve) => {
    this.finish = resolve;
  });
  /** What exactly pi "thought": the test sets this before the turn. */
  script: Array<Record<string, unknown>> = [];

  readonly conversationId: string;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  alive = true;

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(): Promise<void> {
    this.busy = true;
    for (const event of this.script) {
      this.emit(event);
      // Give the HTTP layer time to reach the socket before moving on.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The turn hangs until the test releases it: that way we definitely catch it alive.
    await this.release;
    this.busy = false;
    this.emit({ type: 'agent_settled' });
    this.resolveSettled?.();
  }

  /** The test releases the turn once everything needed has been checked. */
  letGo: () => void = () => {};
  private readonly release = new Promise<void>((resolve) => {
    this.letGo = resolve;
  });

  async abort(): Promise<boolean> {
    this.aborted = true;
    this.busy = false;
    this.emit({ type: 'agent_settled' });
    this.finish();
    return true;
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  // We set the turn scenario in advance: the registry creates the stub inside `acquire`,
  // and by the time it's called it must already know what to "think".
  const script: Array<Record<string, unknown>> = [];
  const created: StubSession[] = [];
  const createSession: SessionFactory = (_config, _user, conversationId) => {
    const session = new StubSession(conversationId);
    session.script = script;
    created.push(session);
    return session as never;
  };
  const registry = new SessionRegistry(config, {
    createSession,
    ensureContainer: async () => 'stub-container',
  });
  return { config, user, chat, script, created, registry };
}

/** Reads an NDJSON stream line by line until the server closes it. */
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

test('F5 in the middle of a turn does not interrupt the reply, and the panel catches it up in full', async () => {
  const { config, chat, script, created, registry } = fixture();
  const server = createServer(config, registry);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };

  try {
    // The turn is deliberately long: we manage to "close the tab" halfway through.
    script.push(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Считаю ' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false, result: { content: 'ok' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'готово.' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' Финал.' } },
    );

    // The panel sends a message but immediately cuts off reading — that is F5.
    const sending = fetch(`${base}/panel/api/chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: chat.id, text: 'посчитай' }),
    });
    const first = await sending;
    assert.equal(first.status, 200);
    // Read a couple of lines and drop the stream: the connection closes.
    const reader = first.body!.getReader();
    await reader.read();
    await reader.cancel();

    // Key check: the turn is not interrupted — abort never went out.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(created[0]?.aborted, false, 'уход клиента не должен прерывать ход');

    // The panel opens again: history says the turn is alive.
    const history = (await (await fetch(`${base}/panel/api/chat/history?id=${chat.id}`, { headers })).json()) as {
      live?: boolean;
    };
    assert.equal(history.live, true, 'история сообщает о живом ходе');

    // And the panel attaches to the stream. We release the turn once catch-up is already subscribed:
    // this checks both what was accumulated and that the stream keeps going.
    const streamed = fetch(`${base}/panel/api/chat/stream?id=${chat.id}`, { headers });
    // Let the server emit the greeting and replay, then finish the turn.
    await new Promise((resolve) => setTimeout(resolve, 60));
    created[0]?.letGo();

    const resumed = await lines(await streamed);
    const types = resumed.map((event) => event.type);
    assert.equal(resumed[0].type, 'live', 'первым идёт подтверждение догона');
    assert.ok(types.includes('text'), 'размышления доехали');
    assert.ok(types.includes('done'), 'поток закрылся на конце хода');
    assert.ok(types.includes('step'), 'трассировка хода сохранилась');
    const text = resumed
      .filter((event) => event.type === 'text')
      .map((event) => String(event.text))
      .join('');
    assert.equal(text, 'Считаю готово. Финал.', 'догон вернул весь ответ, а не хвост');

    // The result is recorded: the panel will find it in history, even if nobody returned.
    // pi itself writes the turn text into the session file — the stub has no file, but in the
    // `done` turn reply it carries the accumulated text and steps.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const done = resumed.find((event) => event.type === 'done');
    assert.equal((done?.steps as unknown[])?.length, 1, 'итог закрытия несёт трассировку хода');
    const after = (await (await fetch(`${base}/panel/api/chat/history?id=${chat.id}`, { headers })).json()) as {
      live?: boolean;
      chat?: { title?: string };
    };
    assert.equal(after.live, false, 'завершённый ход больше не живой');
    assert.notEqual(after.chat?.title, 'Новый чат', 'ход закрыл разговор заголовком');
  } finally {
    server.close();
  }
});

test('when there is no turn, the stream says so honestly', async () => {
  const { config, chat, registry } = fixture();
  const server = createServer(config, registry);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };

  try {
    const response = await fetch(`${base}/panel/api/chat/stream?id=${chat.id}`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { live: false });
  } finally {
    server.close();
  }
});
