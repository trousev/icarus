// Shared config for tests: the service is entirely built around it, and keeping a copy
// in every file means fixing them all on every new field.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IcarusConfig, UserConfig } from '../src/config.ts';

export const API_KEY = 'test-token';
/** Header by which the SSO proxy names the logged-in user: Authelia behind nginx does this. */
export const PANEL_USER_HEADER = 'Remote-User';
/** Provider and model for tests: the id contains "/", like any DeepInfra model. */
export const PROVIDER = 'deepinfra';
export const MODEL_ID = 'deepseek-ai/DeepSeek-V4.1-Flash';

/** A fresh dataDir on every call: tests write to memory and incoming. */
export function makeConfig(overrides: Partial<IcarusConfig> = {}): IcarusConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKey: API_KEY,
    url: 'http://localhost:8081',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-test-')),
    sessionIdleMinutes: 30,
    panel: { userHeader: PANEL_USER_HEADER },
    docker: { image: 'icarus-user:dev', prefix: 'icarus-user', socket: null },
    models: [
      { provider: PROVIDER, id: MODEL_ID, thinking: 'low', tier: 'fast' },
      { provider: PROVIDER, id: MODEL_ID, thinking: 'medium', tier: 'strong' },
    ],
    auth: {},
    // The free You.com MCP is off in tests: scenarios must not suddenly
    // reach out to an external network. Whoever needs it enables it in their own config.
    env: { ICARUS_SEARCH_FREE: 'off' },
    mcp: {},
    // The Telegram bot is off in tests: network and Bot API are beside the point here.
    telegram: null,
    // Voice recognition too: tests that need it set it up themselves.
    speech: null,
    users: [{ id: 'probe' }],
    ...overrides,
  };
}

export function probe(id = 'probe'): UserConfig {
  return { id };
}
