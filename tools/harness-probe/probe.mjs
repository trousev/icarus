#!/usr/bin/env node
// Пробник второго движка: Claude Code headless против Anthropic-совместимого
// эндпоинта (по умолчанию DeepSeek) → события хода Икара.
//
//   ANTHROPIC_API_KEY=... node tools/harness-probe/probe.mjs \
//     --prompt "Ответь ровно: PONG" --out /tmp/probe
//
// Или ключ из файла (значение не печатается и не попадает в стенд):
//
//   node tools/harness-probe/probe.mjs --env-file .env --key-env DEEPSEEK_API_KEY ...
//
// Что делает: поднимает `claude --bare -p --input-format stream-json
// --output-format stream-json`, шлёт одну реплику, пишет raw.jsonl (как пришло),
// turn.jsonl (наши события), summary.json и HTML-стенд. В сеть сам не ходит —
// ходит Claude Code; парсер (parse.mjs) проверяется тестами без сети.
//
// Почему --bare и свой HOME: иначе Claude Code читает ~/.claude/settings.json,
// плагины, хуки и CLAUDE.md человека. В этой песочнице его settings.json
// переопределяет ANTHROPIC_BASE_URL на локальный прокси — прогон «против
// DeepSeek» на самом деле шёл бы в прокси. Изоляция — часть честности прогона.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createTurnStream } from './parse.mjs';
import { renderReport } from './report.mjs';

const args = process.argv.slice(2);

function take(name, fallback) {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} без значения`);
  return value;
}

function takeAll(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} без значения`);
    values.push(value);
  }
  return values;
}

function has(name) {
  return args.includes(name);
}

function usage() {
  console.log(`Пробник Claude Code → события Икара.

  node tools/harness-probe/probe.mjs --prompt "..." [опции]

  --prompt <текст>        реплика (обязательна)
  --out <каталог>         куда писать raw.jsonl, turn.jsonl, summary.json (по умолчанию ./harness-probe-out)
  --cwd <каталог>         рабочий каталог агента (по умолчанию <out>/cwd)
  --seed <файл=текст>     создать файл в cwd до прогона (можно несколько)
  --model <имя>           модель (по умолчанию deepseek-chat)
  --base-url <url>        Anthropic-совместимый эндпоинт (по умолчанию https://api.deepseek.com/anthropic)
  --env-file <файл>       взять ключ из KEY=VALUE файла (вместе с --key-env)
  --key-env <имя>         имя переменной в --env-file (по умолчанию DEEPSEEK_API_KEY)
  --claude <путь>         бинарь claude (по умолчанию $CLAUDE_BIN или claude в PATH)
  --timeout <мс>          сколько ждать result (по умолчанию 120000)
  --max-turns <n>         предел ходов модели (по умолчанию 4)
  --allowed-tools <csv>   что разрешено без вопросов (по умолчанию Read)
  --tools <csv>           явный список инструментов (--tools у Claude Code)
  --thinking              тащить thinking-дельты в turn.jsonl
  --keep-home             не изолировать HOME (для отладки; на результат влияют настройки человека)
  --keep-session          не передавать --no-session-persistence
  --html <файл>           куда положить стенд (по умолчанию <out>/report.html)
  --no-html               не собирать стенд
  --json                  напечатать summary.json в stdout
  -h, --help              эта справка`);
}

if (has('-h') || has('--help')) {
  usage();
  process.exit(0);
}

const prompt = take('--prompt', '');
if (!prompt) {
  usage();
  console.error('\n[x] нужен --prompt');
  process.exit(2);
}

