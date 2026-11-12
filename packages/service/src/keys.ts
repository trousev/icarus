// Ключи инсталляции: чтение, запись и каталог для панели.
//
// Рабочий файл ключей — .env в корне репозитория (в git не попадает). Панель
// переписывает его, не теряя комментарии и чужие строки: люди правят .env руками
// с первого дня, и терять их пояснения при первом же сохранении нельзя.
//
// Но .env — не единственный хозяин значений: deploy.yml на каждом деплое вливает
// в него секреты из GitHub и перетирает то, что человек поменял в панели. Поэтому
// правки панели лежат ещё и в keys.json рядом с .env: он переживает деплой, потому
// что в git не попадает и лежит вне сравнения с origin/main. Порядок силы:
//
//   keys.json (настройки панели) > .env (файл и секреты деплоя) > окружение
//
// Удаление — это не «стереть строку и надеяться, что деплой её не вернёт», а
// запись в removed: значение из .env будет проигнорировано, пока админ не задаст
// ключ снова. Так «убрал ключ в панели» значит именно убрал.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ENV_FILE, PROVIDER_ENV, REPO_ROOT } from './config.ts';
import { log } from './log.ts';

/** Настройки панели: лежат рядом с .env и переживают деплой. */
export const KEYS_FILE = path.join(REPO_ROOT, 'keys.json');

export type KeysStore = {
  version: 1;
  /** Значения, заданные в панели: они сильнее .env. */
  values: Record<string, string>;
  /** Имена, которые в панели убрали: значения из .env дальше не подхватываются. */
  removed: string[];
  updatedAt?: string;
  updatedBy?: string;
};

const EMPTY_STORE: KeysStore = { version: 1, values: {}, removed: [] };

/** Имя переменной окружения. Строго: значение уезжает в docker exec и в .env. */
export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function isEnvName(value: string): boolean {
  return ENV_NAME.test(value) && value.length <= 64;
}

/**
 * Значение из файла: без кавычек и переводов строк — ключи одного строки.
 * Пробелы по краям срезаем: их приносит копирование из браузера.
 */
export function normalizeValue(value: string): string {
  return value.trim();
}

/** Прочитать .env, не трогая окружение. Нет файла — пустая карта, это норма. */
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
 * Значение для строки .env.
 *
 * parseEnv (им же читают сервис и compose) понимает три вида: голое значение,
 * одинарные кавычки (литерал, без раскрытия) и двойные (раскрывает \n). Двойные
 * кавычки он при этом не разэкранирует, поэтому JSON-строка с «"» внутри ломает
 * разбор. Отсюда порядок: голое — если безопасно; одинарные — если внутри нет
 * одинарной кавычки; двойные — если нет ни «"», ни «\». Значение, в котором есть
 * и то и другое, в .env честно не записать — лучше ошибка, чем испорченный файл.
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
 * Поставить или убрать одну переменную в тексте .env.
 *
 * Правится только строка этого имени: комментарии, порядок и чужие переменные
 * остаются как были. Повторы убираются — иначе parseEnv молча взял бы последний,
 * а человек видел бы два разных значения в одном файле.
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
    // Перед добавлением пустая строка: файл читают глазами, и склейка с прошлым
    // блоком выглядит как часть чужого комментария.
    if (next.length > 0 && next[next.length - 1] !== '') next.push('');
    next.push(envLine(name, value));
  }

  const result = next.join('\n');
  return result === '' ? '' : `${result}\n`;
}

/** Атомарная запись с правами 600: ключи не должны светиться даже соседям. */
function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Переписать .env одной переменной, сохранив комментарии и остальные строки. */
export function writeEnvValue(name: string, value: string | null, file: string = ENV_FILE): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // Файла ещё нет — создаём: ./script/update его не успел положить, а ключ уже задают.
    text = '# Ключи Icarus. Файл правит и панель (раздел «Ключи»), и человек руками.\n';
  }
  writePrivate(file, editEnvText(text, name, value));
}

/**
 * Привести .env к настройкам панели.
 *
 * Зовётся перед сборкой compose: деплой вливает секреты GitHub в .env, а настройки
 * панели сильнее — значит и файл, который уедет в контейнеры, должен совпадать с ними.
 * Пишем один раз, а не по строке на ключ: файл читают и люди, и docker.
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

/** Прочитать настройки панели. Битый файл — не повод остаться без ключей из .env. */
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

/** Записать настройки панели. Прошлый файл сохраняем рядом: откатиться всегда можно. */
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
 * Итоговые секреты: .env, поверх — настройки панели, из removed — вычеркнутое.
 * Пустое значение не пишем: пустая переменная для расширений — то же, что нет.
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

// --- каталог для панели -------------------------------------------------------
// Панель показывает не «содержимое файла», а осмысленный список: что это за ключ,
// зачем он нужен и что будет, если его поменять. Незнакомые переменные из .env
// тоже попадают в список — иначе сохранение файла теряло бы их из виду.

export type KeyGroup = 'models' | 'search' | 'telegram' | 'tools' | 'other';

export type KeyInfo = {
  name: string;
  label: string;
  description: string;
  group: KeyGroup;
  /** Где взять ключ. */
  where?: string;
  /** Не секрет: показываем значение как есть (например, поисковый провайдер). */
  plain?: boolean;
  /**
   * Что нужно, чтобы новое значение доехало:
   *  - session — следующий разговор (сервис передаёт env в pi сам);
   *  - restart — перезапуск сервиса (например, токен Telegram-бота);
   *  - compose — пересборка стека (путь монтируется в контейнеры).
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

/** Подписи провайдеров pi: имя провайдера — оно же значение в auth.json. */
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
 * Каталог: провайдерские ключи из PROVIDER_ENV плюс всё, чем пользуемся мы сами.
 * Список держим рядом с кодом, который эти имена читает: ключ без подписи в панели
 * выглядит как строка из пяти заглавных букв, и админ не знает, что он делает.
 */
export function keyCatalog(): KeyInfo[] {
  const providers = new Map<string, KeyInfo>();
  for (const [provider, name] of Object.entries(PROVIDER_ENV)) {
    // Несколько провайдеров делят одну переменную (moonshotai и moonshotai-cn):
    // в панели это один ключ, а не два одинаковых поля.
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
    // Поисковый роутер держит несколько ключей сразу и сам выбирает живого.
    // Порядок здесь — тот же рейтинг, что в search/router.ts: сверху Google-выдача.
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

/** Каталог плюс всё незнакомое, что уже лежит в .env или в настройках панели. */
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

/** Подсказка вместо значения: сам секрет в браузер не уходит никогда. */
export function valueHint(value: string, plain = false): string {
  if (value === '') return '';
  if (plain) return value;
  if (value.length <= 8) return '••••••••';
  return `••••••••${value.slice(-4)}`;
}
