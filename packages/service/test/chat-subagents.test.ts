// Субагенты в панели: подпись шага, живой список детей в потоке и он же в истории.
//
// Поток проверяем по-настоящему: поднимаем HTTP-сервер с заглушкой реестра и читаем
// NDJSON ровно так, как это делает браузер.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { finishChat, createChat, readHistory, subagentsOf, traceDetail, traceLabel, traceUpstream } from '../src/control/chat.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { userPaths } from '../src/config.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  return { config, user: probe('probe') };
}

const TASKS = [
  { agent: 'scout', task: 'найди файлы памяти' },
  { agent: 'researcher', task: 'посмотри цены на amazon.ie' },
];

test('шаг субагентов подписан по-человечески: сколько задач и каких агентов', () => {
  assert.equal(traceLabel('subagent', { tasks: TASKS }), 'СУБАГЕНТЫ');
  assert.equal(traceDetail('subagent', { tasks: TASKS }), '2 задачи · scout, researcher');
  assert.equal(traceDetail('subagent', { tasks: [] }), 'задачи не переданы');
  assert.equal(traceDetail('subagent', { tasks: [...TASKS, TASKS[0]] }).startsWith('3 задачи'), true);
});

test('в трассировке видно, какой провайдер ответил на поиск', () => {
  assert.equal(traceUpstream('курс евро', 'brave'), 'курс евро · brave');
  assert.equal(traceUpstream('', 'brave'), 'brave');
  assert.equal(traceUpstream('курс евро', ''), 'курс евро');
  assert.equal(traceUpstream('курс евро', undefined), 'курс евро');
  assert.equal(traceUpstream('x'.repeat(200), 'exa'), `${'x'.repeat(200)} · exa`.slice(0, 139) + '…');
});

test('детали субагентов разбираются аккуратно: мусор отбрасывается, поля обрезаются', () => {
  const states = subagentsOf([
    { index: 0, agent: 'scout', task: 'x'.repeat(400), status: 'ok', ms: 1200 },
    {
      agent: 'researcher',
      task: 'искать',
      status: 'running',
      activity: 'web_search: amazon.ie',
      startedAt: 1,
      actions: ['read: SKILL.md', 'web_search: amazon.ie', 42, ''],
      actionsTotal: 53,
    },
    { agent: 42 },
    null,
    'строка',
  ]);
  assert.equal(states.length, 2);
  assert.equal(states[0]?.task.length, 160, 'длинное задание обрезается');
  assert.equal(states[1]?.activity, 'web_search: amazon.ie');
  assert.deepEqual(states[1]?.actions, ['read: SKILL.md', 'web_search: amazon.ie'], 'мусор в шагах отбрасывается');
  assert.equal(states[1]?.actionsTotal, 53, 'общее число шагов не теряется');
  assert.deepEqual(subagentsOf(undefined), []);
  assert.deepEqual(subagentsOf({ subagents: [] }), []);
});

test('история помнит, чем кончил каждый субагент, если pi сохранил детали', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, new Date('2026-11-01T10:00:00.000Z'));
  finishChat(config, user, chat.id, 'Разошли задачи');
  const sessionId = sessionIdFor(user.id, chat.id);
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:01.000Z',
        message: { role: 'user', content: 'Разошли задачи' },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Раздаю.' },
            { type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { tasks: TASKS } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:30.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'subagent',
          isError: false,
          content: [{ type: 'text', text: 'Субагенты: 2 задач…' }],
          details: {
            subagents: [
              { index: 0, agent: 'scout', task: TASKS[0]?.task, status: 'ok', ms: 4000 },
              { index: 1, agent: 'researcher', task: TASKS[1]?.task, status: 'error', ms: 100, error: 'таймаут' },
            ],
          },
        },
      }),
    ].join('\n'),
  );

  const history = readHistory(config, user, chat.id);
  const step = history?.messages.flatMap((message) => message.trace ?? []).find((item) => item.tool === 'subagent');
  assert.ok(step, 'шаг субагентов должен быть в истории');
  assert.deepEqual(
    step?.subagents?.map((sub) => [sub.agent, sub.status]),
    [
      ['scout', 'ok'],
      ['researcher', 'error'],
    ],
  );
  assert.equal(step?.subagents?.[1]?.error, 'таймаут');
});

