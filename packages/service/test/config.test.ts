// The config is the only thing a person edits by hand, so we check both parsing
// and the clarity of errors: a silent "undefined" in a container costs more than a startup failure.
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
  mcpLifecycle,
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

test('by default the config is looked up in the repository root', () => {
  assert.equal(DEFAULT_CONFIG_PATH, path.join(REPO_ROOT, 'config.yaml'));
});

test('a minimal config is filled in with defaults', () => {
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
  assert.equal(config.mapleDir, undefined, 'без Maple внешних деревьев в контейнере нет');
  assert.deepEqual(config.auth, {});
  assert.deepEqual(config.env, {});
  assert.deepEqual(config.mcp, {});
  assert.equal(config.telegram, null, 'без токена и маппинга бот выключен');
  assert.equal(config.speech, null, 'без ключа провайдера голосовые не расшифровываются');
});

test('shared settings are read in full: models, keys, mounts, MCP', () => {
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
  assert.equal(config.mapleDir, undefined);
  assert.equal(config.mcp.echo.command, 'node');
  assert.deepEqual(config.mcp.echo.args, ['/opt/echo.mjs']);
  assert.deepEqual(config.users, [{ id: 'probe' }, { id: 'probe2' }]);
});

// Shared MCP secrets: the config holds only names, values are per-person.
test('mcp.secrets: secret names reach the panel, no values in the config', () => {
  const file = writeConfig(`apiKey: token
models: [{ provider: deepinfra, id: flash, tier: fast }]
mcp:
  homeassistant:
    url: http://10.0.0.16/api/mcp
    description: Умный дом
    headers:
      X-Client: icarus
    secrets: [Authorization]
users: [probe]
`);
  const config = loadConfig(file, {} as NodeJS.ProcessEnv);

  assert.equal(config.mcp.homeassistant?.url, 'http://10.0.0.16/api/mcp');
  assert.deepEqual(config.mcp.homeassistant?.secrets, ['Authorization']);
  assert.deepEqual(config.mcp.homeassistant?.headers, { 'X-Client': 'icarus' }, 'постоянные заголовки остались');
  assert.equal(config.mcp.homeassistant?.description, 'Умный дом');
  assert.equal(config.mcp.homeassistant?.transport, undefined, 'транспорт выведет mcp.json: url — это HTTP');
});

// The MCP key no longer comes from .env: otherwise it would be shared by all and bypass the panel.
test('mcp: ${VAR} substitution and env: in headers and env fail with a clear error', () => {
  for (const block of [
    '    headers:\n      Authorization: Bearer ${HOMEASSISTANT_TOKEN}\n',
    '    env:\n      TODOIST_API_KEY: env:TODOIST_TOKEN\n',
  ]) {
    const file = writeConfig(`apiKey: token
models: [{ provider: deepinfra, id: flash, tier: fast }]
mcp:
  homeassistant:
    url: http://10.0.0.16/api/mcp
${block}users: [probe]
`);
    assert.throws(() => loadConfig(file, { HOMEASSISTANT_TOKEN: 'llat' }), /подстановка из окружения в MCP больше не работает/);
  }
});

test('mcp.secrets: a secret value in config.yaml is an error, not a silent leak', () => {
  const file = writeConfig(`apiKey: token
models: [{ provider: deepinfra, id: flash, tier: fast }]
mcp:
  homeassistant:
    url: http://10.0.0.16/api/mcp
    secrets: [Authorization]
    headers:
      Authorization: Bearer llat
users: [probe]
`);
  assert.throws(() => loadConfig(file, {}), /mcp\.homeassistant\.secrets: «Authorization» объявлен секретом/);
});

test('mcp.headers: a non-string is an error with the path to the header', () => {
  const file = writeConfig(`apiKey: token
models: [{ provider: deepinfra, id: flash, tier: fast }]
mcp:
  homeassistant:
    url: http://10.0.0.16/api/mcp
    headers:
      Authorization: [Bearer, llat]
users: [probe]
`);

  assert.throws(
    () => loadConfig(file, {}),
    /mcp\.homeassistant\.headers\.Authorization: ожидалась строка/,
  );
});

