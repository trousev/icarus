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
    // Текст уходит законченными кусками: дельты одной фразы склеиваются в один чанк
    // (см. AnswerBuffer — иначе переключение канала рвёт ответ посреди слова).
    assert.match(text, /"content":"Привет, Саня"/);
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
  });
});

test('мысль и активность тула после начала ответа остаются в reasoning_content, а не в тексте', async () => {
  const steps: Step[] = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Сейчас посмотрю. ' } },
    { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Надо проверить каталог.' } },
    { type: 'tool_execution_end', toolName: 'bash', isError: false },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Готово.' } },
    { type: 'agent_settled' },
  ];
  await withServer(async (base) => {
    const deltas = deltasOf(await (await sseRequest(base, {})).text());

    assert.equal(
      deltas.filter((delta) => delta.reasoning_content && delta.content).length,
      0,
      'чанк с reasoning_content и content сразу — LibreChat рисует такое как plain text, а не как «мысли»',
    );

    // В видимом ответе — только слова модели. Канал размышлений не «закрывается»
    // после первой фразы: агент почти всегда говорит её до тулов, и если закрыть,
    // весь дальнейший монолог модели уезжает в текст (регресс из PR #45).
    assert.equal(
      deltas.map((delta) => delta.content ?? '').join(''),
      'Сейчас посмотрю. Готово.',
      'размышления или фразы тулов утекли в текст ответа',
    );
    assert.equal(
      deltas.map((delta) => delta.reasoning_content ?? '').join(''),
      'выполняю: ls\nНадо проверить каталог.команда отработала\n',
      'мысль или активность тула потерялись после начала ответа',
    );
  }, steps);
});

/** Порядок каналов в потоке: что клиент увидит раньше — мысль или текст. */
function channelsOf(sse: string): string[] {
  return deltasOf(sse)
    .filter((delta) => delta.content || delta.reasoning_content)
    .map((delta) => (delta.reasoning_content ? 'think' : 'text'));
}

test('переключение на активность тула не рвёт ответ посреди слова', async () => {
  const steps: Step[] = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Сайт рендерится д' } },
    { type: 'tool_execution_start', toolName: 'bash', args: { command: 'curl -s site' } },
    { type: 'tool_execution_end', toolName: 'bash', isError: false },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'жаваскриптом, текстом не отдаёт.\n\n' },
    },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Пробую их API.' } },
    { type: 'agent_settled' },
  ];
  await withServer(async (base) => {
    const sse = await (await sseRequest(base, {})).text();
    const content = deltasOf(sse).map((delta) => delta.content ?? '').join('');

    // LibreChat заводит новую часть на каждое переключение канала и рисует её
    // отдельным блоком. Слово, оборванное на тул, должно уехать в одну часть с
    // продолжением, иначе в чате появляется разрыв посреди слова.
    assert.equal(
      content,
      'Сайт рендерится джаваскриптом, текстом не отдаёт.\n\nПробую их API.',
      'оборванное слово разъехалось по разным частям ответа',
    );
    assert.deepEqual(
      channelsOf(sse),
      ['think', 'think', 'text', 'text'],
      'хвост ответа должен уходить после активности тула, а не до неё',
    );
  }, steps);
});

test('поздний thinking_end не вставляет разрыв посреди фразы', async () => {
  // pi присылает thinking_end уже после первых текстовых дельт того же блока —
  // если считать его разрывом, посреди фразы появится пустая строка.
  const steps: Step[] = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Итого:' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'подумал' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'всё хорошо' } },
    { type: 'agent_settled' },
  ];
  await withServer(async (base) => {
    const content = deltasOf(await (await sseRequest(base, {})).text())
      .map((delta) => delta.content ?? '')
      .join('');
    assert.equal(content, 'Итого:всё хорошо', 'разрыв вставлен посреди блока текста');
  }, steps);
});

test('новое сообщение модели начинается с пустой строки, а не приклеивается к хвосту', async () => {
  const steps: Step[] = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Теперь журнал.' } },
    { type: 'tool_execution_start', toolName: 'read', args: { path: '/workspace/memory/journal/2026-09.md' } },
    { type: 'tool_execution_end', toolName: 'read', isError: false },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '## Шаг 2\n\nПрочитал журнал.' } },
    { type: 'agent_settled' },
  ];
  await withServer(async (base) => {
    const content = deltasOf(await (await sseRequest(base, {})).text())
      .map((delta) => delta.content ?? '')
      .join('');
    assert.equal(
      content,
      'Теперь журнал.\n\n## Шаг 2\n\nПрочитал журнал.',
      'заголовок склеился с прошлой фразой — в чате он перестанет быть заголовком',
    );
  }, steps);
});

test('без стрима размышления уезжают в message.reasoning_content, а не в текст', async () => {
  const steps: Step[] = [
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Сначала подумаю. ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Ответ' } },
    { type: 'agent_settled' },
  ];
  await withServer(async (base) => {
    const response = await sseRequest(base, { stream: false });
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string; reasoning_content?: string } }>;
    };
    assert.equal(payload.choices[0].message.content, 'Ответ', 'мысли утекли в текст ответа');
    assert.equal(payload.choices[0].message.reasoning_content, 'Сначала подумаю. ');
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
