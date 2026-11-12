// Очередь реплик и «прервать и отправить»: две разные операции вместо молчаливого
// ожидания.
//
// Проверяем по-настоящему: HTTP-сервер панели, реестр с заглушкой pi и NDJSON-поток
// читаем так же, как это делает браузер. Заглушка держит ход, пока тест не отпустит
// его, — только так можно застать «человек написал, пока Икар думал».
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { SessionRegistry, type SessionFactory } from '../src/sessions/registry.ts';
import { createChat } from '../src/control/chat.ts';
import { watchAll } from '../src/control/chat-live.ts';
import {
  QUEUE_LIMIT,
  clearQueue,
  dropQueued,
  enqueue,
  queueLabel,
  queueView,
  queued,
  takeNext,
} from '../src/control/chat-queue.ts';
import type { UploadedAttachments } from '../src/control/chat.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

type Listener = (event: Record<string, unknown>) => void;

/** Пустые вложения: очередь должна работать и без файлов. */
function noFiles(text = ''): UploadedAttachments {
  return { files: [], images: [], names: [], paths: [], ...(text ? {} : {}) };
}

/**
 * Заглушка pi: каждый ход висит, пока тест его не отпустит, и объявляет конец
 * (`agent_settled`) только после этого — как настоящий pi, который дописывает ответ.
 */
class StubSession {
  busy = false;
  alive = true;
  aborted = false;
  interrupted = false;
  /** Что реально уехало в pi: по этому видно порядок реплик. */
  prompts: string[] = [];
  private listeners = new Set<Listener>();
  private releases: Array<() => void> = [];
  readonly conversationId: string;
  /** Поколение и папка: реестр переиспользует сессию, только если они совпали. */
  readonly generation: number;
  readonly workspace: string;

  constructor(conversationId: string, generation: number, workspace: string) {
    this.conversationId = conversationId;
    this.generation = generation;
    this.workspace = workspace;
  }

  get compacting(): null {
    return null;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.busy = true;
    this.prompts.push(text);
    // Ответ начинается сразу: тест увидит, что частичный текст доехал до панели.
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `думаю ${this.prompts.length}` } });
    await new Promise<void>((resolve) => this.releases.push(resolve));
    this.busy = false;
    this.emit({ type: 'agent_settled' });
  }

  /** Отпускает текущий ход: он дописывает ответ и встаёт. */
  release(): void {
    this.releases.shift()?.();
  }

  private stop(flag: 'aborted' | 'interrupted'): Promise<boolean> {
    this[flag] = true;
    this.busy = false;
    this.emit({ type: 'agent_settled' });
    this.releases.shift()?.();
    return Promise.resolve(true);
  }

  abort(): Promise<boolean> {
    return this.stop('aborted');
  }

  interrupt(): Promise<boolean> {
    return this.stop('interrupted');
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  const created: StubSession[] = [];
  const createSession: SessionFactory = (_config, _user, conversationId, _model, _container, generation, workspace) => {
    const session = new StubSession(conversationId, generation, workspace);
    created.push(session);
    return session as never;
  };
  const registry = new SessionRegistry(config, {
    createSession,
    ensureContainer: async () => 'stub-container',
  });
  return { config, user, chat, created, registry };
}

/** Читает NDJSON-поток по строкам, пока сервер его не закроет. */
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

