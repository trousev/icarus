// Subagents: the queue, the nesting ban, launching a child and the report to the parent.
//
// The tests don't hit the model: instead of pi, a fake script is substituted on PATH
// (ICARUS_SUBAGENT_PI) that logs its arguments, environment and start time.
// This shows both that the child wasn't given anything extra and that the queue keeps
// parallelism in check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import register, {
  AGENTS,
  ALL_TOOLS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_TASKS,
  DEPTH_ENV,
  MAX_CONCURRENCY,
  agentNameOf,
  buildChildArgs,
  extensionFilesOf,
  isSubagentProcess,
  rememberAction,
  renderProgress,
  renderReport,
  resolveLimits,
  runPool,
  snapshot,
  type SubagentState,
} from '../../extensions/subagent.ts';

type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string,
    params: { tasks?: Array<{ agent: string; task: string }>; concurrency?: number },
    signal: AbortSignal | undefined,
    onUpdate: ((partial: ToolResult) => void) | undefined,
    ctx: { cwd: string; model?: { provider: string; id: string } },
  ) => Promise<ToolResult>;
};

/** The extension from pi's point of view: we only need the assembled tool. */
function loadTool(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  const api = {
    registerTool: (tool: unknown) => tools.push(tool as ToolDefinition),
    on: () => undefined,
  };
  register(api as unknown as ExtensionAPI);
  const tool = tools.find((item) => item.name === 'subagent');
  assert.ok(tool, 'инструмент subagent должен регистрироваться');
  return tool;
}

const FAKE_PI = `#!/usr/bin/env node
import fs from 'node:fs';
const log = process.env.FAKE_PI_LOG;
if (log) {
  fs.appendFileSync(
    log,
    JSON.stringify({ event: 'start', args: process.argv.slice(2), depth: process.env.ICARUS_SUBAGENT_DEPTH ?? null }) + '\\n',
  );
}
const sleep = Number(process.env.FAKE_PI_SLEEP_MS || 0);
const code = Number(process.env.FAKE_PI_FAIL || 0);
const text = process.env.FAKE_PI_TEXT || 'нашёл то, что просили';
const actions = Number(process.env.FAKE_PI_ACTIONS || 1);
for (let index = 0; index < actions; index += 1) {
  console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'web_search', args: { query: 'q' + index } }));
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } }));
setTimeout(() => {
  if (log) fs.appendFileSync(log, JSON.stringify({ event: 'end' }) + '\\n');
  process.exitCode = code;
}, sleep);
`;

/** The fake pi in a separate directory: we pass its path via ICARUS_SUBAGENT_PI. */
function fakePi(): { dir: string; file: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-fake-pi-'));
  const file = path.join(dir, 'pi');
  fs.writeFileSync(file, FAKE_PI, { mode: 0o755 });
  return { dir, file, log: path.join(dir, 'log.jsonl') };
}

/** How many children worked at the same time: the log is written in real time. */
function peakFromLog(file: string): number {
  let active = 0;
  let peak = 0;
  for (const entry of readLog(file)) {
    if (entry.event === 'start') {
      active += 1;
      peak = Math.max(peak, active);
    } else if (entry.event === 'end') {
      active -= 1;
    }
  }
  return peak;
}

function readLog(file: string): Array<{ event: string; args?: string[]; depth?: string | null }> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; args?: string[]; depth?: string | null });
}

/** Environment for the duration of the test: the fake pi and fast limits. */
function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('default limits: four in parallel and forty tasks', () => {
  const limits = resolveLimits({});
  assert.equal(limits.concurrency, DEFAULT_CONCURRENCY);
  assert.equal(limits.concurrency, 4);
  assert.equal(limits.maxTasks, DEFAULT_MAX_TASKS);
});

test('limits are clamped: eight is the ceiling, garbage falls back to the default', () => {
  assert.equal(resolveLimits({ ICARUS_SUBAGENT_CONCURRENCY: '40' }).concurrency, MAX_CONCURRENCY);
  assert.equal(resolveLimits({ ICARUS_SUBAGENT_CONCURRENCY: '0' }).concurrency, DEFAULT_CONCURRENCY);
  assert.equal(resolveLimits({ ICARUS_SUBAGENT_CONCURRENCY: 'два' }).concurrency, DEFAULT_CONCURRENCY);
  assert.equal(resolveLimits({ ICARUS_SUBAGENT_MAX_TASKS: '100' }).maxTasks, DEFAULT_MAX_TASKS);
  assert.equal(resolveLimits({ ICARUS_SUBAGENT_TASK_TIMEOUT_MS: '1000' }).taskTimeoutMs, 1000);
});