test('mcp.hidden: the service server is not lost on parse and does not accept a string', () => {
  const file = writeConfig(`${MINIMAL}mcp:
  artifacts:
    command: node
    args: ['/opt/icarus/tools/artifacts-mcp/server.mjs']
    lifecycle: lazy
    hidden: true
    description: Артефакты
`);
  const config = loadConfig(file, {} as NodeJS.ProcessEnv);
  assert.equal(config.mcp.artifacts?.hidden, true, 'hidden должен доезжать из YAML');
  assert.equal(config.mcp.artifacts?.lifecycle, 'lazy');

  const broken = writeConfig(`${MINIMAL}mcp:
  artifacts:
    command: node
    hidden: 'yes'
`);
  assert.throws(() => loadConfig(broken, {} as NodeJS.ProcessEnv), /mcp\.artifacts\.hidden: ожидалось true или false/);
});

test('in the example config artifacts are enabled, hidden and lazy', () => {
  const config = loadConfig(path.join(REPO_ROOT, 'config.example.yaml'), {
    DEEPINFRA_API_KEY: 'sk-test',
  } as NodeJS.ProcessEnv);
  const artifacts = config.mcp.artifacts;
  assert.ok(artifacts, 'артефакты должны быть в примере: это встроенное умение');
  assert.equal(artifacts.hidden, true, 'в панели MCP его нет и выключить нельзя');
  assert.equal(artifacts.lifecycle, 'lazy', 'инструкции не висят в каждом разговоре');
  assert.match(artifacts.description ?? '', /артефакт/i);
});

// The default stack must not start MCP processes on chat start: each
// eager one is a process per session, and "does not scale" starts right here.
test('the example config has no eager MCP: nothing starts on chat start', () => {
  const config = loadConfig(path.join(REPO_ROOT, 'config.example.yaml'), {
    DEEPINFRA_API_KEY: 'sk-test',
  } as NodeJS.ProcessEnv);
  for (const [name, server] of Object.entries(config.mcp)) {
    assert.equal(mcpLifecycle(server), 'lazy', `${name}: подключается по требованию`);
  }
});

test('docker.dns: a list of addresses, a typo is an error with the path to the field', () => {
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

test('~ and environment variables are substituted where promised', () => {
  const file = writeConfig(`apiKey: env:MY_TOKEN
dataDir: ~/icarus-test
models: [{ provider: deepinfra, id: flash, tier: fast }]
auth:
  deepinfra: \${MY_KEY}
users: [probe]
`);
  const config = loadConfig(file, { MY_TOKEN: 'token', MY_KEY: 'secret' } as NodeJS.ProcessEnv);

  assert.equal(config.apiKey, 'token');
  assert.equal(config.dataDir, path.join(os.homedir(), 'icarus-test'));
  assert.deepEqual(config.auth, { deepinfra: 'secret' });
});

test('Maple is mounted by itself: the path comes from MAPLE_DIR', () => {
  const file = writeConfig(`${MINIMAL}mcp:
  maple:
    command: node
`);
  const config = loadConfig(file, { MAPLE_DIR: '/opt/maple18' } as NodeJS.ProcessEnv);
  assert.equal(config.mapleDir, '/opt/maple18');

  assert.throws(() => loadConfig(file, {} as NodeJS.ProcessEnv), /MAPLE_DIR/);
  assert.throws(() => loadConfig(file, { MAPLE_DIR: 'относительный' } as NodeJS.ProcessEnv), /абсолютный/);
});

test('an old mounts in the config does not break startup: it simply no longer exists', () => {
  const file = writeConfig(`${MINIMAL}mounts:
  - host: /host/repo
    container: /workspace/repo
`);
  const config = loadConfig(file, {} as NodeJS.ProcessEnv);
  assert.equal('mounts' in config, false, 'кастомные маунты выпилены из модели конфига');
});

test('the example config from the repository parses', () => {
  const config = loadConfig(path.join(REPO_ROOT, 'config.example.yaml'), {
    DEEPINFRA_API_KEY: 'sk-test',
  } as NodeJS.ProcessEnv);

  assert.ok(config.users.length > 0, 'в примере должны быть люди');
  assert.ok(config.models.some((model) => model.tier === 'fast'), 'нужна быстрая модель');
  assert.deepEqual(config.auth, { deepinfra: 'sk-test' }, 'ключ из .env подхватывается без auth в конфиге');
});

// --- keys from .env -----------------------------------------------------------

test('a provider key from the environment goes into auth by itself', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPINFRA_API_KEY: 'sk-env' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepinfra: 'sk-env' });
});