test('в истории без деталей список детей не выдумывается', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, new Date('2026-11-01T10:00:00.000Z'));
  finishChat(config, user, chat.id, 'Разошли задачи');
  const sessionId = sessionIdFor(user.id, chat.id);
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { tasks: TASKS } }],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:30.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'subagent',
          isError: false,
          content: [{ type: 'text', text: 'старая сессия без деталей' }],
        },
      }),
    ].join('\n'),
  );

  const step = readHistory(config, user, chat.id)
    ?.messages.flatMap((message) => message.trace ?? [])
    .find((item) => item.tool === 'subagent');
  assert.ok(step);
  assert.equal(step?.subagents, undefined, 'без деталей дети остаются «в очереди» — это враньё');
});

test('живой поток: прогресс детей приезжает обновлениями шага, финал — в done', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, new Date('2026-11-01T10:00:00.000Z'));

  const events: Array<Record<string, unknown>> = [
    {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'subagent',
      args: { tasks: TASKS },
    },
    {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: {
        content: [{ type: 'text', text: 'Субагенты: 0 из 2, 1 работает' }],
        details: {
          subagents: [
            {
              index: 0,
              agent: 'scout',
              task: TASKS[0]?.task,
              status: 'running',
              activity: 'web_search: amazon.ie',
              actions: ['read: memory/identity.md', 'web_search: amazon.ie'],
            },
            { index: 1, agent: 'researcher', task: TASKS[1]?.task, status: 'queued' },
          ],
        },
      },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Все дошли. Нашёл три страницы.' }],
        details: {
          subagents: [
            { index: 0, agent: 'scout', task: TASKS[0]?.task, status: 'ok', ms: 4000 },
            { index: 1, agent: 'researcher', task: TASKS[1]?.task, status: 'ok', ms: 9000 },
          ],
        },
      },
    },
    { type: 'agent_settled' },
  ];

  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const session = {
    busy: false,
    compacting: null,
    async prompt() {
      for (const event of events) for (const listener of listeners) listener(event);
    },
    onEvent(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async abort() {
      return true;
    },
  };
  const registry = {
    acquire: async () => session,
    get: () => session,
    bumpResources: () => 0,
    list: () => [],
  };

  const server = createServer(config, registry as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/panel/api/chat/send`, {
      method: 'POST',
      headers: { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: chat.id, text: 'Разошли задачи' }),
    });
    assert.equal(response.status, 200);
    const lines = (await response.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const step = lines.find((event) => event.type === 'step');
    assert.equal((step?.step as { label?: string } | undefined)?.label, 'СУБАГЕНТЫ');

    const updates = lines.filter((event) => event.type === 'step-update');
    assert.ok(updates.length >= 1, 'прогресс обязан приехать до конца');
    const live =
      (updates[0]?.step as { subagents?: Array<{ status: string; activity?: string; actions?: string[] }> })
        .subagents ?? [];
    assert.deepEqual(
      live.map((sub) => sub.status),
      ['running', 'queued'],
    );
    assert.equal(live[0]?.activity, 'web_search: amazon.ie');
    assert.deepEqual(live[0]?.actions, ['read: memory/identity.md', 'web_search: amazon.ie']);

    const end = lines.find((event) => event.type === 'step-end');
    const final = (end?.subagents as Array<{ status: string }> | undefined) ?? [];
    assert.deepEqual(
      final.map((sub) => sub.status),
      ['ok', 'ok'],
    );

    const done = lines.find((event) => event.type === 'done');
    const steps = done?.steps as Array<{ tool: string; subagents?: Array<{ status: string }> }>;
    assert.equal(steps.find((item) => item.tool === 'subagent')?.subagents?.[0]?.status, 'ok');
  } finally {
    server.close();
  }
});