test('the agent name is case-insensitive, a foreign name does not pass', () => {
  assert.equal(agentNameOf('Scout'), 'scout');
  assert.equal(agentNameOf(' RESEARCHER '), 'researcher');
  assert.equal(agentNameOf('хакер'), null);
  assert.deepEqual(Object.keys(AGENTS).sort(), ['researcher', 'scout', 'worker']);
});

test('the tool does not appear inside a subagent', () => {
  assert.equal(isSubagentProcess({}), false);
  assert.equal(isSubagentProcess({ [DEPTH_ENV]: '0' }), false);
  assert.equal(isSubagentProcess({ [DEPTH_ENV]: '1' }), true);
});

test("the child's arguments: its own tools, no foreign extensions and no nesting", () => {
  const spec = AGENTS.researcher;
  const args = buildChildArgs({
    spec,
    model: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash',
    systemPromptFile: '/tmp/system.md',
    extensionFiles: ['/home/node/.pi/agent/extensions/web-search.ts'],
  });
  const at = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  assert.ok(args.includes('--no-extensions'), 'расширения подключаются только свои');
  assert.equal(at('--extension'), '/home/node/.pi/agent/extensions/web-search.ts');
  assert.equal(at('--tools'), 'web_search,web_fetch,read,find,ls', 'чтению нужны и поиск по файлам, и ls');
  assert.equal(at('--exclude-tools'), 'subagent', 'вложенность запрещена даже на уровне флагов');
  assert.equal(at('--model'), 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(at('--append-system-prompt'), '/tmp/system.md');
  assert.ok(args.includes('--no-session'), 'своей сессии ребёнку не надо');
  assert.ok(!args.includes('--no-skills'), 'скиллами ребёнок пользуется: ими и работают задачи');
});

test('the worker gets everything: built-in tools, search, time and the panel', () => {
  const args = buildChildArgs({ spec: AGENTS.worker, systemPromptFile: '/tmp/system.md', extensionFiles: [] });
  const tools = args[args.indexOf('--tools') + 1] ?? '';
  const passed = tools.split(',');
  for (const tool of ALL_TOOLS) assert.ok(passed.includes(tool), `работнику не хватает ${tool}`);
  assert.ok(passed.includes('web_search'), 'веб-поиск работнику тоже положен');
  assert.ok(passed.includes('now'), 'и время: он может считать сроки');
  assert.deepEqual(AGENTS.worker.extensions, ['web-search.ts', 'clock.ts', 'control-panel.ts']);
  assert.equal(args[args.indexOf('--exclude-tools') + 1], 'subagent', 'а вложенность запрещена и ему');
});

test("role extensions are looked up in pi's directory and, when not found, are not attached", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-home-'));
  fs.mkdirSync(path.join(home, '.pi', 'agent', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'extensions', 'web-search.ts'), '// noop');
  assert.deepEqual(extensionFilesOf(AGENTS.researcher, home), [
    path.join(home, '.pi', 'agent', 'extensions', 'web-search.ts'),
  ]);
  assert.deepEqual(extensionFilesOf(AGENTS.worker, home), [
    path.join(home, '.pi', 'agent', 'extensions', 'web-search.ts'),
  ], 'у работника из расширений есть только то, что нашлось в каталоге');
  assert.deepEqual(extensionFilesOf(AGENTS.researcher, path.join(home, 'нет-такого')), []);
});

test('the queue keeps exactly as many workers as allowed', async () => {
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  await runPool(9, 3, async (index) => {
    running += 1;
    peak = Math.max(peak, running);
    order.push(index);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
  });
  assert.equal(order.length, 9);
  assert.equal(peak, 3);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'каждая задача запускается один раз');
});

test('an empty task list does not start the queue at all', async () => {
  let touched = false;
  await runPool(0, 4, async () => {
    touched = true;
  });
  assert.equal(touched, false);
});

