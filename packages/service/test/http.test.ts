// Интеграционный тест HTTP-слоя: живьём поднимаем сервер и читаем SSE,
// вместо pi подсовываем фиктивную сессию. Модель и докер не нужны.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { API_KEY, makeConfig, PANEL_SECRET } from './fixtures.ts';

/** Сценарий хода pi: события, которые фиктивная сессия отдаст на `prompt`. */
type Step = Record<string, unknown>;

const DEFAULT_STEPS: Step[] = [
  { type: 'tool_execution_start', toolName: 'read', args: { path: '/workspace/memory/identity.md' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Привет' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ', Саня' } },
  { type: 'agent_settled' },
];

function makeSession(steps: Step[] = DEFAULT_STEPS) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  return {
    busy: false,
    container: 'stub',
    user: { id: 'probe' },
    conversationId: 'conv-1',
    prompts: [] as string[],
    aborted: 0,
    onEvent(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      this.prompts.push(text);
      const emit = (event: Record<string, unknown>) => listeners.forEach((listener) => listener(event));
      for (const step of steps) emit(step);
    },
    async abort() {
      this.aborted += 1;
    },
    async getMessages() {
      return [];
    },
    async getStats() {
      return { tokens: { input: 10, output: 5, total: 15 } };
    },
  };
}

async function withServer(
  handler: (base: string, session: ReturnType<typeof makeSession>) => Promise<void>,
  steps: Step[] = DEFAULT_STEPS,
): Promise<void> {
  const config = makeConfig();
  const session = makeSession(steps);
  const registry = { acquire: async () => session, list: () => [] };
  const server = createServer(config, registry as never, PANEL_SECRET);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, session);
  } finally {
    server.close();
  }
}

function sseRequest(base: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      'x-icarus-user-id': 'probe',
      'x-icarus-conversation-id': 'conv-1',
      ...headers,
    },
    body: JSON.stringify({ model: 'icarus', stream: true, messages: [{ role: 'user', content: 'привет' }], ...body }),
  });
}

test('/v1/models отдаёт модель icarus и требует токен', async () => {
  await withServer(async (base) => {
    const unauthorized = await fetch(`${base}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
    const payload = (await ok.json()) as { data: Array<{ id: string }> };
    assert.equal(payload.data[0].id, 'icarus');
  });
});

test('неизвестный пользователь получает 403', async () => {
  await withServer(async (base) => {
    const response = await sseRequest(base, {}, { 'x-icarus-user-id': 'stranger' });
    assert.equal(response.status, 403);
  });
});

test('поток содержит текст, активность тулов и финал', async () => {
  await withServer(async (base, session) => {
    const response = await sseRequest(base, {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /"content":"Привет"/);
    assert.match(text, /"reasoning_content":"читаю memory\/identity\.md\\n"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(session.prompts.length, 1);
  });
});

test('usage отдаётся только когда клиент его попросил', async () => {
  await withServer(async (base) => {
    const without = await (await sseRequest(base, {})).text();
    assert.doesNotMatch(without, /"usage"/);

    const withUsage = await (
      await sseRequest(base, { stream_options: { include_usage: true } })
    ).text();
    assert.match(withUsage, /"total_tokens":15/);
  });
});

/** Разбирает SSE в список `delta`-объектов (чанки без choices пропускаем). */
function deltasOf(sse: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ') || line.endsWith('[DONE]')) continue;
    const parsed = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: Record<string, string> }> };
    const delta = parsed.choices?.[0]?.delta;
    if (delta) out.push(delta);
  }
  return out;
}

test('размышления не смешиваются с ответом: один чанк — один канал', async () => {
  await withServer(async (base) => {
    const deltas = deltasOf(await (await sseRequest(base, {})).text());

    const reasoning = deltas.map((delta) => delta.reasoning_content ?? '').join('');
    const content = deltas.map((delta) => delta.content ?? '').join('');
    assert.equal(reasoning, 'читаю memory/identity.md\n', 'фраза тула потерялась или склеилась');
    assert.equal(content, 'Привет, Саня', 'текст ответа потерялся');

    const mixed = deltas.filter((delta) => delta.reasoning_content && delta.content);
    assert.equal(
      mixed.length,
      0,
      'чанк с reasoning_content и content сразу — LibreChat рисует такое как plain text, а не как «мысли»',
    );

    // После первого текста канал закрыт: reasoning_content там клиент допишет в ответ.
    const firstContent = deltas.findIndex((delta) => delta.content);
    for (const delta of deltas.slice(firstContent)) {
      assert.equal(delta.reasoning_content, undefined, 'размышление после текста утекло в ответ');
    }
  });
});

test('активность тула после начала ответа не уходит в reasoning_content', async () => {
  const steps: Step[] = [
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Сначала подумаю. ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Ответ' } },
    { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
    { type: 'tool_execution_end', toolName: 'bash', isError: false },
    { type: 'agent_settled' },
  ];
  await withServer(async (base) => {
    const deltas = deltasOf(await (await sseRequest(base, {})).text());

    assert.equal(
      deltas.filter((delta) => delta.reasoning_content && delta.content).length,
      0,
      'фраза тула смешалась с текстом ответа',
    );

    const afterText = deltas.slice(deltas.findIndex((delta) => delta.content));
    assert.equal(
      afterText.filter((delta) => delta.reasoning_content).length,
      0,
      'фраза тула ушла в reasoning_content после текста — клиент выбросит её как несовпадение типа',
    );

    // После текста канал один — текст, поэтому фразы тула едут туда же и не теряются.
    assert.equal(deltas.map((delta) => delta.content ?? '').join(''), 'Ответвыполняю: ls\nкоманда отработала\n');
  }, steps);
});

test('/healthz отдаёт отпечаток кода: по нему видно, какая версия работает в контейнере', async () => {
  const previous = process.env.ICARUS_REVISION;
  process.env.ICARUS_REVISION = 'rev-test';
  try {
    await withServer(async (base) => {
      const body = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; revision: string | null };
      assert.equal(body.ok, true);
      assert.equal(body.revision, 'rev-test', 'без ревизии «деплой зелёный, а код старый» не отличить');
    });
  } finally {
    if (previous === undefined) delete process.env.ICARUS_REVISION;
    else process.env.ICARUS_REVISION = previous;
  }
});
