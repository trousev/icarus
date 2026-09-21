// Общий конфиг для тестов: сервис целиком завязан на него, и держать копию
// в каждом файле — значит чинить их все при каждом новом поле.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IcarusConfig, UserConfig } from '../src/config.ts';

export const API_KEY = 'test-token';
/** Секрет панели для тестов: из него выводятся личные ключи ссылок на память. */
export const PANEL_SECRET = 'test-panel-secret';
/** Провайдер и модель тестов: id содержит «/», как у любой модели DeepInfra. */
export const PROVIDER = 'deepinfra';
export const MODEL_ID = 'deepseek-ai/DeepSeek-V4.1-Flash';

/** Свежий dataDir на каждый вызов: тесты пишут в память и incoming. */
export function makeConfig(overrides: Partial<IcarusConfig> = {}): IcarusConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKey: API_KEY,
    url: 'http://localhost:8081',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-test-')),
    sessionIdleMinutes: 30,
    docker: { image: 'icarus-user:dev', prefix: 'icarus-user', socket: null },
    models: [
      { provider: PROVIDER, id: MODEL_ID, thinking: 'off', tier: 'fast' },
      { provider: PROVIDER, id: MODEL_ID, thinking: 'medium', tier: 'strong' },
    ],
    auth: {},
    env: {},
    mounts: [],
    mcp: {},
    users: [{ id: 'probe' }],
    ...overrides,
  };
}

export function probe(id = 'probe'): UserConfig {
  return { id };
}
