// Integration test of the HTTP layer: we bring the server up for real and read SSE,
// and pass a fake session instead of pi. No model or docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { API_KEY, makeConfig } from './fixtures.ts';

/** Scenario of a pi turn: events the fake session will emit on `prompt`. */
type Step = Record<string, unknown>;

const DEFAULT_STEPS: Step[] = [
  { type: 'tool_execution_start', toolName: 'read', args: { path: '/workspaces/.icarus/memory/identity.md' } },
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
  const server = createServer(config, registry as never);
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

test('/v1/models returns the icarus model and requires a token', async () => {
  await withServer(async (base) => {
    const unauthorized = await fetch(`${base}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
    const payload = (await ok.json()) as { data: Array<{ id: string }> };
    assert.equal(payload.data[0].id, 'icarus');
  });
});

test('an unknown user gets 403', async () => {
  await withServer(async (base) => {
    const response = await sseRequest(base, {}, { 'x-icarus-user-id': 'stranger' });
    assert.equal(response.status, 403);
  });
});

test('the stream contains text, tool activity and the finish', async () => {
  await withServer(async (base, session) => {
    const response = await sseRequest(base, {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await response.text();
    // Text goes out in completed pieces: deltas of one phrase are merged into a single chunk
    // (see AnswerBuffer — otherwise switching channels tears the answer mid-word).
    assert.match(text, /"content":"Привет, Саня"/);
    assert.match(text, /"reasoning_content":"читаю memory\/identity\.md\\n"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(session.prompts.length, 1);
  });
});

test('usage is returned only when the client asked for it', async () => {
  await withServer(async (base) => {
    const without = await (await sseRequest(base, {})).text();
    assert.doesNotMatch(without, /"usage"/);

    const withUsage = await (
      await sseRequest(base, { stream_options: { include_usage: true } })
    ).text();
    assert.match(withUsage, /"total_tokens":15/);
  });
});

/** Parses SSE into a list of `delta` objects (chunks without choices are skipped). */
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

test('reasoning does not mix with the answer: one chunk — one channel', async () => {
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
      'чанк с reasoning_content и content сразу — клиент рисует такое как plain text, а не как «мысли»',
    );
  });
});

test('a thought and tool activity after the answer has started stay in reasoning_content, not in the text', async () => {
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
      'чанк с reasoning_content и content сразу — клиент рисует такое как plain text, а не как «мысли»',
    );

    // The visible answer contains only the model's words. The reasoning channel is not "closed"
    // after the first phrase: the agent almost always says it before the tools, and if closed,
    // the rest of the model's monologue leaks into the text (regression from PR #45).
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

/** Order of channels in the stream: what the client sees first — thought or text. */
function channelsOf(sse: string): string[] {
  return deltasOf(sse)
    .filter((delta) => delta.content || delta.reasoning_content)
    .map((delta) => (delta.reasoning_content ? 'think' : 'text'));
}

test('switching to tool activity does not tear the answer mid-word', async () => {
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

    // The client starts a new part on every channel switch and renders it as a
    // separate block. A word cut off by a tool must land in the same part as its
    // continuation, otherwise a mid-word gap appears in the chat.
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

test('a late thinking_end does not insert a break in the middle of a phrase', async () => {
  // pi sends thinking_end after the first text deltas of the same block —
  // if it were treated as a break, an empty line would appear in the middle of a phrase.
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

test('a new model message starts with an empty line instead of sticking to the tail', async () => {
  const steps: Step[] = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Теперь журнал.' } },
    { type: 'tool_execution_start', toolName: 'read', args: { path: '/workspaces/.icarus/memory/journal/2026-09.md' } },
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

test('without streaming, reasoning goes into message.reasoning_content, not into the text', async () => {
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

test('/healthz returns the code fingerprint: it shows which version is running in the container', async () => {
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