test('report to the parent: statuses, reasons and truncation of long output', () => {
  const states: SubagentState[] = [
    { index: 0, agent: 'scout', task: 'посмотреть', status: 'ok', ms: 1200, output: 'нашёл три файла' },
    { index: 1, agent: 'researcher', task: 'искать', status: 'error', ms: 3000, error: 'таймаут: 5 с' },
  ];
  const limits = resolveLimits({});
  const report = renderReport(states, limits, 4000);
  assert.match(report, /2 задачи/);
  assert.match(report, /Готово 1, без результата 1/);
  assert.match(report, /нашёл три файла/);
  assert.match(report, /таймаут/);

  const long = renderReport(
    [{ index: 0, agent: 'worker', task: 'писать', status: 'ok', output: 'я'.repeat(20000) }],
    limits,
    1000,
  );
  assert.match(long, /обрезано/);
  assert.match(long, /8000/, 'в пометке об обрезке назван сам лимит');
  assert.ok(long.length < 9000, 'вывод в отчёте не превышает лимит с запасом на пометку');

  const fits = renderReport(
    [{ index: 0, agent: 'worker', task: 'писать', status: 'ok', output: 'я'.repeat(7000) }],
    limits,
    1000,
  );
  assert.ok(!/обрезано/.test(fits), 'вывод в пределах лимита проходит целиком');

  const progress = renderProgress(states, limits, 5000);
  assert.match(progress, /1 из 2/);
  assert.match(progress, /готово/);
  assert.match(progress, /ошибка/);
});

test('role prompts and the tool description know about the limit and about the file', () => {
  const tool = loadTool();
  const description = (tool as unknown as { description?: string }).description ?? '';
  assert.match(description, /8000/, 'в описании назван лимит вывода');
  assert.match(description, /файл/, 'в описании сказано, что делать с объёмным материалом');

  for (const agent of Object.values(AGENTS)) {
    assert.match(agent.systemPrompt, /коротк|сжат/i, `у роли ${agent.name} есть требование к краткости`);
    assert.match(agent.systemPrompt, /файл/i, `роль ${agent.name} умеет уносить объём в файл`);
  }
});

test('an empty set and an unknown agent are refusals without launching processes', async () => {
  const tool = loadTool();
  const ctx = { cwd: os.tmpdir(), model: { provider: 'p', id: 'm' } };

  const empty = await tool.execute('id', { tasks: [] }, undefined, undefined, ctx);
  assert.match(empty.content[0].text, /ни одной задачи/);

  const unknown = await tool.execute('id', { tasks: [{ agent: 'хакер', task: 'сломать' }] }, undefined, undefined, ctx);
  assert.match(unknown.content[0].text, /нет агента «хакер»/);
  assert.match(unknown.content[0].text, /scout/);
});

test('more than forty tasks per call are not accepted', async () => {
  const tool = loadTool();
  const ctx = { cwd: os.tmpdir(), model: { provider: 'p', id: 'm' } };
  const tasks = Array.from({ length: DEFAULT_MAX_TASKS + 1 }, () => ({ agent: 'scout', task: 'смотреть' }));
  const result = await tool.execute('id', { tasks }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /не больше 40/);
});

test('two tasks run and return a report: depth, arguments, progress', async () => {
  const fake = fakePi();
  await withEnv({ ICARUS_SUBAGENT_PI: fake.file, FAKE_PI_LOG: fake.log, FAKE_PI_TEXT: 'итог задачи' }, async () => {
    const tool = loadTool();
    const updates: ToolResult[] = [];
    const result = await tool.execute(
      'call-1',
      {
        tasks: [
          { agent: 'scout', task: 'найди файлы' },
          { agent: 'researcher', task: 'найди цены' },
        ],
      },
      undefined,
      (partial) => updates.push(partial),
      { cwd: os.tmpdir(), model: { provider: 'deepinfra', id: 'model' } },
    );

    assert.match(result.content[0].text, /Все дошли/);
    assert.match(result.content[0].text, /итог задачи/);
    const states = result.details.subagents as SubagentState[];
    assert.deepEqual(states.map((state) => state.status), ['ok', 'ok']);
    assert.ok(states.every((state) => typeof state.ms === 'number'));

    const log = readLog(fake.log);
    assert.equal(log.filter((entry) => entry.event === 'start').length, 2);
    for (const entry of log.filter((item) => item.event === 'start')) {
      assert.equal(entry.depth, '1', 'ребёнок обязан знать, что он ребёнок');
      assert.ok(entry.args?.includes('--exclude-tools'));
      assert.equal(entry.args?.[entry.args.indexOf('--exclude-tools') + 1], 'subagent');
    }

    assert.ok(updates.length >= 2, 'прогресс обязан приходить до финального отчёта');
    assert.ok(updates.some((update) => Array.isArray(update.details.subagents)));
  });
});

