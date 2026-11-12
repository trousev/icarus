// Пользовательские MCP: кто их завёл, с кем поделился и кому они включены.
//
// config.yaml остаётся местом общих серверов (echo, Maple, Home Assistant): их
// заводит тот, кто ведёт стек. Всё, что человек добавил сам в панели, живёт здесь,
// в dataDir — рядом с памятью, но отдельными файлами:
//
//   <dataDir>/mcp/registry.json    — описания серверов и переключатели людей;
//   <dataDir>/mcp/credentials.json — ключи и OAuth-токены, только 0600.
//
// Разделение намеренное: описания можно показать, скопировать и забрать в бэкап,
// а ключи не должны уезжать вместе с ними. Токен — такой же секрет, как ключ
// модели, и лежит с теми же правами, что auth.json в контейнере.
//
// Главное правило видимости: сервер видит владелец и все, с кем он поделился.
// Поделились — сервер приезжает другому человеку ВЫКЛЮЧЕННЫМ: включить его тот
// должен сам. Пока сервер выключен, его нет ни в mcp.json, ни в AGENTS.md, то есть
// он не занимает ни контекст, ни промпт. Ключи при этом не копируются: каждый
// настраивает доступ сам, иначе «поделиться сервером» незаметно означало бы
// «поделиться своим аккаунтом».
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IcarusConfig, McpServerConfig } from '../config.ts';

/** Версия формата: без неё будущая миграция не отличит старый файл от нового. */
export const MCP_STORE_VERSION = 1;

export type McpTransport = NonNullable<McpServerConfig['transport']>;
export type McpAuthType = 'none' | 'headers' | 'oauth';

/**
 * OAuth-состояние одного человека на одном сервере. Здесь и токены, и то, что
 * нужно, чтобы их обновить: issuer, endpoints, client_id и способ аутентификации
 * клиента. Всё это — секреты или почти секреты, поэтому файл отдельный.
 */
export type McpOAuthCredentials = {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  /** Когда истекает access token, мс epoch. Нет — считаем, что не истекает. */
  expiresAt?: number;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** Канонический адрес ресурса: тот же, что уезжает в resource (RFC 8707). */
  resource?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
  /**
   * С каким адресом возврата регистрировали клиента. В режиме мимикрии это
   * мёртвый loopback, иначе публичный callback панели. Хранится, чтобы повторный
   * вход не подсунул серверу другой redirect_uri: он обязан совпадать.
   */
  redirectUri?: string;
  /**
   * Ключ локального прокси сервиса. По нему pi ходит в /mcp-proxy/<ключ>, а
   * сервис подставляет свежий Bearer на каждом запросе. В mcp.json токена нет.
   */
  proxyKey?: string;
  authorizedAt?: string;
  /** Последняя ошибка обновления/авторизации — человеку в панели, не модели. */
  error?: string;
};

export type McpCredentials = {
  /** Заголовки доступа этого человека. Не показываются другим и не шарятся. */
  headers?: Record<string, string>;
  /** Переменные окружения stdio-сервера этого человека. */
  env?: Record<string, string>;
  oauth?: McpOAuthCredentials;
};

/** Описание пользовательского сервера. Секретов здесь нет. */
export type UserMcpServer = {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  /**
   * Постоянные заголовки описания (например, X-Client: icarus). Ключ доступа
   * сюда не кладём — он в credentials, иначе он уехал бы всем, с кем поделились.
   */
  headers?: Record<string, string>;
  /** Постоянные переменные окружения stdio-сервера, тоже без секретов. */
  env?: Record<string, string>;
  /**
   * Имена ключей, которые серверу понадобятся (рецепт их знает заранее).
   * Только имена: значения живут в credentials и человеку показываются пустыми.
   */
  credentialEnv?: string[];
  credentialHeaders?: string[];
  auth: McpAuthType;
  /** Запрошенные scopes: строка через пробел, как в OAuth. */
  scopes?: string;
  /** Заранее зарегистрированный client_id (публичный, не секрет). */
  clientId?: string;
  /** Ручные endpoint'ы: нужны там, где сервер не рассказывает про RFC 9728/8414. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  issuer?: string;
  /**
   * Сервер пускает только «свои» адреса возврата (так делает Any.do: у него
   * белый список redirect_uri). Тогда вход идёт на мёртвый loopback — тот же,
   * что у Claude Code, — а адрес из строки браузера человек вставляет в панель.
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
  /** userId -> serverId -> включён ли сервер у этого человека. */
  prefs: Record<string, Record<string, boolean>>;
  /** userId -> serverId -> ключи и токены. */
  credentials: Record<string, Record<string, McpCredentials>>;
};

