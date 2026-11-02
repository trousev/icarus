// Панель MCP целиком: добавили, поделились, включили, настроили ключ, прошли OAuth.
//
// Тест ходит через настоящий HTTP-сервер панели, а не через внутренние функции:
// человек нажимает кнопки в браузере, и права/видимость должны проверяться там же,
// где их проверит прод.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths } from '../src/config.ts';
import { prepareUser } from '../src/workspace.ts';
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
  // Так делает index.ts на старте: окружение готово у всех людей, а не только у
  // того, кто первым нажал кнопку в панели.
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
  // OAuth redirect_uri и client_id-ссылка строятся из этого адреса.
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

test('сервер добавляется, попадает в mcp.json и виден только владельцу', async () => {
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

test('поделились — приезжает выключенным; включить можно только себе', async () => {
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
    // У владельца от этого ничего не поменялось.
    assert.equal(
      ((await (await api(base, 'probe', 'servers')).json()) as { servers: Array<{ enabled: boolean }> }).servers[0]?.enabled,
      true,
    );
  });
});

test('ключи не копируются вместе с шарингом: второму нужен свой', async () => {
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

test('чужой сервер нельзя переписать, удалить или расшарить', async () => {
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

test('общий MCP из config.yaml выключается себе, но не пропадает у других', async () => {
  await withServer(
    async (base, config) => {
      await post(base, 'probe', 'toggle', { id: 'echo', enabled: false });
      assert.deepEqual(Object.keys(piMcp(config, 'probe').mcpServers), []);
      assert.deepEqual(Object.keys(piMcp(config, 'probe2').mcpServers), ['echo']);
    },
    { mcp: { echo: { command: 'node', args: ['/opt/echo.mjs'] } } },
  );
});

test('OAuth целиком: старт, callback, токен в mcp.json', async () => {
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

      // Браузер возвращается на callback без заголовка SSO: человека знает state.
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

      const server = piMcp(config, 'probe').mcpServers[created.server.id] as { headers?: Record<string, string> };
      assert.equal(server.headers?.Authorization, 'Bearer access-oauth', 'OAuth-токен стал обычным заголовком');

      const listed = (await (await api(base, 'probe', 'servers')).json()) as {
        servers: Array<{ id: string; authState: string }>;
      };
      assert.equal(listed.servers.find((item) => item.id === created.server.id)?.authState, 'ready');
    });
  } finally {
    as.close();
  }
});

test('публичный документ CIMD отдаётся без SSO-заголовка', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/panel/mcp/oauth/client-metadata.json`);
    assert.equal(response.status, 200);
    const document = (await response.json()) as { client_id: string; redirect_uris: string[] };
    assert.equal(document.client_id, `${base}/panel/mcp/oauth/client-metadata.json`);
    assert.deepEqual(document.redirect_uris, [`${base}/panel/mcp/oauth/callback`]);
  });
});

test('страница MCP открывается и рисует кнопку добавления', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/mcp`, { headers: headers('probe') });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Добавить MCP/);
    assert.match(html, /__MCP_CFG__/);
    assert.match(html, /mcp-list/);
    // Клиентский скрипт — обычный JS, но сломанная кавычка в нём роняет всю
    // страницу молча: браузер покажет пустой список, а тест этого не увидит.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length >= 2);
    assert.doesNotThrow(() => new Function(scripts[scripts.length - 1] ?? ''), 'скрипт MCP компилируется');
  });
});
