// Installation keys: reading, writing and catalog for the panel.
//
// The working key file is .env at the repository root (doesn't go into git). The panel
// rewrites it without losing comments and other lines: people edit .env by hand from day
// one, and losing their explanations on the first save is not allowed.
//
// But .env is not the only owner of the values: on every deploy deploy.yml pours GitHub
// secrets into it and overwrites what a person changed in the panel. That's why panel edits
// also live in keys.json next to .env: it survives deploy because it doesn't go into git and
// lies outside the comparison with origin/main. Order of strength:
//
//   keys.json (panel settings) > .env (file and deploy secrets) > environment
//
// Deletion is not «erase the line and hope deploy doesn't bring it back» but a record in
// removed: the value from .env will be ignored until the admin sets the key again. So
// «removed the key in the panel» means exactly removed.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ENV_FILE, PROVIDER_ENV, REPO_ROOT } from './config.ts';
import { log } from './log.ts';

/** Panel settings: live next to .env and survive deploy. */
export const KEYS_FILE = path.join(REPO_ROOT, 'keys.json');

export type KeysStore = {
  version: 1;
  /** Values set in the panel: they are stronger than .env. */
  values: Record<string, string>;
  /** Names removed in the panel: values from .env are no longer picked up. */
  removed: string[];
  updatedAt?: string;
  updatedBy?: string;
};

const EMPTY_STORE: KeysStore = { version: 1, values: {}, removed: [] };

/** Environment variable name. Strict: the value goes into docker exec and into .env. */
export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function isEnvName(value: string): boolean {
  return ENV_NAME.test(value) && value.length <= 64;
}

/**
 * Value from the file: without quotes and newlines — a key is a single line.
 * We trim surrounding spaces: they come from copying in the browser.
 */
export function normalizeValue(value: string): string {
  return value.trim();
}

/** Read .env without touching the environment. No file — empty map, that's fine. */
export function readEnvFile(file: string = ENV_FILE): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(text);
  } catch (error) {
    throw new Error(`.env ${file} не разбирается: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * Value for a .env line.
 *
 * parseEnv (the same one the service and compose read with) understands three kinds: a bare
 * value, single quotes (literal, no expansion) and double quotes (expands \n). It does not
 * unescape double quotes, so a JSON string with «"» inside breaks parsing. Hence the order:
 * bare — if safe; single — if there's no single quote inside; double — if there's neither «"»
 * nor «\». A value that has both honestly cannot be written to .env — an error is better than
 * a broken file.
 */
export function envLine(name: string, value: string): string {
  if (plain(value)) return `${name}=${value}`;
  if (!value.includes("'")) return `${name}='${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `${name}=${JSON.stringify(value)}`;
  throw new Error(`значение ${name} содержит и одинарную, и двойную кавычку — в .env так не записать`);
}

function plain(value: string): boolean {
  return /^[A-Za-z0-9_./:@+,=-]*$/.test(value);
}

/**
 * Set or remove a single variable in the .env text.
 *
 * Only the line with this name is edited: comments, order and other variables stay as they
 * were. Duplicates are removed — otherwise parseEnv would silently take the last one while a
 * person sees two different values in one file.
 */
export function editEnvText(text: string, name: string, value: string | null): string {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const matches = (line: string): boolean => {
    const trimmed = line.trimStart();
    return new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(trimmed) && !trimmed.startsWith('#');
  };
  const present = lines.some(matches);

  let replaced = false;
  const next: string[] = [];
  for (const line of lines) {
    if (!matches(line)) {
      next.push(line);
      continue;
    }
    if (replaced) continue;
    replaced = true;
    if (value !== null) next.push(envLine(name, value));
  }
  if (value !== null && !present) {
    // An empty line before adding: the file is read by eye, and gluing it to the previous
    // block looks like part of someone else's comment.
    if (next.length > 0 && next[next.length - 1] !== '') next.push('');
    next.push(envLine(name, value));
  }

  const result = next.join('\n');
  return result === '' ? '' : `${result}\n`;
}

/** Atomic write with 600 permissions: keys must not be visible even to neighbors. */
function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Rewrite .env with one variable, preserving comments and other lines. */
export function writeEnvValue(name: string, value: string | null, file: string = ENV_FILE): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // The file doesn't exist yet — create it: ./script/update hadn't laid it down yet,
    // but the key is already being set.
    text = '# Ключи Icarus. Файл правит и панель (раздел «Ключи»), и человек руками.\n';
  }
  writePrivate(file, editEnvText(text, name, value));
}

