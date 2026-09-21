// render-config правит боевой config.yaml перед деплоем. Ошибка здесь — это либо
// чужой ключ API, либо пустой список людей, поэтому проверяем и правку, и отказы.
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
mounts:
  - host: /srv/scratchpad
    container: /workspace/scratchpad
    mode: ro
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

test('люди, порт и ключ приезжают из окружения, остальное — из примера', () => {
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
  });
  assert.deepEqual(config.mcp.echo?.args, ['/opt/icarus/mcp/echo-server.mjs']);
});

test('без переменных конфиг на хосте переживает деплой: люди, порт и ключ остаются', () => {
  const result = renderConfig(CUSTOM, {});

  assert.deepEqual(result.users, ['old']);
  assert.equal(result.apiKeySource, 'config');
  assert.equal(result.port, 9000);

  const config = load(result.text);
  assert.equal(config.apiKey, 'old-token');
  assert.equal(config.port, 9000);
  assert.equal(config.dataDir, '/srv/icarus');
  assert.equal(config.mounts.length, 1, 'маунты с хоста не потерялись');
  assert.equal(config.mounts[0]?.host, '/srv/scratchpad');
});

test('ключ API генерируется, если его нет ни в секрете, ни в конфиге', () => {
  const withoutKey = renderConfig(EXAMPLE.replace(/^apiKey:.*$/m, ''), { users: 'probe' }, () => 'generated-token');

  assert.equal(withoutKey.apiKeySource, 'generated');
  assert.equal(load(withoutKey.text).apiKey, 'generated-token');
});

test('люди приходят через запятую и пробел, повторы ловятся', () => {
  assert.deepEqual(renderConfig(EXAMPLE, { users: 'trousev,vita' }).users, ['trousev', 'vita']);
  assert.deepEqual(renderConfig(EXAMPLE, { users: 'trousev, vita' }).users, ['trousev', 'vita']);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'trousev,trousev' }), /повторяется/);
});

test('пустой ICARUS_USERS людей не трогает, а полное отсутствие людей — ошибка', () => {
  assert.deepEqual(renderConfig(EXAMPLE, { users: '  ' }).users, ['probe', 'probe2'], 'пустая переменная — не повод увольнять людей');
  assert.throws(() => renderConfig(EXAMPLE.replace(/^users:[\s\S]*$/m, ''), { users: '' }), /нет ни одного человека/);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'trousev,../etc' }), /не годится/);
  assert.throws(() => renderConfig(EXAMPLE, { users: 'trousev', port: 'восемь' }), /ожидался номер порта/);
});

test('люди в файле заменяются, а не дописываются', () => {
  const result = renderConfig(CUSTOM, { users: 'vita' });
  assert.deepEqual(load(result.text).users.map((user) => user.id), ['vita']);
  assert.equal(/\n\s+- old\b/.test(result.text), false);
});

test('docker.dns приезжает из ICARUS_DNS, none убирает его, пусто — не трогает', () => {
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

test('url приезжает из ICARUS_URL и переживает деплой', () => {
  const set = renderConfig(CUSTOM, { users: 'probe', url: 'https://memory.trousev.pro/' });
  assert.equal(set.url, 'https://memory.trousev.pro/');
  assert.equal(load(set.text).url, 'https://memory.trousev.pro/');

  const kept = renderConfig(set.text, { users: 'probe' });
  assert.equal(kept.url, 'https://memory.trousev.pro/', 'пустая переменная прежний адрес не трогает');

  const absent = renderConfig(CUSTOM, { users: 'probe' });
  assert.equal(absent.url, null, 'без url адрес считается незаданным');
  assert.equal(load(absent.text).url, 'http://localhost:9000', 'конфиг подставит localhost по порту');
});