const out = path.resolve(take('--out', 'harness-probe-out'));
const cwd = path.resolve(take('--cwd', path.join(out, 'cwd')));
const baseUrl = take('--base-url', process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic');
const model = take('--model', 'deepseek-chat');
const timeoutMs = Number(take('--timeout', '120000'));
const maxTurns = take('--max-turns', '4');
const allowedTools = take('--allowed-tools', 'Read');
const tools = take('--tools', '');
const keepHome = has('--keep-home');
const keepSession = has('--keep-session');
const wantThinking = has('--thinking');
const htmlPath = has('--no-html') ? null : path.resolve(take('--html', path.join(out, 'report.html')));
const claudeBin = take('--claude', process.env.CLAUDE_BIN || 'claude');
const envFile = take('--env-file', '');
const keyEnv = take('--key-env', 'DEEPSEEK_API_KEY');

/** Ключ: окружение сильнее файла; в вывод не попадает ни при каких условиях. */
function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN;
  if (!envFile) return '';
  const file = fs.readFileSync(envFile, 'utf8');
  for (const line of file.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== keyEnv) continue;
    return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const key = readKey();
if (!key) {
  console.error(`[x] нет ключа: задай ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN или --env-file + --key-env (${keyEnv})`);
  process.exit(2);
}

const redact = (text) => String(text ?? '').split(key).join('***');

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
for (const seed of takeAll('--seed')) {
  const eq = seed.indexOf('=');
  const name = eq === -1 ? seed : seed.slice(0, eq);
  const content = eq === -1 ? '' : seed.slice(eq + 1);
  const target = path.join(cwd, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const homeDir = path.join(out, 'home');
if (!keepHome) fs.mkdirSync(homeDir, { recursive: true });

const claudeArgs = [
  '--bare',
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--model',
  model,
  '--max-turns',
  maxTurns,
  '--allowedTools',
  allowedTools,
  ...(tools ? ['--tools', tools] : []),
  ...(keepSession ? [] : ['--no-session-persistence']),
];

const childEnv = { ...process.env };
// Обоих сразу Claude Code не любит; лишние модели из окружения песочницы
// подменили бы нашу и сломали бы сравнение движков.
delete childEnv.ANTHROPIC_AUTH_TOKEN;
delete childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
delete childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
delete childEnv.CLAUDE_CODE_SUBAGENT_MODEL;
childEnv.ANTHROPIC_BASE_URL = baseUrl;
childEnv.ANTHROPIC_API_KEY = key;
childEnv.ANTHROPIC_MODEL = model;
childEnv.ANTHROPIC_SMALL_FAST_MODEL = model;
childEnv.DISABLE_AUTOUPDATER = '1';
childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
if (!keepHome) childEnv.HOME = homeDir;

const version = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', env: { ...childEnv } });
const claudeVersion = (version.stdout || '').trim() || null;

const startedAt = new Date();
const started = Date.now();
const stream = createTurnStream({ includeThinking: wantThinking });
const rawLines = [];
const rows = [];
const stderrLines = [];
let firstEventMs = null;
let firstTextMs = null;
let resultMs = null;
let malformed = 0;
let gotResult = false;
let timedOut = false;
let spawnError = '';

const child = spawn(claudeBin, claudeArgs, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
const timer = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
}, timeoutMs);

child.on('error', (error) => {
  spawnError = String(error);
});

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl === -1) break;
    let line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const atMs = Date.now() - started;
    if (firstEventMs === null) firstEventMs = atMs;
    rawLines.push(event);
    const mapped = stream.push(event);
    if (firstTextMs === null && mapped.some((item) => item.type === 'text')) firstTextMs = atMs;
    if (event.type === 'result' && !gotResult) {
      gotResult = true;
      resultMs = atMs;
      // result — последняя строка хода; закрываем stdin, чтобы CLI вышел сам.
      setTimeout(() => child.stdin.end(), 50);
    }
    const rawType =
      String(event.type ?? '?') +
      (typeof event.subtype === 'string' ? `:${event.subtype}` : '') +
      (typeof event.event?.type === 'string' ? `/${event.event.type}` : '');
    rows.push({ index: rows.length, atMs, rawType, events: mapped });
  }
});

child.stderr.on('data', (chunk) => {
  const text = redact(chunk.toString('utf8')).trim();
  if (text) stderrLines.push(text);
});

child.stdin.write(
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n',
);

/** Добиваем ход, если result не пришёл: молчаливый успех был бы враньём. */
function finishStream() {
  const tail = stream.finish();
  if (tail.length > 0) {
    const atMs = Date.now() - started;
    for (const event of tail) rows.push({ index: rows.length, atMs, rawType: 'нет result', events: [event] });
  }
}

