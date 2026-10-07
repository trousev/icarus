// Конфигурация сервиса: config.yaml в корне репозитория.
//
// Всё, что одинаково у всех (модели, ключи провайдеров, маунты, MCP, окружение),
// лежит на верхнем уровне; у человека остаётся только id — из него выводятся имя
// контейнера, каталоги в dataDir и id сессии pi. Иначе конфиг растёт с каждым
// человеком, а настройки у людей незаметно разъезжаются.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { log } from './log.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Корень репозитория: в нём лежат config.yaml, .env, icarus.md и расширения. */
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config.yaml');
/** Файл с ключами: в git не попадает, образец — .env.example. */
export const ENV_FILE = path.join(REPO_ROOT, '.env');

export type ModelConfig = {
  provider: string;
  id: string;
  thinking?: string;
  tier?: 'fast' | 'strong' | 'vision';
};

export type MountConfig = { host: string; container: string; mode?: 'ro' | 'rw' };

/** Описание MCP-сервера: формат тот же, что читает pi-mcp-extension. */
export type McpServerConfig = {
  transport?: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  lifecycle?: 'eager' | 'lazy';
};

/** Человек: пока только id, всё остальное — общее (см. IcarusConfig). */
export type UserConfig = { id: string };

/**
 * Telegram-бот: второй вход к тому же Икару. Человека узнаём по username в
 * Telegram — он приезжает в каждом сообщении, — и по карте переводим в id
 * человека icarus: на проде это uid из LDAP, на стенде — username, ровно то, что
 * приезжает заголовком x-icarus-user-id. Так у бота нет своей
 * таблицы людей: заведён в `users` — значит, можешь и в Telegram.
 */
export type TelegramConfig = {
  token: string;
  /** Ключи — telegram username без «@» и в нижнем регистре, значения — id из users. */
  mapping: Record<string, string>;
};

/**
 * Панель управления: как сервис узнаёт, кто её открыл.
 *
 * Пароля у панели нет и быть не должно: человека называет SSO-прокси (на проде —
 * Authelia за nginx), а сервис читает его имя из заголовка. Поэтому панель обязана
 * жить за прокси: порт icarus, открытый в обход него, — это чужая память в чужих руках.
 */
export type PanelConfig = {
  /** Заголовок, которым прокси называет вошедшего: Authelia кладёт Remote-User. */
  userHeader: string;
  /**
   * Человек, которым панель прикидывается без SSO, — только для локального запуска.
   * Задан на проде — панель открыта всем, кто дотянется до порта (сервис об этом ругается).
   */
  devUser?: string;
};

/**
 * Распознавание речи: голосовые из Telegram модель не слышит, поэтому их сначала
 * перекладывают в текст отдельной моделью провайдера (Whisper у DeepInfra). Ключ
 * берётся из auth — тот же, что уехал в контейнер, так что новых секретов не нужно.
 */
export type SpeechConfig = {
  provider: string;
  /** id модели распознавания. */
  model: string;
  /** Язык диктовки — подсказка распознавателю; не задан, так определит сам. */
  language?: string;
  /** Базовый адрес OpenAI-совместимого API провайдера (метод /audio/transcriptions). */
  baseUrl: string;
  apiKey: string;
};

export type DockerConfig = {
  image: string;
  network?: string;
  prefix?: string;
  /** DNS-серверы контейнеров; не заданы — берётся резолвер хоста (обычный случай). */
  dns?: string[];
  socket?: string | null;
};

