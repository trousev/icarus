// Interrupting a turn for a new utterance: the pi queue is cleared, abort is sent, and only
// after `agent_settled` can the session be occupied again. Tested against a pi stub:
// the order of commands matters to us, and that the method really waits for the end of the turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiSession } from '../src/sessions/pi-session.ts';
import { modelTierEnv } from '../src/docker/spec.ts';
import type { Spawner } from '../src/sessions/rpc-client.ts';
import { makeConfig, probe } from './fixtures.ts';

/**
 * A pi stub: responds to commands and sends `agent_settled` after abort — like
 * the real pi, which shuts down the tools and only then declares the turn finished.
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

/** A stub that remembers the commands and the launch environment. */
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

test('interrupt clears the queue, sends abort and waits for the turn to settle', async () => {
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
    // Queue before abort: otherwise pi would finish the deferred messages of the previous turn.
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['clear_queue', 'abort']);
    session.dispose();
  } finally {
    delete process.env.STUB_LOG;
  }
});

test('tier models go into the container: subagents have someone to take', () => {
  const config = makeConfig();
  assert.deepEqual(modelTierEnv(config), {
    ICARUS_MODEL_FAST: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:low',
    ICARUS_MODEL_STRONG: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:medium',
  });
  assert.deepEqual(modelTierEnv({ ...config, models: [{ provider: 'x', id: 'y' }] }), {});
});

test('in production the model name comes from the config, not from the host environment', async () => {
  const envs: Array<Record<string, string>> = [];
  const session = makeSession(stubSpawner(envs));
  session.dispose();
  assert.equal(envs[0]?.ICARUS_MODEL_FAST, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:low');
  assert.equal(envs[0]?.ICARUS_MODEL_STRONG, 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:medium');
  assert.ok(envs[0]?.ICARUS_CHANNEL, 'канал разговора тоже передаётся');
  assert.match(envs[0]?.ICARUS_SEARCH_URL ?? '', /^http:\/\/icarus:\d+$/, 'адрес роутера задан и не требует токена');
});

test('the search router address is built from the service port', () => {
  const envs: Array<Record<string, string>> = [];
  const config = makeConfig({ port: 8081 });
  const session = new PiSession(config, probe(), 'telegram-1', config.models[0], 'stub', 0, stubSpawner(envs));
  session.dispose();
  assert.equal(envs[0]?.ICARUS_SEARCH_URL, 'http://icarus:8081');
});
