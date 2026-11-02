// Прерывание хода под новую реплику: очередь pi чистится, abort уходит, и только
// после `agent_settled` сессию можно занимать снова. Проверяется на заглушке pi:
// нам важен порядок команд и то, что метод действительно ждёт конца хода.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiSession, modelEnv } from '../src/sessions/pi-session.ts';
import type { Spawner } from '../src/sessions/rpc-client.ts';
import { makeConfig, probe } from './fixtures.ts';

/**
 * Заглушка pi: отвечает на команды и присылает `agent_settled` после abort — как
 * настоящий pi, который гасит инструменты и только потом объявляет ход вставшим.
 */
const STUB = `
import fs from 'node:fs';
let buf = '';
const seen = [];
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    seen.push(cmd.type);
    if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, cmd.type + '\\n');
    process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: { seen } }) + '\\n');
    if (cmd.type === 'abort') {
      setTimeout(() => process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n'), 120);
    }
  }
});
process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
`;

/** Заглушка, которая помнит команды и окружение запуска. */
function stubSpawner(envs: Array<Record<string, string>> = []): Spawner {
  return (_container, _args, env) => {
    if (env) envs.push(env);
    return spawn(process.execPath, ['-e', STUB], { stdio: ['pipe', 'pipe', 'pipe'] });
  };
}

function makeSession(spawner: Spawner): PiSession {
  const config = makeConfig();
  return new PiSession(config, probe(), 'telegram-4242', config.models[0], 'stub', 0, spawner);
}

test('прерывание чистит очередь, шлёт abort и ждёт, пока ход встанет', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-interrupt-')), 'commands.log');
  process.env.STUB_LOG = log;
  try {
    const session = makeSession(stubSpawner());
    session.busy = true;
    const startedAt = Date.now();

    const stopped = await session.interrupt(5_000);
    const elapsed = Date.now() - startedAt;

    assert.equal(stopped, true);
    assert.equal(session.busy, false, 'после прерывания сессия свободна');
    assert.ok(elapsed >= 100, 'ждали agent_settled, а не просто ответ на abort');
    // Очередь до abort: иначе pi доиграл бы отложенные сообщения прошлого хода.
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['clear_queue', 'abort']);
    session.dispose();
  } finally {
    delete process.env.STUB_LOG;
  }
});

test('модели уровней уезжают в контейнер: субагентам есть кого брать', () => {
  const config = makeConfig();
  assert.deepEqual(modelEnv(config), {
    ICARUS_MODEL_FAST: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash',
    ICARUS_MODEL_STRONG: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash',
  });
  assert.deepEqual(modelEnv({ ...config, models: [{ provider: 'x', id: 'y' }] }), {});
});

test('в бою имя модели приходит из конфига, а не из окружения хоста', async () => {
  const envs: Array<Record<string, string>> = [];
  const session = makeSession(stubSpawner(envs));
  session.dispose();
  assert.equal(envs[0]?.ICARUS_MODEL_FAST, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(envs[0]?.ICARUS_MODEL_STRONG, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash');
  assert.ok(envs[0]?.ICARUS_CHANNEL, 'канал разговора тоже передаётся');
});