export type IcarusConfig = {
  host: string;
  port: number;
  apiKey: string;
  /**
   * Внешний адрес панели управления: по нему человек открывает её из чата и из закладки.
   * Внутри контейнера localhost бесполезен, поэтому на проде это публичный адрес.
   */
  url: string;
  dataDir: string;
  sessionIdleMinutes: number;
  docker: DockerConfig;
  /** Панель управления: заголовок прокси и (для локального запуска) человек без SSO. */
  panel: PanelConfig;
  /** Модели всех людей: уровни (tier) раздаёт эскалация. */
  models: ModelConfig[];
  /** Ключи провайдеров: подобранные из .env и явные из auth в config.yaml. */
  auth: Record<string, string>;
  /** Переменные окружения контейнера: ими настраиваются наши расширения. */
  env: Record<string, string>;
  /** Дополнительные каталоги с хоста — одинаковые для всех. */
  mounts: MountConfig[];
  /** MCP-серверы: то, чем Икар обрастает без правки кода. */
  mcp: Record<string, McpServerConfig>;
  /** Telegram-бот: null — выключен (нет токена или некому отвечать). */
  telegram: TelegramConfig | null;
  /** Распознавание голосовых: null — выключено (нет ключа провайдера или отключено в конфиге). */
  speech: SpeechConfig | null;
  users: UserConfig[];
};

/** Подставляет ~ и значения вида env:VAR_NAME / ${VAR_NAME}. */
export function expandValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const withHome = value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
  return withHome.replace(/\$\{([A-Z0-9_]+)\}|^env:([A-Z0-9_]+)$/g, (_m, braced, prefixed) => {
    const name = braced ?? prefixed;
    return env[name] ?? '';
  });
}

/**
 * Читает .env в process.env, не перетирая уже заданное непустым: окружение сильнее
 * файла — ровно как ведёт себя docker compose с env_file, так что порядок не зависит
 * от того, запущен сервис в контейнере или прямо на хосте. Файла нет — это норма:
 * ключи могут прийти из окружения. Сами значения нужны только здесь (auth); в
 * контейнеры людей compose отдаёт файл целиком, поэтому секреты не попадают в
 * docker-compose.yml.
 *
 * Пустая строка в окружении — это «не задано», а не «пусто»: незаданная переменная
 * в CI (например vars.MAPLE_DIR в deploy.yml) приезжает именно так. Считать её
 * заданной нельзя — она перебивает рабочее значение из .env, и ${MAPLE_DIR} в
 * config.yaml раскрывается в '', а маунт — в ::ro (docker: invalid spec).
 */
export function loadEnvFile(file: string = ENV_FILE): void {
  if (!fs.existsSync(file)) return;

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`не читается .env ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(text);
  } catch (error) {
    throw new Error(`.env ${file} не разбирается: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    // Пустое окружение — то же самое, что отсутствующее: иначе незаданная
    // переменная из CI затирает .env (см. комментарий к loadEnvFile).
    if (!process.env[name]) process.env[name] = value;
  }
}

// --- разбор и проверка ---------------------------------------------------------
// Конфиг — единственное, что человек правит руками, поэтому ошибки должны быть
// с путём до поля и по-русски, а не «cannot read property of undefined».

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${what}: ожидался список`);
  return value;
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${what}: ожидалась строка`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requiredString(value: unknown, what: string): string {
  const text = optionalString(value, what);
  if (text === undefined) throw new Error(`${what}: не задано`);
  return text;
}

