// Проверка MCP из панели: сервер должен уметь initialize и tools/list, а 401
// должен приезжать человеку как «нужна авторизация», а не как «сломалось».
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeMcp } from '../src/mcp/probe.ts';

type Seen = { method: string; url: string; body: string; headers: http.IncomingHttpHeaders };

async function withMcp(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void,
  run: (url: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
      handler(req, res, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/mcp`, seen);
  } finally {
    server.close();
  }
}

function json(res: http.ServerResponse, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

test('streamable HTTP: initialize, initialized и tools/list', async () => {
  await withMcp(
    (req, res, seen) => {
      const message = JSON.parse(seen[seen.length - 1]?.body || '{}') as { id?: number; method?: string };
      if (message.method === 'initialize') {
        json(res, {
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'todoist', version: '2.0.0' },
            capabilities: { tools: {} },
          },
        }, { 'mcp-session-id': 'session-1' });
        return;
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === 'tools/list') {
        assert.equal(req.headers['mcp-session-id'], 'session-1', 'сессия дальше едет заголовком');
        json(res, {
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'add_task' }, { name: 'list_tasks' }] },
        });
        return;
      }
      res.writeHead(400);
      res.end();
    },
    async (url, seen) => {
      const result = await probeMcp({ server: { transport: 'streamable-http', url } });
      assert.equal(result.ok, true);
      assert.deepEqual(result.tools, ['add_task', 'list_tasks']);
      assert.equal(result.server?.name, 'todoist');
      assert.equal(result.protocolVersion, '2025-06-18');
      assert.deepEqual(seen.map((item) => JSON.parse(item.body).method), [
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    },
  );
});

test('401 превращается в «нужна авторизация» с подсказкой resource_metadata', async () => {
  await withMcp(
    (_req, res) => {
      res.writeHead(401, {
        'www-authenticate': 'Bearer resource_metadata="https://auth.example/prm", scope="tasks:read"',
      });
      res.end('no');
    },
    async (url) => {
      const result = await probeMcp({ server: { transport: 'streamable-http', url } });
      assert.equal(result.ok, false);
      assert.equal(result.needsAuth, true);
      assert.equal(result.challenge?.resourceMetadata, 'https://auth.example/prm');
      assert.equal(result.challenge?.scope, 'tasks:read');
    },
  );
});

test('сервер, отвечающий JSON-RPC ошибкой, не выдаёт себя за рабочий', async () => {
  await withMcp(
    (_req, res) => {
      json(res, { jsonrpc: '2.0', id: 1, error: { message: 'unsupported protocol' } });
    },
    async (url) => {
      const result = await probeMcp({ server: { transport: 'streamable-http', url } });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /unsupported protocol/);
    },
  );
});

test('legacy SSE: endpoint из потока, initialize и tools/list по нему', async () => {
  let stream: http.ServerResponse | null = null;
  await withMcp(
    (req, res, seen) => {
      if (req.method === 'GET' && req.url?.startsWith('/sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: endpoint\ndata: /messages?session=s1\n\n');
        stream = res;
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/messages')) {
        res.writeHead(202);
        res.end();
        const message = JSON.parse(seen[seen.length - 1]?.body || '{}') as { id?: number; method?: string };
        if (message.method === 'initialize') {
          stream?.write(`event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18', serverInfo: { name: 'legacy' }, capabilities: { tools: {} } },
          })}\n\n`);
        }
        if (message.method === 'tools/list') {
          stream?.write(`event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'ping' }] },
          })}\n\n`);
        }
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async (url, seen) => {
      const sseUrl = url.replace('/mcp', '/sse');
      const result = await probeMcp({ server: { transport: 'sse', url: sseUrl } });
      assert.equal(result.ok, true);
      assert.deepEqual(result.tools, ['ping']);
      assert.equal(result.server?.name, 'legacy');
      assert.deepEqual(seen.map((item) => item.method), ['GET', 'POST', 'POST', 'POST']);
    },
  );
});

test('stdio не проверяется из сервиса: это код в контейнере', async () => {
  const result = await probeMcp({ server: { transport: 'stdio', command: 'node', args: ['/opt/server.mjs'] } });
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.match(result.error ?? '', /контейнер/);
});