test('detectAuth knows the names of pi variables and trims spaces', () => {
  const models = [{ provider: 'google', id: 'gemini-flash' }, { provider: 'deepinfra', id: 'flash' }];
  const auth = detectAuth(models, { GEMINI_API_KEY: ' g ', DEEPINFRA_API_KEY: '' } as NodeJS.ProcessEnv);
  assert.deepEqual(auth, { google: 'g' }, 'пустое значение — это отсутствие ключа');
});

test('detectAuth also knows rare pi providers, including a shared key for two', () => {
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

test('only providers from models end up in auth', () => {
  const config = loadConfig(writeConfig(MINIMAL), {
    DEEPINFRA_API_KEY: 'sk-deepinfra',
    OPENAI_API_KEY: 'sk-openai',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepinfra: 'sk-deepinfra' });
});

test('an empty key in the environment is as good as absent', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPINFRA_API_KEY: '  ' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, {});
});

test('an explicit auth in config.yaml overrides a key from the environment', () => {
  const file = writeConfig(`${MINIMAL}auth:\n  deepinfra: env:MY_KEY\n`);
  const config = loadConfig(file, { MY_KEY: 'явный', DEEPINFRA_API_KEY: 'из-окружения' } as NodeJS.ProcessEnv);
  assert.deepEqual(config.auth, { deepinfra: 'явный' });
});

test('.env is read into the environment but does not overwrite what is already set', () => {
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

test('no .env is not an error: keys may come from the environment', () => {
  assert.doesNotThrow(() => loadEnvFile('/nope/.env'));
});

test('an empty environment variable does not override .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'ICARUS_TEST_EMPTY=из файла\n');

  // An unset repo variable in deploy.yml arrives in prod exactly like this — as an empty
  // string in the environment (envs of the SSH action). It must not be treated as set: it would overwrite
  // the working value from .env, and ${MAPLE_DIR} in config.yaml would expand to ''.
  process.env.ICARUS_TEST_EMPTY = '';
  try {
    loadEnvFile(file);
    assert.equal(process.env.ICARUS_TEST_EMPTY, 'из файла', 'пустое окружение — то же, что отсутствующее');
  } finally {
    delete process.env.ICARUS_TEST_EMPTY;
  }
});

test('prod deploy scenario #57: an empty MAPLE_DIR from CI does not break the config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-deploy-'));
  const env = path.join(dir, '.env');
  const config = path.join(dir, 'config.yaml');
  fs.writeFileSync(env, 'MAPLE_DIR=/opt/maple18\n');
  fs.writeFileSync(config, `${MINIMAL}mcp:\n  maple:\n    command: node\n`);

  // As in prod: vars.MAPLE_DIR is unset — the workflow passed an empty string,
  // script/redeploy put a default into .env, and the environment stayed empty.
  process.env.MAPLE_DIR = '';
  try {
    loadEnvFile(env);
    assert.equal(loadConfig(config).mapleDir, '/opt/maple18');
  } finally {
    delete process.env.MAPLE_DIR;
  }
});

// --- errors -------------------------------------------------------------------

