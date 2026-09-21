#!/usr/bin/env node
// Минимальный RPC-клиент к pi внутри контейнера: гоняет подряд несколько реплик,
// печатает текст ответа и активность тулов. Это прототип будущего моста в icarus.
//
//   node tools/rpc-probe.mjs "Привет! Ты помнишь, кто я?" "Запомни: люблю кофе без сахара"
//
// Переменные: CONTAINER (по умолчанию icarus-test), MODEL (по умолчанию deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:off)
import { spawn } from 'node:child_process';

const container = process.env.CONTAINER || 'icarus-test';
const model = process.env.MODEL || 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:off';
const prompts = process.argv.slice(2);

if (prompts.length === 0) {
  console.error('укажи хотя бы одну реплику');
  process.exit(2);
}

const child = spawn(
  'docker',
  ['exec', '-i', container, 'pi', '--mode', 'rpc', '--no-session', '--model', model],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

let queue = [...prompts];
let settled = false;
const started = Date.now();

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function next() {
  const text = queue.shift();
  if (text === undefined) {
    console.log(`\n--- всё, ${((Date.now() - started) / 1000).toFixed(1)}с ---`);
    child.stdin.end();
    setTimeout(() => child.kill('SIGTERM'), 1500);
    return;
  }
  console.log(`\n=== [${((Date.now() - started) / 1000).toFixed(1)}с] пользователь: ${text}`);
  send({ type: 'prompt', message: text });
}

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

    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    switch (ev.type) {
      case 'message_update': {
        const d = ev.assistantMessageEvent;
        if (d?.type === 'text_delta') process.stdout.write(d.delta);
        if (d?.type === 'thinking_start') process.stdout.write('\n[думает] ');
        if (d?.type === 'thinking_delta') process.stdout.write('.');
        break;
      }
      case 'tool_execution_start':
        process.stdout.write(`\n  ⚙ ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 120)}\n`);
        break;
      case 'tool_execution_end':
        process.stdout.write(`  ↳ ${ev.isError ? 'ошибка' : 'ок'}\n`);
        break;
      case 'error':
      case 'extension_error':
        console.error('\n[ошибка]', JSON.stringify(ev).slice(0, 400));
        break;
      case 'agent_settled':
        if (!settled) {
          settled = true;
          setTimeout(() => {
            settled = false;
            next();
          }, 200);
        }
        break;
      default:
        break;
    }
  }
});

child.on('exit', (code) => {
  console.log(`\npi вышел с кодом ${code}`);
  process.exit(code ?? 0);
});

next();
