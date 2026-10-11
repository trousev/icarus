// mcp.json — единственный мост между config.yaml и pi-mcp-extension: потерянное
// здесь поле не видно ни в логе, ни в ответе модели — только в «сервер не поднялся».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { prepareUser, renderMcpJson, renderSettingsJson } from '../src/workspace.ts';
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
});

test('мост pi подключается только тогда, когда есть хоть один MCP-сервер', () => {
  const empty = JSON.parse(renderSettingsJson(makeConfig())) as { packages?: string[] };
  assert.equal(empty.packages, undefined);

  const withServer = JSON.parse(renderSettingsJson(makeConfig({ mcp: { echo: { command: 'node' } } }))) as {
    packages?: string[];
  };
  assert.deepEqual(withServer.packages, ['npm:pi-mcp-extension@1.5.0']);
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
