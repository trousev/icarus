// mcp.json — единственный мост между config.yaml и pi-mcp-extension: потерянное
// здесь поле не видно ни в логе, ни в ответе модели — только в «сервер не поднялся».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { createServer } from '../src/mcp/registry.ts';
import { prepareUser, renderAgentsMd, renderMcpJson, renderSettingsJson } from '../src/workspace.ts';
import { makeConfig, probe } from './fixtures.ts';

test('HTTP-MCP с ключом уезжает в mcp.json вместе с заголовками', () => {
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

test('stdio-сервер остаётся stdio: url и заголовков у него нет', () => {
  const config = makeConfig({ mcp: { echo: { command: 'node', args: ['/opt/echo.mjs'] } } });

  const json = JSON.parse(renderMcpJson(config)) as { mcpServers: Record<string, Record<string, unknown>> };

  assert.equal(json.mcpServers.echo?.transport, 'stdio');
  assert.equal(json.mcpServers.echo?.url, undefined);
  assert.equal(json.mcpServers.echo?.headers, undefined, 'пустые заголовки в файл не пишем');
  assert.equal(json.mcpServers.echo?.lifecycle, 'lazy', 'без lifecycle сервер подключается по требованию');
});

test('description остаётся подсказкой для AGENTS.md, а не полем mcp.json', () => {
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

// 1.8.0 — первая версия с mcp_connect: без него lazy-сервер из разговора не поднять.
test('мост pi подключается только тогда, когда есть хоть один MCP-сервер', () => {
  const empty = JSON.parse(renderSettingsJson(makeConfig())) as { packages?: string[] };
  assert.equal(empty.packages, undefined);

  const withServer = JSON.parse(renderSettingsJson(makeConfig({ mcp: { echo: { command: 'node' } } }))) as {
    packages?: string[];
  };
  assert.deepEqual(withServer.packages, ['npm:pi-mcp-extension@1.8.0']);
});

// Ключ доступа к чужому серверу — такой же секрет, как ключ модели: файл лежит на
// хосте и монтируется в контейнер, поэтому права те же, что у auth.json.
test('mcp.json пишется закрытым на чтение', () => {
  const config = makeConfig({
    mcp: { homeassistant: { url: 'http://10.0.0.16/api/mcp', headers: { Authorization: 'Bearer llat' } } },
  });
  prepareUser(config, probe());

  const { piAgent } = userPaths(config, probe());
  for (const name of ['mcp.json', 'auth.json']) {
    assert.equal(fs.statSync(path.join(piAgent, name)).mode & 0o777, 0o600, `${name}: права 600`);
  }
});

test('AGENTS.md зовёт подключать ленивый MCP только по теме', () => {
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

// Коннект идемпотентен и наружу ничего не меняет — значит и разрешения не требует.
// Без этого правила модель перестраховывается и начинает каждый разговор с
// «подключить MCP?», хотя человек уже разрешил, включив сервер в панели.
test('AGENTS.md не просит разрешения на подключение и требует честной отбивки', () => {
  const md = renderAgentsMd(
    makeConfig({ mcp: { homeassistant: { url: 'http://10.0.0.16/api/mcp', description: 'Умный дом' } } }),
  );

  assert.match(md, /Подключение — не действие/);
  assert.match(md, /разрешения на него не спрашивай/);
  // Отбивка постфактум, а не просьба разрешить.
  assert.match(md, /одна короткая строка в ответе/);
  // Не поднялся — сказать честно и уйти другим маршрутом, а не выдумывать.
  assert.match(md, /Не поднялся — скажи честно/);
  assert.match(md, /другим маршрутом/);
  // Вход по OAuth — отдельный шаг человека в браузере, а не разрешение модели.
  assert.match(md, /делает его человек в браузере/);
});

// Активация без спроса — только для серверов, у которых доступ уже есть. OAuth без
// входа в окружение не попадает вовсе: «молча» его не поднять, вход даёт человек.
test('OAuth-сервер без входа в подсказку не попадает: его поднимает не модель', () => {
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

test('AGENTS.md не зовёт подключать eager-сервер: его инструменты уже есть', () => {
  const md = renderAgentsMd(
    makeConfig({ mcp: { echo: { command: 'node', description: 'Эхо', lifecycle: 'eager' } } }),
  );

  assert.doesNotMatch(md, /MCP-инструменты по требованию/);
  assert.doesNotMatch(md, /`echo`/);
});

test('без MCP в AGENTS.md нет секции про подключение', () => {
  assert.doesNotMatch(renderAgentsMd(makeConfig()), /MCP-инструменты по требованию/);
});

test('артефакты: в промпте только триггер, полные инструкции — после подключения', () => {
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
  // Триггер виден всегда: иначе модель не узнает, что сервер вообще есть.
  assert.match(md, /`artifacts` — Артефакты: готовые страницы и картинки для человека/);
  assert.match(md, /`mcp_connect`/);
  // А правила про index.ai.md и папку живут в MCP-хендшейке, не в каждом разговоре.
  assert.doesNotMatch(md, /index\.ai\.md/);
  assert.doesNotMatch(md, /artifacts\/<slug>/);
});
