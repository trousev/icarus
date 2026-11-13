// render-config edits the live config.yaml before deployment. A mistake here is either
// someone else's API key or an empty list of people, so we test both the edit and the refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { renderConfig } from '../src/docker/render-config.ts';

const EXAMPLE = fs.readFileSync(path.join(REPO_ROOT, 'config.example.yaml'), 'utf8');

const CUSTOM = `apiKey: old-token
dataDir: /srv/icarus
port: 9000
models:
  - provider: deepinfra
    id: deepseek-ai/DeepSeek-V4.1-Flash
    tier: fast
mcp:
  echo:
    command: node
    args: ['/opt/icarus/mcp/echo-server.mjs']
users:
  - old
`;

function load(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-render-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, text);
  return loadConfig(file, {});
}

test('people, port and key come from the environment, the rest — from the example', () => {
  const result = renderConfig(EXAMPLE, {
    users: 'trousev vita julia',
    port: '8081',
    dataDir: '/home/trousev/deployments/icarus/runtime',
    apiKey: 'token-from-secret',
  });

  assert.deepEqual(result.users, ['trousev', 'vita', 'julia']);
  assert.equal(result.apiKeySource, 'env');
  assert.equal(result.port, 8081);

  const config = load(result.text);
  assert.equal(config.apiKey, 'token-from-secret');
  assert.equal(config.port, 8081);
  assert.equal(config.dataDir, '/home/trousev/deployments/icarus/runtime');
  assert.deepEqual(
    config.users.map((user) => user.id),
    ['trousev', 'vita', 'julia'],
  );
  assert.equal(config.models.length, 3, 'модели из примера не потерялись');
  assert.deepEqual(config.env, {
    ICARUS_EXTRACT_AFTER_MS: '20000',
    ICARUS_EXTRACT_MODEL: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash',
    TZ: 'Europe/Dublin',
    ICARUS_SUBAGENT_CONCURRENCY: '4',
    ICARUS_SUBAGENT_MAX_TASKS: '40',
    ICARUS_SUBAGENT_TASK_TIMEOUT_MS: '300000',
    ICARUS_SUBAGENT_BUDGET_MS: '900000',
  });
  assert.deepEqual(config.mcp.echo?.args, ['/opt/icarus/mcp/echo-server.mjs']);
});

test('without variables the host config survives the deploy: people, port and key stay', () => {
  const result = renderConfig(CUSTOM, {});

  assert.deepEqual(result.users, ['old']);
  assert.equal(result.apiKeySource, 'config');
  assert.equal(result.port, 9000);

  const config = load(result.text);
  assert.equal(config.apiKey, 'old-token');
  assert.equal(config.port, 9000);
  assert.equal(config.dataDir, '/srv/icarus');
});

test('the API key is generated if it is neither in the secret nor in the config', () => {
  const withoutKey = renderConfig(EXAMPLE.replace(/^apiKey:.*$/m, ''), { users: 'probe' }, () => 'generated-token');

  assert.equal(withoutKey.apiKeySource, 'generated');
  assert.equal(load(withoutKey.text).apiKey, 'generated-token');
});

test('people come comma- and space-separated, duplicates are caught', () => {
  assert.deepEqual(renderConfig(EXAMPLE, { users: 'trousev,vita' }).users, ['trousev', 'vita']);
  assert.deepEqual(renderConfig(EXAMPLE, { users: 'trousev, vita' }).users, ['trousev', 'vita']);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'trousev,trousev' }), /повторяется/);
});

test('an empty ICARUS_USERS leaves people alone, but a complete absence of people is an error', () => {
  assert.deepEqual(renderConfig(EXAMPLE, { users: '  ' }).users, ['probe', 'probe2'], 'пустая переменная — не повод увольнять людей');
  assert.throws(() => renderConfig(EXAMPLE.replace(/^users:[\s\S]*$/m, ''), { users: '' }), /нет ни одного человека/);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'trousev,../etc' }), /не годится/);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'trousev', port: 'восемь' }), /ожидался номер порта/);
});

test('people in the file are replaced, not appended', () => {
  const result = renderConfig(CUSTOM, { users: 'vita' });
  assert.deepEqual(load(result.text).users.map((user) => user.id), ['vita']);
  assert.equal(/\n\s+- old\b/.test(result.text), false);
});

test('the admin flag: the migration grants it to trousev, and one granted by hand survives the deploy', () => {
  // The old config has people as strings. A deploy with ICARUS_USERS writes the flag explicitly:
  // trousev has it via migration, the rest don't.
  const migrated = renderConfig(EXAMPLE, { users: 'trousev, vita' });
  assert.deepEqual(load(migrated.text).users, [{ id: 'trousev', admin: true }, { id: 'vita' }]);

  // An admin granted on the host does not disappear on the next deploy: the user
  // stayed in the list — so their flag is preserved.
  const custom = migrated.text.replace('  - vita', '  - id: vita\n    admin: true');
  const kept = renderConfig(custom, { users: 'trousev, vita' });
  assert.deepEqual(load(kept.text).users, [{ id: 'trousev', admin: true }, { id: 'vita', admin: true }]);

  // A person was removed from ICARUS_USERS — their flag goes away with them.
  const removed = renderConfig(custom, { users: 'trousev' });
  assert.deepEqual(load(removed.text).users, [{ id: 'trousev', admin: true }]);
});

