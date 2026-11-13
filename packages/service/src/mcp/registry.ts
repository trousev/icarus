// User MCPs: who created them, who they were shared with, and who has them enabled.
//
// config.yaml remains the place for shared servers (echo, Maple, Home Assistant): they are
// created by whoever runs the stack. Everything a person added themselves in the panel lives here,
// in dataDir — next to memory, but in separate files:
//
//   <dataDir>/mcp/registry.json    — server descriptions and per-person toggles;
//   <dataDir>/mcp/credentials.json — keys and OAuth tokens, 0600 only.
//
// The split is intentional: descriptions can be shown, copied and taken into a backup,
// while keys must not travel along with them. A token is as much a secret as a model
// key, and it is stored with the same permissions as auth.json in the container.
//
// The main visibility rule: a server is seen by its owner and everyone it was shared with.
// Once shared, the server arrives to another person DISABLED: they must enable it
// themselves. While a server is disabled, it is neither in mcp.json nor in AGENTS.md, i.e.
// it takes up neither context nor prompt. Keys are not copied, though: each
// person configures access themselves, otherwise "share a server" would imperceptibly mean
// "share your account".
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IcarusConfig, McpServerConfig } from '../config.ts';

/** Format version: without it a future migration couldn't tell an old file from a new one. */
export const MCP_STORE_VERSION = 1;

export type McpTransport = NonNullable<McpServerConfig['transport']>;
export type McpAuthType = 'none' | 'headers' | 'oauth';

/**
 * OAuth state of one person on one server. Here are both the tokens and what
 * is needed to refresh them: issuer, endpoints, client_id and the client
 * authentication method. All of this is secrets or near-secrets, hence the separate file.
 */
export type McpOAuthCredentials = {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  /** When the access token expires, ms since epoch. Absent — assume it doesn't expire. */
  expiresAt?: number;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** Canonical resource address: the same one that goes into resource (RFC 8707). */
  resource?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
  /**
   * The redirect address the client was registered with. In mimic mode it is
   * a dead loopback, otherwise the panel's public callback. Stored so that a repeat
   * login doesn't slip a different redirect_uri to the server: it must match.
   */
  redirectUri?: string;
  /**
   * Local proxy key of the service. pi uses it to go to /mcp-proxy/<key>, and
   * the service substitutes a fresh Bearer on every request. The token is not in mcp.json.
   */
  proxyKey?: string;
  authorizedAt?: string;
  /** The last refresh/authorization error — for the person in the panel, not for the model. */
  error?: string;
};

export type McpCredentials = {
  /** Access headers of this person. Not shown to others and not shared. */
  headers?: Record<string, string>;
  /** Environment variables of this person's stdio server. */
  env?: Record<string, string>;
  oauth?: McpOAuthCredentials;
};

/** Description of a user server. There are no secrets here. */
export type UserMcpServer = {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  /**
   * Persistent description headers (e.g. X-Client: icarus). We don't put an access
   * key here — it's in credentials, otherwise it would travel to everyone it was shared with.
   */
  headers?: Record<string, string>;
  /** Persistent environment variables of the stdio server, also without secrets. */
  env?: Record<string, string>;
  /**
   * Names of the keys the server will need (the recipe knows them in advance).
   * Names only: the values live in credentials and are shown to the person as empty.
   */
  credentialEnv?: string[];
  credentialHeaders?: string[];
  auth: McpAuthType;
  /** Requested scopes: a space-separated string, as in OAuth. */
  scopes?: string;
  /** A pre-registered client_id (public, not a secret). */
  clientId?: string;
  /** Manual endpoints: needed where the server doesn't advertise RFC 9728/8414. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  issuer?: string;
  /**
   * The server only accepts "its own" redirect addresses (Any.do does this: it has
   * a whitelist of redirect_uri). Then login goes to a dead loopback — the same
   * as with Claude Code — and the person pastes the address from the browser bar into the panel.
   */
  mimic?: boolean;
  owner: string;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
};

export type McpStore = {
  version: number;
  servers: Record<string, UserMcpServer>;
  /** userId -> serverId -> whether the server is enabled for this person. */
  prefs: Record<string, Record<string, boolean>>;
  /** userId -> serverId -> keys and tokens. */
  credentials: Record<string, Record<string, McpCredentials>>;
};

/** What the person submitted in the panel. Secrets — only in credentials. */
export type McpServerInput = {
  name: string;
  description?: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** What the server expects from the person: key names from the recipe, without values. */
  credentialEnv?: string[];
  credentialHeaders?: string[];
  auth?: McpAuthType;
  scopes?: string;
  clientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  issuer?: string;
  mimic?: boolean;
  shared?: boolean;
  credentials?: McpCredentials;
};

/** A server as seen by the panel: no secrets, no internal paths. */
export type McpView = {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  /** Address or command without secrets in the query. */
  target: string;
  auth: McpAuthType;
  /** A server from config.yaml: it cannot be deleted or rewritten from the panel. */
  global: boolean;
  owner: string | null;
  ownerIsMe: boolean;
  shared: boolean;
  enabled: boolean;
  /** Whether the server is ready to work: there is a key/OAuth token (or none is needed). */
  ready: boolean;
  authState: 'none' | 'ready' | 'needed' | 'expired' | 'error';
  authMessage?: string;
  /** Login goes through a dead loopback: the card asks to paste the address manually. */
  mimic?: boolean;
  /** Names of already saved secrets: values do not travel to the panel. */
  credentialHeaders?: string[];
  credentialEnv?: string[];
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
};

