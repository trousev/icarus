// Пользовательские MCP: кто видит сервер, кому он включён и чьи ключи куда едут.
//
// Главные обещания раздела:
//  - чужой приватный сервер не виден никак;
//  - расшаренный приезжает выключенным и до включения не попадает в mcp.json;
//  - выключенный не попадает и в AGENTS.md — иначе модель звала бы сервер, которого нет;
//  - ключи не шарятся: у каждого человека они свои.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { prepareUser, renderAgentsMd, renderMcpJson } from '../src/workspace.ts';
import {
  createServer,
  deleteServer,
  effectiveServers,
  ensureOAuthProxyKeys,
  listVisible,
  readStore,
  saveCredentials,
  saveOAuthCredentials,
  setEnabled,
  setShared,
  slugify,
  updateServer,
} from '../src/mcp/registry.ts';
import { makeConfig, probe } from './fixtures.ts';

const USERS = [probe('probe'), probe('probe2')];

function configWith(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({ users: USERS, ...overrides });
}

function mcpJson(config: ReturnType<typeof makeConfig>): { mcpServers: Record<string, Record<string, unknown>> } {
  prepareUser(config, probe('probe'));
  return JSON.parse(fs.readFileSync(path.join(userPaths(config, probe('probe')).piAgent, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
}

test('приватный сервер видит только владелец', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Мои задачи',
    description: 'Списки задач',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
  });

  const mine = listVisible(config, readStore(config), 'probe').servers;
  const other = listVisible(config, readStore(config), 'probe2').servers;
  assert.deepEqual(mine.map((item) => item.id), [server.id]);
  assert.equal(mine[0]?.enabled, true, 'свой сервер сразу включён');
  assert.deepEqual(other, [], 'чужой приватный не виден');

  const effective = effectiveServers(config, readStore(config), 'probe2').servers;
  assert.deepEqual(Object.keys(effective), [], 'и в окружение не попадает');
});

test('расшаренный сервер приезжает выключенным и включается только вручную', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Todoist',
    description: 'Задачи семьи',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
  });
  setShared(config, 'probe', server.id, true);

  const visible = listVisible(config, readStore(config), 'probe2').servers;
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.enabled, false, 'поделились — значит выключен');
  assert.deepEqual(effectiveServers(config, readStore(config), 'probe2').servers, {}, 'выключенный не входит в окружение');

  setEnabled(config, 'probe2', server.id, true);
  const ready = effectiveServers(config, readStore(config), 'probe2');
  assert.deepEqual(Object.keys(ready.servers), [server.id]);
  assert.equal(ready.servers[server.id]?.lifecycle, 'lazy', 'пользовательские MCP не лезут в промпт заранее');
});

test('ключи не шарятся: у второго человека нужен свой', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Todoist',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'headers',
    credentials: { headers: { Authorization: 'Bearer owner-secret' } },
  });
  setShared(config, 'probe', server.id, true);
  setEnabled(config, 'probe2', server.id, true);

  // Владелец готов, второй — нет: ключа у него ещё нет, и в mcp.json ему нечего класть.
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe').servers), [server.id]);
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe2').servers), []);

  saveCredentials(config, 'probe2', server.id, { headers: { Authorization: 'Bearer other-secret' } });
  const other = effectiveServers(config, readStore(config), 'probe2').servers[server.id];
  assert.equal(other?.headers?.Authorization, 'Bearer other-secret', 'у второго — свой ключ');

  const ownerJson = JSON.parse(renderMcpJson(config, effectiveServers(config, readStore(config), 'probe').servers)) as {
    mcpServers: Record<string, { headers?: Record<string, string> }>;
  };
  assert.equal(ownerJson.mcpServers[server.id]?.headers?.Authorization, 'Bearer owner-secret', 'чужой ключ владельцу не подменили');
});

test('OAuth-токен уезжает в mcp.json заголовком, а не конфигом pi', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Задачи',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'oauth',
  });
  saveCredentials(config, 'probe', server.id, {
    oauth: {
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      resource: 'https://mcp.example.com/mcp',
    },
  });
  const effective = effectiveServers(config, readStore(config), 'probe').servers[server.id];
  assert.equal(effective?.headers?.Authorization, 'Bearer token-1');
  assert.equal('auth' in (effective ?? {}), false, 'pi получает обычные заголовки: свой OAuth ему не нужен');
});

