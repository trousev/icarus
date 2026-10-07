// Конфиг — единственное, что человек правит руками, поэтому проверяем и разбор,
// и внятность ошибок: молчаливое «undefined» в контейнере дороже, чем падение старта.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG_PATH,
  REPO_ROOT,
  detectAuth,
  findTelegramUser,
  loadConfig,
  loadEnvFile,
  publicHost,
} from '../src/config.ts';

function writeConfig(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-config-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, text);
  return file;
}

const MINIMAL = `apiKey: test-token
models:
  - provider: deepinfra
    id: deepseek-ai/DeepSeek-V4.1-Flash
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
  assert.equal(config.url, 'http://localhost:8081', 'без url ссылка ведёт на localhost');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8081);
  assert.equal(config.sessionIdleMinutes, 60, 'час тишины: разговор закончен — сжать и закрыть');
  assert.equal(config.docker.image, 'icarus-user:dev');
  assert.equal(config.docker.prefix, 'icarus-user');
  assert.equal(config.docker.socket, null);
  assert.deepEqual(config.users, [{ id: 'probe' }]);
  assert.deepEqual(config.mounts, []);
  assert.deepEqual(config.auth, {});
  assert.deepEqual(config.env, {});
  assert.deepEqual(config.mcp, {});
  assert.equal(config.telegram, null, 'без токена и маппинга бот выключен');
  assert.equal(config.speech, null, 'без ключа провайдера голосовые не расшифровываются');
});

test('общее для всех читается целиком: модели, ключи, маунты, MCP', () => {
  const file = writeConfig(`apiKey: token
url: https://icarus.example:8443
dataDir: /data
sessionIdleMinutes: 5
docker:
  image: icarus-user:v2
  prefix: icarus
  network: icarus-net
models:
  - provider: deepinfra
    id: deepseek-ai/DeepSeek-V4.1-Flash
    thinking: off
    tier: fast
  - provider: deepinfra
    id: deepseek-ai/DeepSeek-V4.1-Flash
    tier: strong
auth:
  deepinfra: env:MY_KEY
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

  assert.equal(config.url, 'https://icarus.example:8443', 'явный url не переписываем');
  assert.equal(config.docker.image, 'icarus-user:v2');
  assert.equal(config.docker.network, 'icarus-net');
  assert.deepEqual(config.docker.dns, undefined, 'без docker.dns контейнеры берут резолвер хоста');
  assert.equal(config.sessionIdleMinutes, 5);
  assert.equal(config.models.length, 2);
  assert.equal(config.models[0].tier, 'fast');
  assert.equal(config.models[0].thinking, 'off');
  assert.equal(config.models[1].thinking, undefined, 'thinking не выдумываем');
  assert.deepEqual(config.auth, { deepinfra: 'secret' });
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
models: [{ provider: deepinfra, id: flash, tier: fast }]
users: [probe]
`);
  assert.deepEqual(loadConfig(withDns, {}).docker.dns, ['1.1.1.1', '2606:4700:4700::1111']);

  const broken = writeConfig(`apiKey: token
docker:
  dns: ['1.1.1.1 8.8.8.8']
models: [{ provider: deepinfra, id: flash, tier: fast }]
users: [probe]
`);
  assert.throws(() => loadConfig(broken, {}), /docker\.dns\[0\]: «1\.1\.1\.1 8\.8\.8\.8» — ожидался адрес DNS-сервера/);
});

test('~ и переменные окружения подставляются, где обещаны', () => {
  const file = writeConfig(`apiKey: env:MY_TOKEN
dataDir: ~/icarus-test
models: [{ provider: deepinfra, id: flash, tier: fast }]
auth:
  deepinfra: \${MY_KEY}
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

test('одна переменная задаёт обе стороны маунта (путь установки вроде MAPLE_DIR)', () => {
  const file = writeConfig(`apiKey: k
dataDir: ~/icarus-test
models: [{ provider: deepinfra, id: flash, tier: fast }]
mounts:
  - host: \${MAPLE_DIR}
    container: \${MAPLE_DIR}
    mode: ro
users: [probe]
`);
  const config = loadConfig(file, { MAPLE_DIR: '/opt/maple18' } as NodeJS.ProcessEnv);

  assert.deepEqual(config.mounts, [
    { host: '/opt/maple18', container: '/opt/maple18', mode: 'ro' },
  ]);
});

