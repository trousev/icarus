// Ход, переживший перезагрузку панели: F5 посреди ответа, догон при возвращении.
//
// Живой процесс pi тут заменён заглушкой, но маршруты, hub и HTTP — настоящие.
// Проверяем главное обещание: закрытая вкладка не прерывает ход, а вернувшаяся
// панель получает те же размышления и шаги, что увидела бы без перезагрузки.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { SessionRegistry, type SessionFactory } from '../src/sessions/registry.ts';
import { createChat } from '../src/control/chat.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

type Listener = (event: Record<string, unknown>) => void;

/** Заглушка pi: отдаёт события хода, когда их просит `prompt`, и слушает `abort`. */
class StubSession {
  busy = false;
  lastUsed = Date.now();
  aborted = false;
  private listeners = new Set<Listener>();
  private resolveSettled: (() => void) | null = null;
  /** Разрешение, которым тест отпускает ход: имитирует конец ответа pi. */
  finish: () => void = () => {};
  readonly done = new Promise<void>((resolve) => {
    this.finish = resolve;
  });
  /** Что именно «подумал» pi: тест задаёт это перед ходом. */
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
      // Даём HTTP-слою доехать до сокета, прежде чем идти дальше.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Ход висит, пока тест не отпустит: так мы точно застаём его живым.
    await this.release;
    this.busy = false;
    this.emit({ type: 'agent_settled' });
    this.resolveSettled?.();
  }

  /** Тест отпускает ход, когда всё нужное уже проверено. */
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
  // Сценарий хода задаём заранее: реестр создаёт заглушку внутри `acquire`,
  // и к моменту его вызова она должна уже знать, что «подумать».
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

test('F5 посреди хода не прерывает ответ, а панель догоняет его целиком', async () => {
  const { config, chat, script, created, registry } = fixture();
  const server = createServer(config, registry);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };

  try {
    // Ход нарочно длинный: мы успеваем «закрыть вкладку» на середине.
    script.push(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Считаю ' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false, result: { content: 'ok' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'готово.' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' Финал.' } },
    );

    // Панель отправляет реплику, но сразу обрывает чтение — это и есть F5.
    const sending = fetch(`${base}/panel/api/chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: chat.id, text: 'посчитай' }),
    });
    const first = await sending;
    assert.equal(first.status, 200);
    // Читаем пару строк и бросаем поток: соединение закрывается.
    const reader = first.body!.getReader();
    await reader.read();
    await reader.cancel();

    // Ключевая проверка: ход не прерван — abort не уходил.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(created[0]?.aborted, false, 'уход клиента не должен прерывать ход');

    // Панель открывается заново: история говорит, что ход жив.
    const history = (await (await fetch(`${base}/panel/api/chat/history?id=${chat.id}`, { headers })).json()) as {
      live?: boolean;
    };
    assert.equal(history.live, true, 'история сообщает о живом ходе');

    // И панель цепляется к потоку. Ход отпускаем, когда догон уже подписан:
    // так проверяется и накопленное, и то, что поток продолжает идти дальше.
    const streamed = fetch(`${base}/panel/api/chat/stream?id=${chat.id}`, { headers });
    // Даём серверу отдать приветствие и replay, затем завершаем ход.
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

    // Итог записан: панель найдёт его в истории, даже если бы никто не вернулся.
    // Сам текст хода в файл сессии кладёт pi — у заглушки файла нет, зато в ответе
    // хода `done` несёт накопленный текст и шаги.
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

test('когда хода нет, поток честно говорит об этом', async () => {
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