export type McpViewList = { servers: McpView[]; enabled: number; ready: number };

export class McpError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'McpError';
    this.status = status;
  }
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 600;
const URL_LIMIT = 2048;
const HEADER_LIMIT = 20;
const HEADER_VALUE_LIMIT = 8192;
const ENV_LIMIT = 40;
const ENV_VALUE_LIMIT = 8192;
const ARGS_LIMIT = 60;

/** Transliteration for id: a Russian name must yield a predictable Latin slug. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugify(value: string): string {
  const latin = value
    .toLowerCase()
    .split('')
    .map((char) => TRANSLIT[char] ?? char)
    .join('');
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'mcp';
}

export function storePaths(config: IcarusConfig): { dir: string; registry: string; credentials: string } {
  const dir = path.join(config.dataDir, 'mcp');
  return {
    dir,
    registry: path.join(dir, 'registry.json'),
    credentials: path.join(dir, 'credentials.json'),
  };
}

function emptyStore(): McpStore {
  return { version: MCP_STORE_VERSION, servers: {}, prefs: {}, credentials: {} };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpError(`${where}: ожидался объект`, 500);
  }
  return value as Record<string, unknown>;
}

function readJson(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new McpError(
      `файл MCP ${file} не разбирается: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

/**
 * Reads both files. There are no secrets in error messages — only the path and the cause:
 * otherwise a broken registry.json would itself become a leak.
 */
export function readStore(config: IcarusConfig): McpStore {
  const paths = storePaths(config);
  const store = emptyStore();
  if (fs.existsSync(paths.registry)) {
    const raw = asRecord(readJson(paths.registry), 'registry.json');
    const servers = raw.servers === undefined ? {} : asRecord(raw.servers, 'registry.json.servers');
    for (const [id, item] of Object.entries(servers)) {
      const server = asRecord(item, `registry.json.servers.${id}`) as Partial<UserMcpServer>;
      if (server.id !== id || typeof server.name !== 'string' || typeof server.owner !== 'string') {
        throw new McpError(`registry.json: сервер «${id}» записан не целиком`, 500);
      }
      store.servers[id] = server as UserMcpServer;
    }
    const prefs = raw.prefs === undefined ? {} : asRecord(raw.prefs, 'registry.json.prefs');
    for (const [userId, own] of Object.entries(prefs)) {
      const map = asRecord(own, `registry.json.prefs.${userId}`);
      store.prefs[userId] = {};
      for (const [id, enabled] of Object.entries(map)) {
        if (typeof enabled === 'boolean') store.prefs[userId][id] = enabled;
      }
    }
  }
  if (fs.existsSync(paths.credentials)) {
    const raw = asRecord(readJson(paths.credentials), 'credentials.json');
    for (const [userId, own] of Object.entries(raw)) {
      if (!own || typeof own !== 'object' || Array.isArray(own)) continue;
      store.credentials[userId] = own as Record<string, McpCredentials>;
    }
  }
  return store;
}

function writeAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Permissions don't change on every filesystem; we still write the file closed.
  }
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function writeStore(config: IcarusConfig, store: McpStore): void {
  const paths = storePaths(config);
  writeAtomic(
    paths.registry,
    `${JSON.stringify({ version: MCP_STORE_VERSION, servers: store.servers, prefs: store.prefs }, null, 2)}\n`,
  );
  writeAtomic(paths.credentials, `${JSON.stringify(store.credentials, null, 2)}\n`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new McpError(`${where}: ожидалась строка`);
  return value.trim();
}

function optionalText(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new McpError(`${where}: ожидалась строка`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function limited(value: string | undefined, limit: number, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > limit) throw new McpError(`${where}: длиннее ${limit} символов`);
  return value;
}

function decodeHeaderName(name: string): string {
  return name.trim();
}

function stringMap(value: unknown, where: string, limit: number, valueLimit: number): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpError(`${where}: ожидался объект`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > limit) throw new McpError(`${where}: больше ${limit} записей`);
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = decodeHeaderName(rawName);
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new McpError(`${where}: имя «${name}» не похоже на имя заголовка/переменной`);
    }
    if (typeof rawValue !== 'string') throw new McpError(`${where}.${name}: ожидалась строка`);
    if (rawValue.length > valueLimit) throw new McpError(`${where}.${name}: длиннее ${valueLimit} символов`);
    if (/[\r\n]/.test(rawValue)) throw new McpError(`${where}.${name}: перевод строки недопустим`);
    if (rawValue !== '') out[name] = rawValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** List of key names: the recipe says what to ask for, but doesn't substitute values. */
function nameList(value: unknown, where: string, limit: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new McpError(`${where}: ожидался массив имён`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new McpError(`${where}: ожидалась строка`);
    const name = item.trim();
    if (name === '') continue;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new McpError(`${where}: «${name}» не похоже на имя переменной/заголовка`);
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > limit) throw new McpError(`${where}: больше ${limit} имён`);
  return out.length > 0 ? out : undefined;
}

function httpUrl(value: string, where: string): string {
  if (value.length > URL_LIMIT) throw new McpError(`${where}: длиннее ${URL_LIMIT} символов`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError(`${where}: «${value}» не похоже на адрес`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new McpError(`${where}: нужен http или https, а не ${url.protocol}`);
  }
  if (url.hash) throw new McpError(`${where}: фрагмент (#…) в адресе MCP-сервера не нужен`);
  if (url.username || url.password) {
    throw new McpError(`${where}: логин и пароль в адресе — плохая идея, положи ключ в заголовок`);
  }
  return url.toString();
}

function normalizeTransport(value: unknown): McpTransport {
  const transport = value === undefined || value === null ? undefined : text(value, 'transport');
  if (transport === undefined) return 'streamable-http';
  if (transport === 'stdio' || transport === 'sse' || transport === 'streamable-http') return transport;
  throw new McpError('transport: ожидалось stdio, sse или streamable-http');
}

function normalizeAuth(value: unknown): McpAuthType {
  if (value === undefined || value === null) return 'none';
  const auth = text(value, 'auth');
  if (auth === 'none' || auth === 'headers' || auth === 'oauth') return auth;
  throw new McpError('auth: ожидалось none, headers или oauth');
}

/** Validates and cleans what the person submitted in the form. */
export function normalizeInput(raw: McpServerInput): McpServerInput {
  const name = text(raw.name, 'name');
  if (name === '') throw new McpError('имя не может быть пустым');
  limited(name, NAME_LIMIT, 'имя');
  const description = limited(optionalText(raw.description, 'description'), DESCRIPTION_LIMIT, 'описание');
  const transport = normalizeTransport(raw.transport);
  const auth = normalizeAuth(raw.auth);
  const shared = raw.shared === true;

  if (transport === 'stdio') {
    const command = limited(optionalText(raw.command, 'command'), URL_LIMIT, 'команда');
    if (!command) throw new McpError('для stdio нужна команда запуска');
    if (/[\r\n]/.test(command)) throw new McpError('команда не должна содержать перевод строки');
    const args = (raw.args ?? [])
      .map((arg, index) => {
        if (typeof arg !== 'string') throw new McpError(`args[${index}]: ожидалась строка`);
        if (arg.length > URL_LIMIT) throw new McpError(`args[${index}]: слишком длинный аргумент`);
        if (/[\r\n]/.test(arg)) throw new McpError(`args[${index}]: перевод строки недопустим`);
        return arg;
      })
      .filter((arg) => arg !== '');
    if (args.length > ARGS_LIMIT) throw new McpError(`args: больше ${ARGS_LIMIT} аргументов`);
    if (auth === 'oauth') throw new McpError('OAuth бывает только у HTTP-серверов: stdio берёт ключи из окружения');
    const env = stringMap(raw.env, 'env', ENV_LIMIT, ENV_VALUE_LIMIT);
    const credentialEnv = nameList(raw.credentialEnv, 'credentialEnv', ENV_LIMIT);
    return {
      name,
      ...(description === undefined ? {} : { description }),
      transport,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env === undefined ? {} : { env }),
      ...(credentialEnv === undefined ? {} : { credentialEnv }),
      auth,
      shared,
    };
  }

  if (!raw.url) throw new McpError('для HTTP-сервера нужен адрес');
  const url = httpUrl(text(raw.url, 'url'), 'адрес');
  const headers = stringMap(raw.headers, 'headers', HEADER_LIMIT, HEADER_VALUE_LIMIT);
  // Key expectations make sense only for "key / headers": with OAuth the login
  // is done via the browser, and a list of env there would be a false hint.
  const credentialHeaders = auth === 'headers' ? nameList(raw.credentialHeaders, 'credentialHeaders', HEADER_LIMIT) : undefined;
  const scopes = limited(optionalText(raw.scopes, 'scopes'), DESCRIPTION_LIMIT, 'scopes');
  const clientId = limited(optionalText(raw.clientId, 'clientId'), URL_LIMIT, 'clientId');
  const authorizationEndpoint =
    optionalText(raw.authorizationEndpoint, 'authorizationEndpoint') === undefined
      ? undefined
      : httpUrl(optionalText(raw.authorizationEndpoint, 'authorizationEndpoint')!, 'authorizationEndpoint');
  const tokenEndpoint =
    optionalText(raw.tokenEndpoint, 'tokenEndpoint') === undefined
      ? undefined
      : httpUrl(optionalText(raw.tokenEndpoint, 'tokenEndpoint')!, 'tokenEndpoint');
  const registrationEndpoint =
    optionalText(raw.registrationEndpoint, 'registrationEndpoint') === undefined
      ? undefined
      : httpUrl(optionalText(raw.registrationEndpoint, 'registrationEndpoint')!, 'registrationEndpoint');
  const issuer =
    optionalText(raw.issuer, 'issuer') === undefined ? undefined : httpUrl(optionalText(raw.issuer, 'issuer')!, 'issuer');
  if (auth === 'oauth' && (authorizationEndpoint === undefined) !== (tokenEndpoint === undefined)) {
    throw new McpError('ручные OAuth endpoints задаются парой: и authorization, и token');
  }

  return {
    name,
    ...(description === undefined ? {} : { description }),
    transport,
    url,
    ...(headers === undefined ? {} : { headers }),
    ...(credentialHeaders === undefined ? {} : { credentialHeaders }),
    auth,
    ...(scopes === undefined ? {} : { scopes }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(authorizationEndpoint === undefined ? {} : { authorizationEndpoint }),
    ...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
    ...(registrationEndpoint === undefined ? {} : { registrationEndpoint }),
    ...(issuer === undefined ? {} : { issuer }),
    // Mimicry exists only with OAuth: it changes redirect_uri, and without login it isn't needed.
    ...(auth === 'oauth' && raw.mimic === true ? { mimic: true } : {}),
    shared,
  };
}

function idsTaken(config: IcarusConfig, store: McpStore): Set<string> {
  return new Set([...Object.keys(config.mcp ?? {}), ...Object.keys(store.servers)]);
}

function uniqueId(config: IcarusConfig, store: McpStore, name: string): string {
  const taken = idsTaken(config, store);
  const base = slugify(name);
  if (!taken.has(base) && ID_PATTERN.test(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base.slice(0, 36)}-${index}`;
    if (!taken.has(candidate) && ID_PATTERN.test(candidate)) return candidate;
  }
  throw new McpError('не вышло подобрать id: слишком много серверов с таким именем', 409);
}

export function isVisible(config: IcarusConfig, store: McpStore, userId: string, id: string): boolean {
  if (Object.hasOwn(config.mcp ?? {}, id)) return true;
  const server = store.servers[id];
  return Boolean(server && (server.owner === userId || server.shared));
}

export function getServer(config: IcarusConfig, store: McpStore, id: string): UserMcpServer | undefined {
  return store.servers[id];
}

function isGlobal(config: IcarusConfig, id: string): boolean {
  return Object.hasOwn(config.mcp ?? {}, id);
}

/**
 * Service server: it is declared in config.yaml with the hidden flag. It is not in the panel,
 * and you cannot disable it for yourself — it is a built-in capability, not someone else's tool.
 * At the same time it always goes into the person's mcp.json.
 */
export function isHidden(config: IcarusConfig, id: string): boolean {
  return config.mcp?.[id]?.hidden === true;
}

function enabledFor(store: McpStore, userId: string, id: string, fallback: boolean): boolean {
  return store.prefs[userId]?.[id] ?? fallback;
}

function oauthFresh(oauth: McpOAuthCredentials | undefined, now = Date.now()): boolean {
  if (!oauth?.accessToken) return false;
  return oauth.expiresAt === undefined || oauth.expiresAt > now + 30_000;
}

function hasHeaders(server: UserMcpServer, credentials: McpCredentials | undefined): boolean {
  return Object.keys(credentials?.headers ?? {}).length > 0 || Object.keys(server.headers ?? {}).length > 0;
}

function authStateOf(
  server: UserMcpServer,
  credentials: McpCredentials | undefined,
  now: number,
): { ready: boolean; state: McpView['authState']; message?: string } {
  if (server.auth === 'none') return { ready: true, state: 'none' };
  if (server.auth === 'headers') {
    // For stdio, readiness is determined only by personal environment variables. The persistent
    // env is part of the description, it travels to everyone the server was shared with: counting it as
    // "key configured" would mean promising the model tools without access.
    const has = server.transport === 'stdio'
      ? Object.keys(credentials?.env ?? {}).length > 0
      : hasHeaders(server, credentials);
    return has
      ? { ready: true, state: 'ready' }
      : {
          ready: false,
          state: 'needed',
          message: server.transport === 'stdio' ? 'нужны переменные окружения' : 'нужен ключ доступа',
        };
  }
  const oauth = credentials?.oauth;
  if (oauthFresh(oauth, now)) return { ready: true, state: 'ready' };
  // The proxy can refresh the token itself, and if the refresh is dead — return a link to
  // re-login. That's why a server with a proxy key stays in mcp.json even
  // with an expired token: otherwise the person would see the problem only in the panel.
  if (oauth?.proxyKey && (oauth.accessToken || oauth.refreshToken)) {
    return oauth.error
      ? { ready: true, state: 'error', message: oauth.error }
      : { ready: true, state: 'expired', message: 'токен обновится при запросе через прокси' };
  }
  if (oauth?.error) return { ready: false, state: 'error', message: oauth.error };
  if (oauth?.refreshToken) {
    return { ready: false, state: 'expired', message: 'токен истёк — обновится при следующем подключении' };
  }
  return { ready: false, state: 'needed', message: 'нужно войти через браузер' };
}

/** Address to display: query secrets are masked so the list isn't a leak. */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const [key] of url.searchParams) {
      if (/token|key|secret|auth|password|signature/i.test(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function maskTarget(server: UserMcpServer): string {
  if (server.transport === 'stdio') {
    return [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ');
  }
  return maskUrl(server.url ?? '');
}

export function viewOf(
  config: IcarusConfig,
  store: McpStore,
  userId: string,
  id: string,
  now = Date.now(),
): McpView | null {
  if (isGlobal(config, id)) {
    const server = config.mcp[id];
    if (!server || isHidden(config, id)) return null;
    const enabled = enabledFor(store, userId, id, true);
    return {
      id,
      name: id,
      description: server.description ?? '',
      transport: server.transport ?? (server.url ? 'streamable-http' : 'stdio'),
      target: server.url ? maskUrl(server.url) : [server.command ?? '', ...(server.args ?? [])].join(' '),
      auth: server.headers ? 'headers' : 'none',
      global: true,
      owner: null,
      ownerIsMe: false,
      shared: true,
      enabled,
      ready: true,
      authState: server.headers ? 'ready' : 'none',
      canEdit: false,
      canShare: false,
      canDelete: false,
    };
  }

  const server = store.servers[id];
  if (!server) return null;
  const ownerIsMe = server.owner === userId;
  if (!ownerIsMe && !server.shared) return null;
  const enabled = enabledFor(store, userId, id, ownerIsMe);
  const credentials = store.credentials[userId]?.[id];
  const auth = authStateOf(server, credentials, now);
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    transport: server.transport,
    target: maskTarget(server),
    auth: server.auth,
    global: false,
    owner: server.owner,
    ownerIsMe,
    shared: server.shared,
    enabled,
    ready: auth.ready,
    authState: auth.state,
    ...(auth.message === undefined ? {} : { authMessage: auth.message }),
    ...(server.mimic === true ? { mimic: true } : {}),
    // Saved names matter more than expected ones, but if there are no keys yet, the panel should
    // know what to ask for: otherwise "Configure access" would open empty.
    ...(() => {
      const headers = Object.keys(credentials?.headers ?? {});
      const names = headers.length > 0 ? headers : (server.credentialHeaders ?? []);
      return names.length === 0 ? {} : { credentialHeaders: names };
    })(),
    ...(() => {
      const env = Object.keys(credentials?.env ?? {});
      const names = env.length > 0 ? env : (server.credentialEnv ?? []);
      return names.length === 0 ? {} : { credentialEnv: names };
    })(),
    canEdit: ownerIsMe,
    canShare: ownerIsMe,
    canDelete: ownerIsMe,
  };
}

export function listVisible(config: IcarusConfig, store: McpStore, userId: string, now = Date.now()): McpViewList {
  const own: McpView[] = [];
  const shared: McpView[] = [];
  const globals: McpView[] = [];
  for (const id of Object.keys(config.mcp ?? {})) {
    const view = viewOf(config, store, userId, id, now);
    if (view) globals.push(view);
  }
  for (const server of Object.values(store.servers)) {
    if (server.owner !== userId && !server.shared) continue;
    const view = viewOf(config, store, userId, server.id, now);
    if (!view) continue;
    (server.owner === userId ? own : shared).push(view);
  }
  const byName = (a: McpView, b: McpView) => a.name.localeCompare(b.name, 'ru');
  const servers = [...globals.sort(byName), ...own.sort(byName), ...shared.sort(byName)];
  return {
    servers,
    enabled: servers.filter((server) => server.enabled).length,
    ready: servers.filter((server) => server.enabled && server.ready).length,
  };
}

export function countVisible(config: IcarusConfig, userId: string): number {
  return listVisible(config, readStore(config), userId).servers.length;
}

/**
 * Builds a person's mcp.json: shared servers from config.yaml (if they haven't disabled them)
 * plus their own and shared ones, but only enabled and ready to work.
 *
 * A disabled server doesn't get in here at all: neither its name nor its tools. That is exactly
 * why "disabled" honestly means "doesn't clutter the context", not "connected but
 * hidden in the UI".
 */
export type EffectiveServersOptions = {
  /** Proxy base; null — do not proxy (tests and direct token checking). */
  proxyBase?: string | null;
};

/**
 * Where pi goes for OAuth MCP. By default — the service by container name:
 * user containers and icarus live on the same compose network. For running
 * without compose (or with a different name), the address is overridden by ICARUS_MCP_PROXY_BASE.
 */
export function mcpProxyBase(config: IcarusConfig): string {
  const override = process.env.ICARUS_MCP_PROXY_BASE?.trim();
  const base = override && override !== '' ? override : `http://icarus:${config.port}`;
  return `${base.replace(/\/+$/, '')}/mcp-proxy`;
}

export function effectiveServers(
  config: IcarusConfig,
  store: McpStore,
  userId: string,
  now = Date.now(),
  options: EffectiveServersOptions = {},
): { servers: Record<string, McpServerConfig>; skipped: string[] } {
  const proxyBase = options.proxyBase === undefined ? mcpProxyBase(config) : options.proxyBase;
  const servers: Record<string, McpServerConfig> = {};
  const skipped: string[] = [];
  for (const [id, server] of Object.entries(config.mcp ?? {})) {
    // A service server cannot be disabled: prefs don't apply to it at all.
    if (server.hidden !== true && !enabledFor(store, userId, id, true)) {
      skipped.push(id);
      continue;
    }
    servers[id] = server;
  }

  for (const server of Object.values(store.servers)) {
    if (server.owner !== userId && !server.shared) continue;
    const view = viewOf(config, store, userId, server.id, now);
    if (!view || !view.enabled || !view.ready) continue;
    if (Object.hasOwn(servers, server.id)) {
      skipped.push(server.id);
      continue;
    }
    servers[server.id] = toPiConfig(
      server,
      store.credentials[userId]?.[server.id],
      proxyBase ?? undefined,
    );
  }
  return { servers, skipped };
}

/**
 * Turns a panel description into what pi-mcp-extension reads.
 *
 * An OAuth server with proxyKey goes into mcp.json as a reference to our /mcp-proxy: the token
 * isn't there and doesn't expire along with a live conversation. Without proxyBase (panel,
 * check, tests), a direct address with Authorization remains — easier to debug that way.
 */
export function toPiConfig(
  server: UserMcpServer,
  credentials: McpCredentials | undefined,
  proxyBase?: string,
): McpServerConfig {
  const headers: Record<string, string> =
    server.transport === 'stdio' ? {} : { ...(server.headers ?? {}), ...(credentials?.headers ?? {}) };
  const proxyKey = credentials?.oauth?.proxyKey;
  const viaProxy =
    server.transport !== 'stdio' && server.auth === 'oauth' && server.url !== undefined && proxyKey !== undefined && proxyBase !== undefined;
  if (viaProxy) {
    // The secret must not travel to the proxy as an ordinary header: the service will substitute it.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
  } else if (server.transport !== 'stdio' && server.auth === 'oauth' && credentials?.oauth?.accessToken) {
    headers.Authorization = `Bearer ${credentials.oauth.accessToken}`;
  }
  const endpoint = viaProxy ? `${proxyBase.replace(/\/+$/, '')}/${proxyKey}` : server.url;
  const env: Record<string, string> =
    server.transport === 'stdio' ? { ...(server.env ?? {}), ...(credentials?.env ?? {}) } : {};
  const description = [server.name, server.description].filter(Boolean).join(': ');
  return {
    transport: server.transport,
    ...(endpoint === undefined ? {} : { url: endpoint }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    // User servers are always lazy: enabling a server doesn't mean
    // inserting all its tools into every conversation.
    lifecycle: 'lazy',
    ...(description === '' ? {} : { description }),
  };
}

export function createServer(config: IcarusConfig, owner: string, raw: McpServerInput): UserMcpServer {
  const input = normalizeInput(raw);
  const store = readStore(config);
  const id = uniqueId(config, store, input.name);
  const now = new Date().toISOString();
  const server: UserMcpServer = {
    id,
    name: input.name,
    description: input.description ?? '',
    transport: input.transport,
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.credentialEnv === undefined ? {} : { credentialEnv: input.credentialEnv }),
    ...(input.credentialHeaders === undefined ? {} : { credentialHeaders: input.credentialHeaders }),
    auth: input.auth ?? 'none',
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    ...(input.authorizationEndpoint === undefined ? {} : { authorizationEndpoint: input.authorizationEndpoint }),
    ...(input.tokenEndpoint === undefined ? {} : { tokenEndpoint: input.tokenEndpoint }),
    ...(input.registrationEndpoint === undefined ? {} : { registrationEndpoint: input.registrationEndpoint }),
    ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
    ...(input.mimic === true ? { mimic: true } : {}),
    owner,
    shared: input.shared === true,
    createdAt: now,
    updatedAt: now,
  };
  store.servers[id] = server;
  // The id could have belonged to a deleted shared server from config.yaml: people
  // would have been left with old toggles and keys. A new server starts with a clean
  // slate — enabled for the owner, disabled for the rest.
  for (const prefs of Object.values(store.prefs)) delete prefs[id];
  for (const own of Object.values(store.credentials)) delete own[id];
  store.prefs[owner] = { ...(store.prefs[owner] ?? {}), [id]: true };
  // Secrets don't go through normalizeInput: this is not a server description but a personal
  // part, and it is saved separately from it.
  const credentials = sanitizeCredentials(raw.credentials);
  if (credentials) {
    store.credentials[owner] = { ...(store.credentials[owner] ?? {}), [id]: credentials };
  }
  writeStore(config, store);
  return server;
}

function sanitizeCredentials(raw: McpCredentials | undefined): McpCredentials | undefined {
  if (!raw) return undefined;
  const headers = stringMap(raw.headers, 'credentials.headers', HEADER_LIMIT, HEADER_VALUE_LIMIT);
  const env = stringMap(raw.env, 'credentials.env', ENV_LIMIT, ENV_VALUE_LIMIT);
  const oauth = raw.oauth;
  if (!headers && !env && !oauth) return undefined;
  return {
    ...(headers ? { headers } : {}),
    ...(env ? { env } : {}),
    ...(oauth ? { oauth: { ...oauth } } : {}),
  };
}

function sameEndpoint(a: UserMcpServer, b: UserMcpServer): boolean {
  return (
    a.transport === b.transport &&
    a.url === b.url &&
    a.command === b.command &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    a.auth === b.auth &&
    a.scopes === b.scopes &&
    a.clientId === b.clientId &&
    a.authorizationEndpoint === b.authorizationEndpoint &&
    a.tokenEndpoint === b.tokenEndpoint &&
    a.registrationEndpoint === b.registrationEndpoint &&
    a.issuer === b.issuer
  );
}

export function updateServer(
  config: IcarusConfig,
  userId: string,
  id: string,
  raw: McpServerInput,
): UserMcpServer {
  const store = readStore(config);
  const existing = store.servers[id];
  if (!existing) throw new McpError('такого MCP нет', 404);
  if (existing.owner !== userId) throw new McpError('менять чужой MCP может только его владелец', 403);
  const input = normalizeInput(raw);
  const next: UserMcpServer = {
    ...existing,
    name: input.name,
    description: input.description ?? '',
    transport: input.transport,
    url: input.url,
    command: input.command,
    args: input.args,
    headers: input.headers,
    env: input.env,
    auth: input.auth ?? 'none',
    scopes: input.scopes,
    clientId: input.clientId,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    registrationEndpoint: input.registrationEndpoint,
    issuer: input.issuer,
    // false means "uncheck", not "leave as it was": otherwise there would be
    // no way to turn mimicry off.
    mimic: input.mimic === true ? true : undefined,
    shared: input.shared === true,
    updatedAt: new Date().toISOString(),
  };
  // Fields that are absent must not be left stale: otherwise switching the URL to stdio
  // would keep the old address and the server would become two-faced.
  for (const key of [
    'url',
    'command',
    'args',
    'headers',
    'env',
    'scopes',
    'clientId',
    'authorizationEndpoint',
    'tokenEndpoint',
    'registrationEndpoint',
    'issuer',
    'mimic',
  ] as const) {
    if (next[key] === undefined) delete next[key];
  }

  // Key expectations come only from the recipe when adding. The edit form
  // doesn't send them and must not overwrite them: otherwise "saved the description" would lose the hint.
  if (input.credentialEnv !== undefined) next.credentialEnv = input.credentialEnv;
  if (input.credentialHeaders !== undefined) next.credentialHeaders = input.credentialHeaders;

  const wasShared = existing.shared;
  if (!sameEndpoint(existing, next)) {
    // The address or login method changed — the old keys and tokens belong to a different
    // server. We don't carry them over: let the person configure access anew rather than get
    // "works half the time" with someone else's token.
    store.credentials = {};
  }
  if (!wasShared && next.shared) {
    // Shared for the first time: others must be left with neither enablement nor
    // keys from the server's past life. It arrives disabled — they'll enable it themselves.
    for (const [other, prefs] of Object.entries(store.prefs)) {
      if (other === userId) continue;
      delete prefs[id];
      delete store.credentials[other]?.[id];
    }
  }
  store.servers[id] = next;
  writeStore(config, store);
  return next;
}

export function deleteServer(config: IcarusConfig, userId: string, id: string): void {
  const store = readStore(config);
  const existing = store.servers[id];
  if (!existing) throw new McpError('такого MCP нет', 404);
  if (existing.owner !== userId) throw new McpError('удалить чужой MCP может только его владелец', 403);
  delete store.servers[id];
  for (const prefs of Object.values(store.prefs)) delete prefs[id];
  for (const own of Object.values(store.credentials)) delete own[id];
  writeStore(config, store);
}

export function setShared(config: IcarusConfig, userId: string, id: string, shared: boolean): UserMcpServer {
  const store = readStore(config);
  const existing = store.servers[id];
  if (!existing) throw new McpError('такого MCP нет', 404);
  if (existing.owner !== userId) throw new McpError('делиться чужим MCP нельзя', 403);
  const next = { ...existing, shared, updatedAt: new Date().toISOString() };
  if (!existing.shared && shared) {
    for (const [other, prefs] of Object.entries(store.prefs)) {
      if (other === userId) continue;
      delete prefs[id];
      delete store.credentials[other]?.[id];
    }
  }
  store.servers[id] = next;
  writeStore(config, store);
  return next;
}

export function setEnabled(config: IcarusConfig, userId: string, id: string, enabled: boolean): void {
  if (isHidden(config, id)) throw new McpError('служебный MCP встроен: его нельзя выключить', 400);
  const store = readStore(config);
  if (!isVisible(config, store, userId, id)) throw new McpError('такого MCP нет или он не расшарен', 404);
  store.prefs[userId] = { ...(store.prefs[userId] ?? {}), [id]: enabled };
  writeStore(config, store);
}

export function getCredentials(config: IcarusConfig, userId: string, id: string): McpCredentials | undefined {
  return readStore(config).credentials[userId]?.[id];
}

/**
 * Backfills proxyKey for old OAuth records. Without it mcp.json would go with a
 * pasted-in Bearer that would expire in five minutes right inside a live thread.
 */
export function ensureOAuthProxyKeys(config: IcarusConfig, userId: string): string[] {
  const store = readStore(config);
  const changed: string[] = [];
  for (const server of Object.values(store.servers)) {
    if (server.auth !== 'oauth' || !server.url) continue;
    if (server.owner !== userId && !server.shared) continue;
    const oauth = store.credentials[userId]?.[server.id]?.oauth;
    if (!oauth || oauth.proxyKey || (!oauth.accessToken && !oauth.refreshToken)) continue;
    oauth.proxyKey = randomBytes(24).toString('base64url');
    changed.push(server.id);
  }
  if (changed.length > 0) writeStore(config, store);
  return changed;
}

/** Finds whose key this is — the only thing the proxy knows about the request. */
export function findOAuthByProxyKey(
  config: IcarusConfig,
  key: string,
): { userId: string; server: UserMcpServer } | null {
  const store = readStore(config);
  for (const [userId, servers] of Object.entries(store.credentials)) {
    for (const [serverId, credentials] of Object.entries(servers)) {
      if (!credentials || typeof credentials !== 'object') continue;
      if (credentials.oauth?.proxyKey !== key) continue;
      const server = store.servers[serverId];
      if (!server || server.auth !== 'oauth' || !server.url) continue;
      if (server.owner !== userId && !server.shared) continue;
      return { userId, server };
    }
  }
  return null;
}

/** Full record for the editor: description plus secret names, but not their values. */
export function editorOf(
  config: IcarusConfig,
  userId: string,
  id: string,
): { server: UserMcpServer; credentialHeaders: string[]; credentialEnv: string[]; oauth: McpOAuthCredentials | null; global: boolean } | null {
  if (isGlobal(config, id)) {
    // A service server is neither edited nor shown in the panel — as in the list.
    if (isHidden(config, id)) return null;
    return { server: {
      id,
      name: id,
      description: config.mcp[id]?.description ?? '',
      transport: config.mcp[id]?.transport ?? 'stdio',
      auth: 'none',
      owner: '',
      shared: true,
      createdAt: '',
      updatedAt: '',
    }, credentialHeaders: [], credentialEnv: [], oauth: null, global: true };
  }
  const store = readStore(config);
  const server = store.servers[id];
  if (!server) return null;
  if (server.owner !== userId && !server.shared) return null;
  if (server.owner !== userId) return null;
  const credentials = store.credentials[userId]?.[id];
  return {
    server,
    credentialHeaders: Object.keys(credentials?.headers ?? {}),
    credentialEnv: Object.keys(credentials?.env ?? {}),
    oauth: credentials?.oauth
      ? {
          ...credentials.oauth,
          accessToken: credentials.oauth.accessToken ? '•••' : undefined,
          refreshToken: credentials.oauth.refreshToken ? '•••' : undefined,
          clientSecret: credentials.oauth.clientSecret ? '•••' : undefined,
          proxyKey: undefined,
        }
      : null,
    global: false,
  };
}

function mergeCredentials(existing: McpCredentials | undefined, patch: McpCredentials): McpCredentials {
  const next: McpCredentials = { ...(existing ?? {}) };
  // An empty string means "don't touch": the form shows only secret names,
  // and values don't travel into it. Full clearing — by a separate request (clear).
  if (patch.headers !== undefined) {
    next.headers = { ...(next.headers ?? {}), ...patch.headers };
  }
  if (patch.env !== undefined) {
    next.env = { ...(next.env ?? {}), ...patch.env };
  }
  if (patch.oauth !== undefined) next.oauth = { ...(next.oauth ?? {}), ...patch.oauth };
  return next;
}

export function saveCredentials(
  config: IcarusConfig,
  userId: string,
  id: string,
  patch: { headers?: Record<string, string>; env?: Record<string, string>; oauth?: McpOAuthCredentials },
): void {
  const store = readStore(config);
  if (!isVisible(config, store, userId, id)) throw new McpError('такого MCP нет или он не расшарен', 404);
  if (isGlobal(config, id)) throw new McpError('у общего MCP из config.yaml доступ задаётся там же', 400);
  const clean = sanitizeCredentials({
    ...(patch.headers === undefined ? {} : { headers: patch.headers }),
    ...(patch.env === undefined ? {} : { env: patch.env }),
    ...(patch.oauth === undefined ? {} : { oauth: patch.oauth }),
  });
  const current = store.credentials[userId]?.[id] ?? {};
  const merged = clean ? mergeCredentials(current, clean) : current;
  store.credentials[userId] = { ...(store.credentials[userId] ?? {}) };
  if (Object.keys(merged).length === 0) delete store.credentials[userId][id];
  else store.credentials[userId][id] = merged;
  writeStore(config, store);
}

export function clearCredentials(config: IcarusConfig, userId: string, id: string): void {
  const store = readStore(config);
  if (!isVisible(config, store, userId, id)) throw new McpError('такого MCP нет или он не расшарен', 404);
  if (store.credentials[userId]) delete store.credentials[userId][id];
  writeStore(config, store);
}

export function saveOAuthCredentials(
  config: IcarusConfig,
  userId: string,
  id: string,
  oauth: McpOAuthCredentials,
): void {
  const store = readStore(config);
  const server = store.servers[id];
  if (!server) throw new McpError('такого MCP нет', 404);
  if (server.owner !== userId && !server.shared) throw new McpError('сервер не расшарен', 403);
  const current = store.credentials[userId]?.[id] ?? {};
  store.credentials[userId] = {
    ...(store.credentials[userId] ?? {}),
    [id]: { ...current, oauth: { ...(current.oauth ?? {}), ...oauth } },
  };
  writeStore(config, store);
}

export function clearOAuthCredentials(config: IcarusConfig, userId: string, id: string): void {
  const store = readStore(config);
  const server = store.servers[id];
  if (!server) throw new McpError('такого MCP нет', 404);
  if (server.owner !== userId && !server.shared) throw new McpError('сервер не расшарен', 403);
  const current = store.credentials[userId]?.[id];
  if (current) {
    delete current.oauth;
    if (Object.keys(current).length === 0) delete store.credentials[userId][id];
  }
  writeStore(config, store);
}

/** The OAuth token is alive or it's time to refresh: the decision is made by time, not by the panel. */
export function oauthNeedsRefresh(oauth: McpOAuthCredentials | undefined, now = Date.now()): boolean {
  if (!oauth?.refreshToken) return false;
  return !oauthFresh(oauth, now);
}

export function serverForUser(config: IcarusConfig, userId: string, id: string): UserMcpServer | undefined {
  const store = readStore(config);
  const server = store.servers[id];
  if (!server) return undefined;
  if (server.owner !== userId && !server.shared) return undefined;
  return server;
}
