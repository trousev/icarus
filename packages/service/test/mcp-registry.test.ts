// User MCP: who sees a server, who has it enabled and whose keys go where.
//
// The main promises of this section:
//  - someone else's private server is not visible in any way;
//  - a shared one arrives disabled and does not get into mcp.json until enabled;
//  - a disabled one also does not get into AGENTS.md — otherwise the model would call a server that doesn't exist;
//  - keys are not shared: each person has their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { prepareUser, renderAgentsMd, renderMcpJson } from '../src/workspace.ts';
import {
  clearCredentials,
  createServer,
  deleteServer,
  editorOf,
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
  viewOf,
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

test('a private server is visible only to its owner', () => {
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

test('a shared server arrives disabled and is enabled only manually', () => {
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

test('keys are not shared: the second person needs their own', () => {
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

  // The owner is ready, the second person is not: they don't have the key yet, and there's nothing to put into their mcp.json.
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

test('the OAuth token goes into mcp.json as a header, not as pi config', () => {
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

test('old OAuth records get a proxy key added, and the token leaves mcp.json', () => {
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

test('an expired OAuth with a proxy key stays in mcp.json: the proxy will refresh it or give a link', () => {
  const config = configWith();
  const server = createServer(config, 'probe', {
    name: 'Протухший',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    auth: 'oauth',
  });
  saveCredentials(config, 'probe', server.id, { headers: {} });
  saveOAuthCredentials(config, 'probe', server.id, {
    accessToken: 'old',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() - 1000,
    proxyKey: 'k'.repeat(32),
  });

  const view = listVisible(config, readStore(config), 'probe').servers[0];
  assert.equal(view?.ready, true, 'сервер не выпадает из окружения');
  assert.equal(view?.authState, 'expired');

  prepareUser(config, probe());
  const json = JSON.parse(
    fs.readFileSync(path.join(userPaths(config, probe()).piAgent, 'mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, { url?: string }> };
  assert.match(json.mcpServers[server.id]?.url ?? '', /\/mcp-proxy\//);
});

test('changing the address resets someone else\'s keys: they belong to a different server', () => {
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

test('deletion removes the server for everyone, not just from one\'s own list', () => {
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

test('a server from config.yaml can be disabled for oneself without touching the shared config', () => {
  const config = configWith({ mcp: { echo: { command: 'node', args: ['/opt/echo.mjs'], lifecycle: 'eager' } } });
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe').servers), ['echo']);

  setEnabled(config, 'probe', 'echo', false);
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe').servers), []);
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe2').servers), ['echo'], 'у второго не тронуто');
  assert.ok(config.mcp.echo, 'config.yaml остался как был');
});

test('a service server (hidden) is not visible in the panel and is always enabled', () => {
  const config = configWith({
    mcp: { maple: { command: 'node', args: ['/opt/maple.mjs'], lifecycle: 'eager', hidden: true } },
  });
  const store = readStore(config);
  assert.deepEqual(listVisible(config, store, 'probe').servers, [], 'в панели его нет');
  assert.deepEqual(Object.keys(effectiveServers(config, store, 'probe').servers), ['maple'], 'а в mcp.json — есть');
  assert.equal(viewOf(config, store, 'probe', 'maple'), null, 'карточки для панели тоже нет');
  assert.equal(editorOf(config, 'probe', 'maple'), null, 'и редактор его не отдаёт');
  assert.throws(() => setEnabled(config, 'probe', 'maple', false), /встроен/, 'выключить себе нельзя');

  const json = mcpJson(config);
  assert.deepEqual(Object.keys(json.mcpServers), ['maple'], 'в mcp.json он есть у каждого');
  assert.equal(json.mcpServers.maple?.hidden, undefined, 'служебная пометка в pi не уезжает');
});

test('the old MAPLE.md instruction is removed during environment assembly', () => {
  const config = configWith();
  const paths = userPaths(config, probe('probe'));
  fs.mkdirSync(paths.icarus, { recursive: true });
  fs.writeFileSync(path.join(paths.icarus, 'MAPLE.md'), '# старая инструкция про Maple\n');

  prepareUser(config, probe('probe'));

  assert.equal(fs.existsSync(path.join(paths.icarus, 'MAPLE.md')), false, 'правила живут в описаниях инструментов');
});

test('mcp.json and AGENTS.md are assembled per person: disabled things do not leak through', () => {
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

test('the server id is a Latin slug, even if the name is Russian', () => {
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

test('the id of a deleted shared server starts from a clean slate, not from the old toggle', () => {
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

test('a server cannot take the name of a shared one from config.yaml', () => {
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

// --- общий сервер из config.yaml: секреты у каждого свои ----------------------

function globalConfig() {
  return configWith({
    mcp: {
      homeassistant: {
        transport: 'streamable-http',
        url: 'http://ha.local/api/mcp',
        secrets: ['Authorization'],
        description: 'Умный дом',
      },
    },
  });
}

test('общий MCP с секретом ждёт доступа, пока человек не ввёл свой ключ', () => {
  const config = globalConfig();
  const view = viewOf(config, readStore(config), 'probe', 'homeassistant');
  assert.ok(view);
  assert.equal(view.auth, 'headers', 'объявленный секрет — это ключ доступа');
  assert.equal(view.authState, 'needed', 'без ключа сервер не готов');
  assert.equal(view.ready, false);
  assert.deepEqual(view.credentialHeaders, ['Authorization'], 'панель знает, что спросить');
  assert.equal(view.enabled, true, 'включён себе по умолчанию');
  assert.equal(view.canEdit, false, 'команду и адрес задаёт config.yaml');
  assert.equal(view.canDelete, false, 'удалить общий сервер нельзя');
  assert.equal(view.canShare, false);

  const effective = effectiveServers(config, readStore(config), 'probe');
  assert.deepEqual(Object.keys(effective.servers), [], 'без доступа сервер не попадает в mcp.json');
  assert.deepEqual(effective.skipped, ['homeassistant']);
});

test('общий MCP: у двух людей разные значения одного секрета', () => {
  const config = globalConfig();
  saveCredentials(config, 'probe', 'homeassistant', { headers: { Authorization: 'Bearer first' } });
  saveCredentials(config, 'probe2', 'homeassistant', { headers: { Authorization: 'Bearer second' } });

  const first = effectiveServers(config, readStore(config), 'probe').servers.homeassistant;
  const second = effectiveServers(config, readStore(config), 'probe2').servers.homeassistant;
  assert.equal(first?.headers?.Authorization, 'Bearer first');
  assert.equal(second?.headers?.Authorization, 'Bearer second');
  assert.equal(first?.url, 'http://ha.local/api/mcp', 'адрес общий — из config.yaml');

  const firstView = viewOf(config, readStore(config), 'probe', 'homeassistant');
  assert.equal(firstView?.authState, 'ready');
  assert.deepEqual(firstView?.credentialHeaders, ['Authorization']);
});

test('общий MCP: очистить доступ — снова ждёт доступа, чужой ключ не подхватывается', () => {
  const config = globalConfig();
  saveCredentials(config, 'probe', 'homeassistant', { headers: { Authorization: 'Bearer mine' } });
  saveCredentials(config, 'probe2', 'homeassistant', { headers: { Authorization: 'Bearer other' } });

  clearCredentials(config, 'probe', 'homeassistant');
  assert.equal(viewOf(config, readStore(config), 'probe', 'homeassistant')?.authState, 'needed');
  assert.deepEqual(Object.keys(effectiveServers(config, readStore(config), 'probe').servers), []);
  assert.equal(
    effectiveServers(config, readStore(config), 'probe2').servers.homeassistant?.headers?.Authorization,
    'Bearer other',
    'у второго доступ остался',
  );
});

test('общий MCP без объявленных секретов: ключа нет, всё как раньше', () => {
  const config = configWith({
    mcp: { legacy: { url: 'http://legacy.local/mcp', headers: { Authorization: 'Bearer shared' } } },
  });
  assert.equal(viewOf(config, readStore(config), 'probe', 'legacy')?.authState, 'ready');
  assert.equal(
    effectiveServers(config, readStore(config), 'probe').servers.legacy?.headers?.Authorization,
    'Bearer shared',
    'общий ключ из config.yaml продолжает работать',
  );
  assert.throws(
    () => saveCredentials(config, 'probe', 'legacy', { headers: { Authorization: 'Bearer mine' } }),
    /нет объявленных секретов/,
  );
});
