// Web chat: if MCP refused on authorization, a card with a link to the panel
// arrives in the feed, not just a red step in the trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { createChat } from '../src/control/chat.ts';
import { createServer as createMcp } from '../src/mcp/registry.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

test('MCP authorization error arrives as a reauth event with a link', async () => {
  const config = makeConfig({
    users: [probe('probe')],
    url: 'https://chat.trousev.pro',
  });
  createMcp(config, 'probe', {
    name: 'Black Forest',
    transport: 'streamable-http',
    url: 'https://mcp.bfl.ai',
    auth: 'oauth',
  });
  const chat = createChat(config, probe(), new Date('2026-11-03T10:00:00.000Z'));

  const steps: Array<Record<string, unknown>> = [
    {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'mcp_black_forest_get_credits',
      args: {},
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'mcp_black_forest_get_credits',
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
    },
    { type: 'agent_settled' },
  ];

  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const session = {
    busy: false,
    compacting: null,
    async prompt() {
      for (const event of steps) for (const listener of listeners) listener(event);
    },
    onEvent(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async abort() {
      return true;
    },
  };
  const registry = {
    acquire: async () => session,
    get: () => session,
    bumpResources: () => 0,
    list: () => [],
  };

  const server = createServer(config, registry as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/panel/api/chat/send`, {
      method: 'POST',
      headers: { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: chat.id, text: 'сколько кредитов?' }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const reauth = events.find((event) => event.type === 'reauth');
    assert.deepEqual(reauth, {
      type: 'reauth',
      server: 'Black Forest',
      url: 'https://chat.trousev.pro/panel/mcp?server=black-forest',
    });
  } finally {
    server.close();
  }
});