function statusOf() {
  if (spawnError) return 'spawn-error';
  // Таймаут и оборванный поток важнее синтетической ошибки, которую finish()
  // добавляет уже после закрытия процесса: иначе timeout выглядел бы как error.
  if (timedOut) return 'timeout';
  if (!gotResult) return 'truncated';
  const errorRow = rows.find((row) => row.events.some((event) => event.type === 'error'));
  return errorRow ? 'error' : 'ok';
}

child.on('close', (code) => {
  clearTimeout(timer);
  finishStream();
  const finishedAt = Date.now();
  const status = statusOf();
  const engineInfo = stream.engine ?? {};
  const doneEvent = rows.flatMap((row) => row.events).find((event) => event.type === 'done');
  const errorEvent = rows.flatMap((row) => row.events).find((event) => event.type === 'error');

  // Строки без события — не поломка: status/thinking_tokens/ui_invalidate — шум.
  const ignored = Object.create(null);
  for (const row of rows) {
    if (row.rawType === 'нет result') continue;
    if (row.events.length > 0) continue;
    ignored[row.rawType] = (ignored[row.rawType] ?? 0) + 1;
  }

  const summary = {
    status,
    engine: 'claude-code',
    claudeVersion,
    model,
    baseUrl,
    prompt,
    cwd,
    isolation: keepHome ? 'HOME человека (отладка)' : 'изолированный HOME + --bare',
    allowedTools,
    toolsFlag: tools || null,
    command: [claudeBin, ...claudeArgs],
    startedAt: startedAt.toISOString(),
    wallMs: finishedAt - started,
    firstEventMs,
    firstTextMs,
    resultMs,
    exitCode: code,
    rawEvents: rawLines.length,
    mappedEvents: rows.reduce((sum, row) => sum + row.events.length, 0),
    malformedLines: malformed,
    ignoredTypes: ignored,
    unknownTypes: stream.unknownTypes,
    engineInfo: {
      tools: engineInfo.tools ?? [],
      mcpServers: engineInfo.mcpServers ?? [],
      permissionMode: engineInfo.permissionMode ?? null,
      sessionId: engineInfo.sessionId ?? null,
      model: engineInfo.model ?? null,
    },
    result: doneEvent
      ? {
          text: doneEvent.result,
          usage: doneEvent.usage,
          costUsd: doneEvent.costUsd,
          durationMs: doneEvent.durationMs,
          numTurns: doneEvent.numTurns,
          steps: doneEvent.steps,
          permissionDenials: doneEvent.permissionDenials,
        }
      : null,
    error: errorEvent?.message ?? (spawnError || null),
    stderr: stderrLines.slice(0, 20),
    timelineLimit: 28,
  };

  fs.writeFileSync(path.join(out, 'raw.jsonl'), rawLines.map((event) => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(
    path.join(out, 'turn.jsonl'),
    rows.flatMap((row) => row.events).map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (htmlPath) {
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, renderReport({ summary, rows }));
  }

  if (has('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`движок:     Claude Code ${claudeVersion ?? '(версия?)'} · ${model}`);
    console.log(`эндпоинт:   ${baseUrl}`);
    console.log(`статус:     ${status}`);
    console.log(
      `время:      ${(summary.wallMs / 1000).toFixed(2)} с · первый event ${firstEventMs === null ? '—' : `${firstEventMs} мс`} · result ${resultMs === null ? '—' : `${resultMs} мс`}`,
    );
    console.log(`поток:      ${summary.rawEvents} строк → ${summary.mappedEvents} событий Икара`);
    console.log(`инструменты: ${engineInfo.tools?.length ?? 0} доступно (${(engineInfo.tools ?? []).slice(0, 8).join(', ')})`);
    if (summary.result) {
      console.log(`ответ:      ${JSON.stringify(summary.result.text)}`);
      console.log(
        `токены:     вход ${summary.result.usage?.input_tokens ?? '—'} · выход ${summary.result.usage?.output_tokens ?? '—'} · ходов ${summary.result.numTurns ?? '—'}`,
      );
    }
    if (summary.error) console.log(`ошибка:     ${summary.error}`);
    console.log(`файлы:      ${out}/${htmlPath ? ' · report.html' : ''}`);
  }
  process.exit(status === 'ok' ? 0 : 1);
});