/**
 * Bring .env in line with panel settings.
 *
 * Called before the compose build: deploy pours GitHub secrets into .env, and panel settings
 * are stronger — so the file that goes to containers must match them too. We write once,
 * not line by line per key: the file is read both by people and by docker.
 */
export function syncEnvFile(store: KeysStore, file: string = ENV_FILE): void {
  if (Object.keys(store.values).length === 0 && store.removed.length === 0) return;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '# Ключи Icarus. Файл правит и панель (раздел «Ключи»), и человек руками.\n';
  }
  for (const name of store.removed) text = editEnvText(text, name, null);
  for (const [name, value] of Object.entries(store.values)) {
    text = editEnvText(text, name, value.trim() === '' ? null : value);
  }
  writePrivate(file, text);
}

/** Read panel settings. A broken file is no reason to be left without keys from .env. */
export function readKeysStore(file: string = KEYS_FILE): KeysStore {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...EMPTY_STORE, values: {}, removed: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    log.warn('keys.json не разобрался — остаются ключи из .env', { file, error: String(error) });
    return { ...EMPTY_STORE, values: {}, removed: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('keys.json не объект — остаются ключи из .env', { file });
    return { ...EMPTY_STORE, values: {}, removed: [] };
  }
  const record = parsed as Record<string, unknown>;
  const values: Record<string, string> = {};
  if (record.values !== null && typeof record.values === 'object' && !Array.isArray(record.values)) {
    for (const [name, value] of Object.entries(record.values as Record<string, unknown>)) {
      if (typeof value === 'string' && isEnvName(name)) values[name] = value;
    }
  }
  const removed = Array.isArray(record.removed)
    ? record.removed.filter((name): name is string => typeof name === 'string' && isEnvName(name))
    : [];
  return {
    version: 1,
    values,
    removed,
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.updatedBy === 'string' ? { updatedBy: record.updatedBy } : {}),
  };
}

/** Write panel settings. We keep the previous file nearby: you can always roll back. */
export function writeKeysStore(store: KeysStore, file: string = KEYS_FILE): void {
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
      fs.chmodSync(`${file}.bak`, 0o600);
    } catch (error) {
      log.warn('не удалось сохранить копию keys.json', { file, error: String(error) });
    }
  }
  const payload: KeysStore = {
    version: 1,
    values: Object.fromEntries(Object.entries(store.values).sort(([a], [b]) => a.localeCompare(b))),
    removed: [...new Set(store.removed)].sort(),
    ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}),
    ...(store.updatedBy ? { updatedBy: store.updatedBy } : {}),
  };
  writePrivate(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Resulting secrets: .env, with panel settings on top, removed ones struck out.
 * We don't write an empty value: an empty variable for extensions is the same as absent.
 */
export function effectiveSecrets(
  fileVars: Record<string, string>,
  store: KeysStore,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(fileVars)) {
    if (value.trim() !== '') secrets[name] = value;
  }
  for (const name of store.removed) delete secrets[name];
  for (const [name, value] of Object.entries(store.values)) {
    if (value.trim() === '') delete secrets[name];
    else secrets[name] = value;
  }
  return secrets;
}

// --- catalog for the panel -------------------------------------------------------
// The panel shows not «the file contents» but a meaningful list: what this key is,
// why it's needed and what happens if it's changed. Unknown variables from .env also
// make it into the list — otherwise saving the file would lose sight of them.

export type KeyGroup = 'models' | 'search' | 'telegram' | 'tools' | 'other';

