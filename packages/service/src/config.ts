// Service configuration: config.yaml at the repository root.
//
// Everything that is the same for everyone (models, provider keys, mounts, MCP, environment)
// lives at the top level; the human keeps only an id — from it the container name, the
// directories under dataDir and the pi session id are derived. Otherwise the config grows with
// every human, and people's settings quietly drift apart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { log } from './log.ts';
import { isLanguage, type Language } from './profile.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root: it holds config.yaml, .env, icarus.md and the extensions. */
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config.yaml');
/** File with the keys: doesn't go into git, the template is .env.example. */
export const ENV_FILE = path.join(REPO_ROOT, '.env');

export type ModelConfig = {
  provider: string;
  id: string;
  thinking?: string;
  tier?: 'fast' | 'strong' | 'vision';
};

/** MCP server description: the same format that pi-mcp-extension reads. */
export type McpServerConfig = {
  transport?: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /**
   * Permanent HTTP transport headers (streamable-http, sse): X-Client, Accept —
   * the things that are the same for everyone. The access key is not written here: its name is
   * declared in secrets, and the value is entered by the human in the panel.
   */
  headers?: Record<string, string>;
  /**
   * Names of the secrets the server needs from the human: for stdio these are environment
   * variables, for HTTP — headers. There are no values here and there can't be: each person
   * enters them in the MCP settings, and they land in credentials.json under their userId.
   */
  secrets?: string[];
  lifecycle?: 'eager' | 'lazy';
  /**
   * Service server: everyone has it and it's always on, and it isn't in the panel.
   * This is how built-in abilities like Maple live — it's part of Icarus, not a third-party
   * tool the human adds, configures and turns off for themselves.
   * It still doesn't disappear from mcp.json and AGENTS.md.
   */
  hidden?: boolean;
  /**
   * Human-readable description of the server for the model. It doesn't go to mcp.json:
   * it's used to compose a hint in AGENTS.md — why the server is needed and when to
   * connect it (see renderAgentsMd). Without a description the model sees only the server name.
   */
  description?: string;
};

/**
 * When to connect an MCP server. By default — on demand: a lazy server doesn't keep
 * its tools in the prompt of every conversation. eager is a deliberate choice
 * for servers that are always needed.
 */
export const DEFAULT_MCP_LIFECYCLE: NonNullable<McpServerConfig['lifecycle']> = 'lazy';

export function mcpLifecycle(server: McpServerConfig): NonNullable<McpServerConfig['lifecycle']> {
  return server.lifecycle ?? DEFAULT_MCP_LIFECYCLE;
}

/**
 * Human: id and admin flag. Everything else is shared (see IcarusConfig).
 *
 * The admin edits the installation's secrets in the panel ("Keys" section). The flag is
 * optional: for a config written before it existed, trousev is considered the admin — that's
 * how the migration went, and the old config.yaml keeps working without edits (see
 * parseUsers). `admin` in the human object overrides this default.
 */
export type UserConfig = { id: string; admin?: boolean };

/**
 * Who got the flag during migration: before the "Keys" section appeared, one person edited
 * the keys by hand, and that was trousev. New people are given the flag explicitly.
 */
export const LEGACY_ADMIN_ID = 'trousev';

export function isAdmin(user: UserConfig | undefined): boolean {
  return user?.admin === true;
}

/**
 * Telegram bot: the main entrance to the same Icarus. We recognize the human by the username
 * in Telegram — it arrives in every message — and map it to the icarus human id:
 * the id is the same string as in `users` and in the x-icarus-user-id header. This way the bot
 * has no people table of its own: listed in `users` means you can also use it via Telegram.
 */
export type TelegramConfig = {
  token: string;
  /** Keys are telegram usernames without "@" and lowercased, values are ids from users. */
  mapping: Record<string, string>;
};

