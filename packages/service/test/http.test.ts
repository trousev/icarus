// Интеграционный тест HTTP-слоя: живьём поднимаем сервер и читаем SSE,
// вместо pi подсовываем фиктивную сессию. Модель и докер не нужны.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import type { IcarusConfig } from '../src/config.ts';

const API_KEY = 'test-token';

function makeConfig(): IcarusConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKey: API_KEY,
    panelKey: API_KEY,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-http-')),
    sessionIdleMinutes: 30,
    docker: { image: 'icarus-user:dev', prefix: 'icarus-user', socket: null },
    users: [{ id: 'probe', models: [{ provider: 'deepseek', id: 'deepseek-v4-flash', tier: 'fast' }] }],
  };
}

function makeSession() {
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
      emit({ type: 'tool_execution_start', toolName: 'read', args: { path: '/workspace/memory/identity.md' } });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Привет' } });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ', Саня' } });
      emit({ type: 'agent_settled' });
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
): Promise<void> {
  const config = makeConfig();
  const session = makeSession();
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
