// Refreshing OAuth tokens before session start: pi reads mcp.json once,
// so an expired token must be refreshed before it wakes up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { prepareUser } from '../src/workspace.ts';
import {
  createServer,
  effectiveServers,
  readStore,
  saveOAuthCredentials,
  saveCredentials,
  setEnabled,
} from '../src/mcp/registry.ts';
import { refreshUserMcpTokens } from '../src/mcp/refresh.ts';
import type { FetchLike } from '../src/mcp/oauth.ts';
import { makeConfig, probe } from './fixtures.ts';

test('an expired token is refreshed, and mcp.json goes to the proxy without a Bearer', async () => {
  const config = makeConfig();
  const server = createServer(config, 'probe', {
    name: 'Задачи',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'oauth',
  });
  saveCredentials(config, 'probe', server.id, { headers: {} });
  saveOAuthCredentials(config, 'probe', server.id, {
    accessToken: 'old',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() - 1000,
    tokenEndpoint: 'https://as.example/token',
    clientId: 'client-1',
    resource: 'https://mcp.example.com/mcp',
  });

  let body = '';
  const fetchImpl: FetchLike = async (_url, init) => {
    body = String(init?.body ?? '');
    return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'refresh-2', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await refreshUserMcpTokens(config, probe(), { fetchImpl });
  assert.deepEqual(result.refreshed, [server.id]);
  assert.equal(new URLSearchParams(body).get('refresh_token'), 'refresh-1');

  const oauth = readStore(config).credentials.probe?.[server.id]?.oauth;
  assert.equal(oauth?.accessToken, 'new');
  assert.equal(oauth?.refreshToken, 'refresh-2');

  prepareUser(config, probe());
  const mcp = JSON.parse(
    fs.readFileSync(path.join(userPaths(config, probe()).piAgent, 'mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> };
  assert.match(mcp.mcpServers[server.id]?.url ?? '', /^http:\/\/icarus:\d+\/mcp-proxy\//);
  assert.equal(mcp.mcpServers[server.id]?.headers?.Authorization, undefined, 'в mcp.json токена нет');

  const direct = effectiveServers(config, readStore(config), 'probe', Date.now(), { proxyBase: null }).servers[server.id];
  assert.equal(direct?.headers?.Authorization, 'Bearer new', 'прямой вид для панели/проверки — со свежим токеном');
});

test('a disabled server does not refresh the token: it won\'t go into the session anyway', async () => {
  const config = makeConfig();
  const server = createServer(config, 'probe', {
    name: 'Выключенный',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'oauth',
  });
  saveOAuthCredentials(config, 'probe', server.id, {
    accessToken: 'old',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() - 1000,
    tokenEndpoint: 'https://as.example/token',
    clientId: 'client-1',
  });
  setEnabled(config, 'probe', server.id, false);

  let called = 0;
  const fetchImpl: FetchLike = async () => {
    called += 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await refreshUserMcpTokens(config, probe(), { fetchImpl });
  assert.deepEqual(result.refreshed, []);
  assert.equal(called, 0);
});