test('without apiKey we do not start', () => {
  const file = writeConfig('models: [{ provider: deepinfra, id: flash }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /apiKey/);
});

test('an unsubstituted variable in apiKey is an error, not an empty token', () => {
  const file = writeConfig('apiKey: env:NO_SUCH_TOKEN\nmodels: [{ provider: d, id: m }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /apiKey: пустой/);
});

test('an empty provider key is caught at startup, not in the container', () => {
  const file = writeConfig(`${MINIMAL}auth:\n  deepinfra: env:NO_SUCH_KEY\n`);
  assert.throws(() => loadConfig(file, {}), /auth\.deepinfra: пусто/);
});

test('without models we do not start', () => {
  const file = writeConfig('apiKey: token\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /ни одной модели/);
});

test('without people we do not start', () => {
  const file = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers: []\n');
  assert.throws(() => loadConfig(file, {}), /ни одного человека/);
});

test('the admin flag: an old config gets it by migration, a new one explicitly', () => {
  // Migration: before the flag existed, one trousev ran the keys. A config written
  // with strings keeps working — exactly that person becomes the admin.
  const legacy = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers: [trousev, probe]\n');
  assert.deepEqual(loadConfig(legacy, {}).users, [{ id: 'trousev', admin: true }, { id: 'probe' }]);

  // Explicit objects: the flag is granted and revoked without touching the rest. false is not
  // stored in the model: "no flag" and "flag revoked" are the same thing.
  const explicit = writeConfig(
    'apiKey: token\nmodels: [{ provider: d, id: m }]\nusers:\n' +
      '  - id: trousev\n    admin: false\n  - id: vita\n    admin: true\n  - id: probe\n',
  );
  assert.deepEqual(loadConfig(explicit, {}).users, [{ id: 'trousev' }, { id: 'vita', admin: true }, { id: 'probe' }]);

  assert.throws(
    () => loadConfig(writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers:\n  - id: probe\n    admin: да\n'), {}),
    /users\[0\]\.admin: ожидалось true или false/,
  );
  assert.throws(
    () => loadConfig(writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers:\n  - admin: true\n'), {}),
    /users\[0\]\.id: не задано/,
  );
});

test("a person's id is validated: it goes into the container name and the path on disk", () => {
  const bad = ['../etc', 'probe/2', 'с пробелом', '-probe'];
  for (const id of bad) {
    const file = writeConfig(`apiKey: token\nmodels: [{ provider: d, id: m }]\nusers: ['${id}']\n`);
    assert.throws(() => loadConfig(file, {}), /не годится/, `id «${id}» должен быть отвергнут`);
  }
});

test('a duplicate id is caught', () => {
  const file = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m }]\nusers: [probe, probe]\n');
  assert.throws(() => loadConfig(file, {}), /повторяется/);
});

test('an unknown tier on a model is an error', () => {
  const file = writeConfig('apiKey: token\nmodels: [{ provider: d, id: m, tier: быстрый }]\nusers: [probe]\n');
  assert.throws(() => loadConfig(file, {}), /tier/);
});



test('broken YAML explains that the file cannot be parsed', () => {
  const file = writeConfig('apiKey: token\n  models: [\n');
  assert.throws(() => loadConfig(file, {}), /не разбирается как YAML/);
});

test('a non-existent file is a clear error, not a stack trace', () => {
  assert.throws(() => loadConfig('/nope/config.yaml', {}), /не читается конфиг/);
});

test('an empty file does not pretend to be a config', () => {
  assert.throws(() => loadConfig(writeConfig(''), {}), /ожидался объект/);
});

// --- telegram -----------------------------------------------------------------

/** Telegram -> person mapping: in yaml a name with "@" is quoted, otherwise it will not parse. */
const TELEGRAM = `${MINIMAL}telegram_mapping:
  '@trousev': probe
`;

test('the telegram mapping is read from a separate key and matches a name without "@"', () => {
  const config = loadConfig(writeConfig(TELEGRAM), { TELEGRAM_BOT_TOKEN: 'bot-token' });

  assert.deepEqual(config.telegram, { token: 'bot-token', mapping: { trousev: 'probe' } });
  assert.equal(findTelegramUser(config, 'trousev')?.id, 'probe');
  assert.equal(findTelegramUser(config, '@TrOuSev')?.id, 'probe', 'имя сравниваем без @ и регистра');
  assert.equal(findTelegramUser(config, 'кто-то'), undefined);
  assert.equal(findTelegramUser(config, undefined), undefined);
});

test('telegram.mapping inside the block is the same, and the token can be set as a string', () => {
  const file = writeConfig(`${MINIMAL}telegram:
  token: \${MY_BOT_TOKEN}
  mapping:
    '@trousev': probe
`);
  const config = loadConfig(file, { MY_BOT_TOKEN: 'from-env' });
  assert.deepEqual(config.telegram, { token: 'from-env', mapping: { trousev: 'probe' } });
});

test('without a token and without a mapping the bot is simply off', () => {
  assert.equal(loadConfig(writeConfig(MINIMAL), {}).telegram, null, 'нет ни токена, ни маппинга');
  assert.equal(loadConfig(writeConfig(TELEGRAM), {}).telegram, null, 'есть маппинг, но нет токена');
  assert.equal(
    loadConfig(writeConfig(`${MINIMAL}telegram: {}\n`), { TELEGRAM_BOT_TOKEN: 'bot-token' }).telegram,
    null,
    'есть токен, но некому отвечать',
  );
});

test('a telegram name leading to a person who does not exist is an error', () => {
  const file = writeConfig(`${MINIMAL}telegram_mapping:\n  '@trousev': vita\n`);
  assert.throws(() => loadConfig(file, { TELEGRAM_BOT_TOKEN: 'bot-token' }), /нет в users/);
});

test('a name without "@" does not parse in yaml, and it says so in words', () => {
  const file = writeConfig(`${MINIMAL}telegram_mapping:\n  @trousev: probe\n`);
  // yaml fails on "@" before we do: the message explains that the name must be quoted.
  assert.throws(() => loadConfig(file, { TELEGRAM_BOT_TOKEN: 'bot-token' }), /не разбирается как YAML/);
});

test('garbage instead of a telegram username is caught with a hint about quotes', () => {
  const file = writeConfig(`${MINIMAL}telegram_mapping:\n  'трусев': probe\n`);
  assert.throws(() => loadConfig(file, { TELEGRAM_BOT_TOKEN: 'bot-token' }), /не похоже на telegram username/);
});

// --- voice --------------------------------------------------------------------

test('by default voice messages are transcribed by Whisper at DeepInfra', () => {
  const config = loadConfig(writeConfig(MINIMAL), { DEEPINFRA_API_KEY: 'deepinfra-key' });

  assert.deepEqual(config.speech, {
    provider: 'deepinfra',
    model: 'openai/whisper-large-v3',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKey: 'deepinfra-key',
  });
});

test('speech is set explicitly: provider, model, language', () => {
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

test('speech: none disables recognition even with a key', () => {
  const off = loadConfig(writeConfig(`${MINIMAL}speech: none\n`), { DEEPINFRA_API_KEY: 'key' });
  assert.equal(off.speech, null);
  assert.equal(loadConfig(writeConfig(`${MINIMAL}speech: false\n`), { DEEPINFRA_API_KEY: 'key' }).speech, null);
});

test('a provider without a key means recognition is off, not a crash', () => {
  assert.equal(loadConfig(writeConfig(MINIMAL), {}).speech, null);
  assert.equal(loadConfig(writeConfig(MINIMAL), { OPENAI_API_KEY: 'openai-key' }).speech, null);
});

test('an unknown provider without an address is an error with a hint', () => {
  const file = writeConfig(`${MINIMAL}speech:\n  provider: whisperbox\n`);
  assert.throws(() => loadConfig(file, {}), /не знаю адреса распознавания.*speech\.baseUrl/s);
});

test('for an unknown provider the address, model and key are set by hand', () => {
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

test('an address but no model is also an error, not a made-up id', () => {
  const file = writeConfig(`${MINIMAL}speech:\n  provider: whisperbox\n  baseUrl: https://speech.example/v1\n`);
  assert.throws(() => loadConfig(file, {}), /не знаю модели распознавания.*speech\.model/s);
});

test('the recognition provider need not be among the chat models', () => {
  const file = writeConfig(`${MINIMAL}speech:\n  provider: openai\n`);
  const config = loadConfig(file, { OPENAI_API_KEY: 'openai-key' });

  assert.equal(config.speech?.provider, 'openai');
  assert.equal(config.speech?.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.speech?.model, 'whisper-1', 'у каждого провайдера своя модель распознавания');
});

// --- panel secret -------------------------------------------------------------

test('publicHost hides "listen everywhere"', () => {
  assert.equal(publicHost('0.0.0.0'), 'localhost');
  assert.equal(publicHost('::'), 'localhost');
  assert.equal(publicHost(''), 'localhost');
  assert.equal(publicHost('icarus.example'), 'icarus.example');
});

test('panel: the proxy header defaults, and devUser is validated against people', () => {
  const plain = loadConfig(writeConfig(MINIMAL), {});
  assert.equal(plain.panel.userHeader, 'Remote-User', 'умолчание — заголовок Authelia');
  assert.equal(plain.panel.devUser, undefined, 'без SSO панель никого не пускает');

  const custom = loadConfig(writeConfig(`${MINIMAL}panel:\n  userHeader: X-Forwarded-User\n  devUser: probe\n`), {});
  assert.equal(custom.panel.userHeader, 'X-Forwarded-User', 'заголовок другого прокси задаётся конфигом');
  assert.equal(custom.panel.devUser, 'probe');

  // A typo in devUser means "the panel lets no one in", and you need to know about it at startup.
  assert.throws(
    () => loadConfig(writeConfig(`${MINIMAL}panel:\n  devUser: probe2\n`), {}),
    /panel\.devUser: человека «probe2» нет в users/,
  );
});

