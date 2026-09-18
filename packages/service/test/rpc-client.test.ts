// RPC-мост: корреляция команд и событий на заглушке вместо pi в контейнере.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { RpcClient, type Spawner } from '../src/sessions/rpc-client.ts';

const STUB = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'привет' } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
    }
    process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: { echo: cmd.type } }) + '\\n');
  }
});
`;

function stubSpawner(): Spawner {
  return () => spawn(process.execPath, ['-e', STUB], { stdio: ['pipe', 'pipe', 'pipe'] });
}

test('команда получает ответ с тем же id', async () => {
  const client = new RpcClient({} as any, 'stub', [], stubSpawner());
  const response = await client.request({ type: 'get_state' });
  assert.equal(response.success, true);
  assert.deepEqual(response.data, { echo: 'get_state' });
  client.dispose();
});

test('события приходят подписчику и не мешают ответам', async () => {
  const client = new RpcClient({} as any, 'stub', [], stubSpawner());
  const seen: string[] = [];
  client.onEvent((event) => seen.push(event.type));

  await client.request({ type: 'prompt', message: 'привет' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.ok(seen.includes('message_update'), 'должен прийти текст');
  assert.ok(seen.includes('agent_settled'), 'ход должен завершиться');
  client.dispose();
});

test('таймаут не виснет навсегда', async () => {
  const silent: Spawner = () => spawn(process.execPath, ['-e', 'process.stdin.resume();'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new RpcClient({} as any, 'stub', [], silent);
  await assert.rejects(() => client.request({ type: 'get_state' }, 300), /таймаут/);
  client.dispose();
});

test('после закрытия канала команды отклоняются', async () => {
  const client = new RpcClient({} as any, 'stub', [], stubSpawner());
  client.dispose();
  await assert.rejects(() => client.request({ type: 'get_state' }), /закрыт/);
});