/**
 * Control panel: how the service finds out who opened it.
 *
 * The panel has no password and shouldn't have one: the human is named by the SSO proxy
 * (Authelia behind nginx in production), and the service reads their name from the header.
 * That's why the panel must live behind a proxy: an icarus port exposed around it is
 * someone else's memory in someone else's hands.
 */
export type PanelConfig = {
  /** The header with which the proxy names the logged-in person: Authelia sets Remote-User. */
  userHeader: string;
  /**
   * The human the panel pretends to be without SSO — only for local runs.
   * Set in production, the panel is open to anyone who can reach the port (the service complains about this).
   */
  devUser?: string;
};

/**
 * Speech recognition: the model can't hear Telegram voice messages, so they are first
 * converted to text by a separate provider model (Whisper on DeepInfra). The key
 * is taken from auth — the same one shipped into the container, so no new secrets are needed.
 */
export type SpeechConfig = {
  provider: string;
  /** recognition model id. */
  model: string;
  /** Dictation language — a hint to the recognizer; if unset, it determines it itself. */
  language?: string;
  /** Base URL of the provider's OpenAI-compatible API (the /audio/transcriptions method). */
  baseUrl: string;
  apiKey: string;
};

export type DockerConfig = {
  image: string;
  network?: string;
  prefix?: string;
  /** Container DNS servers; if unset, the host resolver is used (the usual case). */
  dns?: string[];
  socket?: string | null;
};

export type IcarusConfig = {
  host: string;
  port: number;
  apiKey: string;
  /**
   * External address of the control panel: the human opens it from the chat and from a bookmark.
   * Inside the container localhost is useless, so in production this is the public address.
   */
  url: string;
  dataDir: string;
  sessionIdleMinutes: number;
  /**
   * Default answer language: Russian or English. The human can override it
   * for themselves in the panel ("User" section), and this is the default for those who haven't chosen.
   */
  userLanguage?: Language;
  docker: DockerConfig;
  /** Control panel: the proxy header and (for local runs) the human without SSO. */
  panel: PanelConfig;
  /** Models of all people: escalation hands out the tiers. */
  models: ModelConfig[];
  /** Provider keys: those picked up from .env and the explicit ones from auth in config.yaml. */
  auth: Record<string, string>;
  /** Container environment variables: our extensions are configured with them. */
  env: Record<string, string>;
  /**
   * Maple installation directory, if the server is enabled: it's mounted into the container at
   * the same path as on the host (the launcher looks for its libraries at the path recorded inside).
   */
  mapleDir?: string;
  /** MCP servers: what Icarus grows with without editing code. */
  mcp: Record<string, McpServerConfig>;
  /** Telegram bot: null means disabled (no token or no one to answer). */
  telegram: TelegramConfig | null;
  /** Voice recognition: null means disabled (no provider key or disabled in the config). */
  speech: SpeechConfig | null;
  users: UserConfig[];
  /**
   * Where the config was read from. Needed so the panel can re-read it after
   * saving keys, without asking the caller for the path (see runtime.ts).
   */
  configPath?: string;
  /** Working keys file: .env at the root by default (overridden in tests). */
  envFile?: string;
  /** Panel settings: keys.json at the root by default (overridden in tests). */
  keysFile?: string;
  /**
   * Search router state (quarantines and the current provider). By default
   * search-router.json in dataDir; overridden in tests so as not to write to the shared one.
   */
  searchStateFile?: string;
  /**
   * Keys and variables from .env and the panel settings — exactly what should be shipped
   * into the pi process. The container gets them at creation, but a new key from the panel
   * must reach the next conversation without recreating the container: the service
   * passes this set into `docker exec -e` (see sessions/pi-session.ts).
   */
  secretEnv?: Record<string, string>;
};

/** Substitutes ~ and values of the form env:VAR_NAME / ${VAR_NAME}. */
export function expandValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const withHome = value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
  return withHome.replace(/\$\{([A-Z0-9_]+)\}|^env:([A-Z0-9_]+)$/g, (_m, braced, prefixed) => {
    const name = braced ?? prefixed;
    return env[name] ?? '';
  });
}