test('пример конфига из репозитория разбирается', () => {
  const config = loadConfig(path.join(REPO_ROOT, 'config.example.yaml'), {
    DEEPINFRA_API_KEY: 'sk-test',
  } as NodeJS.ProcessEnv);

  assert.ok(config.users.length > 0, 'в примере должны быть люди');
  assert.ok(config.models.some((model) => model.tier === 'fast'), 'нужна быстрая модель');
  assert.deepEqual(config.auth, { deepinfra: 'sk-test' }, 'ключ из .env подхватывается без auth в конфиге');
});

// --- ключи из .env ------------------------------------------------------------

test('ключ провайдера из окружения сам уезжает в auth', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPINFRA_API_KEY: 'sk-env' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepinfra: 'sk-env' });
});

test('detectAuth знает имена переменных pi и чистит пробелы', () => {
  const models = [{ provider: 'google', id: 'gemini-flash' }, { provider: 'deepinfra', id: 'flash' }];
  const auth = detectAuth(models, { GEMINI_API_KEY: ' g ', DEEPINFRA_API_KEY: '' } as NodeJS.ProcessEnv);
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
    DEEPINFRA_API_KEY: 'sk-deepinfra',
    OPENAI_API_KEY: 'sk-openai',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepinfra: 'sk-deepinfra' });
});

test('пустой ключ в окружении — всё равно что нет', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPINFRA_API_KEY: '  ' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, {});
});

test('явный auth в config.yaml сильнее ключа из окружения', () => {
  const file = writeConfig(`${MINIMAL}auth:\n  deepinfra: env:MY_KEY\n`);
  const config = loadConfig(file, { MY_KEY: 'явный', DEEPINFRA_API_KEY: 'из-окружения' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepinfra: 'явный' });
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

test('пустая переменная окружения не перебивает .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'ICARUS_TEST_EMPTY=из файла\n');

  // Незаданная repo-переменная в deploy.yml приезжает на прод именно так — пустой
  // строкой в окружении (envs SSH-экшена). Заданной её считать нельзя: она затрёт
  // рабочее значение из .env, и ${MAPLE_DIR} в config.yaml раскроется в ''.
  process.env.ICARUS_TEST_EMPTY = '';
  try {
    loadEnvFile(file);
    assert.equal(process.env.ICARUS_TEST_EMPTY, 'из файла', 'пустое окружение — то же, что отсутствующее');
  } finally {
    delete process.env.ICARUS_TEST_EMPTY;
  }
});

test('прод-сценарий деплоя #57: пустой MAPLE_DIR из CI не ломает маунт', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-deploy-'));
  const env = path.join(dir, '.env');
  const config = path.join(dir, 'config.yaml');
  fs.writeFileSync(env, 'MAPLE_DIR=/opt/maple18\n');
  fs.writeFileSync(
    config,
    `${MINIMAL}mounts:\n  - host: \${MAPLE_DIR}\n    container: \${MAPLE_DIR}\n    mode: ro\n`,
  );

  // Как на проде: vars.MAPLE_DIR не задана — workflow прокинул пустую строку,
  // script/redeploy положил дефолт в .env, а окружение так и осталось пустым.
  process.env.MAPLE_DIR = '';
  try {
    loadEnvFile(env);
    assert.deepEqual(loadConfig(config).mounts, [
      { host: '/opt/maple18', container: '/opt/maple18', mode: 'ro' },
    ]);
  } finally {
    delete process.env.MAPLE_DIR;
  }
});

// --- ошибки -------------------------------------------------------------------

