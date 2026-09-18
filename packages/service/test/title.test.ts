// Заголовок разговора: LibreChat спрашивает его отдельным запросом, и этот
// запрос не должен поднимать сессию pi. Проверяем и разбор промпта, и маршрут.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import type { IcarusConfig } from '../src/config.ts';
import {
  conversationFromTitlePrompt,
  isTitleRequest,
  titleFromPrompt,
  titleFromText,
  TITLE_MODEL_ID,
  TITLE_SENTINEL,
} from '../src/http/title.ts';

const API_KEY = 'test-token';

/** Промпт ровно в той форме, в какой его собирает LibreChat (`titlePrompt` из yaml). */
function libreChatPrompt(input: string, output = ''): string {
  return `${TITLE_SENTINEL}
Придумай короткий заголовок этого разговора: 3–6 слов, на языке разговора,
без кавычек и без точки в конце. Верни только заголовок.

Conversation:
User: ${input}
AI: ${output}`;
}

test('запрос заголовка узнаётся по модели и по метке', () => {
  const plain = [{ role: 'user', content: 'привет' }];
  assert.equal(isTitleRequest(TITLE_MODEL_ID, plain), true);
  assert.equal(isTitleRequest('icarus', [{ role: 'user', content: libreChatPrompt('привет') }]), true);
  assert.equal(isTitleRequest('icarus', plain), false);
  assert.equal(isTitleRequest(undefined, []), false);
});

test('из промпта LibreChat достаётся первая реплика человека', () => {
  const prompt = libreChatPrompt('Почему не стартует docker compose?');
  assert.equal(conversationFromTitlePrompt(prompt), 'Почему не стартует docker compose?');
});

test('приветствие и обращение в заголовок не попадают', () => {
  assert.equal(titleFromText('Привет!'), 'Привет!');
  assert.equal(titleFromText('Привет, Икар! Помоги разобраться, как настроить память.'), 'Помоги разобраться, как настроить память');
  assert.equal(titleFromText('Икар, а как настроить память?'), 'Как настроить память');
  assert.equal(titleFromText('как настроить память?'), 'Как настроить память');
});

test('заголовок ограничен по словам и длине', () => {
  const long = titleFromText('очень длинное сообщение из многих слов которое надо обрезать');
  assert.ok(long.split(/\s+/).length <= 6, `слишком много слов: ${long}`);
  assert.ok(long.length <= 48, `слишком длинно: ${long}`);
});

test('пустая реплика даёт понятный фолбэк', () => {
  assert.equal(titleFromText('   '), 'Новый разговор');
  assert.equal(titleFromText('!!!'), '!!!');
});

test('заголовок собирается из полного промпта', () => {
  assert.equal(titleFromPrompt(libreChatPrompt('Почему не стартует docker compose')), 'Почему не стартует docker compose');
});

test('запрос заголовка не поднимает сессию и не требует пользователя', async () => {
  const config = {
    host: '127.0.0.1',
    port: 0,
    apiKey: API_KEY,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-title-')),
    sessionIdleMinutes: 30,
    docker: { image: 'icarus-user:dev', prefix: 'icarus-user', network: null, socket: null },
    users: [{ id: 'probe', models: [{ provider: 'deepseek', id: 'deepseek-v4-flash', tier: 'fast' }] }],
  } as IcarusConfig;

  let acquired = 0;
  const registry = {
    acquire: async () => {
      acquired += 1;
      throw new Error('сессию поднимать нельзя');
    },
    list: () => [],
  };

  const server = createServer(config, registry as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: TITLE_MODEL_ID,
        stream: false,
        messages: [{ role: 'user', content: libreChatPrompt('Привет, Икар! Почему не стартует docker compose?') }],
      }),
    });

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    };
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.model, TITLE_MODEL_ID);
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.equal(payload.choices[0].message.content, 'Почему не стартует docker compose');
    assert.equal(acquired, 0, 'заголовок не должен трогать реестр сессий');
  } finally {
    server.close();
  }
});
