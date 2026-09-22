// Прогон целиком, но против заглушки вместо Икара: проверяем не модель,
// а то, что раннер шлёт правильные заголовки, считает шаги Maple, сверяет
// ответы и оставляет отчёт. Ровно эти вещи не видно в отчёте, когда они сломаны.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { runSuite } from '../src/run.ts';
import { loadSuite, selectProblems } from '../src/suite.ts';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('набор с опечаткой не проходит молча', () => {
  const dir = tmp('math-eval-suite-');
  const file = path.join(dir, 'bad.jsonl');
  const line = (extra: Record<string, unknown>) =>
    JSON.stringify({ id: 'a', category: 'c', tier: 'smoke', question: 'q?', answers: ['1'], ...extra });
  fs.writeFileSync(file, `${line({})}\n${line({ id: 'a' })}\n`);
  assert.throws(() => loadSuite(file), /повторяется/);
  fs.writeFileSync(file, `${line({ answers: [] })}\n`);
  assert.throws(() => loadSuite(file), /эталон/);
  fs.writeFileSync(file, '# только комментарий\n');
  assert.throws(() => loadSuite(file), /ни одной задачи/);
});

test('прогон против заглушки: свой разговор на задачу, шаги Maple, отчёт', async () => {
  const dir = tmp('math-eval-run-');
  const suiteFile = path.join(dir, 'suite.jsonl');
  fs.writeFileSync(
    suiteFile,
    [
      JSON.stringify({ id: 'num', category: 'number-theory', tier: 'smoke', question: 'чему равно phi(1000)?', answers: ['400'] }),
      JSON.stringify({ id: 'sym', category: 'ode', tier: 'smoke', question: 'реши y\'+y=0', answers: ['2*exp(-x)'] }),
      JSON.stringify({ id: 'honest', category: 'honesty', tier: 'smoke', kind: 'refusal', question: 'возьми int x^x', answers: [] }),
    ].join('\n') + '\n',
  );

  const mapleDir = path.join(dir, 'maple');
  fs.mkdirSync(mapleDir);
  const journal = path.join(mapleDir, 'eval.jsonl');
  fs.writeFileSync(journal, '{"code":"1+1"}\n');

  const seen: Array<{ authorization?: string; user?: string; conversation?: string; prompt: string }> = [];
  let appended = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> };
      const prompt = body.messages[0].content;
      seen.push({
        authorization: request.headers.authorization,
        user: request.headers['x-icarus-user-id'] as string,
        conversation: request.headers['x-icarus-conversation-id'] as string,
        prompt,
      });
      // Заглушка «трогает Maple» ровно в первой задаче: так проверяется подсчёт шагов.
      if (!appended) {
        fs.appendFileSync(journal, '{"code":"2+2"}\n');
        appended = true;
      }
      const content = prompt.includes('phi(1000)')
        ? 'Считал в Maple.\n\n\\boxed{400}'
        : prompt.includes("y'+y=0")
          ? 'Решение:\n\n\\boxed{2*exp(-x)}'
          : 'Maple вернул int(x^x, x) без изменений — эту первообразную он не нашёл.';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content, reasoning_content: 'работаю: mcp_maple_evaluate_code' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const problems = selectProblems(loadSuite(suiteFile), { tier: 'smoke' });
    const outDir = path.join(dir, 'out');
    const { outcomes, meta } = await runSuite({
      suite: suiteFile,
      problems,
      target: 'icarus',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      user: 'probe',
      model: 'icarus',
      arm: 'test-arm',
      repeat: 1,
      timeoutMs: 10_000,
      concurrency: 1,
      outDir,
      mapleDir,
      grader: 'strict',
    });

    assert.equal(outcomes.length, 3);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.ok),
      [true, true, true],
      outcomes.map((outcome) => `${outcome.id}: ${outcome.reason}`).join('; '),
    );
    // Отчёт сортируется по id, а не по порядку ответов: сверяемся по имени задачи.
    const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
    assert.equal(byId.get('num')?.extracted, '400');
    assert.equal(byId.get('num')?.usage?.total_tokens, 15);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.id, outcome.mapleSteps]),
      [
        ['honest', 0],
        ['num', 1],
        ['sym', 0],
      ],
    );

    assert.equal(seen[0].authorization, 'Bearer test-key');
    assert.equal(seen[0].user, 'probe');
    assert.equal(new Set(seen.map((entry) => entry.conversation)).size, 3, 'на каждую задачу свой разговор');
    assert.equal(meta.arm, 'test-arm');
    assert.equal(meta.target, 'icarus');
    assert.equal(meta.grader, 'strict');

    const summary = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    assert.match(summary, /Точность: 3\/3 \(100%\)/);
    assert.match(summary, /Maple трогали в 1\/3/);
    assert.equal(fs.readFileSync(path.join(outDir, 'results.jsonl'), 'utf8').trim().split('\n').length, 3);
    assert.ok(fs.existsSync(path.join(outDir, 'summary.json')));
  } finally {
    server.close();
  }
});

test('прерванный прогон продолжается с места обрыва', async () => {
  const dir = tmp('math-eval-resume-');
  const suiteFile = path.join(dir, 'suite.jsonl');
  fs.writeFileSync(
    suiteFile,
    [
      JSON.stringify({ id: 'a', category: 'test', tier: 'full', kind: 'answer', question: 'сколько 1+1?', answers: ['2'] }),
      JSON.stringify({ id: 'b', category: 'test', tier: 'full', kind: 'answer', question: 'сколько 2+2?', answers: ['4'] }),
    ].join('\n') + '\n',
  );

  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  // Первая задача «уже отвечена» прошлым прогоном — её не должно быть в запросах.
  fs.writeFileSync(
    path.join(outDir, 'results.jsonl'),
    `${JSON.stringify({
      id: 'a',
      category: 'test',
      arm: 'test-arm',
      repeat: 1,
      ok: true,
      reason: 'сошлось',
      extracted: '2',
      expected: ['2'],
      content: 'Ответ: 2',
      reasoning: '',
      ms: 1,
      mapleSteps: 0,
      usage: null,
      error: null,
    })}\n`,
  );

  let calls = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ответ: 4' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const { outcomes } = await runSuite({
      suite: suiteFile,
      problems: selectProblems(loadSuite(suiteFile), { tier: 'all' }),
      target: 'icarus',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'k',
      user: 'probe',
      model: 'icarus',
      arm: 'test-arm',
      repeat: 1,
      timeoutMs: 10_000,
      concurrency: 1,
      outDir,
      mapleDir: null,
      grader: 'strict',
      resume: true,
    });
    assert.equal(calls, 1, 'уже отвеченную задачу переспрашивать нельзя');
    assert.deepEqual(
      outcomes.map((outcome) => outcome.id),
      ['a', 'b'],
      'в отчёт должны попасть и прежние, и новые задачи',
    );
    assert.ok(outcomes.every((outcome) => outcome.ok));
  } finally {
    server.close();
  }
});
