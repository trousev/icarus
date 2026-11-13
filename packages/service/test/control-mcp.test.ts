// The MCP panel end to end: added, shared, enabled, key configured, OAuth passed.
//
// The test goes through the panel's real HTTP server, not internal functions:
// a person clicks buttons in the browser, and permissions/visibility must be checked in the same
// place where prod will check them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths } from '../src/config.ts';
import { prepareUser } from '../src/workspace.ts';
import { effectiveServers, readStore } from '../src/mcp/registry.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

const USERS = [probe('probe'), probe('probe2')];

function headers(userId?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(userId === undefined ? {} : { [PANEL_USER_HEADER]: userId }) };
}

function piMcp(config: ReturnType<typeof makeConfig>, userId: string): { mcpServers: Record<string, Record<string, unknown>> } {
  const file = path.join(userPaths(config, probe(userId)).piAgent, 'mcp.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
}

async function withServer(
  run: (base: string, config: ReturnType<typeof makeConfig>, registry: Record<string, unknown>) => Promise<void>,
  overrides: Parameters<typeof makeConfig>[0] = {},
): Promise<void> {
  const config = makeConfig({ users: USERS, ...overrides });
  // This is what index.ts does at startup: the environment is ready for all people, not only for
  // the one who pressed a button in the panel first.
  for (const user of config.users) prepareUser(config, user);
  const registry = {
    bumpResources: () => 0,
    oneShot: async () => '',
    list: () => [],
  };
  const server = createServer(config, registry as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  // The OAuth redirect_uri and client_id link are built from this address.
  config.url = base;
  try {
    await run(base, config, registry);
  } finally {
    server.close();
  }
}

const api = (base: string, user: string, route: string, init: RequestInit = {}) =>
  fetch(`${base}/panel/mcp/${route}`, {
    ...init,
    headers: { ...headers(user), ...(init.headers ?? {}) },
  });

const add = (base: string, user: string, body: Record<string, unknown>) =>
  api(base, user, 'add', { method: 'POST', body: JSON.stringify(body) });

const post = (base: string, user: string, route: string, body: Record<string, unknown>) =>
  api(base, user, route, { method: 'POST', body: JSON.stringify(body) });

test('a server is added, lands in mcp.json and is visible only to the owner', async () => {
  await withServer(async (base, config) => {
    const response = await add(base, 'probe', {
      name: 'Задачи',
      description: 'Списки задач',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      auth: 'none',
    });
    assert.equal(response.status, 200);
    const created = (await response.json()) as { server: { id: string; enabled: boolean } };
    assert.equal(created.server.enabled, true);

    const mine = (await (await api(base, 'probe', 'servers')).json()) as { servers: Array<{ id: string }> };
    const other = (await (await api(base, 'probe2', 'servers')).json()) as { servers: Array<{ id: string }> };
    assert.deepEqual(mine.servers.map((item) => item.id), [created.server.id]);
    assert.deepEqual(other.servers, []);

    assert.deepEqual(Object.keys(piMcp(config, 'probe').mcpServers), [created.server.id]);
    assert.deepEqual(Object.keys(piMcp(config, 'probe2').mcpServers), []);
  });
});

test('shared — arrives disabled; only you can enable it for yourself', async () => {
  await withServer(async (base, config) => {
    const created = (await (
      await add(base, 'probe', {
        name: 'Todoist',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        auth: 'none',
      })
    ).json()) as { server: { id: string } };

    const shared = await post(base, 'probe', 'share', { id: created.server.id, shared: true });
    assert.equal(shared.status, 200);

    const seen = (await (await api(base, 'probe2', 'servers')).json()) as {
      servers: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(seen.servers[0]?.enabled, false, 'расшаренный приходит выключенным');
    assert.doesNotMatch(fs.readFileSync(path.join(userPaths(config, probe('probe2')).piAgent, 'mcp.json'), 'utf8'), /Todoist/);

    await post(base, 'probe2', 'toggle', { id: created.server.id, enabled: true });
    assert.deepEqual(Object.keys(piMcp(config, 'probe2').mcpServers), [created.server.id]);
    // Nothing changed for the owner because of this.
    assert.equal(
      ((await (await api(base, 'probe', 'servers')).json()) as { servers: Array<{ enabled: boolean }> }).servers[0]?.enabled,
      true,
    );
  });
});

test('keys are not copied along with sharing: the second person needs their own', async () => {
  await withServer(async (base, config) => {
    const created = (await (
      await add(base, 'probe', {
        name: 'Ключевой',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        auth: 'headers',
        credentialHeaders: { Authorization: 'Bearer owner-secret' },
      })
    ).json()) as { server: { id: string } };
    await post(base, 'probe', 'share', { id: created.server.id, shared: true });
    await post(base, 'probe2', 'toggle', { id: created.server.id, enabled: true });

    assert.deepEqual(Object.keys(piMcp(config, 'probe2').mcpServers), [], 'без своего ключа сервер не готов');

    const raw = fs.readFileSync(path.join(config.dataDir, 'mcp', 'credentials.json'), 'utf8');
    assert.doesNotMatch(raw, /owner-secret.*probe2/s, 'ключ владельца не уехал второму');

    await post(base, 'probe2', 'credentials', { id: created.server.id, headers: { Authorization: 'Bearer other-secret' } });
    const ready = piMcp(config, 'probe2').mcpServers[created.server.id] as { headers?: Record<string, string> };
    assert.equal(ready.headers?.Authorization, 'Bearer other-secret');
  });
});

test("someone else's server cannot be rewritten, deleted or shared", async () => {
  await withServer(async (base) => {
    const created = (await (
      await add(base, 'probe', {
        name: 'Мой',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        auth: 'none',
      })
    ).json()) as { server: { id: string } };
    await post(base, 'probe', 'share', { id: created.server.id, shared: true });

    for (const [route, body] of [
      ['update', { id: created.server.id, name: 'Чужой', transport: 'streamable-http', url: 'https://evil.example/mcp', auth: 'none' }],
      ['delete', { id: created.server.id }],
      ['share', { id: created.server.id, shared: false }],
    ] as Array<[string, Record<string, unknown>]>) {
      const response = await post(base, 'probe2', route, body);
      assert.equal(response.status, 403, `${route}: чужой сервер не трогаем`);
    }
  });
});

test('a shared MCP from config.yaml is disabled for oneself but does not disappear for others', async () => {
  await withServer(
    async (base, config) => {
      await post(base, 'probe', 'toggle', { id: 'echo', enabled: false });
      assert.deepEqual(Object.keys(piMcp(config, 'probe').mcpServers), []);
      assert.deepEqual(Object.keys(piMcp(config, 'probe2').mcpServers), ['echo']);
    },
    { mcp: { echo: { command: 'node', args: ['/opt/echo.mjs'] } } },
  );
});

test('OAuth end to end: start, callback, token in mcp.json', async () => {
  let tokenBody = '';
  let registered = 0;
  const as = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const pathname = new URL(req.url ?? '/', origin).pathname;
      if (pathname === '/mcp') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/prm", scope="tasks:read"`,
        });
        res.end();
        return;
      }
      if (pathname === '/prm') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
        return;
      }
      if (pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          }),
        );
        return;
      }
      if (pathname === '/register') {
        registered += 1;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ client_id: 'client-1', token_endpoint_auth_method: 'none' }));
        return;
      }
      if (pathname === '/token') {
        tokenBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'access-oauth', refresh_token: 'refresh-oauth', expires_in: 3600 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => as.listen(0, '127.0.0.1', resolve));
  const asBase = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;

  try {
    await withServer(async (base, config) => {
      const created = (await (
        await add(base, 'probe', {
          name: 'OAuth-задачи',
          transport: 'streamable-http',
          url: `${asBase}/mcp`,
          auth: 'oauth',
        })
      ).json()) as { server: { id: string } };

      const started = (await (
        await post(base, 'probe', 'oauth/start', { id: created.server.id })
      ).json()) as { url: string };
      const authorize = new URL(started.url);
      assert.equal(authorize.pathname, '/authorize');
      assert.equal(authorize.searchParams.get('resource'), `${asBase}/mcp`);
      assert.equal(authorize.searchParams.get('redirect_uri'), `${base}/panel/mcp/oauth/callback`);
      assert.equal(registered, 1);

      // The browser returns to the callback without the SSO header: the person is known from state.
      const callback = await fetch(
        `${base}/panel/mcp/oauth/callback?state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}&code=code-1`,
        { redirect: 'manual' },
      );
      assert.equal(callback.status, 302);
      assert.match(callback.headers.get('location') ?? '', /connected=/);

      const form = new URLSearchParams(tokenBody);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('resource'), `${asBase}/mcp`);
      assert.ok((form.get('code_verifier') ?? '').length >= 43, 'PKCE-verifier уехал на token endpoint');

      const entry = piMcp(config, 'probe').mcpServers[created.server.id] as {
        url?: string;
        headers?: Record<string, string>;
      };
      assert.match(entry.url ?? '', /^http:\/\/icarus:\d+\/mcp-proxy\//, 'OAuth-MCP идёт через локальный прокси');
      assert.equal(entry.headers?.Authorization, undefined, 'токен в mcp.json не уезжает');

      // The direct view remains for the panel and for checking: Authorization is needed there.
      const direct = effectiveServers(config, readStore(config), 'probe', Date.now(), { proxyBase: null }).servers[
        created.server.id
      ];
      assert.equal(direct?.headers?.Authorization, 'Bearer access-oauth');

      const listed = (await (await api(base, 'probe', 'servers')).json()) as {
        servers: Array<{ id: string; authState: string }>;
      };
      assert.equal(listed.servers.find((item) => item.id === created.server.id)?.authState, 'ready');
    });
  } finally {
    as.close();
  }
});

