// Ссылка на повторный вход: ошибка авторизации MCP должна превращаться в
// человеческое «переподключить», а таймаут — нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpReauthNotice, mcpReauthUrl, serverIdFromReauthUrl } from '../src/mcp/reauth.ts';
import { createServer } from '../src/mcp/registry.ts';
import { makeConfig } from './fixtures.ts';

test('ссылка ведёт на карточку сервера в панели', () => {
  const config = makeConfig({ url: 'https://chat.trousev.pro/' });
  assert.equal(
    mcpReauthUrl(config, 'black-forest'),
    'https://chat.trousev.pro/panel/mcp?server=black-forest',
  );
  assert.equal(
    serverIdFromReauthUrl('https://chat.trousev.pro/panel/mcp?server=black-forest'),
    'black-forest',
  );
});

test('invalid_token с reauth_url в теле становится уведомлением', () => {
  const config = makeConfig({ url: 'https://chat.trousev.pro' });
  const notice = mcpReauthNotice({
    config,
    userId: 'probe',
    toolName: 'mcp_black_forest_generate_image',
    isError: true,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'invalid_token',
            reauth_url: 'https://chat.trousev.pro/panel/mcp?server=black-forest',
          }),
        },
      ],
    },
  });

  assert.deepEqual(notice, {
    server: 'black-forest',
    name: 'black-forest',
    url: 'https://chat.trousev.pro/panel/mcp?server=black-forest',
  });
});

test('имя сервера берётся человеческое, а ссылка — из имени тула', () => {
  const config = makeConfig({ url: 'https://chat.trousev.pro' });
  const server = createServer(config, 'probe', {
    name: 'Black Forest',
    transport: 'streamable-http',
    url: 'https://mcp.bfl.ai',
    auth: 'oauth',
  });
  assert.equal(server.id, 'black-forest');

  const notice = mcpReauthNotice({
    config,
    userId: 'probe',
    toolName: 'mcp_black_forest_get_credits',
    isError: true,
    result: { content: [{ type: 'text', text: '401 invalid_token' }] },
  });
  assert.equal(notice?.name, 'Black Forest');
  assert.equal(notice?.url, 'https://chat.trousev.pro/panel/mcp?server=black-forest');
});

test('mcp_connect со старым конфигом тоже даёт ссылку по своему аргументу', () => {
  const config = makeConfig({ url: 'https://chat.trousev.pro' });
  const notice = mcpReauthNotice({
    config,
    userId: 'probe',
    toolName: 'mcp_connect',
    args: { name: 'black-forest' },
    isError: true,
    result: { content: [{ type: 'text', text: 'MCP connection failed: invalid_token' }] },
  });
  assert.equal(notice?.url, 'https://chat.trousev.pro/panel/mcp?server=black-forest');
});

test('чужой reauth_url не подставляется: строим свой', () => {
  const config = makeConfig({ url: 'https://chat.trousev.pro' });
  createServer(config, 'probe', {
    name: 'Black Forest',
    transport: 'streamable-http',
    url: 'https://mcp.bfl.ai',
    auth: 'oauth',
  });
  const notice = mcpReauthNotice({
    config,
    userId: 'probe',
    toolName: 'mcp_black_forest_get_credits',
    isError: true,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'invalid_token',
            reauth_url: 'https://evil.example/panel/mcp?server=black-forest',
          }),
        },
      ],
    },
  });
  assert.equal(notice?.url, 'https://chat.trousev.pro/panel/mcp?server=black-forest');
});

test('таймаут и обычная ошибка сервера — не повод звать на вход', () => {
  const config = makeConfig({ url: 'https://chat.trousev.pro' });
  for (const text of ['MCP error -32001: Request timed out', 'HTTP 500 Internal Server Error']) {
    assert.equal(
      mcpReauthNotice({
        config,
        userId: 'probe',
        toolName: 'mcp_black_forest_get_result',
        isError: true,
        result: { content: [{ type: 'text', text }] },
      }),
      null,
    );
  }
});
