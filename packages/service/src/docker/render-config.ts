// CLI для ./script/redeploy: правит боевой config.yaml на хосте.
//
// config.yaml — единственный файл, который человек правит руками, поэтому деплой не
// пересобирает его с нуля, а меняет только то, что приезжает из GitHub: людей
// (variables.ICARUS_USERS), порт, каталог данных и ключ API. Модели, маунты и MCP
// остаются такими, какими их оставили на хосте.
//
//   ICARUS_USERS='trousev vita julia' ICARUS_PORT=8081 \
//     node packages/service/src/docker/render-config.ts
//
// Рабочего config.yaml ещё нет — за основу берётся config.example.yaml, и на выходе
// получается полностью готовый к запуску конфиг.
//
// Значения приходят из окружения, а не из argv: apiKey не должен светиться в `ps`.
// Комментарии в config.yaml не переживают правку — они и не нужны: описание полей
// живёт в config.example.yaml, а этот файл собирается машиной.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { DEFAULT_CONFIG_PATH, REPO_ROOT } from '../config.ts';

/** Образец, с которого начинается config.yaml, если рабочего файла ещё нет. */
const EXAMPLE_CONFIG = path.join(REPO_ROOT, 'config.example.yaml');

/** id идёт в имя контейнера и в путь на диске — тот же шаблон, что в config.ts. */
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
};

export type RenderResult = {
  text: string;
  users: string[];
  port: number;
  dataDir: string;
  /** Откуда взялся ключ API: из секрета, из прежнего файла или сгенерирован заново. */
  apiKeySource: 'env' | 'config' | 'generated';
};

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

/** Люди в config.yaml — простые строки (см. parseUsers в config.ts). */
function existingUsers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item !== 'string') {
      throw new Error('users: человек — это просто его id строкой (например "- trousev")');
    }
    return item.trim();
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

function parsePort(value: string): number {
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ICARUS_PORT: «${value}» — ожидался номер порта 1..65535`);
  }
  return port;
}

/**
 * Чистая правка конфига: на вход текст, на выход текст. Генератор ключа вынесен
 * параметром, чтобы тест не зависел от случайности.
 */
export function renderConfig(
  sourceText: string,
  overrides: Overrides,
  generate: () => string = () => crypto.randomBytes(24).toString('hex'),
): RenderResult {
  const doc = asRecord(parseYaml(sourceText), 'config');

  const users = overrides.users?.trim() ? splitUsers(overrides.users) : checkUsers(existingUsers(doc.users));
  if (users.length === 0) {
    throw new Error('в конфиге нет ни одного человека: задай ICARUS_USERS (например trousev,vita,julia)');
  }
  doc.users = users;

  if (overrides.port?.trim()) doc.port = parsePort(overrides.port);
  const port = Number(doc.port ?? 8080);

  if (overrides.dataDir?.trim()) doc.dataDir = overrides.dataDir.trim();
  const dataDir = String(doc.dataDir ?? '~/icarus-data');

  const fromEnv = overrides.apiKey?.trim() ?? '';
  const fromConfig = typeof doc.apiKey === 'string' ? doc.apiKey.trim() : '';
  const apiKeySource = fromEnv ? 'env' : fromConfig ? 'config' : 'generated';
  if (fromEnv) doc.apiKey = fromEnv;
  else if (!fromConfig) doc.apiKey = generate();

  return { text: HEADER + stringifyYaml(doc, { lineWidth: 0 }), users, port, dataDir, apiKeySource };
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
  });

  // Ключ API лежит в этом файле, поэтому 600 — и на новый файл, и на старый:
  // writeFileSync режим у существующего файла не меняет.
  fs.writeFileSync(file, result.text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  const where = result.apiKeySource === 'env' ? 'из секрета' : result.apiKeySource === 'config' ? 'прежний' : 'сгенерирован';
  process.stdout.write(
    `config.yaml (${source === EXAMPLE_CONFIG ? 'из примера' : 'прежний'}): ` +
      `люди ${result.users.join(', ')}; порт ${result.port}; dataDir ${result.dataDir}; ключ API — ${where}\n`,
  );
}

// Тесты импортируют renderConfig из этого же файла, поэтому CLI запускаем только
// тогда, когда файл — точка входа, а не чей-то импорт.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
