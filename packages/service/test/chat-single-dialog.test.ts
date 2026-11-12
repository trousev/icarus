// Один разговор на Telegram и панель: транспорт — труба, разговор живёт у нас.
//
// Сессия pi у разговора одна, её ключ — (человек, conversationId), а не канал.
// Здесь проверяется, что панель пишет в ту же сессию, что и бот, не заводит
// вторую и не начинает второй ход, пока в разговоре отвечает Telegram.
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
 * Заглушка pi на разговор: помнит, сколько реплик ей прислали и из какого входа.
 * Ход висит, пока тест не отпустит (`autoRelease: false`), — так видно, что
 * второй вход не начинает второй ход.
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

/** Разговор, начатый в Telegram: запись в реестре и файл истории на диске. */
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

/** HTTP-сервер панели на случайном порту: маршруты и ход настоящие. */
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

/** Читает NDJSON-поток хода по строкам, пока сервер его не закроет. */
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

test('панель продолжает Telegram-разговор в той же сессии pi, а не в новой', async () => {
  const value = fixture();
  // Бот поднимает сессию разговора — ровно так, как это делает telegram/bot.ts.
  await value.registry.acquire(value.user, CONVERSATION);
  assert.equal(value.created.length, 1);

  await withServer(value, async (_base, send) => {
    const response = await send({ chatId: CONVERSATION, text: 'продолжи' });
    assert.equal(response.status, 200, 'в Telegram-разговор из панели теперь можно писать');
    const events = await lines(response);
    assert.equal(events.at(-1)?.type, 'done', 'ход доехал до конца');
  });

  // Одна сессия на разговор: панель взяла ту же, что бот, и не подняла вторую.
  assert.equal(value.created.length, 1, 'вторая сессия pi не завелась');
  assert.equal(value.created[0]?.conversationId, CONVERSATION);
  assert.deepEqual(value.created[0]?.prompts, ['продолжи'], 'реплика ушла в общий процесс');
  // Ход из панели подписан панелью: шапка скажет, кто говорил последним.
  assert.equal(lastTurnOf(value.config, value.user, CONVERSATION)?.channel, 'web');

  const history = readHistory(value.config, value.user, CONVERSATION);
  assert.equal(history?.chat.readOnly, false, 'разговор не только для чтения');
  assert.equal(history?.chat.lastTurn?.channel, 'web');
  assert.equal(history?.messages.length, 2, 'история та же, что была в Telegram');
  assert.match(history?.messages[0]?.text ?? '', /отчёт для мамы/);

  // Запись остаётся одна: канал разговора не переписывается на «веб».
  const [chat] = readChats(value.config, value.user);
  assert.equal(chat?.channel, 'telegram', 'разговор по-прежнему telegram-разговор');
  assert.equal(chat?.conversationId, CONVERSATION);
});

test('ход в Telegram: реплика из панели встаёт в очередь, а не начинает второй ход', async () => {
  const value = fixture();
  const session = (await value.registry.acquire(value.user, CONVERSATION)) as unknown as StubSession;
  // Ответ сейчас печатается в Telegram: сессия занята, а потока в панели нет.
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

    // «Стоп» снимает и очередь: иначе реплика доехала бы без спроса.
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

test('два окна панели: реплика второго встаёт в очередь и доезжает после первого хода', async () => {
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

    // Очередь досылается сама, без второго HTTP-запроса от панели.
    for (let i = 0; i < 100 && value.created[0]!.prompts.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(value.created[0]?.prompts, ['раз', 'два'], 'реплика из очереди доехала вторым ходом');
  });
});