/** Что человек прислал в панели. Секреты — только в credentials. */
export type McpServerInput = {
  name: string;
  description?: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Чего сервер ждёт от человека: имена ключей из рецепта, без значений. */
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

/** Сервер глазами панели: ни секретов, ни внутренних путей. */
export type McpView = {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  /** Адрес или команда без секретов в query. */
  target: string;
  auth: McpAuthType;
  /** Сервер из config.yaml: его нельзя удалить и переписать из панели. */
  global: boolean;
  owner: string | null;
  ownerIsMe: boolean;
  shared: boolean;
  enabled: boolean;
  /** Готов ли сервер к работе: есть ключ/OAuth-токен (или он не нужен). */
  ready: boolean;
  authState: 'none' | 'ready' | 'needed' | 'expired' | 'error';
  authMessage?: string;
  /** Вход идёт через мёртвый loopback: карточка просит вставить адрес вручную. */
  mimic?: boolean;
  /** Имена уже сохранённых секретов: значения в панель не уезжают. */
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

/** Транслитерация для id: русское имя должно дать предсказуемый латинский слаг. */
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
 * Читает оба файла. Секретов в сообщениях об ошибках нет — только путь и причина:
 * иначе сломанный registry.json сам стал бы утечкой.
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
    // Не на всех ФС права меняются; файл всё равно пишем закрытым.
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

/** Список имён ключей: рецепт говорит, что спросить, но не подставляет значения. */
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

/** Проверяет и чистит то, что человек прислал в форму. */
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
  // Ожидания ключей имеют смысл только у «ключа / заголовков»: у OAuth вход
  // делается через браузер, и список env там был бы ложной подсказкой.
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
    // Мимикрия бывает только у OAuth: она меняет redirect_uri, а без входа он не нужен.
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
 * Служебный сервер: он объявлен в config.yaml с пометкой hidden. В панели его нет,
 * выключить себе его нельзя — это встроенное умение, а не чужой инструмент.
 * В mcp.json человека он при этом уезжает всегда.
 */
export function isHidden(config: IcarusConfig, id: string): boolean {
  return config.mcp?.[id]?.hidden === true;
}

/**
 * Общий сервер из config.yaml в том же виде, что и личный: панель, проверка
 * доступа и mcp.json должны видеть одно и то же.
 *
 * Секретов в config.yaml нет — только имена: у stdio это переменные окружения,
 * у HTTP — заголовки. Значения приходят из credentials.json этого человека,
 * поэтому у одного и того же общего сервера ключ у каждого свой.
 */
export function globalServerOf(config: IcarusConfig, id: string): UserMcpServer | null {
  const server = config.mcp?.[id];
  if (!server) return null;
  const transport = server.transport ?? (server.url ? 'streamable-http' : 'stdio');
  const names = server.secrets ?? [];
  const own = names.length > 0;
  return {
    id,
    name: id,
    description: server.description ?? '',
    transport,
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.headers === undefined ? {} : { headers: server.headers }),
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(own && transport !== 'stdio' ? { credentialHeaders: names } : {}),
    ...(own && transport === 'stdio' ? { credentialEnv: names } : {}),
    // Без объявленных секретов сервер живёт как раньше: заголовки из config.yaml
    // общие на всех, и настраивать человеку нечего.
    auth: own || server.headers ? 'headers' : 'none',
    owner: '',
    shared: true,
    createdAt: '',
    updatedAt: '',
  };
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
    // У stdio готовность определяют только личные переменные окружения. Постоянный
    // env — часть описания, он уезжает всем, с кем сервер поделились: считать его
    // «ключ настроен» значило бы обещать модели инструменты без доступа.
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
  // Прокси умеет обновить токен сам, а если refresh мёртв — вернуть ссылку на
  // повторный вход. Поэтому сервер с ключом прокси остаётся в mcp.json даже
  // с просроченным токеном: иначе человек увидел бы проблему только в панели.
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

/** Адрес для показа: query-секреты маскируются, чтобы список не был утечкой. */
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
    // Постоянные env — часть описания и они не секреты. Без них два сервера
    // одного рецепта (два OPDS-каталога) выглядели бы в панели одинаково.
    const env = Object.entries(server.env ?? {}).map(([name, value]) => `${name}=${value}`);
    return [server.command ?? '', ...(server.args ?? []), ...env].filter(Boolean).join(' ');
  }
  return maskUrl(server.url ?? '');
}