function numberOr(value: unknown, what: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${what}: ожидалось число`);
  return parsed;
}

/** Карта строк, в значениях подставляются ~ и переменные окружения. */
function stringMap(value: unknown, what: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const record = value === undefined || value === null ? {} : asRecord(value, what);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, expandValue(requiredString(item, `${what}.${key}`), env)]),
  );
}

/**
 * Провайдер pi → переменная окружения с его ключом. Список повторяет карту pi
 * (@earendil-works/pi-ai, env-api-keys), чтобы провайдера из models не приходилось
 * дублировать в config.yaml: положил ключ в .env — он уже в auth.json. Провайдера
 * в списке нет — ключ задаётся явно через auth. Один ключ на нескольких
 * провайдеров — норма: у moonshotai и moonshotai-cn он общий.
 *
 * deepinfra в каталоге pi нет — это наш кастомный провайдер, его описание живёт в
 * providers.ts и уезжает в models.json. В auth.json ключ всё равно попадает: там он
 * лежит по имени провайдера, и лишним не бывает.
 *
 * Особые случаи pi сюда не помещаются, для них остаётся auth: — anthropic
 * принимает ещё ANTHROPIC_AUTH_TOKEN и ANTHROPIC_OAUTH_TOKEN, amazon-bedrock
 * обходится AWS-кредами, google-vertex — Application Default Credentials.
 */
const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
  google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  huggingface: 'HF_TOKEN',
  baseten: 'BASETEN_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_API_KEY',
  'ant-ling': 'ANT_LING_API_KEY',
  radius: 'RADIUS_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
  'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
};

/**
 * DeepInfra — единственный провайдер, описание которого нам приходится держать
 * самим (см. providers.ts). Адрес один и на чат, и на распознавание речи: методы
 * у OpenAI-совместимого API те же, отличается только путь.
 */
export const DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';

/**
 * Где и чем расшифровывать голосовые — по имени провайдера из `speech`. Ключ берём
 * из auth (или из окружения — тем же именем, что у моделей), отдельного секрета не
 * заводим. У незнакомого провайдера ни адреса, ни модели не угадать: и то и другое
 * задаётся в конфиге.
 */
export const SPEECH_PROVIDERS: Record<string, { baseUrl: string; model: string }> = {
  deepinfra: { baseUrl: DEEPINFRA_BASE_URL, model: 'openai/whisper-large-v3' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
};

/** По умолчанию голосовые расшифровывает Whisper у DeepInfra: ключ уже есть в .env. */
export const DEFAULT_SPEECH_PROVIDER = 'deepinfra';

/**
 * Ключ провайдера из окружения — одним списком имён на всех (PROVIDER_ENV).
 */
function keyFromEnv(provider: string, env: NodeJS.ProcessEnv): string {
  const name = PROVIDER_ENV[provider];
  return (name === undefined ? undefined : env[name])?.trim() ?? '';
}

/**
 * Ключи, которые уже лежат в окружении. Берём только провайдеров из models:
 * ключ от провайдера, которого в конфиге нет, в auth.json не нужен.
 */
export function detectAuth(models: ModelConfig[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const auth: Record<string, string> = {};
  for (const provider of new Set(models.map((model) => model.provider))) {
    const key = keyFromEnv(provider, env);
    if (key) auth[provider] = key;
  }
  return auth;
}

/**
 * Ключи провайдеров: то, что нашлось в окружении (.env), плюс явный auth из config.yaml —
 * он сильнее. Пустое явное значение — это почти всегда неподставленная переменная
 * окружения, а не желание работать без ключа: ругаемся сразу, иначе сервис молча
 * перезапишет auth.json пустышкой и агент сломается на первом же запросе.
 */
function parseAuth(value: unknown, env: NodeJS.ProcessEnv, models: ModelConfig[]): Record<string, string> {
  const explicit = stringMap(value, 'auth', env);
  for (const [provider, key] of Object.entries(explicit)) {
    if (key === '') {
      throw new Error(`auth.${provider}: пусто — проверь, что переменная задана в .env или в окружении (env:VAR)`);
    }
  }
  return { ...detectAuth(models, env), ...explicit };
}

const TIERS: Array<NonNullable<ModelConfig['tier']>> = ['fast', 'strong', 'vision'];function parseModels(value: unknown): ModelConfig[] {
  const models = asArray(value, 'models').map((item, index) => {
    const where = `models[${index}]`;
    const model = asRecord(item, where);
    const tier = optionalString(model.tier, `${where}.tier`);
    if (tier !== undefined && !TIERS.includes(tier as NonNullable<ModelConfig['tier']>)) {
      throw new Error(`${where}.tier: «${tier}» — ожидалось ${TIERS.join(', ')}`);
    }
    const thinking = optionalString(model.thinking, `${where}.thinking`);
    return {
      provider: requiredString(model.provider, `${where}.provider`),
      id: requiredString(model.id, `${where}.id`),
      ...(thinking === undefined ? {} : { thinking }),
      ...(tier === undefined ? {} : { tier: tier as NonNullable<ModelConfig['tier']> }),
    };
  });
  if (models.length === 0) throw new Error('в конфиге нет ни одной модели (models)');
  return models;
}

function parseMounts(value: unknown, env: NodeJS.ProcessEnv): MountConfig[] {
  return asArray(value, 'mounts').map((item, index) => {
    const where = `mounts[${index}]`;
    const mount = asRecord(item, where);
    const mode = optionalString(mount.mode, `${where}.mode`);
    if (mode !== undefined && mode !== 'ro' && mode !== 'rw') {
      throw new Error(`${where}.mode: «${mode}» — ожидалось ro или rw`);
    }
    // Обе стороны маунта раскрываются одинаково: путь установки (например MAPLE_DIR)
    // задаётся одной переменной в .env, и хост с контейнером не разъезжаются.
    const host = expandValue(requiredString(mount.host, `${where}.host`), env).trim();
    const container = expandValue(requiredString(mount.container, `${where}.container`), env).trim();
    // Пустая сторона маунта — это почти всегда неподставившаяся переменная
    // (${MAPLE_DIR} без MAPLE_DIR, например пустая vars.MAPLE_DIR из CI). Docker
    // ругается на такое «invalid spec: ::ro» уже посреди сборки, поэтому ловим
    // здесь и объясняем, чего не хватает.
    const sides: Array<[string, string]> = [
      ['host', host],
      ['container', container],
    ];
    for (const [side, text] of sides) {
      if (text === '') {
        throw new Error(
          `${where}.${side}: пусто — проверь, что переменная задана в .env или в окружении (например MAPLE_DIR)`,
        );
      }
    }
    return { host, container, mode: (mode ?? 'rw') as MountConfig['mode'] };
  });
}

const TRANSPORTS: Array<NonNullable<McpServerConfig['transport']>> = ['stdio', 'streamable-http', 'sse'];

/**
 * DNS-серверы контейнеров (docker.dns). Нужны там, где резолвер хоста не пускает
 * docker-подсети (например, unbound с access-control только на 10.0.0.0/8 отвечает
 * контейнерам REFUSED, и тогда каждый внешний запрос ждёт таймаут ~4 с, прежде чем
 * Docker уйдёт на следующий сервер из resolv.conf). Проверяем форму записи здесь,
 * чтобы опечатка не всплыла посреди `docker compose up`.
 */
const DNS_ENTRY = /^[0-9a-fA-F:.]{3,45}$/;

function parseDns(value: unknown): string[] {
  return asArray(value, 'docker.dns').map((item, index) => {
    const where = `docker.dns[${index}]`;
    const entry = requiredString(item, where);
    if (!DNS_ENTRY.test(entry)) {
      throw new Error(`${where}: «${entry}» — ожидался адрес DNS-сервера, например 1.1.1.1`);
    }
    return entry;
  });
}

function parseMcp(value: unknown, env: NodeJS.ProcessEnv): Record<string, McpServerConfig> {
  const record = value === undefined || value === null ? {} : asRecord(value, 'mcp');
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, item] of Object.entries(record)) {
    const where = `mcp.${name}`;
    const server = asRecord(item, where);
    const transportText = optionalString(server.transport, `${where}.transport`);
    if (transportText !== undefined && !TRANSPORTS.includes(transportText as NonNullable<McpServerConfig['transport']>)) {
      throw new Error(`${where}.transport: «${transportText}» — ожидалось ${TRANSPORTS.join(', ')}`);
    }
    const transport = transportText as NonNullable<McpServerConfig['transport']> | undefined;
    const lifecycle = optionalString(server.lifecycle, `${where}.lifecycle`);
    if (lifecycle !== undefined && lifecycle !== 'eager' && lifecycle !== 'lazy') {
      throw new Error(`${where}.lifecycle: «${lifecycle}» — ожидалось eager или lazy`);
    }
    const command = optionalString(server.command, `${where}.command`);
    const url = optionalString(server.url, `${where}.url`);
    const args = asArray(server.args, `${where}.args`).map((arg, index) =>
      requiredString(arg, `${where}.args[${index}]`),
    );
    servers[name] = {
      ...(transport === undefined ? {} : { transport }),
      ...(command === undefined ? {} : { command }),
      ...(args.length === 0 ? {} : { args }),
      ...(server.env === undefined ? {} : { env: stringMap(server.env, `${where}.env`, env) }),
      ...(url === undefined ? {} : { url }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
    };
  }
  return servers;
}

/** id идёт в имя контейнера и в путь на диске — держим его предсказуемым. */
const USER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;function parseUsers(value: unknown): UserConfig[] {
  const users = asArray(value, 'users').map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`users[${index}]: человек — это просто его id строкой, например "- probe"`);
    }
    const id = item.trim();
    if (!USER_ID.test(id)) {
      throw new Error(`users[${index}]: id «${id}» не годится — буквы, цифры, точка, дефис, подчёркивание`);
    }
    return { id };
  });
  if (users.length === 0) throw new Error('в конфиге нет ни одного человека (users)');
  const seen = new Set<string>();
  for (const user of users) {
    if (seen.has(user.id)) throw new Error(`users: id «${user.id}» повторяется`);
    seen.add(user.id);
  }
  return users;
}

/**
 * Telegram username: в конфиге и в апдейтах он в одном виде — без «@», нижним
 * регистром. В yaml имя с «@» придётся взять в кавычки: с @ начинаются
 * зарезервированные конструкции, и `@trousev: trousev` не разберётся.
 */
const TELEGRAM_USERNAME = /^[a-zA-Z0-9_]{3,32}$/;

export function normalizeTelegramUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

/**
 * Telegram: токен бота и карта «кто есть кто».
 *
 * Карту принимаем в двух написаниях: `telegram.mapping` и отдельным ключом
 * `telegram_mapping` — второе читается ровно как в жизни:
 *
 *   telegram_mapping:
 *     '@trousev': trousev
 *
 * Заданы оба — побеждает `telegram.mapping`.
 *
 * Без токена или с пустой картой бот просто не поднимается: сервис работает как
 * раньше, а в логе видно, чего не хватает.
 */
function parseTelegram(
  value: unknown,
  alias: unknown,
  env: NodeJS.ProcessEnv,
  users: UserConfig[],
): TelegramConfig | null {
  const raw = value === undefined || value === null ? {} : asRecord(value, 'telegram');
  // Токен можно и не писать: он подхватывается из .env, как ключи провайдеров.
  const token = expandValue(optionalString(raw.token, 'telegram.token') ?? '${TELEGRAM_BOT_TOKEN}', env).trim();

  const nested = raw.mapping;
  const mappingRaw = nested ?? alias;
  const where = nested === undefined ? 'telegram_mapping' : 'telegram.mapping';
  const mapping: Record<string, string> = {};

  if (mappingRaw !== undefined && mappingRaw !== null) {
    for (const [username, item] of Object.entries(asRecord(mappingRaw, where))) {
      const id = requiredString(item, `${where}.${username}`);
      if (!users.some((user) => user.id === id)) {
        throw new Error(`${where}.${username}: «${id}» нет в users — telegram-имя ведёт к человеку, которого нет`);
      }
      const key = normalizeTelegramUsername(username);
      if (!TELEGRAM_USERNAME.test(key)) {
        throw new Error(
          `${where}.${username}: «${username}» не похоже на telegram username — буквы, цифры и «_», без «@» ` +
            '(в yaml имя с @ берётся в кавычки)',
        );
      }
      mapping[key] = id;
    }
  }

  if (token === '') {
    if (Object.keys(mapping).length > 0) {
      log.info('telegram-бот не поднят: нет токена (положи TELEGRAM_BOT_TOKEN в .env)');
    }
    return null;
  }
  if (Object.keys(mapping).length === 0) {
    log.warn('telegram-бот не поднят: пусто в telegram.mapping — некому отвечать');
    return null;
  }
  return { token, mapping };
}

/** Заголовок Authelia по умолчанию: его подставляет nginx из ответа /api/verify. */
export const DEFAULT_PANEL_USER_HEADER = 'Remote-User';

/**
 * Разбор panel: заголовок прокси и человек для локального запуска. Незнакомый devUser —
 * ошибка, а не «панель никого не найдёт»: опечатку в id видно сразу на старте.
 */
function parsePanel(value: unknown, users: UserConfig[]): PanelConfig {
  const record = value === undefined || value === null ? {} : asRecord(value, 'panel');
  const devUser = optionalString(record.devUser, 'panel.devUser');
  if (devUser !== undefined && !users.some((user) => user.id === devUser)) {
    throw new Error(`panel.devUser: человека «${devUser}» нет в users`);
  }
  return {
    userHeader: optionalString(record.userHeader, 'panel.userHeader') ?? DEFAULT_PANEL_USER_HEADER,
    ...(devUser === undefined ? {} : { devUser }),
  };
}

/**
 * Голосовые: чем расшифровывать. Блока в конфиге нет — берём Whisper у DeepInfra,
 * чей ключ уже лежит в .env: голосовые должны работать без правки конфига, как и
 * остальные модели. Отключить совсем — `speech: none` (или `false`).
 *
 * Ключа провайдера нет — распознавание выключается с записью в лог: сервис работает
 * как раньше, а бот на голосовое отвечает, что не умеет, вместо тишины.
 */
function parseSpeech(value: unknown, env: NodeJS.ProcessEnv, auth: Record<string, string>): SpeechConfig | null {
  const off = value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'none');
  if (off) {
    log.info('распознавание голосовых выключено в конфиге (speech)');
    return null;
  }

  const raw = value === undefined || value === null ? {} : asRecord(value, 'speech');
  const provider = optionalString(raw.provider, 'speech.provider') ?? DEFAULT_SPEECH_PROVIDER;
  const known = SPEECH_PROVIDERS[provider];
  const language = optionalString(raw.language, 'speech.language');
  const baseUrl = (optionalString(raw.baseUrl, 'speech.baseUrl') ?? known?.baseUrl ?? '').replace(/\/+$/, '');
  const model = optionalString(raw.model, 'speech.model') ?? known?.model ?? '';
  const hints = `известные провайдеры: ${Object.keys(SPEECH_PROVIDERS).join(', ')}`;

  if (baseUrl === '') {
    throw new Error(`speech.provider: «${provider}» — не знаю адреса распознавания, задай speech.baseUrl (${hints})`);
  }
  if (model === '') {
    throw new Error(`speech.provider: «${provider}» — не знаю модели распознавания, задай speech.model (${hints})`);
  }

  // Ключ ищем и в auth, и прямо в окружении: распознавание — не модель, и его
  // провайдера в `models` может не быть (перешли на другую модель для чата —
  // голосовые от этого работать не перестают).
  const apiKey = auth[provider] ?? keyFromEnv(provider, env);
  if (apiKey === '') {
    const where = PROVIDER_ENV[provider] ?? `auth.${provider}`;
    log.info(`голосовые не расшифровываются: нет ключа ${provider} (положи ${where} в .env)`);
    return null;
  }

  return { provider, model, baseUrl, apiKey, ...(language === undefined ? {} : { language }) };
}

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): IcarusConfig {
  const resolved = expandValue(file, env);

  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new Error(`не читается конфиг ${resolved}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new Error(
      `конфиг ${resolved} не разбирается как YAML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const raw = asRecord(parsed, `конфиг ${resolved}`);
  const dockerRaw = raw.docker === undefined || raw.docker === null ? {} : asRecord(raw.docker, 'docker');
  const network = optionalString(dockerRaw.network, 'docker.network');
  const socket = optionalString(dockerRaw.socket, 'docker.socket');
  const dns = parseDns(dockerRaw.dns);

  const apiKey = expandValue(requiredString(raw.apiKey, 'apiKey'), env);
  if (apiKey === '') throw new Error('apiKey: пустой (возможно, не подставилась переменная окружения)');

  const models = parseModels(raw.models);
  const host = optionalString(raw.host, 'host') ?? '0.0.0.0';
  const port = numberOr(raw.port, 'port', 8081);
  const users = parseUsers(raw.users);
  const auth = parseAuth(raw.auth, env, models);

  return {
    host,
    port,
    apiKey,
    // В ссылке не покажешь «слушать везде»: без явного url человек получит localhost.
    url: expandValue(optionalString(raw.url, 'url') ?? `http://${publicHost(host)}:${port}`, env),
    dataDir: expandValue(optionalString(raw.dataDir, 'dataDir') ?? '~/icarus', env),
    sessionIdleMinutes: numberOr(raw.sessionIdleMinutes, 'sessionIdleMinutes', 60),
    panel: parsePanel(raw.panel, users),
    docker: {
      image: optionalString(dockerRaw.image, 'docker.image') ?? 'icarus-user:dev',
      ...(network === undefined ? {} : { network }),
      ...(dns.length === 0 ? {} : { dns }),
      prefix: optionalString(dockerRaw.prefix, 'docker.prefix') ?? 'icarus-user',
      socket: socket ?? null,
    },
    models,
    auth,
    env: stringMap(raw.env, 'env', env),
    mounts: parseMounts(raw.mounts, env),
    mcp: parseMcp(raw.mcp, env),
    telegram: parseTelegram(raw.telegram, raw.telegram_mapping, env, users),
    speech: parseSpeech(raw.speech, env, auth),
    users,
  };
}

