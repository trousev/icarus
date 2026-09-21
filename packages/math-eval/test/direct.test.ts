// Прямая рука: провайдер без агента. Проверяем разбор ответа, повтор при сбое,
// список моделей и то, что параллельный прогон действительно идёт внахлёст.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { askDirect, providerModels } from '../src/direct.ts';
import { runSuite } from '../src/run.ts';
import { loadSuite, selectProblems } from '../src/suite.ts';

/** Тело ответа в формате OpenAI: то, что вернул бы провайдер. */
const reply = (content: string, reasoning = ''): unknown => ({
  choices: [{ message: { role: 'assistant', content, reasoning_content: reasoning } }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

/** Заглушка провайдера: слушает на случайном порту и отдаёт всё своему обработчику. */
async function serve(
  handler: (url: string, body: unknown, response: http.ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      handler(request.url ?? '/', raw.length > 0 ? JSON.parse(raw) : null, response);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

test('прямой вызов разбирает ответ провайдера', async () => {
  const server = await serve((_url, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply('\\boxed{4}', 'думал')));
  });
  try {
    const answer = await askDirect('сколько?', { baseUrl: server.baseUrl, apiKey: 'k', model: 'm' });
    assert.equal(answer.content, '\\boxed{4}');
    assert.equal(answer.reasoning, 'думал');
    assert.equal(answer.usage?.total_tokens, 5);
  } finally {
    server.close();
  }
});

test('сбой провайдера повторяется, а не роняет задачу', async () => {
  let calls = 0;
  const server = await serve((_url, _body, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"перегрузка"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply('готово')));
  });
  try {
    const answer = await askDirect('привет', {
      baseUrl: server.baseUrl,
      apiKey: 'k',
      model: 'm',
      retryDelayMs: 1,
    });
    assert.equal(answer.content, 'готово');
    assert.equal(calls, 2, 'первый вызов должен быть повторён');
  } finally {
    server.close();
  }
});

test('ошибка 400 не повторяется — это не перегрузка', async () => {
  let calls = 0;
  const server = await serve((_url, _body, response) => {
    calls += 1;
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{"error":"плохой запрос"}');
  });
  try {
    await assert.rejects(() => askDirect('привет', { baseUrl: server.baseUrl, apiKey: 'k', model: 'm' }), /400/);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('список моделей читается, а мёртвый провайдер даёт null', async () => {
  const server = await serve((_url, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
  });
  try {
    assert.deepEqual(await providerModels({ baseUrl: server.baseUrl, apiKey: 'k' }), [
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
  } finally {
    server.close();
  }
  assert.equal(await providerModels({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', timeoutMs: 500 }), null);
});

test('прогон руки model идёт параллельно и попадает в отчёт', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'math-eval-direct-'));
  const suiteFile = path.join(dir, 'suite.jsonl');
  const problems = [
    { id: 'a', question: 'сколько будет 1+1?', answer: '2' },
    { id: 'b', question: 'сколько будет 2+2?', answer: '4' },
    { id: 'c', question: 'сколько будет 3+3?', answer: '6' },
  ];
  fs.writeFileSync(
    suiteFile,
    problems
      .map((item) =>
        JSON.stringify({
          id: item.id,
          category: 'test',
          tier: 'full',
          kind: 'answer',
          question: item.question,
          answers: [item.answer],
        }),
      )
      .join('\n') + '\n',
  );

  let inFlight = 0;
  let maxInFlight = 0;
  const server = await serve((_url, body, response) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const prompt = (body as { messages: Array<{ content: string }> }).messages[0].content;
    const answer = problems.find((item) => prompt.includes(item.question))?.answer ?? '?';
    setTimeout(() => {
      inFlight -= 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply(`Ответ: ${answer}`)));
    }, 30);
  });

  try {
    const { outcomes, meta } = await runSuite({
      suite: suiteFile,
      problems: selectProblems(loadSuite(suiteFile), { tier: 'all' }),
      target: 'model',
      baseUrl: server.baseUrl,
      apiKey: 'k',
      user: 'probe',
      model: 'deepseek-flash',
      arm: 'control',
      repeat: 1,
      timeoutMs: 10_000,
      concurrency: 3,
      outDir: path.join(dir, 'out'),
      mapleDir: null,
      grader: 'strict',
    });
    assert.deepEqual(
      outcomes.map((outcome) => outcome.ok),
      [true, true, true],
    );
    assert.equal(meta.target, 'model');
    assert.equal(meta.concurrency, 3);
    assert.ok(maxInFlight >= 2, `ожидал параллельные запросы, а максимум был ${maxInFlight}`);
    const summary = fs.readFileSync(path.join(dir, 'out', 'summary.md'), 'utf8');
    assert.match(summary, /напрямую, без агента и инструментов/);
  } finally {
    server.close();
  }
});
