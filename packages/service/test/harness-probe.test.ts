// Пробник второго движка: перевод потока Claude Code в события Икара.
//
// Тесты не ходят в сеть и не запускают Claude Code: fixtures/*.jsonl — реальные
// прогоны (см. tools/harness-probe/README.md), из которых убран только служебный
// шум. Проверяем главное: панель получает те же события, что и от pi, а всё, что
// протокол не отдал, видно как ошибка, а не как пустой успешный ход.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type TurnEvent = {
  type: string;
  engine?: string;
  text?: string;
  message?: string;
  truncated?: boolean;
  subtype?: string;
  result?: string;
  sessionId?: string | null;
  usage?: Record<string, unknown> | null;
  costUsd?: number | null;
  durationMs?: number | null;
  numTurns?: number | null;
  permissionDenials?: unknown[];
  steps?: Array<{ id: string; tool: string; label: string; detail: string; status: string; result?: string }>;
  step?: { id: string; tool: string; label: string; detail: string; status: string; result?: string };
  id?: string;
  status?: string;
  model?: string | null;
  tools?: string[];
  mcpServers?: string[];
  permissionMode?: string | null;
};

type Stream = {
  push: (event: Record<string, unknown>) => TurnEvent[];
  finish: () => TurnEvent[];
  unknownTypes: Record<string, number>;
};

type ParseModule = {
  translateEvents: (events: Array<Record<string, unknown>>, options?: { includeThinking?: boolean }) => TurnEvent[];
  createTurnStream: (options?: { includeThinking?: boolean }) => Stream;
};

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FIXTURES = path.join(ROOT, 'tools/harness-probe/fixtures');
const MODULE_URL = new URL('../../../tools/harness-probe/parse.mjs', import.meta.url).href;
const { translateEvents, createTurnStream } = (await import(MODULE_URL)) as ParseModule;

/** Фикстура — JSONL ровно в том виде, в каком его пишет claude --output-format stream-json. */
function fixture(name: string): Array<Record<string, unknown>> {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim();
  return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function of(events: TurnEvent[], type: string): TurnEvent[] {
  return events.filter((event) => event.type === type);
}

function textOf(events: TurnEvent[]): string {
  return of(events, 'text')
    .map((event) => event.text ?? '')
    .join('');
}

test('текстовый прогон: engine, текст дельтами и done вместо agent_settled', () => {
  const events = translateEvents(fixture('text-run.jsonl'));

  assert.equal(events[0]?.type, 'engine', 'движок должен представиться первым событием');
  assert.equal(events[0]?.engine, 'claude-code');
  assert.equal(events[0]?.model, 'deepseek-chat');
  assert.ok(events[0]?.tools?.includes('Read'), 'список инструментов приезжает в system:init');

  assert.equal(textOf(events), 'CLEAN-OK');

  const done = of(events, 'done')[0];
  assert.ok(done, 'result должен стать событием done');
  assert.equal(done?.result, 'CLEAN-OK');
  assert.equal(done?.engine, 'claude-code');
  assert.equal(done?.numTurns, 1);
  assert.equal(typeof done?.sessionId, 'string');
  assert.equal(of(events, 'error').length, 0);
});

test('инструмент: шаг открывается, обновляется и закрывается ровно один раз', () => {
  const events = translateEvents(fixture('tool-run.jsonl'));

  const steps = of(events, 'step');
  assert.equal(steps.length, 1, 'один вызов Read — один шаг');
  assert.equal(steps[0]?.step?.tool, 'read', 'имя Claude Code приводится к имени pi');
  assert.equal(steps[0]?.step?.status, 'running');

  const updates = of(events, 'step-update');
  assert.equal(updates.length, 1, 'одно обновление шага, без дублей на content_block_stop и assistant');
  assert.match(updates[0]?.step?.detail ?? '', /probe\.txt$/, 'аргументы доезжают из input_json_delta');

  const ends = of(events, 'step-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.status, 'ok');
  assert.match(ends[0]?.result ?? '', /МАЯК-42/, 'результат инструмента — это user.tool_result');

  const done = of(events, 'done')[0];
  assert.equal(done?.steps?.length, 1);
  assert.equal(done?.steps?.[0]?.status, 'ok', 'к концу хода шаг уже закрыт');
  assert.equal(textOf(events), done?.result, 'текст ответа не задваивается из-за partial messages');
});

test('оборванный поток: без result — ошибка, а не тихий успех', () => {
  const events = translateEvents(fixture('truncated-run.jsonl'));

  const errors = of(events, 'error');
  assert.equal(errors.length, 1, 'отсутствие result должно быть видно');
  assert.equal(errors[0]?.truncated, true);
  assert.match(errors[0]?.message ?? '', /без result/);
  assert.equal(of(events, 'done').length, 0);
});

test('result с ошибкой становится error и не притворяется done', () => {
  const events = translateEvents([
    { type: 'system', subtype: 'init', tools: ['Read'], model: 'deepseek-chat', session_id: 's-1' },
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: 401',
      permission_denials: [{ tool_name: 'Read' }],
    },
  ]);

  const errors = of(events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, 'API Error: 401');
  assert.equal(errors[0]?.subtype, 'error_during_execution');
  assert.equal(of(events, 'done').length, 0);
});

test('неизвестный тип не роняет парсер и попадает в счётчик протокола', () => {
  const stream = createTurnStream();
  assert.equal(stream.push({ type: 'hyperspace', payload: 1 }).length, 0, 'выдумывать событие нельзя');
  assert.deepEqual(stream.unknownTypes, { hyperspace: 1 });
});

test('thinking по умолчанию не едет в панель, но включается флагом', () => {
  const stream = [
    {
      type: 'stream_event',
      api_message_id: 'm-1',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'думаю' } },
    },
  ];
  assert.equal(of(translateEvents(stream), 'thinking').length, 0);
  assert.equal(of(translateEvents(stream, { includeThinking: true }), 'thinking')[0]?.text, 'думаю');
});