/**
 * Reads .env into process.env without overwriting what's already set to a non-empty value:
 * the environment is stronger than the file — exactly how docker compose with env_file behaves,
 * so the order doesn't depend on whether the service runs in a container or directly on the host.
 * No file is fine: keys may come from the environment. The values themselves are needed only
 * here (auth); compose passes the file whole to people's containers, so secrets don't end up
 * in docker-compose.yml.
 *
 * An empty string in the environment means "not set", not "empty": an unset variable
 * in CI (e.g. vars.MAPLE_DIR in deploy.yml) arrives exactly like that. It must not be
 * treated as set — it overrides a working value from .env, and ${MAPLE_DIR} in
 * config.yaml expands to '', and the mount to ::ro (docker: invalid spec).
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
    // An empty environment is the same as a missing one: otherwise an unset
    // variable from CI wipes out .env (see the comment on loadEnvFile).
    if (!process.env[name]) process.env[name] = value;
  }
}

// --- parsing and validation ---------------------------------------------------
// The config is the only thing the human edits by hand, so errors must come with the
// path to the field and in Russian, not "cannot read property of undefined".

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

/** String map, values get ~ and environment variables substituted. */
function stringMap(value: unknown, what: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const record = value === undefined || value === null ? {} : asRecord(value, what);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, expandValue(requiredString(item, `${what}.${key}`), env)]),
  );
}

/**
 * String map of an MCP server. There are no `env:VAR` or `${VAR}` substitutions here: MCP keys
 * are declared in `secrets` and entered in the panel, and everything else (addresses, ports,
 * modes) is written literally. Otherwise a "shared key from .env" would remain a back door
 * past the panel — exactly what we're moving away from.
 */
function literalMap(value: unknown, what: string): Record<string, string> {
  const record = value === undefined || value === null ? {} : asRecord(value, what);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      const text = requiredString(item, `${what}.${key}`);
      if (/\$\{[A-Za-z0-9_]+\}/.test(text) || /^env:[A-Za-z0-9_]+$/.test(text)) {
        throw new Error(
          `${what}.${key}: подстановка из окружения в MCP больше не работает — ` +
            'объяви имя в secrets этого сервера и введи значение в панели (MCP → «Настроить доступ»)',
        );
      }
      return [key, text];
    }),
  );
}

/**
 * pi provider → environment variable with its key. The list repeats pi's map
 * (@earendil-works/pi-ai, env-api-keys), so that a provider from models doesn't have to be
 * duplicated in config.yaml: put the key in .env — it's already in auth.json. If the provider
 * isn't in the list, the key is set explicitly via auth. One key for several
 * providers is normal: moonshotai and moonshotai-cn share one.
 *
 * deepinfra isn't in pi's catalog — it's our custom provider, its description lives in
 * providers.ts and is shipped to models.json. The key ends up in auth.json anyway: there it
 * is stored by provider name, and it never hurts.
 *
 * pi's special cases don't fit here, for those auth: remains — anthropic
 * also accepts ANTHROPIC_AUTH_TOKEN and ANTHROPIC_OAUTH_TOKEN, amazon-bedrock
 * gets by with AWS creds, google-vertex with Application Default Credentials.
 */