test('the queue limits parallelism in a real run too', async () => {
  const fake = fakePi();
  await withEnv(
    {
      ICARUS_SUBAGENT_PI: fake.file,
      FAKE_PI_LOG: fake.log,
      ICARUS_SUBAGENT_CONCURRENCY: '2',
      FAKE_PI_SLEEP_MS: '60',
    },
    async () => {
      const tool = loadTool();
      const tasks = Array.from({ length: 5 }, (_, index) => ({ agent: 'scout', task: `задача ${index}` }));
      const result = await tool.execute('call-2', { tasks }, undefined, undefined, {
        cwd: os.tmpdir(),
        model: { provider: 'p', id: 'm' },
      });
      const states = result.details.subagents as SubagentState[];
      assert.equal(states.length, 5);
      assert.ok(states.every((state) => state.status === 'ok'));

      const log = readLog(fake.log);
      assert.equal(log.filter((entry) => entry.event === 'start').length, 5);
      // All five write to the same log: before the first "end", no more than two manage to start.
      const firstEnd = log.findIndex((entry) => entry.event === 'end');
      assert.ok(firstEnd > 0);
      const startedBeforeEnd = log.slice(0, firstEnd).filter((entry) => entry.event === 'start').length;
      assert.equal(startedBeforeEnd, 2, 'третья задача должна ждать в очереди');
    },
  );
});

test('the ceiling of eight is for the whole process: a second call does not raise eight more', async () => {
  const fake = fakePi();
  await withEnv(
    {
      ICARUS_SUBAGENT_PI: fake.file,
      FAKE_PI_LOG: fake.log,
      ICARUS_SUBAGENT_CONCURRENCY: '8',
      FAKE_PI_SLEEP_MS: '60',
    },
    async () => {
      const tool = loadTool();
      const ctx = { cwd: os.tmpdir(), model: { provider: 'p', id: 'm' } };
      const make = (prefix: string) =>
        Array.from({ length: 8 }, (_, index) => ({ agent: 'scout', task: `${prefix} ${index}` }));
      await Promise.all([
        tool.execute('call-a', { tasks: make('a') }, undefined, undefined, ctx),
        tool.execute('call-b', { tasks: make('b') }, undefined, undefined, ctx),
      ]);
      const peak = peakFromLog(fake.log);
      assert.ok(peak <= MAX_CONCURRENCY, `одновременно работало ${peak} детей, потолок ${MAX_CONCURRENCY}`);
      assert.ok(peak >= 3, 'дети всё-таки идут параллельно, а не по одному');
    },
  );
});

test("a child's crash does not fail the call: the error is visible in the report", async () => {
  const fake = fakePi();
  await withEnv({ ICARUS_SUBAGENT_PI: fake.file, FAKE_PI_LOG: fake.log, FAKE_PI_FAIL: '2' }, async () => {
    const tool = loadTool();
    const result = await tool.execute(
      'call-3',
      { tasks: [{ agent: 'scout', task: 'упасть' }] },
      undefined,
      undefined,
      { cwd: os.tmpdir(), model: { provider: 'p', id: 'm' } },
    );
    const states = result.details.subagents as SubagentState[];
    assert.equal(states[0]?.status, 'error');
    assert.match(result.content[0].text, /без результата 1/);
  });
});