test('без apiKey не стартуем', () => {
  const file = writeConfig('models: [{ provider: deepinfra, id: flash }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /apiKey/);
});

test('неподставившаяся переменная в apiKey — это ошибка, а не пустой токен', () => {
  const file = writeConfig('apiKey: env:NO_SUCH_TOKEN\nmodels: [{ provider: d, id: m }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /apiKey: пустой/);
});

test('пустой ключ провайдера ловим на старте, а не в контейнере', () => {
  const file = writeConfig(`${MINIMAL}auth:\n  deepinfra: env:NO_SUCH_KEY\n`);
  assert.throws(() => loadConfig(file, {}), /auth\.deepinfra: пусто/);
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

test('неподставившаяся переменная в маунте — понятная ошибка, а не ::ro', () => {
  const file = writeConfig(`${MINIMAL}mounts:\n  - host: \${NO_SUCH_DIR}\n    container: \${NO_SUCH_DIR}\n    mode: ro\n`);
  // Ни отсутствующая переменная, ни пустая, ни пробельная маунта не задают.
  for (const value of [undefined, '', '   ']) {
    const env = value === undefined ? {} : { NO_SUCH_DIR: value };
    assert.throws(() => loadConfig(file, env as NodeJS.ProcessEnv), /mounts\[0\]\.host: пусто/);
  }
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

// --- telegram -----------------------------------------------------------------

/** Маппинг telegram → человек: в yaml имя с «@» берётся в кавычки, иначе не разберётся. */
const TELEGRAM = `${MINIMAL}telegram_mapping:
  '@trousev': probe
`;

test('маппинг telegram читается отдельным ключом и по имени без «@»', () => {
  const config = loadConfig(writeConfig(TELEGRAM), { TELEGRAM_BOT_TOKEN: 'bot-token' });

  assert.deepEqual(config.telegram, { token: 'bot-token', mapping: { trousev: 'probe' } });
  assert.equal(findTelegramUser(config, 'trousev')?.id, 'probe');
  assert.equal(findTelegramUser(config, '@TrOuSev')?.id, 'probe', 'имя сравниваем без @ и регистра');
  assert.equal(findTelegramUser(config, 'кто-то'), undefined);
  assert.equal(findTelegramUser(config, undefined), undefined);
});

test('telegram.mapping внутри блока — то же самое, и токен можно задать строкой', () => {
  const file = writeConfig(`${MINIMAL}telegram:
  token: \${MY_BOT_TOKEN}
  mapping:
    '@trousev': probe
`);
  const config = loadConfig(file, { MY_BOT_TOKEN: 'from-env' });
  assert.deepEqual(config.telegram, { token: 'from-env', mapping: { trousev: 'probe' } });
});

test('без токена и без маппинга бот просто выключен', () => {
  assert.equal(loadConfig(writeConfig(MINIMAL), {}).telegram, null, 'нет ни токена, ни маппинга');
  assert.equal(loadConfig(writeConfig(TELEGRAM), {}).telegram, null, 'есть маппинг, но нет токена');
  assert.equal(
    loadConfig(writeConfig(`${MINIMAL}telegram: {}\n`), { TELEGRAM_BOT_TOKEN: 'bot-token' }).telegram,
    null,
    'есть токен, но некому отвечать',
  );
});

test('telegram-имя, ведущее к незаведённому человеку, — ошибка', () => {
  const file = writeConfig(`${MINIMAL}telegram_mapping:\n  '@trousev': vita\n`);
  assert.throws(() => loadConfig(file, { TELEGRAM_BOT_TOKEN: 'bot-token' }), /нет в users/);
});

test('имя без «@» в yaml не разбирается — и об этом сказано словами', () => {
  const file = writeConfig(`${MINIMAL}telegram_mapping:\n  @trousev: probe\n`);
  // yaml падает на «@» раньше нас: сообщение объясняет, что имя надо взять в кавычки.
  assert.throws(() => loadConfig(file, { TELEGRAM_BOT_TOKEN: 'bot-token' }), /не разбирается как YAML/);
});

test('мусор вместо telegram username ловим с подсказкой про кавычки', () => {
  const file = writeConfig(`${MINIMAL}telegram_mapping:\n  'трусев': probe\n`);
  assert.throws(() => loadConfig(file, { TELEGRAM_BOT_TOKEN: 'bot-token' }), /не похоже на telegram username/);
});

// --- голосовые ----------------------------------------------------------------

test('по умолчанию голосовые расшифровывает Whisper у DeepInfra', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPINFRA_API_KEY: 'deepinfra-key' });

  assert.deepEqual(config.speech, {
    provider: 'deepinfra',
    model: 'openai/whisper-large-v3',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKey: 'deepinfra-key',
  });
});

test('speech задаётся явно: провайдер, модель, язык', () => {
  const file = writeConfig(`${MINIMAL}speech:
  provider: deepinfra
  model: openai/whisper-large-v3-turbo
  language: ru
`);
  const config = loadConfig(file, { DEEPINFRA_API_KEY: 'deepinfra-key' });

  assert.equal(config.speech?.model, 'openai/whisper-large-v3-turbo');
  assert.equal(config.speech?.language, 'ru');
  assert.equal(config.speech?.apiKey, 'deepinfra-key', 'ключ берётся из auth, а не из блока');
});

test('speech: none выключает распознавание даже с ключом', () => {
  const off = loadConfig(writeConfig(`${MINIMAL}speech: none\n`), { DEEPINFRA_API_KEY: 'key' });
  assert.equal(off.speech, null);
  assert.equal(loadConfig(writeConfig(`${MINIMAL}speech: false\n`), { DEEPINFRA_API_KEY: 'key' }).speech, null);
});

test('провайдер без ключа — распознавание выключено, а не падение', () => {
  assert.equal(loadConfig(writeConfig(MINIMAL), {}).speech, null);
  assert.equal(loadConfig(writeConfig(MINIMAL), { OPENAI_API_KEY: 'openai-key' }).speech, null);
});

test('незнакомый провайдер без адреса — ошибка с подсказкой', () => {
  const file = writeConfig(`${MINIMAL}speech:\n  provider: whisperbox\n`);
  assert.throws(() => loadConfig(file, {}), /не знаю адреса распознавания.*speech\.baseUrl/s);
});

test('незнакомому провайдеру адрес, модель и ключ задаются руками', () => {
  const file = writeConfig(`${MINIMAL}auth:
  whisperbox: secret
speech:
  provider: whisperbox
  model: whisper-large
  baseUrl: https://speech.example/v1/
`);
  const config = loadConfig(file, {});

  assert.equal(config.speech?.baseUrl, 'https://speech.example/v1', 'хвостовой слэш не удваивается');
  assert.equal(config.speech?.model, 'whisper-large');
  assert.equal(config.speech?.apiKey, 'secret');
});

test('адрес есть, а модели нет — тоже ошибка, а не выдуманный id', () => {
  const file = writeConfig(`${MINIMAL}speech:\n  provider: whisperbox\n  baseUrl: https://speech.example/v1\n`);
  assert.throws(() => loadConfig(file, {}), /не знаю модели распознавания.*speech\.model/s);
});

test('провайдер распознавания может не быть среди моделей чата', () => {
  const file = writeConfig(`${MINIMAL}speech:\n  provider: openai\n`);
  const config = loadConfig(file, { OPENAI_API_KEY: 'openai-key' });

  assert.equal(config.speech?.provider, 'openai');
  assert.equal(config.speech?.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.speech?.model, 'whisper-1', 'у каждого провайдера своя модель распознавания');
});

// --- секрет панели ------------------------------------------------------------

test('publicHost прячет «слушать везде»', () => {
  assert.equal(publicHost('0.0.0.0'), 'localhost');
  assert.equal(publicHost('::'), 'localhost');
  assert.equal(publicHost(''), 'localhost');
  assert.equal(publicHost('icarus.example'), 'icarus.example');
});

test('панель: заголовок прокси по умолчанию, а devUser проверяется по людям', () => {
  const plain = loadConfig(writeConfig(MINIMAL), {});
  assert.equal(plain.panel.userHeader, 'Remote-User', 'умолчание — заголовок Authelia');
  assert.equal(plain.panel.devUser, undefined, 'без SSO панель никого не пускает');

  const custom = loadConfig(writeConfig(`${MINIMAL}panel:\n  userHeader: X-Forwarded-User\n  devUser: probe\n`), {});
  assert.equal(custom.panel.userHeader, 'X-Forwarded-User', 'заголовок другого прокси задаётся конфигом');
  assert.equal(custom.panel.devUser, 'probe');

  // Опечатка в devUser — это «панель не пустит никого», и знать об этом надо на старте.
  assert.throws(
    () => loadConfig(writeConfig(`${MINIMAL}panel:\n  devUser: probe2\n`), {}),
    /panel\.devUser: человека «probe2» нет в users/,
  );
});