export const PROVIDER_ENV: Record<string, string> = {
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
 * DeepInfra is the only provider whose description we have to keep ourselves
 * (see providers.ts). The address is the same for chat and for speech recognition: the
 * OpenAI-compatible API has the same methods, only the path differs.
 */
export const DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';

/**
 * Where and with what to transcribe voice messages — by the provider name from `speech`.
 * The key is taken from auth (or from the environment — under the same name as the models),
 * we don't introduce a separate secret. For an unfamiliar provider neither the address nor the
 * model can be guessed: both are set in the config.
 */
export const SPEECH_PROVIDERS: Record<string, { baseUrl: string; model: string }> = {
  deepinfra: { baseUrl: DEEPINFRA_BASE_URL, model: 'openai/whisper-large-v3' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
};

/** By default DeepInfra's Whisper transcribes voice messages: the key is already in .env. */
export const DEFAULT_SPEECH_PROVIDER = 'deepinfra';

/**
 * Provider key from the environment — with a single list of names for everyone (PROVIDER_ENV).
 */
function keyFromEnv(provider: string, env: NodeJS.ProcessEnv): string {
  const name = PROVIDER_ENV[provider];
  return (name === undefined ? undefined : env[name])?.trim() ?? '';
}

/**
 * Keys that are already in the environment. We take only providers from models:
 * a key from a provider that isn't in the config isn't needed in auth.json.
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
 * Provider keys: what was found in the environment (.env), plus the explicit auth from
 * config.yaml — it wins. An empty explicit value is almost always an unsubstituted environment
 * variable, not a wish to work without a key: we complain right away, otherwise the service
 * would silently overwrite auth.json with a blank and the agent would break on the very first request.
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

const TIERS: Array<NonNullable<ModelConfig['tier']>> = ['fast', 'strong', 'vision'];/**
 * Maple directory: it's mounted by itself, it's no longer set with a separate mount in the config.
 * Empty or relative — an error: the path must be the same inside and outside.
 */
function resolveMapleDir(
  mcp: Record<string, McpServerConfig>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!mcp.maple) return undefined;
  const dir = (env.MAPLE_DIR ?? '').trim();
  if (dir === '') {
    throw new Error('MAPLE_DIR: не задан, а mcp.maple включён — положи путь в .env или выключи сервер');
  }
  if (!path.isAbsolute(dir)) throw new Error(`MAPLE_DIR: «${dir}» — нужен абсолютный путь`);
  return dir;
}

function parseModels(value: unknown): ModelConfig[] {
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


const TRANSPORTS: Array<NonNullable<McpServerConfig['transport']>> = ['stdio', 'streamable-http', 'sse'];

/**
 * Container DNS servers (docker.dns). Needed where the host resolver doesn't let
 * docker subnets through (e.g. unbound with access-control only on 10.0.0.0/8 answers
 * containers with REFUSED, and then every external request waits ~4 s for the timeout before
 * Docker moves on to the next server from resolv.conf). We validate the entry format here
 * so a typo doesn't surface in the middle of `docker compose up`.
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

/** Header/variable name: both for secrets and for the "secret isn't set as a value" check. */
const SECRET_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Secret names of the shared server. Names only: each human has their own value,
 * so there's nothing for it to do in config.yaml.
 */
function parseSecrets(value: unknown, what: string): string[] | undefined {
  const names = asArray(value, what).map((item, index) => requiredString(item, `${what}[${index}]`));
  const out: string[] = [];
  for (const name of names) {
    if (!SECRET_NAME.test(name)) {
      throw new Error(`${what}: «${name}» не похоже на имя заголовка или переменной окружения`);
    }
    if (out.includes(name)) throw new Error(`${what}: «${name}» повторяется`);
    out.push(name);
  }
  return out.length === 0 ? undefined : out;
}

function parseMcp(value: unknown): Record<string, McpServerConfig> {
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
    const description = optionalString(server.description, `${where}.description`);
    if (server.hidden !== undefined && typeof server.hidden !== 'boolean') {
      throw new Error(`${where}.hidden: ожидалось true или false`);
    }
    const hidden = server.hidden === true;
    const args = asArray(server.args, `${where}.args`).map((arg, index) =>
      requiredString(arg, `${where}.args[${index}]`),
    );
    const env = literalMap(server.env, `${where}.env`);
    const headers = literalMap(server.headers, `${where}.headers`);
    const secrets = parseSecrets(server.secrets, `${where}.secrets`);
    for (const secret of secrets ?? []) {
      if (Object.hasOwn(env, secret) || Object.hasOwn(headers, secret)) {
        throw new Error(
          `${where}.secrets: «${secret}» объявлен секретом, значит значения в env/headers быть не должно — ` +
            'его вводит человек в панели и оно хранится в его credentials.json',
        );
      }
    }
    servers[name] = {
      ...(transport === undefined ? {} : { transport }),
      ...(command === undefined ? {} : { command }),
      ...(args.length === 0 ? {} : { args }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(url === undefined ? {} : { url }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(secrets === undefined ? {} : { secrets }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(description === undefined ? {} : { description }),
      ...(hidden ? { hidden: true } : {}),
    };
  }
  return servers;
}

/** The id goes into the container name and the disk path — we keep it predictable. */
const USER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Default answer language. A typo here isn't a reason not to come up: an unknown
 * language is ignored with a log entry, and the human gets the built-in Russian.
 */
function parseLanguage(value: unknown): Language | undefined {
  if (value === undefined || value === null) return undefined;
  if (isLanguage(value)) return value;
  log.warn('userLanguage в конфиге непонятен — беру русский', { value: String(value) });
  return undefined;
}

/**
 * People. Two spellings: a string (as it was) and an object with an admin flag.
 *
 *   users:
 *     - trousev            # admin by migration: before the flag, they alone edited the keys
 *     - id: vita
 *       admin: true        # explicitly granted flag
 *
 * The admin flag isn't cosmetic: it opens the "Keys" section, i.e. access to all
 * the installation's secrets. That's why it's granted explicitly, not to "whoever comes first":
 * for an old config without objects there's exactly one admin — trousev (LEGACY_ADMIN_ID).
 * An explicit `admin: false` overrides this default: the flag can be taken away from the founder.
 */
function parseUsers(value: unknown): UserConfig[] {
  const users = asArray(value, 'users').map((item, index) => {
    const where = `users[${index}]`;
    if (typeof item === 'string') {
      const id = item.trim();
      if (!USER_ID.test(id)) {
        throw new Error(`${where}: id «${id}» не годится — буквы, цифры, точка, дефис, подчёркивание`);
      }
      return id === LEGACY_ADMIN_ID ? { id, admin: true } : { id };
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where}: человек — это его id строкой или объект с id и admin`);
    }
    const record = item as Record<string, unknown>;
    const id = requiredString(record.id, `${where}.id`);
    if (!USER_ID.test(id)) {
      throw new Error(`${where}.id: «${id}» не годится — буквы, цифры, точка, дефис, подчёркивание`);
    }
    const admin = record.admin;
    if (admin !== undefined && typeof admin !== 'boolean') {
      throw new Error(`${where}.admin: ожидалось true или false`);
    }
    return admin === true ? { id, admin: true } : { id };
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
 * Telegram username: in the config and in updates it's in one form — without "@", lowercased.
 * In yaml a name with "@" has to be quoted: reserved constructs start with @,
 * and `@trousev: trousev` won't parse.
 */
const TELEGRAM_USERNAME = /^[a-zA-Z0-9_]{3,32}$/;

export function normalizeTelegramUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

/**
 * Telegram: bot token and the "who is who" map.
 *
 * We accept the map in two spellings: `telegram.mapping` and a separate key
 * `telegram_mapping` — the latter reads exactly as in real life:
 *
 *   telegram_mapping:
 *     '@trousev': trousev
 *
 * If both are set, `telegram.mapping` wins.
 *
 * Without a token or with an empty map the bot simply doesn't come up: the service works as
 * before, and the log shows what's missing.
 */
function parseTelegram(
  value: unknown,
  alias: unknown,
  env: NodeJS.ProcessEnv,
  users: UserConfig[],
): TelegramConfig | null {
  const raw = value === undefined || value === null ? {} : asRecord(value, 'telegram');
  // The token can be omitted too: it's picked up from .env, like the provider keys.
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

/** The default Authelia header: nginx sets it from the /api/verify response. */
export const DEFAULT_PANEL_USER_HEADER = 'Remote-User';

/**
 * Parsing panel: the proxy header and the human for local runs. An unfamiliar devUser is
 * an error, not "the panel won't find anyone": a typo in the id is visible right at startup.
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
 * Voice messages: with what to transcribe. If there's no block in the config — take DeepInfra's
 * Whisper, whose key is already in .env: voice messages should work without editing the config,
 * just like the other models. To disable entirely — `speech: none` (or `false`).
 *
 * If there's no provider key, recognition is disabled with a log entry: the service works
 * as before, and the bot answers a voice message that it can't, instead of silence.
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

  // We look for the key both in auth and directly in the environment: recognition isn't a
  // model, and its provider may not be in `models` (you switched to another model for chat —
  // voice messages don't stop working because of that).
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
  if (raw.mounts !== undefined) {
    // There are no more custom mounts: the container sees only /workspaces and service stuff.
    // Need someone else's repository — check it out into the workspace, not a mount from the host.
    log.warn('mounts в конфиге больше не поддерживаются и пропущены', { file: resolved });
  }
  const mcp = parseMcp(raw.mcp);
  const mapleDir = resolveMapleDir(mcp, env);

  return {
    host,
    port,
    apiKey,
    // You can't show "listen everywhere" in a link: without an explicit url the human gets localhost.
    url: expandValue(optionalString(raw.url, 'url') ?? `http://${publicHost(host)}:${port}`, env),
    dataDir: expandValue(optionalString(raw.dataDir, 'dataDir') ?? '~/icarus', env),
    sessionIdleMinutes: numberOr(raw.sessionIdleMinutes, 'sessionIdleMinutes', 60),
    ...(parseLanguage(raw.userLanguage) === undefined ? {} : { userLanguage: parseLanguage(raw.userLanguage) }),    panel: parsePanel(raw.panel, users),
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
    mcp,
    ...(mapleDir === undefined ? {} : { mapleDir }),
    telegram: parseTelegram(raw.telegram, raw.telegram_mapping, env, users),
    speech: parseSpeech(raw.speech, env, auth),
    users,
    // The path isn't a secret or a setting, but the panel needs it to re-read the file
    // after saving keys (see runtime.ts).
    configPath: resolved,
  };
}

export function findUser(config: IcarusConfig, userId: string | undefined): UserConfig | undefined {
  return config.users.find((user) => user.id === userId);
}

/** The human by telegram username: we compare names without "@" and case-insensitively. */
export function findTelegramUser(config: IcarusConfig, username: string | undefined): UserConfig | undefined {
  if (!username) return undefined;
  const id = config.telegram?.mapping[normalizeTelegramUsername(username)];
  return id === undefined ? undefined : findUser(config, id);
}

/**
 * Icarus's service directory inside the container. Everything "about Icarus" is here: memory,
 * attachments, sessions, persona and the environment map. The `/workspace` itself stays
 * empty and free: it's the human's place, where the agent can put anything
 * without touching anything. One list for the whole codebase — so that the mount point and the
 * path that goes into the prompt don't drift apart.
 */
export const CONTAINER_HOME = '/workspaces/.icarus';

/**
 * Root of the workspaces. One workspace — one folder inside: the agent works
 * in /workspaces/<slug>, and the service household sits next to it, in /workspaces/.icarus,
 * and isn't part of any workspace. This way the human's folder stays their folder, and we
 * don't mix our files into it.
 */
export const CONTAINER_WORKSPACES = '/workspaces';

/** Paths inside the container: only what we mount ourselves (see userVolumes). */
export const CONTAINER_PATHS = {
  workspaces: CONTAINER_WORKSPACES,
  home: CONTAINER_HOME,
  /** Global artifact library: shared by everyone, a separate mount. */
  artifacts: '/artifacts',
  memory: `${CONTAINER_HOME}/memory`,
  incoming: `${CONTAINER_HOME}/incoming`,
  sessions: `${CONTAINER_HOME}/sessions`,
  /** Conversation registry: read-only, so the agent can link the panel id to the pi session. */
  chats: `${CONTAINER_HOME}/chats.json`,
  /** Conversation map for the agent: conversationId → sessionId and the history file. */
  sessionsMap: `${CONTAINER_HOME}/sessions.json`,
  sharedMemory: `${CONTAINER_HOME}/shared-memory`,
  /**
   * Snapshots of shared skills: the global directory `<dataDir>/skills/shared`,
   * mounted read-only. Enabled skills from there arrive in the human's
   * settings.json as additional paths, rather than being copied into their directory.
   */
  sharedSkills: `${CONTAINER_HOME}/shared-skills`,
  agentsMd: `${CONTAINER_HOME}/AGENTS.md`,
  icarusMd: `${CONTAINER_HOME}/icarus.md`,
  /** pi-agent is mounted to pi, not into the working tree: it's its own home. */
  piAgent: '/home/node/.pi/agent',
} as const;

/** Default workspace: dialogues live in it and return to it. */
export const DEFAULT_WORKSPACE = 'talk';

/** Private workspace: memory is visible, but you can't write to it. */
export const PRIVATE_WORKSPACE = 'private';

/** Workspace directory inside the container — it's also the cwd of the pi session. */
export function containerWorkspace(slug: string): string {
  return `${CONTAINER_WORKSPACES}/${slug}`;
}

/**
 * Where the human's container sees the attachments directory (see userVolumes in compose.ts).
 * The service needs the path too: it puts the attachment on the host, but passes this
 * address in the reply — otherwise pi would look for the file in the wrong place.
 */
export const CONTAINER_INCOMING = CONTAINER_PATHS.incoming;

/** Host paths that the service prepares and mounts for the user. */
export function userPaths(config: IcarusConfig, user: UserConfig) {
  const root = path.join(config.dataDir, 'users', user.id);
  // Everything service-related is under /workspaces/.icarus: the workspace root
  // is mounted into the container whole, and .icarus simply lies inside it.
  const workspaces = path.join(root, 'workspaces');
  const icarus = path.join(workspaces, '.icarus');
  return {
    root,
    workspaces,
    icarus,
    memory: path.join(icarus, 'memory'),
    incoming: path.join(icarus, 'incoming'),
    sessions: path.join(icarus, 'sessions'),
    /** The conversation registry lies in the human's root, and is given to the container inside .icarus. */
    chats: path.join(root, 'chats.json'),
    /**
     * Task schedules lie in the human's root next to the chats: a schedule
     * belongs to the human, not the conversation — a task survives /clear and the move
     * of the previous run to the archive.
     */
    scheduledTasks: path.join(root, 'scheduled-tasks.json'),
    /** Conversation map for the agent — next to the registry, also read-only. */
    sessionsMap: path.join(icarus, 'sessions.json'),
    piAgent: path.join(root, 'pi-agent'),
    /**
     * Skills: `~/.pi/agent/skills` inside the container. The directory is agent-level (not project-level),
     * so pi takes it without any trust in the project. The panel writes here, the
     * "Skills" section (control/skills.ts), and keeps the directory under git — history and rollback
     * the panel promises are the same as for memory.
     */
    skills: path.join(root, 'pi-agent', 'skills'),
    agentsMd: path.join(icarus, 'AGENTS.md'),
    icarusMd: path.join(icarus, 'icarus.md'),
    sharedMemory: path.join(config.dataDir, 'shared'),
  };
}

/** Containers: one per user, running permanently. */
export function userContainer(config: IcarusConfig, user: UserConfig): string {
  return `${config.docker.prefix}-${user.id}`;
}

/** 0.0.0.0 and :: mean "listen everywhere"; they have no place in a link, so localhost remains. */
export function publicHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host;
}
