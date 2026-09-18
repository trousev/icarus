// Конфиг — единственное, что человек правит руками, поэтому проверяем и разбор,
// и внятность ошибок: молчаливое «undefined» в контейнере дороже, чем падение старта.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG_PATH, REPO_ROOT, loadConfig } from '../src/config.ts';

function writeConfig(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-config-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, text);
  return file;
}

const MINIMAL = `apiKey: test-token
models:
  - provider: deepseek
    id: deepseek-v4-flash
    tier: fast
users:
  - probe
`;

test('по умолчанию конфиг ищется в корне репозитория', () => {
  assert.equal(DEFAULT_CONFIG_PATH, path.join(REPO_ROOT, 'config.yaml'));
});

test('минимальный конфиг дочитывается умолчаниями', () => {
  const config = loadConfig(writeConfig(MINIMAL), {});

  assert.equal(config.apiKey, 'test-token');
  assert.equal(config.panelKey, 'test-token', 'ключ панели по умолчанию — apiKey');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8080);
  assert.equal(config.sessionIdleMinutes, 30);
  assert.equal(config.docker.image, 'icarus-user:dev');
  assert.equal(config.docker.prefix, 'icarus-user');
  assert.equal(config.docker.socket, null);
  assert.deepEqual(config.users, [{ id: 'probe' }]);
  assert.deepEqual(config.mounts, []);
  assert.deepEqual(config.auth, {});
  assert.deepEqual(config.env, {});
  assert.deepEqual(config.mcp, {});
});

test('общее для всех читается целиком: модели, ключи, маунты, MCP', () => {
  const file = writeConfig(`apiKey: token
panelKey: panel
dataDir: /data
sessionIdleMinutes: 5
docker:
  image: icarus-user:v2
  prefix: icarus
  network: icarus-net
models:
  - provider: deepseek
    id: deepseek-v4-flash
    thinking: off
    tier: fast
  - provider: deepseek
    id: deepseek-v4-pro
    tier: strong
auth:
  deepseek: env:MY_KEY
env:
  ICARUS_EXTRACT_AFTER_MS: '1000'
mounts:
  - host: /host/repo
    container: /workspace/repo
    mode: ro
mcp:
  echo:
    command: node
    args: ['/opt/echo.mjs']
    lifecycle: eager
users:
  - probe
  - probe2
`);
  const config = loadConfig(file, { MY_KEY: 'secret' } as NodeJS.ProcessEnv);

  assert.equal(config.panelKey, 'panel');
  assert.equal(config.docker.image, 'icarus-user:v2');
  assert.equal(config.docker.network, 'icarus-net');
  assert.equal(config.sessionIdleMinutes, 5);
  assert.equal(config.models.length, 2);
  assert.equal(config.models[0].tier, 'fast');
  assert.equal(config.models[0].thinking, 'off');
  assert.equal(config.models[1].thinking, undefined, 'thinking не выдумываем');
  assert.deepEqual(config.auth, { deepseek: 'secret' });
  assert.equal(config.env.ICARUS_EXTRACT_AFTER_MS, '1000');
  assert.deepEqual(config.mounts, [{ host: '/host/repo', container: '/workspace/repo', mode: 'ro' }]);
  assert.equal(config.mcp.echo.command, 'node');
  assert.deepEqual(config.mcp.echo.args, ['/opt/echo.mjs']);
  assert.deepEqual(config.users, [{ id: 'probe' }, { id: 'probe2' }]);
});

test('~ и переменные окружения подставляются, где обещаны', () => {
  const file = writeConfig(`apiKey: env:MY_TOKEN
dataDir: ~/icarus-test
models: [{ provider: deepseek, id: flash, tier: fast }]
auth:
  deepseek: \${MY_KEY}
mounts:
  - host: ~/src/repo
    container: /workspace/repo
users: [probe]
`);
  const config = loadConfig(file, { MY_TOKEN: 'token', MY_KEY: 'secret' } as NodeJS.ProcessEnv);

  assert.equal(config.apiKey, 'token');
  assert.equal(config.dataDir, path.join(os.homedir(), 'icarus-test'));
  assert.deepEqual(config.mounts, [
    { host: path.join(os.homedir(), 'src/repo'), container: '/workspace/repo', mode: 'rw' },
  ]);
});

test('пример конфига из репозитория разбирается', () => {
  const config = loadConfig(path.join(REPO_ROOT, 'config.example.yaml'), {
    DEEPSEEK_API_KEY: 'sk-test',
  } as NodeJS.ProcessEnv);

  assert.ok(config.users.length > 0, 'в примере должны быть люди');
  assert.ok(config.models.some((model) => model.tier === 'fast'), 'нужна быстрая модель');
});

// --- ошибки -------------------------------------------------------------------

test('без apiKey не стартуем', () => {
  const file = writeConfig('models: [{ provider: deepseek, id: flash }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /apiKey/);
});

test('неподставившаяся переменная в apiKey — это ошибка, а не пустой токен', () => {
  const file = writeConfig('apiKey: env:NO_SUCH_TOKEN\nmodels: [{ provider: d, id: m }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /apiKey: пустой/);
});

test('пустой ключ провайдера ловим на старте, а не в контейнере', () => {
  const file = writeConfig(`${MINIMAL}auth:\n  deepseek: env:NO_SUCH_KEY\n`);
  assert.throws(() => loadConfig(file, {}), /auth\.deepseek: пусто/);
});

test('без моделей не стартуем', () => {
  const file = writeConfig('apiKey: token\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /ни одной модели/);
});

test('без людей не стартуем', () => {
  const file = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers: []\n');
  assert.throws(() => loadConfig(file, {}), /ни одного человека/);
});

test('старый формат людей с объектами объясняет, как надо', () => {
  const file = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers:\n  - id: probe\n');
  assert.throws(() => loadConfig(file, {}), /users\[0\].*id строкой/);
});

test('id человека проверяем: он идёт в имя контейнера и в путь на диске', () => {
  const bad = ['../etc', 'probe/2', 'с пробелом', '-probe'];
  for (const id of bad) {
    const file = writeConfig(`apiKey: token\nmodels: [{ provider: d, id: m }]\nusers: ['${id}']\n`);
    assert.throws(() => loadConfig(file, {}), /не годится/, `id «${id}» должен быть отвергнут`);
  }
});

test('повторяющийся id ловим', () => {
  const file = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers: [probe, probe]\n');
  assert.throws(() => loadConfig(file, {}), /повторяется/);
});

test('неизвестный tier у модели — ошибка', () => {
  const file = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m, tier: быстрый }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /tier/);
});

test('режим маунта только ro или rw', () => {
  const file = writeConfig(`${MINIMAL}mounts:\n  - host: /h\n    container: /c\n    mode: rwx\n`);
  assert.throws(() => loadConfig(file, {}), /mode/);
});

test('битый YAML объясняет, что файл не разобрать', () => {
  const file = writeConfig('apiKey: token\n  models: [\n');
  assert.throws(() => loadConfig(file, {}), /не разбирается как YAML/);
});

test('несуществующий файл — понятная ошибка, а не стек', () => {
  assert.throws(() => loadConfig('/nope/config.yaml', {}), /не читается конфиг/);
});

test('пустой файл не притворяется конфигом', () => {
  assert.throws(() => loadConfig(writeConfig(''), {}), /ожидался объект/);
});