export type KeyInfo = {
  name: string;
  label: string;
  description: string;
  group: KeyGroup;
  /** Where to get the key. */
  where?: string;
  /** Not a secret: we show the value as is (e.g. the search provider). */
  plain?: boolean;
  /**
   * What's needed for a new value to take effect:
   *  - session — the next conversation (the service passes env to pi itself);
   *  - restart — restarting the service (e.g. the Telegram bot token);
   *  - compose — rebuilding the stack (the path is mounted into containers).
   */
  apply?: 'session' | 'restart' | 'compose';
};

export const GROUP_LABELS: Record<KeyGroup, string> = {
  models: 'Модели',
  search: 'Поиск',
  telegram: 'Telegram',
  tools: 'Инструменты',
  other: 'Прочее',
};

/** pi provider labels: the provider name is also the value in auth.json. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  deepinfra: 'DeepInfra',
  google: 'Google Gemini',
  groq: 'Groq',
  cerebras: 'Cerebras',
  xai: 'xAI (Grok)',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot',
  zai: 'Z.ai',
  nvidia: 'NVIDIA',
  together: 'Together AI',
  fireworks: 'Fireworks',
  huggingface: 'Hugging Face',
};

/**
 * Catalog: provider keys from PROVIDER_ENV plus everything we use ourselves.
 * We keep the list next to the code that reads these names: a key without a label in the
 * panel looks like a string of five capital letters, and the admin doesn't know what it does.
 */
