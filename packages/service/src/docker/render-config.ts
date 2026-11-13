// CLI for ./script/redeploy: edits the production config.yaml on the host.
//
// config.yaml is the only file a person edits by hand, so the deploy doesn't
// rebuild it from scratch, but changes only what arrives from GitHub: people
// (variables.ICARUS_USERS), the port, the data directory and the API key. Models, mounts and MCP
// stay as they were left on the host.
//
//   ICARUS_USERS='trousev vita julia' ICARUS_PORT=8081 \
//     node packages/service/src/docker/render-config.ts
//
// There's no working config.yaml yet — config.example.yaml is taken as the base, and the output
// is a fully run-ready config.
//
// Values come from the environment, not from argv: apiKey must not show up in `ps`.
// Comments in config.yaml don't survive an edit — and they aren't needed: the description of fields
// lives in config.example.yaml, while this file is assembled by a machine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { DEFAULT_CONFIG_PATH, LEGACY_ADMIN_ID, REPO_ROOT } from '../config.ts';

/** The sample config.yaml starts from when there's no working file yet. */
const EXAMPLE_CONFIG = path.join(REPO_ROOT, 'config.example.yaml');

/** The id goes into the container name and the on-disk path — the same pattern as in config.ts. */
const USER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const HEADER = [
  '# Собран ./script/redeploy: люди, порт, dataDir и apiKey приезжают из GitHub.',
  '# Описание полей и значения по умолчанию — в config.example.yaml; правки этого',
  '# файла переживут только следующий деплой.',
  '',
].join('\n');

export type Overrides = {
  users?: string | undefined;
  port?: string | undefined;
  dataDir?: string | undefined;
  apiKey?: string | undefined;
  dns?: string | undefined;
  url?: string | undefined;
  telegramMapping?: string | undefined;
  sessionIdleMinutes?: string | undefined;
};

export type RenderResult = {
  text: string;
  users: string[];
  port: number;
  dataDir: string;
  /** What happened to docker.dns: a list, removed, or untouched (null). */
  dns: string[] | null;
  /** Where the API key came from: from the secret, from the previous file, or generated anew. */
  apiKeySource: 'env' | 'config' | 'generated';
  /** The external panel address (url) or null if it's not set. */
  url: string | null;
  /** Telegram bot mapping: a map, an empty map (removed) or null (untouched). */
  telegram: Record<string, string> | null;
  /** The quiet hour after an edit: after it the conversation is considered finished. */
  sessionIdleMinutes: number;
};

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

/** A person in config.yaml: an id as a string or an object with an admin flag (see parseUsers). */
type UserEntry = { id: string; admin?: boolean };

/** Migration flag: for a config without explicit admins, the admin is trousev. */
function legacyAdmin(id: string): boolean | undefined {
  return id === LEGACY_ADMIN_ID ? true : undefined;
}

/**
 * People from the previous config. A string is the old format, an object the new one. The admin flag
 * survives a deploy: otherwise manually granted access would disappear on every push.
 */
function existingUsers(value: unknown): UserEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === 'string') {
      const id = item.trim();
      const admin = legacyAdmin(id);
      return admin === undefined ? { id } : { id, admin };
    }
    const where = `users[${index}]`;
    const record = asRecord(item, where);
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (id === '') throw new Error(`${where}: у человека нужен id`);
    if (record.admin !== undefined && typeof record.admin !== 'boolean') {
      throw new Error(`${where}.admin: ожидалось true или false`);
    }
    const admin = record.admin === undefined ? legacyAdmin(id) : record.admin;
    return admin === undefined ? { id } : { id, admin };
  });
}

function checkUsers(ids: string[]): string[] {
  const users: string[] = [];
  for (const id of ids) {
    if (id === '') continue;
    if (!USER_ID.test(id)) {
      throw new Error(`users: id «${id}» не годится — буквы, цифры, точка, дефис, подчёркивание`);
    }
    if (users.includes(id)) throw new Error(`users: id «${id}» повторяется`);
    users.push(id);
  }
  return users;
}

function splitUsers(value: string): string[] {
  return checkUsers(value.split(/[\s,]+/));
}

/** How to write a person into YAML: the flag only when it's explicitly set. */
function userToYaml(entry: UserEntry): string | { id: string; admin: boolean } {
  if (entry.admin === undefined) return entry.id;
  return { id: entry.id, admin: entry.admin };
}