test('mimicry: loopback login finishes by pasting the address into the panel', async () => {
  let tokenBody = '';
  let registeredRedirects: string[] = [];
  const as = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const pathname = new URL(req.url ?? '/', origin).pathname;
      if (pathname === '/mcp') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm"` });
        res.end();
        return;
      }
      if (pathname === '/prm') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
        return;
      }
      if (pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          }),
        );
        return;
      }
      if (pathname === '/register') {
        const payload = JSON.parse(body) as { redirect_uris?: string[] };
        registeredRedirects = payload.redirect_uris ?? [];
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ client_id: 'client-loop', token_endpoint_auth_method: 'none' }));
        return;
      }
      if (pathname === '/token') {
        tokenBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'access-loop', refresh_token: 'refresh-loop', expires_in: 3600 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => as.listen(0, '127.0.0.1', resolve));
  const asBase = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;

  try {
    await withServer(async (base, config) => {
      const created = (await (
        await add(base, 'probe', {
          name: 'Any.do MCP',
          transport: 'streamable-http',
          url: `${asBase}/mcp`,
          auth: 'oauth',
          mimic: true,
          shared: true,
        })
      ).json()) as { server: { id: string; mimic?: boolean } };
      assert.equal(created.server.mimic, true);

      const started = (await (
        await post(base, 'probe', 'oauth/start', { id: created.server.id })
      ).json()) as { url: string; state: string; mimic: boolean; redirectUri: string; expiresIn: number };
      assert.equal(started.mimic, true);
      assert.equal(started.redirectUri, 'http://localhost:47821/callback');
      assert.equal(new URL(started.url).searchParams.get('redirect_uri'), 'http://localhost:47821/callback');
      assert.deepEqual(registeredRedirects, ['http://localhost:47821/callback'], 'клиент зарегистрирован на loopback');
      assert.equal(started.expiresIn, 600);

      const pasted = (redirect: string, state = started.state): string =>
        `${redirect}?code=code-1&state=${encodeURIComponent(state)}`;

      // Another person does not finish someone else's login — even with a valid address.
      const foreign = await post(base, 'probe2', 'oauth/complete', {
        id: created.server.id,
        url: pasted('http://localhost:47821/callback'),
      });
      assert.equal(foreign.status, 403);

      // An address without a code does not consume the one-time state.
      const junk = await post(base, 'probe', 'oauth/complete', {
        id: created.server.id,
        url: `http://localhost:47821/callback?state=${encodeURIComponent(started.state)}`,
      });
      assert.equal(junk.status, 400);

      // An address from another port is not our login.
      const wrong = await post(base, 'probe', 'oauth/complete', {
        id: created.server.id,
        url: pasted('http://localhost:9999/callback'),
      });
      assert.equal(wrong.status, 400);

      const done = await post(base, 'probe', 'oauth/complete', {
        id: created.server.id,
        url: pasted('http://localhost:47821/callback'),
      });
      assert.equal(done.status, 200);
      assert.equal(((await done.json()) as { server: { authState: string } }).server.authState, 'ready');

      const form = new URLSearchParams(tokenBody);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), 'http://localhost:47821/callback');
      assert.equal(form.get('code'), 'code-1');
      assert.ok((form.get('code_verifier') ?? '').length >= 43);

      const entry = piMcp(config, 'probe').mcpServers[created.server.id] as { url?: string; headers?: Record<string, string> };
      assert.match(entry.url ?? '', /\/mcp-proxy\//, 'токен уезжает через прокси, как у обычного OAuth');
      assert.equal(entry.headers?.Authorization, undefined);

      // Pasting the same address again will not work: state is one-time.
      const again = await post(base, 'probe', 'oauth/complete', {
        id: created.server.id,
        url: pasted('http://localhost:47821/callback'),
      });
      assert.equal(again.status, 400);
    });
  } finally {
    as.close();
  }
});

test('the public CIMD document is served without the SSO header', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/panel/mcp/oauth/client-metadata.json`);
    assert.equal(response.status, 200);
    const document = (await response.json()) as { client_id: string; redirect_uris: string[] };
    assert.equal(document.client_id, `${base}/panel/mcp/oauth/client-metadata.json`);
    assert.deepEqual(document.redirect_uris, [`${base}/panel/mcp/oauth/callback`]);
  });
});

test('the MCP page opens and renders the add button', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/mcp`, { headers: headers('probe') });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Добавить MCP/);
    assert.match(html, /__MCP_CFG__/);
    assert.match(html, /mcp-list/);
    // The client script is ordinary JS, but a broken quote in it silently takes down the whole
    // page: the browser will show an empty list, and the test would not see it.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length >= 2);
    assert.doesNotThrow(() => new Function(scripts[scripts.length - 1] ?? ''), 'скрипт MCP компилируется');
  });
});