/** Ждём события из мира заглушки: без таймаута тест мог бы висеть вечно. */
async function until(check: () => boolean, what = 'события', ms = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Panel = {
  base: string;
  headers: Record<string, string>;
  send: (body: Record<string, unknown>) => Promise<Response>;
  history: () => Promise<{ queue?: Array<{ id: string; text: string }>; messages?: unknown[] }>;
  command: (text: string) => Promise<{ text?: string }>;
  close: () => Promise<void>;
};

function openPanel(config: ReturnType<typeof makeConfig>, registry: SessionRegistry, chatId: string): Panel {
  const server = createServer(config, registry);
  let base = '';
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };
  const ready = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  return {
    get base() {
      return base;
    },
    headers,
    async send(body) {
      await ready;
      return fetch(`${base}/panel/api/chat/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chatId, ...body }),
      });
    },
    async history() {
      await ready;
      const response = await fetch(`${base}/panel/api/chat/history?id=${chatId}`, { headers });
      return (await response.json()) as { queue?: Array<{ id: string; text: string }> };
    },
    async command(text) {
      await ready;
      const response = await fetch(`${base}/panel/api/chat/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chatId, text }),
      });
      return (await response.json()) as { text?: string };
    },
    async close() {
      await ready;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ── сама очередь: порядок, лимит, снятие ──────────────────────────────────── */

test('подпись реплики: текст, имена файлов или «вложение»', () => {
  assert.equal(queueLabel('  посчитай курс  ', []), 'посчитай курс');
  assert.equal(queueLabel('', ['смета.pdf']), 'смета.pdf');
  assert.equal(queueLabel('', ['a.png', 'b.png']), 'a.png, b.png');
  assert.equal(queueLabel('', []), 'вложение');
  const long = queueLabel('я'.repeat(400), []);
  assert.equal(long.length, 120, 'длинная реплика обрезается в индикаторе');
  assert.ok(long.endsWith('…'));
});

test('очередь — это FIFO на разговор, и её видно без вложений', () => {
  const user = 'u1';
  const chat = 'c1';
  clearQueue(user, chat);
  assert.equal(enqueue(user, chat, { text: 'первое', attachments: noFiles() })?.position, 1);
  assert.equal(enqueue(user, chat, { text: 'второе', attachments: noFiles() })?.position, 2);
  // Обгон: «сейчас» ставит реплику перед уже стоящими.
  assert.equal(enqueue(user, chat, { text: 'срочно', attachments: noFiles() }, true)?.position, 1);
  assert.deepEqual(
    queued(user, chat).map((item) => item.text),
    ['срочно', 'первое', 'второе'],
  );
  assert.deepEqual(queueView(user, chat).map((item) => item.text), ['срочно', 'первое', 'второе']);
  assert.equal('attachments' in (queueView(user, chat)[0] ?? {}), false, 'вложения не уезжают в браузер');
  assert.equal(takeNext(user, chat)?.text, 'срочно');
  assert.equal(queued(user, chat).length, 2);
  clearQueue(user, chat);
  assert.deepEqual(queued(user, chat), []);
});

test('очередь не растёт бесконечно и умеет снимать одну реплику', () => {
  const user = 'u2';
  const chat = 'c2';
  clearQueue(user, chat);
  for (let index = 0; index < QUEUE_LIMIT; index += 1) {
    assert.ok(enqueue(user, chat, { text: `р${index}`, attachments: noFiles() }), 'место ещё есть');
  }
  assert.equal(enqueue(user, chat, { text: 'лишняя', attachments: noFiles() }), null, 'шестая не влезает');
  const victim = queued(user, chat)[1];
  assert.ok(victim);
  assert.equal(dropQueued(user, chat, victim.id), true);
  assert.equal(dropQueued(user, chat, victim.id), false, 'повторно снимать нечего');
  assert.deepEqual(
    queued(user, chat).map((item) => item.text),
    ['р0', 'р2', 'р3', 'р4'],
  );
  clearQueue(user, chat);
});

/* ── «в очередь»: ход не прерывается, реплика доезжает сама ────────────────── */

test('реплика во время хода встаёт в очередь и стартует сама после него', async () => {
  const { config, chat, created, registry } = fixture();
  const panel = openPanel(config, registry, chat.id);
  const stub = () => created.at(-1)!;
  const bulletin: Array<{ type?: string; chatId?: string; queue?: unknown[] }> = [];
  const off = watchAll((event) => bulletin.push(event));
  try {
    // Ход идёт и висит: панель читает поток, но не закрывает его.
    const first = await panel.send({ text: 'первое' });
    assert.equal(first.status, 200);
    const firstEvents = lines(first);
    await until(() => stub().prompts.length === 1, 'первый ход начался');

    // Вторая реплика не отбивается и не ждёт молча: сервер отвечает, что она в очереди.
    const second = await panel.send({ text: 'второе' });
    assert.equal(second.status, 202);
    const accepted = (await second.json()) as { queued?: boolean; position?: number; queue?: Array<{ text: string }> };
    assert.equal(accepted.queued, true);
    assert.equal(accepted.position, 1);
    assert.deepEqual(accepted.queue?.map((item) => item.text), ['второе']);

    // Панель узнала об очереди сводкой, а не догадкой.
    assert.ok(
      bulletin.some((event) => event.type === 'queue' && event.chatId === chat.id && event.queue?.length === 1),
      'сводка сообщила об очереди',
    );

    // F5: история отдаёт очередь вместе с сообщениями — реплика не потерялась.
    assert.deepEqual((await panel.history()).queue?.map((item) => item.text), ['второе']);

    // Первый ход встал — очередь берёт следующую реплику сама.
    stub().release();
    const finished = await firstEvents;
    assert.equal(finished.at(-1)?.type, 'done', 'первый ответ дошёл целиком');
    await until(() => stub().prompts.length === 2, 'очередь начала второй ход');
    assert.deepEqual(stub().prompts, ['первое', 'второе'], 'порядок реплик сохранён');

    // Ход из очереди живёт без HTTP-запроса: панель цепляется к нему потоком.
    const stream = await fetch(`${panel.base}/panel/api/chat/stream?id=${chat.id}`, { headers: panel.headers });
    assert.equal(stream.status, 200);
    const streamed = lines(stream);
    await until(() => stub().busy, 'второй ход идёт');
    stub().release();
    const events = await streamed;
    assert.deepEqual(
      events.slice(0, 3).map((event) => event.type),
      ['live', 'user', 'text'],
      'панель сначала догоняет, потом объявляет реплику и ответ',
    );
    assert.equal(events[1]?.text, 'второе');
    assert.equal((await panel.history()).queue?.length, 0, 'очередь опустела');
  } finally {
    off();
    await panel.close();
    for (const session of created) session.dispose();
  }
});

/* ── «сейчас»: прерывание и частичный ответ ───────────────────────────────── */

test('«сейчас» прерывает ход, сохраняет частичный ответ и отправляет новую реплику', async () => {
  const { config, chat, created, registry } = fixture();
  const panel = openPanel(config, registry, chat.id);
  const stub = () => created.at(-1)!;
  try {
    const first = await panel.send({ text: 'первое' });
    assert.equal(first.status, 200);
    const firstEvents = lines(first);
    await until(() => stub().prompts.length === 1, 'первый ход начался');

    const now = await panel.send({ text: 'второе', mode: 'now' });
    assert.equal(now.status, 200, 'новый ход пошёл сразу, без 409');
    const nextEvents = lines(now);
    await until(() => stub().interrupted, 'прежний ход прерван');

    // Частичный ответ не выбрасывается: то, что pi успел сказать, доехало до
    // панели, а ход закрылся `done`, а не ошибкой.
    const finished = await firstEvents;
    assert.ok(finished.some((event) => event.type === 'text' && event.text === 'думаю 1'), 'частичный текст отдан');
    assert.equal(finished.at(-1)?.type, 'done');

    await until(() => stub().prompts.length === 2, 'новый ход начался');
    assert.deepEqual(stub().prompts, ['первое', 'второе']);
    stub().release();
    const events = await nextEvents;
    assert.equal(events.at(-1)?.type, 'done');
    assert.deepEqual((await panel.history()).queue, [], 'в очередь ничего не попало');
  } finally {
    await panel.close();
    for (const session of created) session.dispose();
  }
});

test('«сейчас» не пускает очередь вперёд себя: два хода не идут одновременно', async () => {
  // Гонка из жизни: человек поставил реплику в очередь, потом нажал «прервать и
  // отправить». Очередь не должна стартовать в зазоре между прерыванием и новым
  // ходом — иначе ответы перемешаются в одну плашку.
  const { config, chat, created, registry } = fixture();
  const panel = openPanel(config, registry, chat.id);
  const stub = () => created.at(-1)!;
  try {
    const first = await panel.send({ text: 'первое' });
    const firstEvents = lines(first);
    await until(() => stub().prompts.length === 1, 'первый ход начался');
    await panel.send({ text: 'из очереди' });

    const now = await panel.send({ text: 'сейчас', mode: 'now' });
    assert.equal(now.status, 200);
    const nextEvents = lines(now);
    await until(() => stub().interrupted, 'ход прерван');
    await until(() => stub().prompts.length === 2, 'новый ход начался');
    assert.deepEqual(stub().prompts, ['первое', 'сейчас'], 'очередь не обогнала «сейчас»');

    // Пока идёт ход «сейчас», очередь молчит.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(stub().prompts.length, 2, 'второй ход не запустился параллельно');

    stub().release();
    await firstEvents;
    await nextEvents;
    await until(() => stub().prompts.length === 3, 'очередь пошла после «сейчас»');
    assert.deepEqual(stub().prompts, ['первое', 'сейчас', 'из очереди']);
    stub().release();
    await until(() => !stub().busy, 'разговор освободился');
  } finally {
    await panel.close();
    for (const session of created) session.dispose();
  }
});

/* ── «стоп» и снятие из очереди ────────────────────────────────────────────── */

test('/stop снимает и ход, и очередь: «стоп» — это «останови всё»', async () => {
  const { config, chat, created, registry } = fixture();
  const panel = openPanel(config, registry, chat.id);
  const stub = () => created.at(-1)!;
  try {
    const first = await panel.send({ text: 'первое' });
    const firstEvents = lines(first);
    await until(() => stub().prompts.length === 1, 'ход начался');
    await panel.send({ text: 'второе' });
    await panel.send({ text: 'третье' });
    assert.equal((await panel.history()).queue?.length, 2);

    const stopped = await panel.command('/stop');
    assert.match(String(stopped.text), /Из очереди снял: 2/, 'о снятой очереди сказано честно');
    assert.deepEqual((await panel.history()).queue, [], 'очередь пуста');
    await firstEvents;

    // Ничего не началось само: человек нажал «хватит».
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stub().prompts.length, 1);
  } finally {
    await panel.close();
    for (const session of created) session.dispose();
  }
});

