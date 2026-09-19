// Конфиг — единственное, что человек правит руками, поэтому проверяем и разбор,
// и внятность ошибок: молчаливое «undefined» в контейнере дороже, чем падение старта.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG_PATH, REPO_ROOT, detectAuth, loadConfig, loadEnvFile } from '../src/config.ts';

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
  assert.deepEqual(config.docker.dns, undefined, 'без docker.dns контейнеры берут резолвер хоста');
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

test('docker.dns: список адресов, опечатка — ошибка с путём до поля', () => {
  const withDns = writeConfig(`apiKey: token
docker:
  dns: ['1.1.1.1', '2606:4700:4700::1111']
models: [{ provider: deepseek, id: flash, tier: fast }]
users: [probe]
`);
  assert.deepEqual(loadConfig(withDns, {}).docker.dns, ['1.1.1.1', '2606:4700:4700::1111']);

  const broken = writeConfig(`apiKey: token
docker:
  dns: ['1.1.1.1 8.8.8.8']
models: [{ provider: deepseek, id: flash, tier: fast }]
users: [probe]
`);
  assert.throws(() => loadConfig(broken, {}), /docker\.dns\[0\]: «1\.1\.1\.1 8\.8\.8\.8» — ожидался адрес DNS-сервера/);
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
  assert.deepEqual(config.auth, { deepseek: 'sk-test' }, 'ключ из .env подхватывается без auth в конфиге');
});

// --- ключи из .env ------------------------------------------------------------

test('ключ провайдера из окружения сам уезжает в auth', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPSEEK_API_KEY: 'sk-env' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepseek: 'sk-env' });
});

test('detectAuth знает имена переменных pi и чистит пробелы', () => {
  const models = [{ provider: 'google', id: 'gemini-flash' }, { provider: 'deepseek', id: 'flash' }];
  const auth = detectAuth(models, { GEMINI_API_KEY: ' g ', DEEPSEEK_API_KEY: '' } as NodeJS.ProcessEnv);
  assert.deepEqual(auth, { google: 'g' }, 'пустое значение — это отсутствие ключа');
});

test('detectAuth знает и редких провайдеров pi, включая общий ключ на двоих', () => {
  const models = ['moonshotai-cn', 'qwen-token-plan-cn', 'xiaomi-token-plan-ams', 'opencode-go'].map(
    (provider) => ({ provider, id: `${provider}-model` }),
  );
  const auth = detectAuth(models, {
    MOONSHOT_API_KEY: 'moonshot',
    QWEN_TOKEN_PLAN_CN_API_KEY: 'qwen',
    XIAOMI_TOKEN_PLAN_AMS_API_KEY: 'xiaomi',
    OPENCODE_API_KEY: 'opencode',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(auth, {
    'moonshotai-cn': 'moonshot',
    'qwen-token-plan-cn': 'qwen',
    'xiaomi-token-plan-ams': 'xiaomi',
    'opencode-go': 'opencode',
  });
});

test('в auth попадают только провайдеры из models', () => {
  const config = loadConfig(writeConfig(MINIMAL), {
    DEEPSEEK_API_KEY: 'sk-deepseek',
    OPENAI_API_KEY: 'sk-openai',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepseek: 'sk-deepseek' });
});

test('пустой ключ в окружении — всё равно что нет', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPSEEK_API_KEY: '  ' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, {});
});

test('явный auth в config.yaml сильнее ключа из окружения', () => {
  const file = writeConfig(`${MINIMAL}auth:\n  deepseek: env:MY_KEY\n`);
  const config = loadConfig(file, { MY_KEY: 'явный', DEEPSEEK_API_KEY: 'из-окружения' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepseek: 'явный' });
});

test('.env читается в окружение, но не перетирает уже заданное', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# ключи\nICARUS_TEST_FROM_FILE=файл\nICARUS_TEST_PRESET="из файла"\n');

  process.env.ICARUS_TEST_PRESET = 'из окружения';
  try {
    loadEnvFile(file);
    assert.equal(process.env.ICARUS_TEST_FROM_FILE, 'файл', 'значение из файла видно в окружении');
    assert.equal(process.env.ICARUS_TEST_PRESET, 'из окружения', 'окружение сильнее файла');
  } finally {
    delete process.env.ICARUS_TEST_FROM_FILE;
    delete process.env.ICARUS_TEST_PRESET;
  }
});

test('нет .env — не ошибка: ключи могут прийти из окружения', () => {
  assert.doesNotThrow(() => loadEnvFile('/nope/.env'));
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