export function keyCatalog(): KeyInfo[] {
  const providers = new Map<string, KeyInfo>();
  for (const [provider, name] of Object.entries(PROVIDER_ENV)) {
    // Several providers share one variable (moonshotai and moonshotai-cn):
    // in the panel this is one key, not two identical fields.
    if (providers.has(name)) continue;
    const label = PROVIDER_LABELS[provider] ?? provider;
    providers.set(name, {
      name,
      label: `Ключ ${label}`,
      description: `API-ключ провайдера «${provider}»: уезжает в auth.json контейнеров.`,
      group: 'models',
      apply: 'session',
    });
  }

  return [
    ...providers.values(),
    // The search router holds several keys at once and picks a live one itself.
    // The order here is the same rating as in search/router.ts: Google output on top.
    {
      name: 'SERPAPI_API_KEY',
      label: 'Поиск — SerpApi (Google)',
      description: 'Выдача Google через SerpApi. 250 поисков в месяц бесплатно — верх рейтинга роутера.',
      group: 'search',
      where: 'https://serpapi.com',
      apply: 'session',
    },
    {
      name: 'SERPSTACK_API_KEY',
      label: 'Поиск — Serpstack (Google)',
      description: 'Выдача Google от APILayer. 100 поисков в месяц, только некоммерческое использование.',
      group: 'search',
      where: 'https://serpstack.com',
      apply: 'session',
    },
    {
      name: 'BRAVE_API_KEY',
      label: 'Поиск — Brave',
      description: 'Свой индекс Brave, $5 кредитов в месяц. Нужна карта для активации плана.',
      group: 'search',
      where: 'https://brave.com/search/api/',
      apply: 'session',
    },
    {
      name: 'EXA_API_KEY',
      label: 'Поиск — Exa',
      description: 'Семантический поиск Exa, $10 кредитов в месяц без карты.',
      group: 'search',
      where: 'https://dashboard.exa.ai/api-keys',
      apply: 'session',
    },
    {
      name: 'TAVILY_API_KEY',
      label: 'Поиск — Tavily',
      description: '1 000 кредитов в месяц. Раньше был единственным провайдером, теперь один из многих.',
      group: 'search',
      where: 'https://app.tavily.com',
      apply: 'session',
    },
    {
      name: 'FIRECRAWL_API_KEY',
      label: 'Поиск — Firecrawl',
      description: 'Поиск с полным текстом страниц, 1 000 кредитов в месяц (= 500 поисков).',
      group: 'search',
      where: 'https://www.firecrawl.dev',
      apply: 'session',
    },
    {
      name: 'YOU_API_KEY',
      label: 'Поиск — You.com',
      description:
        'API You.com с ключом: больше квоты и чтение страниц. Бесплатный MCP-профиль работает и без него — см. ICARUS_SEARCH_FREE.',
      group: 'search',
      where: 'https://you.com/platform',
      apply: 'session',
    },
    {
      name: 'ICARUS_SEARCH_FREE',
      label: 'Поиск — бесплатный MCP You.com',
      description:
        'on (по умолчанию) — роутер ходит в MCP You.com без ключа: 100 поисков в сутки, страницы читать не умеет. off — выключить совсем.',
      group: 'search',
      plain: true,
      apply: 'session',
    },
    {
      name: 'LINKUP_API_KEY',
      label: 'Поиск — Linkup',
      description: 'Дешёвый аналог Tavily: $20 кредитов в месяц. В рейтинге последний — как запасной.',
      group: 'search',
      where: 'https://app.linkup.so',
      apply: 'session',
    },
    {
      name: 'CLOUDFLARE_ACCOUNT_ID',
      label: 'Извлечение — Cloudflare (аккаунт)',
      description: 'ID аккаунта Cloudflare: без него Browser Run не позвать. Не секрет, но нужен вместе с токеном.',
      group: 'search',
      plain: true,
      where: 'https://dash.cloudflare.com → Workers & Pages → Account ID',
      apply: 'session',
    },
    {
      name: 'CLOUDFLARE_API_TOKEN',
      label: 'Извлечение — Cloudflare (токен)',
      description:
        'API-токен с правом Browser Run - Edit. Дешевле всех для страниц: время браузера, 10 минут в день бесплатно.',
      group: 'search',
      where: 'https://dash.cloudflare.com/profile/api-tokens',
      apply: 'session',
    },
    {
      name: 'ICARUS_SEARCH_PROVIDER',
      label: 'Поиск — провайдер',
      description:
        'router (по умолчанию в контейнере: поиск идёт через сервис) | tavily | brave | searxng | none. Адрес роутера сервис задаёт сам, токен внутри сети не нужен.',
      group: 'search',
      plain: true,
      apply: 'session',
    },
    {
      name: 'ICARUS_SEARCH_DEPTH',
      label: 'Поиск — глубина',
      description: 'basic (по умолчанию) или advanced: глубже и дороже. Относится к старому одиночному режиму.',
      group: 'search',
      plain: true,
      apply: 'session',
    },
    {
      name: 'ICARUS_SEARXNG_URL',
      label: 'Поиск — адрес SearXNG',
      description: 'Нужен, когда ICARUS_SEARCH_PROVIDER=searxng.',
      group: 'search',
      plain: true,
      apply: 'session',
    },
    {
      name: 'TELEGRAM_BOT_TOKEN',
      label: 'Telegram — токен бота',
      description: 'Токен от @BotFather. Новый токен подхватится после перезапуска сервиса.',
      group: 'telegram',
      where: 'https://t.me/BotFather',
      apply: 'restart',
    },
    {
      name: 'MAPLE_DIR',
      label: 'Maple — каталог установки',
      description: 'Путь на хосте. Меняется только с пересборкой стека: он же маунт.',
      group: 'tools',
      plain: true,
      apply: 'compose',
    },
  ];
}

/** Catalog plus everything unfamiliar already in .env or in panel settings. */
export function fullCatalog(extra: Iterable<string>): KeyInfo[] {
  const catalog = keyCatalog();
  const known = new Set(catalog.map((key) => key.name));
  const others: KeyInfo[] = [];
  for (const name of extra) {
    if (known.has(name)) continue;
    known.add(name);
    others.push({
      name,
      label: name,
      description: 'Переменная окружения из .env: уезжает в контейнеры людей.',
      group: 'other',
      apply: 'session',
    });
  }
  return [...catalog, ...others.sort((a, b) => a.name.localeCompare(b.name))];
}

/** A hint instead of the value: the secret itself never goes to the browser. */
export function valueHint(value: string, plain = false): string {
  if (value === '') return '';
  if (plain) return value;
  if (value.length <= 8) return '••••••••';
  return `••••••••${value.slice(-4)}`;
}
