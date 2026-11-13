// The cinema MCP in the shared suite: the server lives in tools/arr-mcp, here is a short
// integration over real stdio, so CI at least sees the essentials: lookup
// orders nothing, and arr_add without confirm never reaches the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const SERVER = path.resolve(import.meta.dirname, '../../../tools/arr-mcp/server.mjs');

type FakeArr = {
  url: string;
  posts: Array<{ path: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
};

/** Exactly the routes the "found → added" scenario needs. */
async function fakeRadarr(): Promise<FakeArr> {
  const posts: FakeArr['posts'] = [];
  const movie = {
    title: 'Прибытие',
    tmdbId: 329865,
    year: 2016,
    overview: 'Лингвист пытается понять язык пришельцев.',
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== 'radarr-secret') return json(401, { message: 'Unauthorized' });
    const route = url.pathname.replace(/^\/api\/v3/, '');
    if (route === '/movie/lookup') return json(200, [movie]);
    if (route === '/movie/lookup/tmdb') return json(200, movie);
    if (route === '/movie' && req.method === 'GET') return json(200, []);
    if (route === '/movie' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        posts.push({ path: route, body: parsed });
        json(201, { ...parsed, id: 1, path: '/movies/Прибытие (2016)' });
      });
      return;
    }
    if (route === '/qualityprofile') return json(200, [{ id: 4, name: 'HD-1080p', cutoff: 7 }]);
    if (route === '/rootfolder') return json(200, [{ id: 1, path: '/movies', accessible: true }]);
    return json(404, { message: `нет маршрута: ${req.method} ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    posts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Rpc = {
  call: (message: Record<string, unknown>) => Promise<Record<string, any>>;
  tool: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  stop: () => Promise<void>;
};

async function start(env: Record<string, string>): Promise<Rpc> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let id = 0;
  const pending = new Map<number, (value: Record<string, any>) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  child.stderr.on('data', () => {
    // the test doesn't need server diagnostics
  });
  const call = (message: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...message })}\n`);
    });
  return {
    call,
    tool: async (name, args = {}) => {
      const message = await call({ method: 'tools/call', params: { name, arguments: args } });
      return {
        text: ((message.result?.content ?? []) as Array<{ text?: string }>).map((item) => item.text ?? '').join('\n'),
        isError: message.result?.isError === true,
      };
    },
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill(), 1000).unref();
      }),
  };
}

test('cinema MCP: lookup is read-only, ordering only with confirmation', async () => {
  const radarr = await fakeRadarr();
  const rpc = await start({
    ARR_RADARR_URL: radarr.url,
    ARR_RADARR_KEY: 'radarr-secret',
  });
  try {
    const init = await rpc.call({ method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'arr');
    assert.match(init.result.instructions, /confirm: true/);

    const found = await rpc.tool('arr_lookup', { kind: 'movie', term: 'Прибытие' });
    assert.equal(found.isError, false, found.text);
    assert.match(found.text, /Прибытие \(2016\)/);
    assert.match(found.text, /НЕ заказан/);
    assert.equal(radarr.posts.length, 0, 'lookup не имеет права заказывать файл');

    const refused = await rpc.tool('arr_add', { kind: 'movie', id: 329865 });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /confirm: true/);
    assert.equal(radarr.posts.length, 0, 'без confirm POST не должен уходить');

    const added = await rpc.tool('arr_add', { kind: 'movie', id: 329865, confirm: true });
    assert.equal(added.isError, false, added.text);
    assert.match(added.text, /ЗАКАЗАНО \(Radarr\)/);
    assert.equal(radarr.posts.length, 1);
    assert.equal(radarr.posts[0].body.tmdbId, 329865);
    assert.equal(radarr.posts[0].body.qualityProfileId, 4);
    assert.equal(radarr.posts[0].body.rootFolderPath, '/movies');
  } finally {
    await rpc.stop();
    await radarr.close();
  }
});