function parsePort(value: string): number {
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ICARUS_PORT: «${value}» — ожидался номер порта 1..65535`);
  }
  return port;
}

/** DNS server address: the same pattern as in config.ts (IPv4 or IPv6). */
const DNS_ENTRY = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * ICARUS_DNS: a list of addresses separated by space or comma; `none` — remove docker.dns;
 * empty — don't touch what's already in the config.
 */
function parseDns(value: string | undefined): string[] | null {
  const text = value?.trim() ?? '';
  if (text === '') return null;
  if (text === 'none' || text === 'off' || text === '-') return [];
  return text.split(/[\s,]+/).map((entry) => {
    if (!DNS_ENTRY.test(entry)) {
      throw new Error(`ICARUS_DNS: «${entry}» — ожидался адрес DNS-сервера, например 1.1.1.1`);
    }
    return entry;
  });
}

/** Telegram username: the same form as in config.ts — without "@", lowercase. */
const TELEGRAM_USERNAME = /^[a-zA-Z0-9_]{3,32}$/;

/**
 * ICARUS_TELEGRAM_MAPPING: "who is who" for the Telegram bot — pairs
 * `@username:person` separated by comma or space (the person is an id from `ICARUS_USERS`,
 * i.e. the uid from LDAP in production):
 *
 *   ICARUS_TELEGRAM_MAPPING='@trousev:trousev,@vita:vita'
 *
 * `none` — remove the mapping (the bot goes silent), empty — don't touch what's in the config.
 * The person must be in users: a Telegram name leading nowhere is a refusal to answer
 * in the middle of the night, not a setting.
 */
export function parseTelegramMapping(value: string | undefined, users: string[]): Record<string, string> | null {
  const text = value?.trim() ?? '';
  if (text === '') return null;
  if (text === 'none' || text === 'off' || text === '-') return {};

  const mapping: Record<string, string> = {};
  for (const pair of text.split(/[,\s]+/)) {
    if (pair === '') continue;
    const at = pair.indexOf(':');
    if (at <= 0 || at === pair.length - 1) {
      throw new Error(`ICARUS_TELEGRAM_MAPPING: «${pair}» — ожидал пару «@username:человек»`);
    }
    const username = pair.slice(0, at).replace(/^@/, '').toLowerCase();
    const user = pair.slice(at + 1);
    if (!TELEGRAM_USERNAME.test(username)) {
      throw new Error(`ICARUS_TELEGRAM_MAPPING: «${username}» не похоже на telegram username`);
    }
    if (!users.includes(user)) {
      throw new Error(
        `ICARUS_TELEGRAM_MAPPING: «${user}» нет среди людей (${users.join(', ')}) — бот не поймёт, чей это разговор`,
      );
    }
    mapping[username] = user;
  }
  return mapping;
}

/**
 * ICARUS_SESSION_IDLE_MINUTES: how many minutes of silence mean "the conversation is over"
 * (after that icarus compresses the pi session and shuts it down). Empty — don't touch the value
 * from the config: it could have been configured by hand on the host.
 */
function parseIdleMinutes(value: string | undefined): number | null {
  const text = value?.trim() ?? '';
  if (text === '') return null;
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes < 0 || Math.floor(minutes) !== minutes) {
    throw new Error(`ICARUS_SESSION_IDLE_MINUTES: «${value}» — ожидалось целое число минут (0 и больше)`);
  }
  return minutes;
}

/**
 * A pure config edit: text in, text out. The key generator is passed as
 * a parameter so the test doesn't depend on randomness.
 */
export function renderConfig(
  sourceText: string,
  overrides: Overrides,
  generate: () => string = () => crypto.randomBytes(24).toString('hex'),
): RenderResult {
  const doc = asRecord(parseYaml(sourceText), 'config');

  // People from ICARUS_USERS arrive without flags: the admin — by migration (trousev),
  // while flags already granted on the host are kept for those who remain in the list.
  const previous = existingUsers(doc.users);
  const entries: UserEntry[] = overrides.users?.trim()
    ? splitUsers(overrides.users).map((id) => {
        const admin = previous.find((entry) => entry.id === id)?.admin ?? legacyAdmin(id);
        return admin === undefined ? { id } : { id, admin };
      })
    : previous;
  const users = checkUsers(entries.map((entry) => entry.id));
  if (users.length === 0) {
    throw new Error('в конфиге нет ни одного человека: задай ICARUS_USERS (например trousev,vita,julia)');
  }
  doc.users = entries.map(userToYaml);

  if (overrides.port?.trim()) doc.port = parsePort(overrides.port);
  const port = Number(doc.port ?? 8081);

  if (overrides.dataDir?.trim()) doc.dataDir = overrides.dataDir.trim();
  const dataDir = String(doc.dataDir ?? '~/icarus-data');

  // docker.dns is also a production setting: the value arrives from the environment, and isn't edited
  // by hand on the host (see ICARUS_DNS in script/redeploy). Empty — we don't touch the previous one.
  const dns = parseDns(overrides.dns);
  if (dns !== null) {
    const docker = asRecord(doc.docker ?? {}, 'docker');
    if (dns.length > 0) docker.dns = dns;
    else delete docker.dns;
    doc.docker = docker;
  }

  const fromEnv = overrides.apiKey?.trim() ?? '';
  const fromConfig = typeof doc.apiKey === 'string' ? doc.apiKey.trim() : '';
  const apiKeySource = fromEnv ? 'env' : fromConfig ? 'config' : 'generated';
  if (fromEnv) doc.apiKey = fromEnv;
  else if (!fromConfig) doc.apiKey = generate();

  // url — the external panel address for personal links. It's edited from the environment the same
  // way as the port and apiKey, but one set on the host isn't lost either.
  const urlOverride = overrides.url?.trim() ?? '';
  if (urlOverride) doc.url = urlOverride;
  const url = typeof doc.url === 'string' && doc.url.trim() !== '' ? doc.url.trim() : null;

  // The quiet hour is a product rule, not a local setting: a conversation that went quiet for
  // sessionIdleMinutes is considered finished by icarus, compressed and closed. On the host
  // it can be overridden, but the deploy sets its own (one hour by default).
  const idleOverride = parseIdleMinutes(overrides.sessionIdleMinutes);
  if (idleOverride !== null) doc.sessionIdleMinutes = idleOverride;
  const sessionIdleMinutes = Number(doc.sessionIdleMinutes ?? 60);

  // telegram.mapping — who from Telegram is whose person. Next to it in the config lives only
  // the token (and even that is usually taken from .env), so we edit the block as a whole: the mapping
  // arrives from variables.ICARUS_TELEGRAM_MAPPING, and isn't edited by hand on the host.
  const telegram = parseTelegramMapping(overrides.telegramMapping, users);
  if (telegram !== null) {
    const block = doc.telegram === undefined || doc.telegram === null ? {} : asRecord(doc.telegram, 'telegram');
    if (Object.keys(telegram).length > 0) block.mapping = telegram;
    else delete block.mapping;
    // An empty block in the config only confuses: nothing to configure — no key.
    if (Object.keys(block).length > 0) doc.telegram = block;
    else delete doc.telegram;
  }

  return {
    text: HEADER + stringifyYaml(doc, { lineWidth: 0 }),
    users,
    port,
    dataDir,
    dns,
    apiKeySource,
    url,
    telegram,
    sessionIdleMinutes,
  };
}

function parseArgs(argv: string[]): { config: string } {
  let config = DEFAULT_CONFIG_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('для --config нужен аргумент');
      config = next;
      i += 1;
    } else if (flag === '-h' || flag === '--help') {
      process.stdout.write('render-config [--config <путь>]\n');
      process.exit(0);
    } else {
      throw new Error(`неизвестный аргумент: ${flag}`);
    }
  }
  return { config };
}

function main(): void {
  const { config: file } = parseArgs(process.argv.slice(2));
  const source = fs.existsSync(file) ? file : EXAMPLE_CONFIG;
  const result = renderConfig(fs.readFileSync(source, 'utf8'), {
    users: process.env.ICARUS_USERS,
    port: process.env.ICARUS_PORT,
    dataDir: process.env.ICARUS_DATA_DIR,
    apiKey: process.env.ICARUS_API_KEY,
    dns: process.env.ICARUS_DNS,
    url: process.env.ICARUS_URL,
    telegramMapping: process.env.ICARUS_TELEGRAM_MAPPING,
    sessionIdleMinutes: process.env.ICARUS_SESSION_IDLE_MINUTES,
  });

  // The API key lives in this file, so 600 — both for a new file and an old one:
  // writeFileSync doesn't change the mode of an existing file.
  fs.writeFileSync(file, result.text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  const where = result.apiKeySource === 'env' ? 'из секрета' : result.apiKeySource === 'config' ? 'прежний' : 'сгенерирован';
  const dns = result.dns === null ? 'не трогал' : result.dns.length > 0 ? result.dns.join(', ') : 'убран';
  const panel = result.url ?? 'не задан — ссылки поведут на localhost';
  const telegram =
    result.telegram === null
      ? 'не трогал'
      : Object.keys(result.telegram).length > 0
        ? Object.entries(result.telegram)
            .map(([username, user]) => `@${username}→${user}`)
            .join(', ')
        : 'убран';
  process.stdout.write(
    `config.yaml (${source === EXAMPLE_CONFIG ? 'из примера' : 'прежний'}): ` +
      `люди ${result.users.join(', ')}; порт ${result.port}; dataDir ${result.dataDir}; ` +
      `docker.dns ${dns}; ключ API — ${where}; url ${panel}; telegram ${telegram}; ` +
      `тишина ${result.sessionIdleMinutes} мин\n`,
  );
}

// Tests import renderConfig from this same file, so we run the CLI only
// when the file is the entry point, not someone's import.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
