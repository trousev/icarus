// Локальный прокси OAuth-MCP: pi больше не держит протухающий Bearer в конфиге.
//
// Тест держит две вещи, которые важны в жизни: заголовок Authorization подменяется
// на каждом запросе, а просроченный токен обновляется по refresh_token до похода
// в настоящий MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createIcarus } from '../src/http/server.ts';
import { createServer as createMcp, saveOAuthCredentials } from '../src/mcp/registry.ts';
import { makeConfig } from './fixtures.ts';

type Seen = { authorization?: string; method?: string; url?: string; body?: string };

function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function bodyOf(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    req.on('end', () => resolve(text));
  });
}

function json(res: http.ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

async function withIcarus(run: (base: string, config: ReturnType<typeof makeConfig>) => Promise<void>): Promise<void> {
  const config = makeConfig();
  const server = createIcarus(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, config);
  } finally {
    server.close();
  }
}

const KEY = 'p'.repeat(32);

test('прокси подставляет Bearer и не пропускает клиентский Authorization', async () => {
  const seen: Seen[] = [];
  const upstream = await listen(async (req, res) => {
    seen.push({
      authorization: req.headers.authorization,
      method: req.method,
      url: req.url,
      body: await bodyOf(req),
    });
    json(res, { jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  try {
    await withIcarus(async (base, config) => {
      const mcp = createMcp(config, 'probe', {
        name: 'Проксируемый',
        transport: 'streamable-http',
        url: `${upstream.base}/mcp`,
        auth: 'oauth',
      });
      saveOAuthCredentials(config, 'probe', mcp.id, {
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 3_600_000,
        tokenEndpoint: `${upstream.base}/token`,
        clientId: 'client-1',
        resource: `${upstream.base}/mcp`,
        proxyKey: KEY,
      });

      const response = await fetch(`${base}/mcp-proxy/${KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer evil' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: { tools: [] } });

      assert.equal(seen[0]?.authorization, 'Bearer token-1', 'клиентский Authorization заменён токеном сервиса');
      assert.equal(seen[0]?.method, 'POST');
      assert.equal(seen[0]?.url, '/mcp', 'путь настоящего MCP сохранён');
      assert.match(seen[0]?.body ?? '', /tools\/list/);
    });
  } finally {
    upstream.server.close();
  }
});

test('просроченный токен обновляется по refresh_token до запроса в MCP', async () => {
  let tokenBody = '';
  const as = await listen(async (req, res) => {
    tokenBody = await bodyOf(req);
    json(res, { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 300 });
  });
  const seen: Seen[] = [];
  const upstream = await listen(async (req, res) => {
    seen.push({ authorization: req.headers.authorization });
    json(res, { jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  try {
    await withIcarus(async (base, config) => {
      const mcp = createMcp(config, 'probe', {
        name: 'Протухший',
        transport: 'streamable-http',
        url: `${upstream.base}/mcp`,
        auth: 'oauth',
      });
      saveOAuthCredentials(config, 'probe', mcp.id, {
        accessToken: 'old-token',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1000,
        tokenEndpoint: `${as.base}/token`,
        clientId: 'client-1',
        tokenEndpointAuthMethod: 'none',
        resource: `${upstream.base}/mcp`,
        proxyKey: KEY,
      });

      const response = await fetch(`${base}/mcp-proxy/${KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(response.status, 200);
      assert.equal(seen[0]?.authorization, 'Bearer new-token', 'MCP увидел уже свежий токен');

      const form = new URLSearchParams(tokenBody);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'refresh-1');
      assert.equal(form.get('resource'), `${upstream.base}/mcp`);
    });
  } finally {
    as.server.close();
    upstream.server.close();
  }
});

test('SSE-поток проходит через прокси как поток, а не буфером', async () => {
  const upstream = await listen((req, res) => {
    if (req.method !== 'GET') {
      json(res, { ok: false }, 405);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
    setTimeout(() => res.end(), 30);
  });

  try {
    await withIcarus(async (base, config) => {
      const mcp = createMcp(config, 'probe', {
        name: 'SSE',
        transport: 'sse',
        url: `${upstream.base}/sse`,
        auth: 'oauth',
      });
      saveOAuthCredentials(config, 'probe', mcp.id, {
        accessToken: 'token-1',
        expiresAt: Date.now() + 3_600_000,
        proxyKey: KEY,
      });

      const response = await fetch(`${base}/mcp-proxy/${KEY}`, { method: 'GET' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const text = await response.text();
      assert.match(text, /event: message/);
      assert.match(text, /"ok":true/);
    });
  } finally {
    upstream.server.close();
  }
});

test('неизвестный ключ не открывает чужой MCP', async () => {
  await withIcarus(async (base) => {
    const response = await fetch(`${base}/mcp-proxy/${'x'.repeat(32)}`);
    assert.equal(response.status, 404);
  });
});