test('docker.dns comes from ICARUS_DNS, none removes it, empty leaves it alone', () => {
  const withDns = renderConfig(EXAMPLE, { users: 'probe', dns: '1.1.1.1, 8.8.8.8' });
  assert.deepEqual(withDns.dns, ['1.1.1.1', '8.8.8.8']);
  assert.deepEqual(load(withDns.text).docker.dns, ['1.1.1.1', '8.8.8.8']);

  const kept = renderConfig(withDns.text, { users: 'probe' });
  assert.equal(kept.dns, null, 'пустая переменная — прежнее значение остаётся');
  assert.deepEqual(load(kept.text).docker.dns, ['1.1.1.1', '8.8.8.8']);

  const removed = renderConfig(withDns.text, { users: 'probe', dns: 'none' });
  assert.deepEqual(removed.dns, []);
  assert.equal(load(removed.text).docker.dns, undefined, 'none убирает docker.dns');

  assert.throws(() => renderConfig(EXAMPLE, { users: 'probe', dns: 'мой-резолвер' }), /ICARUS_DNS: «мой-резолвер»/);
});

test('url comes from ICARUS_URL and survives the deploy', () => {
  const set = renderConfig(CUSTOM, { users: 'probe', url: 'https://chat.trousev.pro/' });
  assert.equal(set.url, 'https://chat.trousev.pro/');
  assert.equal(load(set.text).url, 'https://chat.trousev.pro/');

  const kept = renderConfig(set.text, { users: 'probe' });
  assert.equal(kept.url, 'https://chat.trousev.pro/', 'пустая переменная прежний адрес не трогает');

  const absent = renderConfig(CUSTOM, { users: 'probe' });
  assert.equal(absent.url, null, 'без url адрес считается незаданным');
  assert.equal(load(absent.text).url, 'http://localhost:9000', 'конфиг подставит localhost по порту');
});

/** The same parsing, but with a bot token in the environment: without it the telegram block does not come up. */
function loadWithBot(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-render-tg-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, text);
  return loadConfig(file, { TELEGRAM_BOT_TOKEN: 'bot-token' });
}

test('the telegram mapping comes from ICARUS_TELEGRAM_MAPPING and survives the deploy', () => {
  const set = renderConfig(EXAMPLE, { users: 'trousev, vita', telegramMapping: '@trousev:trousev, @vita:vita' });
  assert.deepEqual(set.telegram, { trousev: 'trousev', vita: 'vita' });
  assert.deepEqual(loadWithBot(set.text).telegram, {
    token: 'bot-token',
    mapping: { trousev: 'trousev', vita: 'vita' },
  });

  const kept = renderConfig(set.text, { users: 'trousev, vita' });
  assert.equal(kept.telegram, null, 'пустая переменная прежний маппинг не трогает');
  assert.deepEqual(loadWithBot(kept.text).telegram?.mapping, { trousev: 'trousev', vita: 'vita' });

  const removed = renderConfig(set.text, { users: 'trousev, vita', telegramMapping: 'none' });
  assert.deepEqual(removed.telegram, {});
  assert.equal(loadWithBot(removed.text).telegram, null, 'none убирает маппинг, а с ним и блок');

  assert.throws(() => renderConfig(EXAMPLE, { users: 'probe', telegramMapping: '@trousev' }), /@username:человек/);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'trousev', telegramMapping: '@vita:julia' }), /нет среди людей/);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'probe', telegramMapping: 'трусев:probe' }), /не похоже/);
});

test('the quiet hour comes from ICARUS_SESSION_IDLE_MINUTES and survives the deploy', () => {
  const set = renderConfig(CUSTOM, { users: 'probe', sessionIdleMinutes: '60' });
  assert.equal(set.sessionIdleMinutes, 60);
  assert.equal(load(set.text).sessionIdleMinutes, 60);

  const kept = renderConfig(set.text, { users: 'probe' });
  assert.equal(kept.sessionIdleMinutes, 60, 'пустая переменная прежнее значение не трогает');

  const off = renderConfig(set.text, { users: 'probe', sessionIdleMinutes: '0' });
  assert.equal(off.sessionIdleMinutes, 0, 'ноль — «сжимать сразу», это тоже осознанный выбор');

  assert.throws(() => renderConfig(EXAMPLE, { users: 'probe', sessionIdleMinutes: 'час' }), /ICARUS_SESSION_IDLE_MINUTES/);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'probe', sessionIdleMinutes: '-5' }), /ICARUS_SESSION_IDLE_MINUTES/);
});