test('кнопка «стоп» снимает очередь и говорит, сколько сняла', async () => {
  const { config, chat, created, registry } = fixture();
  const panel = openPanel(config, registry, chat.id);
  const stub = () => created.at(-1)!;
  try {
    const first = await panel.send({ text: 'первое' });
    const firstEvents = lines(first);
    await until(() => stub().prompts.length === 1, 'ход начался');
    await panel.send({ text: 'в очереди' });

    const aborted = await fetch(`${panel.base}/panel/api/chat/abort`, {
      method: 'POST',
      headers: panel.headers,
      body: JSON.stringify({ chatId: chat.id }),
    });
    assert.equal(aborted.status, 200);
    const result = (await aborted.json()) as { ok?: boolean; dropped?: number };
    assert.equal(result.ok, true);
    assert.equal(result.dropped, 1, 'очередь снята вместе с ходом');
    assert.deepEqual((await panel.history()).queue, []);
    stub().release();
    await firstEvents;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stub().prompts.length, 1, 'снятая реплика не отправилась');
  } finally {
    await panel.close();
    for (const session of created) session.dispose();
  }
});

test('одну реплику можно снять из очереди, пока она не отправилась', async () => {
  const { config, chat, created, registry } = fixture();
  const panel = openPanel(config, registry, chat.id);
  const stub = () => created.at(-1)!;
  try {
    const first = await panel.send({ text: 'первое' });
    const firstEvents = lines(first);
    await until(() => stub().prompts.length === 1, 'ход начался');
    const second = await panel.send({ text: 'лишнее' });
    const queuedView = (await second.json()) as { queue?: Array<{ id: string; text: string }> };
    const id = queuedView.queue?.[0]?.id;
    assert.ok(id);

    const dropped = await fetch(`${panel.base}/panel/api/chat/queue/drop`, {
      method: 'POST',
      headers: panel.headers,
      body: JSON.stringify({ chatId: chat.id, id }),
    });
    assert.equal(dropped.status, 200);
    assert.deepEqual(((await dropped.json()) as { queue: unknown[] }).queue, []);
    assert.deepEqual((await panel.history()).queue, []);

    stub().release();
    await firstEvents;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stub().prompts.length, 1, 'снятая реплика не отправилась');
  } finally {
    await panel.close();
    for (const session of created) session.dispose();
  }
});

test('в очередь не влезает больше лимита — отказ, а не бесконечная память', async () => {
  const { config, chat, created, registry } = fixture();
  const panel = openPanel(config, registry, chat.id);
  const stub = () => created.at(-1)!;
  try {
    const first = await panel.send({ text: 'первое' });
    const firstEvents = lines(first);
    await until(() => stub().prompts.length === 1, 'ход начался');
    for (let index = 0; index < QUEUE_LIMIT; index += 1) {
      assert.equal((await panel.send({ text: `р${index}` })).status, 202);
    }
    const full = await panel.send({ text: 'лишняя' });
    assert.equal(full.status, 429);

    stub().release();
    await firstEvents;
  } finally {
    await panel.close();
    for (const session of created) session.dispose();
  }
});