test('a task timeout is marked as an error instead of hanging forever', async () => {
  const fake = fakePi();
  await withEnv(
    {
      ICARUS_SUBAGENT_PI: fake.file,
      FAKE_PI_LOG: fake.log,
      FAKE_PI_SLEEP_MS: '5000',
      ICARUS_SUBAGENT_TASK_TIMEOUT_MS: '150',
    },
    async () => {
      const tool = loadTool();
      const startedAt = Date.now();
      const result = await tool.execute(
        'call-4',
        { tasks: [{ agent: 'scout', task: 'долго' }] },
        undefined,
        undefined,
        { cwd: os.tmpdir(), model: { provider: 'p', id: 'm' } },
      );
      const states = result.details.subagents as SubagentState[];
      assert.equal(states[0]?.status, 'error');
      assert.match(states[0]?.error ?? '', /таймаут/);
      assert.ok(Date.now() - startedAt < 4000, 'ждать пять секунд таймаута незачем');
    },
  );
});

test('aborting the turn kills the children and exits the tool', async () => {
  const fake = fakePi();
  await withEnv({ ICARUS_SUBAGENT_PI: fake.file, FAKE_PI_LOG: fake.log, FAKE_PI_SLEEP_MS: '5000' }, async () => {
    const tool = loadTool();
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = tool.execute(
      'call-5',
      { tasks: [{ agent: 'scout', task: 'долго' }] },
      controller.signal,
      undefined,
      { cwd: os.tmpdir(), model: { provider: 'p', id: 'm' } },
    );
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(() => running, /остановлены/);
    assert.ok(Date.now() - startedAt < 4000, 'прерывание не должно ждать конца задачи');
    const ends = readLog(fake.log).filter((entry) => entry.event === 'end');
    assert.equal(ends.length, 0, 'убитый ребёнок до конца не доходит');
  });
});

test('in a child process the extension stays silent', () => {
  const saved = process.env[DEPTH_ENV];
  process.env[DEPTH_ENV] = '1';
  try {
    const tools: unknown[] = [];
    register({ registerTool: (tool: unknown) => tools.push(tool), on: () => undefined } as unknown as ExtensionAPI);
    assert.equal(tools.length, 0, 'инструмент субагента ребёнку не регистрируется');
  } finally {
    if (saved === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = saved;
  }
});

test("the child's steps accumulate without repeats and don't grow endlessly", () => {
  const actions: string[] = [];
  assert.equal(rememberAction(actions, 'web_search: amazon.ie'), true);
  assert.equal(rememberAction(actions, 'web_search: amazon.ie'), false, 'повтор подряд новым шагом не считается');
  assert.deepEqual(actions, ['web_search: amazon.ie'], 'один и тот же шаг подряд не дублируется');
  assert.equal(rememberAction(actions, '   '), false, 'пустой шаг не копится');
  assert.deepEqual(actions, ['web_search: amazon.ie'], 'пустой шаг в список не попал');

  for (let index = 0; index < 20; index += 1) rememberAction(actions, `read: файл-${index}`);
  assert.equal(actions.length, 10, 'в списке только последние десять шагов');
  assert.equal(actions[actions.length - 1], 'read: файл-19');
});

test('the total step count is honest even when the list holds only the last ten', async () => {
  const fake = fakePi();
  await withEnv({ ICARUS_SUBAGENT_PI: fake.file, FAKE_PI_LOG: fake.log, FAKE_PI_ACTIONS: '12' }, async () => {
    const tool = loadTool();
    const result = await tool.execute(
      'call-actions',
      { tasks: [{ agent: 'scout', task: 'много ходить' }] },
      undefined,
      undefined,
      { cwd: os.tmpdir(), model: { provider: 'p', id: 'm' } },
    );
    const states = result.details.subagents as SubagentState[];
    assert.equal(states[0]?.actionsTotal, 12, 'всего шагов двенадцать');
    assert.equal(states[0]?.actions?.length, 10, 'а в списке — последние десять');
    assert.match(states[0]?.actions?.[0] ?? '', /q2/, 'список начинается с третьего шага');
  });
});

test('the details snapshot does not bloat with steps: long strings are truncated', () => {
  const states = [
    {
      index: 0,
      agent: 'researcher',
      task: 'искать',
      status: 'running' as const,
      actions: ['x'.repeat(500)],
    },
  ];
  const [state] = snapshot(states);
  assert.equal(state?.actions?.[0]?.length, 161, 'строка шага обрезана до 160 знаков плюс многоточие');
});