test('старым OAuth-записям достраивается ключ прокси, и токен уходит из mcp.json', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Старый OAuth',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'oauth',
  });
  saveCredentials(config, 'probe', server.id, { headers: {} });
  saveOAuthCredentials(config, 'probe', server.id, {
    accessToken: 'token-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(readStore(config).credentials.probe?.[server.id]?.oauth?.proxyKey, undefined);

  const changed = ensureOAuthProxyKeys(config, 'probe');
  assert.deepEqual(changed, [server.id]);
  const key = readStore(config).credentials.probe?.[server.id]?.oauth?.proxyKey;
  assert.match(key ?? '', /^[A-Za-z0-9_-]{20,}$/);

  prepareUser(config, probe());
  const json = JSON.parse(
    fs.readFileSync(path.join(userPaths(config, probe()).piAgent, 'mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> };
  assert.match(json.mcpServers[server.id]?.url ?? '', /\/mcp-proxy\//);
  assert.equal(json.mcpServers[server.id]?.headers?.Authorization, undefined);
});

test('смена адреса сбрасывает чужие ключи: они относятся к другому серверу', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Сервер',
    transport: 'streamable-http',
    url: 'https://one.example.com/mcp',
    auth: 'headers',
    credentials: { headers: { Authorization: 'Bearer one' } },
  });
  assert.ok(readStore(config).credentials.probe?.[server.id]);

  updateServer(config, 'probe', server.id, {
    name: 'Сервер',
    transport: 'streamable-http',
    url: 'https://two.example.com/mcp',
    auth: 'headers',
  });
  assert.equal(readStore(config).credentials.probe?.[server.id], undefined);
});

test('удаление убирает сервер у всех, а не только из своего списка', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Общий',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
  });
  setShared(config, 'probe', server.id, true);
  setEnabled(config, 'probe2', server.id, true);

  deleteServer(config, 'probe', server.id);
  assert.deepEqual(listVisible(config, readStore(config), 'probe2').servers, []);
  assert.equal(readStore(config).servers[server.id], undefined);
});

test('сервер из config.yaml можно выключить себе и не трогать общий конфиг', () => {
  const config = configWith({ mcp: { maple: { command: 'node', args: ['/opt/maple.mjs'], lifecycle: 'eager' } } });
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe').servers), ['maple']);

  setEnabled(config, 'probe', 'maple', false);
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe').servers), []);
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe2').servers), ['maple'], 'у второго не тронуто');
  assert.ok(config.mcp.maple, 'config.yaml остался как был');
});

test('выключенный себе Maple не обещает модели математику', () => {
  const config = configWith({ mcp: { maple: { command: 'node', args: ['/opt/maple.mjs'] } } });
  setEnabled(config, 'probe', 'maple', false);
  prepareUser(config, probe());
  const paths = userPaths(config, probe());
  const agents = fs.readFileSync(paths.agentsMd, 'utf8');
  assert.doesNotMatch(agents, /Если нужна математика/, 'инструкции про Maple нет');
  assert.doesNotMatch(agents, /читай и считай через Maple/);
  assert.equal(fs.existsSync(paths.mapleMd), true, 'файл остаётся: он может быть источником bind-mount, но модель на него не ссылается');
});

test('mcp.json и AGENTS.md собираются под человека: выключенное не просачивается', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Todoist',
    description: 'Списки задач',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
  });

  const enabledJson = mcpJson(config);
  assert.deepEqual(Object.keys(enabledJson.mcpServers), [server.id]);
  assert.equal(enabledJson.mcpServers[server.id]?.lifecycle, 'lazy');

  setEnabled(config, 'probe', server.id, false);
  const disabledJson = mcpJson(config);
  assert.deepEqual(Object.keys(disabledJson.mcpServers), [], 'выключенного нет в mcp.json');

  const agents = renderAgentsMd(config, effectiveServers(config, readStore(config), 'probe').servers);
  assert.doesNotMatch(agents, /Todoist/, 'и в подсказке модели его тоже нет');
});

test('id сервера — латинский слаг, даже если имя русское', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Списки задач',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
  });
  assert.match(server.id, /^[a-z][a-z0-9-]+$/);
  assert.equal(slugify('Списки задач'), 'spiski-zadach');

  const conflict = createServer(config, 'probe', {
    name: 'Списки задач',
    transport: 'streamable-http',
    url: 'https://mcp2.example.com/mcp',
    auth: 'none',
  });
  assert.notEqual(conflict.id, server.id, 'одинаковые имена не затирают друг друга');
});

test('id удалённого общего сервера начинается с чистого листа, а не со старого выключателя', () => {
  const first = configWith({ mcp: { echo: { command: 'node' } } });
  setEnabled(first, 'probe', 'echo', false);
  const second = makeConfig({ dataDir: first.dataDir, users: USERS, mcp: {} });
  const server = createServer(second, 'probe', {
    name: 'Echo',
    transport: 'streamable-http',
    url: 'https://echo.example/mcp',
    auth: 'none',
  });
  assert.equal(server.id, 'echo');
  const mine = listVisible(second, readStore(second), 'probe').servers;
  assert.equal(mine[0]?.enabled, true, 'свой новый сервер включён, старый выключатель не пережил удаление');
});

test('сервер не может занять имя общего из config.yaml', () => {
  const config = configWith({ mcp: { echo: { command: 'node' } } });
  const server = createServer(config, 'probe', {
    name: 'Echo',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
  });
  assert.notEqual(server.id, 'echo');
  assert.equal(config.mcp.echo?.command, 'node', 'общий сервер не подменён');
});
