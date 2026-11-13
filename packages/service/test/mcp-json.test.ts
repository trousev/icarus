// mcp.json is the only bridge between config.yaml and pi-mcp-extension: a field lost
// here is invisible both in the log and in the model's response — only in "the server did not start".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { createServer } from '../src/mcp/registry.ts';
import { prepareUser, renderAgentsMd, renderMcpJson, renderSettingsJson } from '../src/workspace.ts';
import { makeConfig, probe } from './fixtures.ts';

test('HTTP-MCP with a key goes into mcp.json together with the headers', () => {
  const config = makeConfig({
    mcp: {
      homeassistant: {
        url: 'http://10.0.0.16/api/mcp',
        headers: { Authorization: 'Bearer llat' },
        lifecycle: 'eager',
      },
    },
  });

  const json = JSON.parse(renderMcpJson(config)) as { mcpServers: Record<string, Record<string, unknown>> };

  assert.deepEqual(json.mcpServers.homeassistant, {
    transport: 'streamable-http',
    url: 'http://10.0.0.16/api/mcp',
    headers: { Authorization: 'Bearer llat' },
    lifecycle: 'eager',
  });
});

test('a stdio server stays stdio: it has no url and no headers', () => {
  const config = makeConfig({ mcp: { echo: { command: 'node', args: ['/opt/echo.mjs'] } } });

  const json = JSON.parse(renderMcpJson(config)) as { mcpServers: Record<string, Record<string, unknown>> };

  assert.equal(json.mcpServers.echo?.transport, 'stdio');
  assert.equal(json.mcpServers.echo?.url, undefined);
  assert.equal(json.mcpServers.echo?.headers, undefined, 'пустые заголовки в файл не пишем');
  assert.equal(json.mcpServers.echo?.lifecycle, 'lazy', 'без lifecycle сервер подключается по требованию');
});

test('description stays a hint for AGENTS.md, not a field of mcp.json', () => {
  const config = makeConfig({
    mcp: {
      homeassistant: {
        url: 'http://10.0.0.16/api/mcp',
        description: 'Умный дом',
      },
    },
  });

  const json = JSON.parse(renderMcpJson(config)) as { mcpServers: Record<string, Record<string, unknown>> };
  assert.equal(json.mcpServers.homeassistant?.description, undefined);
  assert.equal(json.mcpServers.homeassistant?.lifecycle, 'lazy');
});

// 1.8.0 is the first version with mcp_connect: without it a lazy server cannot be brought up from a conversation.
test('the pi bridge is connected only when there is at least one MCP server', () => {
  const empty = JSON.parse(renderSettingsJson(makeConfig())) as { packages?: string[] };
  assert.equal(empty.packages, undefined);

  const withServer = JSON.parse(renderSettingsJson(makeConfig({ mcp: { echo: { command: 'node' } } }))) as {
    packages?: string[];
  };
  assert.deepEqual(withServer.packages, ['npm:pi-mcp-extension@1.8.0']);
});

// A key to access a third-party server is as much a secret as a model key: the file lies on
// the host and is mounted into the container, so the permissions are the same as auth.json's.
test('mcp.json is written with restricted read permissions', () => {
  const config = makeConfig({
    mcp: { homeassistant: { url: 'http://10.0.0.16/api/mcp', headers: { Authorization: 'Bearer llat' } } },
  });
  prepareUser(config, probe());

  const { piAgent } = userPaths(config, probe());
  for (const name of ['mcp.json', 'auth.json']) {
    assert.equal(fs.statSync(path.join(piAgent, name)).mode & 0o777, 0o600, `${name}: права 600`);
  }
});

test('AGENTS.md tells you to connect a lazy MCP only on topic', () => {
  const md = renderAgentsMd(
    makeConfig({
      mcp: {
        homeassistant: {
          url: 'http://10.0.0.16/api/mcp',
          description: 'Умный дом: свет, климат, сцены',
        },
      },
    }),
  );

  assert.match(md, /MCP-инструменты по требованию/);
  assert.match(md, /`homeassistant` — Умный дом: свет, климат, сцены/);
  assert.match(md, /`mcp_connect`/);
  assert.match(md, /`mcp_status`/);
});

// Connecting is idempotent and changes nothing outward — so it requires no permission either.
// Without this rule the model overprotects and starts every conversation with
// "connect MCP?", even though the person already allowed it by enabling the server in the panel.
test('AGENTS.md does not ask permission to connect and requires an honest confirmation', () => {
  const md = renderAgentsMd(
    makeConfig({ mcp: { homeassistant: { url: 'http://10.0.0.16/api/mcp', description: 'Умный дом' } } }),
  );

  assert.match(md, /Подключение — не действие/);
  assert.match(md, /разрешения на него не спрашивай/);
  // A confirmation afterwards, not a request for permission.
  assert.match(md, /одна короткая строка в ответе/);
  // If it did not start, say so honestly and take another route, do not make things up.
  assert.match(md, /Не поднялся — скажи честно/);
  assert.match(md, /другим маршрутом/);
  // OAuth login is a separate step the person takes in the browser, not a model permission.
  assert.match(md, /делает его человек в браузере/);
});

// Activation without asking is only for servers whose access already exists. OAuth without
// login does not enter the environment at all: it cannot be brought up "silently", the person provides the login.
test('an OAuth server without login does not appear in the hint: the model does not bring it up', () => {
  const config = makeConfig();
  createServer(config, 'probe', {
    name: 'Black Forest',
    transport: 'streamable-http',
    url: 'https://mcp.bfl.ai',
    auth: 'oauth',
  });
  prepareUser(config, probe());

  const md = fs.readFileSync(userPaths(config, probe()).agentsMd, 'utf8');
  assert.doesNotMatch(md, /MCP-инструменты по требованию/);
  assert.doesNotMatch(md, /black-forest/);
});

test('AGENTS.md does not tell you to connect an eager server: its tools are already there', () => {
  const md = renderAgentsMd(
    makeConfig({ mcp: { echo: { command: 'node', description: 'Эхо', lifecycle: 'eager' } } }),
  );

  assert.doesNotMatch(md, /MCP-инструменты по требованию/);
  assert.doesNotMatch(md, /`echo`/);
});

test('without MCP there is no connection section in AGENTS.md', () => {
  assert.doesNotMatch(renderAgentsMd(makeConfig()), /MCP-инструменты по требованию/);
});

test('artifacts: only the trigger is in the prompt, full instructions come after connecting', () => {
  const md = renderAgentsMd(
    makeConfig({
      mcp: {
        artifacts: {
          command: 'node',
          lifecycle: 'lazy',
          hidden: true,
          description: 'Артефакты: готовые страницы и картинки для человека',
        },
      },
    }),
  );
  // The trigger is always visible: otherwise the model would not know the server exists at all.
  assert.match(md, /`artifacts` — Артефакты: готовые страницы и картинки для человека/);
  assert.match(md, /`mcp_connect`/);
  // And the rules about index.ai.md and the folder live in the MCP handshake, not in every conversation.
  assert.doesNotMatch(md, /index\.ai\.md/);
  assert.doesNotMatch(md, /artifacts\/<slug>/);
});