export function findUser(config: IcarusConfig, userId: string | undefined): UserConfig | undefined {
  return config.users.find((user) => user.id === userId);
}

/** Человек по telegram username: имена сравниваем без «@» и без регистра. */
export function findTelegramUser(config: IcarusConfig, username: string | undefined): UserConfig | undefined {
  if (!username) return undefined;
  const id = config.telegram?.mapping[normalizeTelegramUsername(username)];
  return id === undefined ? undefined : findUser(config, id);
}

/**
 * Куда контейнер человека видит каталог вложений (см. userVolumes в compose.ts).
 * Путь нужен и сервису: вложение он кладёт на хост, а в реплику отдаёт уже этот
 * адрес — иначе pi искал бы файл мимо.
 */
export const CONTAINER_INCOMING = '/workspace/incoming';

/** Пути на хосте, которые сервис готовит и монтирует пользователю. */
export function userPaths(config: IcarusConfig, user: UserConfig) {
  const root = path.join(config.dataDir, 'users', user.id);
  return {
    root,
    memory: path.join(root, 'memory'),
    /**
     * Математика: журналы сессий Maple, графики и воркшиты. Лежит рядом с памятью
     * и переживает и перезапуск сервиса, и пересоздание контейнера: MCP-мост pi
     * поднимается на время чата, поэтому всё, что должно остаться, обязано лежать
     * на хосте, а не во временном каталоге внутри контейнера.
     */
    maple: path.join(root, 'maple'),
    incoming: path.join(root, 'incoming'),
    sessions: path.join(root, 'sessions'),
    piAgent: path.join(root, 'pi-agent'),
    /**
     * Скиллы: `~/.pi/agent/skills` внутри контейнера. Каталог агентский (не проектный),
     * поэтому pi берёт его без всякого доверия к проекту. Никто, кроме pi, в него сейчас
     * не пишет: скиллы кладут руками, панель правки скиллов — отдельная задача.
     */
    skills: path.join(root, 'pi-agent', 'skills'),
    agentsMd: path.join(root, 'AGENTS.md'),
    icarusMd: path.join(root, 'icarus.md'),
    /** Инструкция по Maple: читается агентом по требованию, не висит в промпте. */
    mapleMd: path.join(root, 'MAPLE.md'),
    sharedMemory: path.join(config.dataDir, 'shared'),
  };
}

/** Контейнеры: один на пользователя, живёт постоянно. */
export function userContainer(config: IcarusConfig, user: UserConfig): string {
  return `${config.docker.prefix}-${user.id}`;
}

/** 0.0.0.0 и :: — это «слушать везде»; в ссылке им делать нечего, остаётся localhost. */
export function publicHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host;
}