/**
 * Имена секретов для панели: сохранённые важнее ожидаемых (рецепт знает, что
 * спросить, а человек — что уже ввёл). Значения сюда не уезжают никогда.
 */
function credentialNames(credentials: McpCredentials | undefined, server: UserMcpServer): Partial<McpView> {
  const headers = Object.keys(credentials?.headers ?? {});
  const env = Object.keys(credentials?.env ?? {});
  const headerNames = headers.length > 0 ? headers : (server.credentialHeaders ?? []);
  const envNames = env.length > 0 ? env : (server.credentialEnv ?? []);
  return {
    ...(headerNames.length === 0 ? {} : { credentialHeaders: headerNames }),
    ...(envNames.length === 0 ? {} : { credentialEnv: envNames }),
  };
}

export function viewOf(
  config: IcarusConfig,
  store: McpStore,
  userId: string,
  id: string,
  now = Date.now(),
): McpView | null {
  if (isGlobal(config, id)) {
    const server = globalServerOf(config, id);
    if (!server || isHidden(config, id)) return null;
    const enabled = enabledFor(store, userId, id, true);
    const credentials = store.credentials[userId]?.[id];
    const auth = authStateOf(server, credentials, now);
    return {
      id,
      name: id,
      description: server.description,
      transport: server.transport,
      target: maskTarget(server),
      auth: server.auth,
      global: true,
      owner: null,
      ownerIsMe: false,
      shared: true,
      enabled,
      ready: auth.ready,
      authState: auth.state,
      ...(auth.message === undefined ? {} : { authMessage: auth.message }),
      ...credentialNames(credentials, server),
      // Команду и адрес задаёт config.yaml, поэтому «Изменить» у общего сервера
      // нет. Своё у него — ключи (если объявлены секреты) и включённость.
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
    ...credentialNames(credentials, server),
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
 * Собирает mcp.json человека: общие серверы из config.yaml (если он их не выключил)
 * плюс его собственные и расшаренные, но только включённые и готовые к работе.
 *
 * Выключенный сервер сюда не попадает вообще: ни его имени, ни инструментов. Именно
 * поэтому «выключен» честно значит «не замусоривает контекст», а не «подключён, но
 * спрятан в UI».
 */
export type EffectiveServersOptions = {
  /** База прокси; null — не проксировать (тесты и прямая проверка токена). */
  proxyBase?: string | null;
};

/**
 * Куда pi ходит за OAuth-MCP. По умолчанию — сервис по имени контейнера:
 * пользовательские контейнеры и icarus живут в одной сети compose. Для запуска
 * без compose (или с другим именем) адрес перекрывается ICARUS_MCP_PROXY_BASE.
 */
export function mcpProxyBase(config: IcarusConfig): string {
  const override = process.env.ICARUS_MCP_PROXY_BASE?.trim();
  const base = override && override !== '' ? override : `http://icarus:${config.port}`;
  return `${base.replace(/\/+$/, '')}/mcp-proxy`;
}

/**
 * Дополняет описание общего сервера личными секретами этого человека. Постоянные
 * заголовки и env остаются: секреты их не заменяют, а ложатся рядом.
 */
function withUserCredentials(server: McpServerConfig, credentials: McpCredentials | undefined): McpServerConfig {
  if (!credentials) return server;
  const transport = server.transport ?? (server.url ? 'streamable-http' : 'stdio');
  if (transport === 'stdio') {
    const env = { ...(server.env ?? {}), ...(credentials.env ?? {}) };
    return { ...server, ...(Object.keys(env).length === 0 ? {} : { env }) };
  }
  const headers = { ...(server.headers ?? {}), ...(credentials.headers ?? {}) };
  return { ...server, ...(Object.keys(headers).length === 0 ? {} : { headers }) };
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
    // Служебный сервер выключить нельзя: prefs к нему не применяются вовсе.
    if (server.hidden !== true && !enabledFor(store, userId, id, true)) {
      skipped.push(id);
      continue;
    }
    const credentials = store.credentials[userId]?.[id];
    const global = globalServerOf(config, id);
    // Секреты объявлены, а человек их ещё не ввёл — сервер ждёт доступа и не
    // попадает ни в mcp.json, ни в AGENTS.md: иначе модель звала бы инструменты,
    // на которые сервер ответит 401.
    if (server.hidden !== true && global && !authStateOf(global, credentials, now).ready) {
      skipped.push(id);
      continue;
    }
    servers[id] = withUserCredentials(server, credentials);
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
 * Превращает описание панели в то, что читает pi-mcp-extension.
 *
 * OAuth-сервер с proxyKey уезжает в mcp.json ссылкой на наш /mcp-proxy: токен
 * там не лежит и не протухает вместе с живым разговором. Без proxyBase (панель,
 * проверка, тесты) остаётся прямой адрес с Authorization — так проще отладить.
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
    // Секрет не должен уехать в прокси как обычный заголовок: его подставит сервис.
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
    // Пользовательские серверы всегда ленивые: включить сервер — не значит
    // вставить все его инструменты в каждый разговор.
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
  // id мог принадлежать удалённому общему серверу из config.yaml: у людей
  // остались бы старые выключатели и ключи. Новый сервер начинается с чистого
  // листа — владельцу включён, остальным выключен.
  for (const prefs of Object.values(store.prefs)) delete prefs[id];
  for (const own of Object.values(store.credentials)) delete own[id];
  store.prefs[owner] = { ...(store.prefs[owner] ?? {}), [id]: true };
  // Секреты не проходят через normalizeInput: это не описание сервера, а личная
  // часть, и она сохраняется отдельно от него.
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
    // false значит «снять галочку», а не «оставить как было»: иначе выключить
    // мимикрию было бы нечем.
    mimic: input.mimic === true ? true : undefined,
    shared: input.shared === true,
    updatedAt: new Date().toISOString(),
  };
  // Поля, которых нет, нельзя оставлять старыми: иначе смена URL на stdio
  // сохранила бы прежний адрес и сервер стал бы двуликим.
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

  // Ожидания ключей приходят только из рецепта при добавлении. Правка формы
  // их не шлёт и не должна затирать: иначе «сохранил описание» потеряет подсказку.
  if (input.credentialEnv !== undefined) next.credentialEnv = input.credentialEnv;
  if (input.credentialHeaders !== undefined) next.credentialHeaders = input.credentialHeaders;

  const wasShared = existing.shared;
  if (!sameEndpoint(existing, next)) {
    // Сменился адрес или способ входа — старые ключи и токены относятся к другому
    // серверу. Их не переносим: пусть человек настроит доступ заново, чем получит
    // «работает через раз» с чужим токеном.
    store.credentials = {};
  }
  if (!wasShared && next.shared) {
    // Поделились впервые: у остальных не должно остаться ни включённости, ни
    // ключей от прошлой жизни сервера. Приезжает выключенным — включат сами.
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
 * Достраивает proxyKey старым OAuth-записям. Без него mcp.json пошёл бы с
 * вклеенным Bearer, который через пять минут протух бы прямо в живом треде.
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

/** Находит, чей это ключ, — единственное, что знает прокси о запросе. */
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

/** Полная запись для редактора: описание плюс имена секретов, но не их значения. */
export function editorOf(
  config: IcarusConfig,
  userId: string,
  id: string,
): { server: UserMcpServer; credentialHeaders: string[]; credentialEnv: string[]; oauth: McpOAuthCredentials | null; global: boolean } | null {
  if (isGlobal(config, id)) {
    // Служебный сервер в панели не редактируется и не показывается — как и в списке.
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
  // Форма должна показать имена и тогда, когда значений ещё нет: рецепт их знает
  // заранее (OPDS спрашивает логин каталога, даже если тот открыт).
  const savedHeaders = Object.keys(credentials?.headers ?? {});
  const savedEnv = Object.keys(credentials?.env ?? {});
  return {
    server,
    credentialHeaders: savedHeaders.length > 0 ? savedHeaders : (server.credentialHeaders ?? []),
    credentialEnv: savedEnv.length > 0 ? savedEnv : (server.credentialEnv ?? []),
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
  // Пустая строка значит «не трогать»: форма показывает только имена секретов,
  // а значения в неё не уезжают. Полная очистка — отдельным запросом (clear).
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
  if (isGlobal(config, id)) {
    // Общий сервер живёт в config.yaml, но личный ключ ему нужен так же, как
    // пользовательскому: команду и адрес панель не трогает, секреты — да.
    const global = globalServerOf(config, id);
    const declared = [...(global?.credentialHeaders ?? []), ...(global?.credentialEnv ?? [])];
    if (declared.length === 0) {
      throw new McpError('у этого общего MCP нет объявленных секретов: всё, что ему нужно, задано в config.yaml', 400);
    }
  }
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

/** OAuth-токен жив или его пора обновлять: решение принимает не панель, а время. */
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
