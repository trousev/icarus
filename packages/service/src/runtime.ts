// Перечитывание настроек без перезапуска сервиса.
//
// Ключи правятся в панели и живут в двух местах: .env (рабочий файл, его же читает
// docker compose) и keys.json (настройки панели, они сильнее и переживают деплой).
// Сохранили ключ — сервис обязан увидеть его сейчас, а не со следующего рестарта:
// иначе «сохранено» в панели значит «может быть, когда-нибудь».
//
// Конфиг в сервисе один на всех: его держат реестр сессий, бот, HTTP-сервер и панель.
// Поэтому перечитывание не создаёт новый объект, а подменяет содержимое старого —
// ссылки, которые уже кто-то держит, остаются рабочими.
import fs from 'node:fs';
import { DEFAULT_CONFIG_PATH, ENV_FILE, PROVIDER_ENV, loadConfig, type IcarusConfig } from './config.ts';
import { effectiveSecrets, fullCatalog, readEnvFile, readKeysStore, type KeysStore } from './keys.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';

/** Что .env положил в процесс в прошлый раз: чтобы убрать устаревшее, а не копить. */
let fileOwned = new Map<string, string>();

/** Имена, которые сервис вообще готов передать в процесс pi. */
function knownSecretNames(): Set<string> {
  const names = new Set<string>(Object.values(PROVIDER_ENV));
  for (const key of fullCatalog([])) names.add(key.name);
  return names;
}

export type RuntimeEnv = {
  /** Окружение для loadConfig: файл + настройки панели поверх process.env. */
  env: NodeJS.ProcessEnv;
  /** Что уедет в процесс pi: только ключи и настройки, не весь PATH. */
  secrets: Record<string, string>;
  store: KeysStore;
  fileVars: Record<string, string>;
};

/**
 * Окружение по слоям: base (окружение процесса) → .env → настройки панели.
 * Отдельная функция нужна панели: перед записью ключа она проверяет, что конфиг
 * с новым значением всё ещё разбирается, и делает это на копии, а не на живом env.
 */
export function envWithStore(
  base: NodeJS.ProcessEnv,
  fileVars: Record<string, string>,
  store: KeysStore,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(fileVars)) {
    if (!env[name]) env[name] = value;
  }
  for (const name of store.removed) delete env[name];
  for (const [name, value] of Object.entries(store.values)) {
    if (value.trim() === '') delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * Собрать окружение из трёх слоёв.
 *
 * process.env сильнее .env — ровно как docker compose с env_file и как ждёт
 * loadEnvFile: пустая переменная из CI не должна затирать рабочее значение файла.
 * А настройки панели сильнее обоих — иначе сохранённый в панели ключ не пережил бы
 * первый же деплой, который вливает секреты GitHub обратно в .env.
 */
export function loadRuntimeEnv(
  options: { envFile?: string; keysFile?: string; base?: NodeJS.ProcessEnv } = {},
): RuntimeEnv {
  const envFile = options.envFile ?? ENV_FILE;
  const base = options.base ?? process.env;

  // Прошлый .env больше не хозяин своих значений: убираем то, что он положил,
  // если человек (или панель) с тех пор ничего не переопределил.
  for (const [name, value] of fileOwned) {
    if (base[name] === value) delete base[name];
  }

  let fileVars: Record<string, string>;
  try {
    fileVars = readEnvFile(envFile);
  } catch (error) {
    log.warn('не удалось прочитать .env — работаю на окружении и настройках панели', {
      file: envFile,
      error: String(error),
    });
    fileVars = {};
  }

  const store = readKeysStore(options.keysFile);
  const env = envWithStore(base, fileVars, store);
  fileOwned = new Map(Object.entries(fileVars));

  // Сервис читает process.env и напрямую (имя контейнера MCP-прокси, DOCKER_HOST).
  // Поэтому, когда собираем боевое окружение, приводим процесс к тому же виду:
  // иначе ключ, заданный в панели, видел бы только loadConfig, а не остальной код.
  const sync = options.base === undefined || options.base === process.env;
  if (sync) {
    for (const name of Object.keys(process.env)) {
      if (!(name in env)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) process.env[name] = value;
    }
  }

  const secrets = effectiveSecrets(fileVars, store);
  // Убранный ключ нужно именно погасить в процессе pi: окружение контейнера всё
  // ещё помнит старое значение из .env, и без явной пустой переменной расширение
  // продолжило бы им пользоваться.
  for (const name of store.removed) secrets[name] = '';
  // Ключ, экспортированный в окружение (локальный запуск без .env), тоже должен
  // доехать до pi: иначе сервис видит его, а контейнер — нет.
  const known = knownSecretNames();
  for (const [name, value] of Object.entries(env)) {
    if (!known.has(name) || value === undefined || value.trim() === '') continue;
    if (store.removed.includes(name)) continue;
    if (!(name in secrets)) secrets[name] = value;
  }

  return { env, secrets, store, fileVars };
}

/** Подменить содержимое конфига целиком: ссылки на объект остаются валидными. */
export function replaceConfig(target: IcarusConfig, source: IcarusConfig): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in source)) delete record[key];
  }
  Object.assign(target, source);
}

/**
 * Окружение, каким оно станет после записи: панель проверяет конфиг на этой копии
 * и только потом пишет файл. Прошлые значения .env при этом вычитаются — ровно как
 * в loadRuntimeEnv, иначе валидация видела бы не то, что увидит сервис.
 */
export function previewEnv(
  store: KeysStore,
  fileVars: Record<string, string>,
  options: { base?: NodeJS.ProcessEnv } = {},
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };
  for (const [name, value] of fileOwned) {
    if (clean[name] === value) delete clean[name];
  }
  return envWithStore(clean, fileVars, store);
}

export type ReloadResult = {
  users: number;
  keys: number;
  /** Люди, чьё окружение не переписалось: ключ сохранён, но до человека не доехал. */
  warnings: string[];
};

/**
 * Перечитать .env, keys.json и config.yaml и разложить новое по людям.
 *
 * pi читает auth.json и mcp.json при старте сессии, поэтому после перезаписи
 * файлов реестр сессий должен пометить ресурсы обновлёнными (это делает вызывающий:
 * у runtime нет реестра). Здесь — только файлы и живой конфиг.
 */
export function reloadRuntime(config: IcarusConfig): ReloadResult {
  const state = loadRuntimeEnv({ envFile: config.envFile, keysFile: config.keysFile });
  const path = config.configPath ?? DEFAULT_CONFIG_PATH;
  const fresh = loadConfig(path, state.env);
  fresh.secretEnv = state.secrets;
  // Пути настроек не приходят из YAML: их задаёт вызывающий (или умолчания), и
  // терять их при перечитывании нельзя — иначе следующий saveKey промахнётся мимо
  // временного файла теста.
  if (config.envFile !== undefined) fresh.envFile = config.envFile;
  if (config.keysFile !== undefined) fresh.keysFile = config.keysFile;
  replaceConfig(config, fresh);

  const warnings: string[] = [];
  for (const user of config.users) {
    try {
      prepareUser(config, user);
    } catch (error) {
      warnings.push(`${user.id}: ${error instanceof Error ? error.message : String(error)}`);
      log.warn('окружение человека не обновилось после перечитывания ключей', {
        user: user.id,
        error: String(error),
      });
    }
  }

  log.info('ключи и конфиг перечитаны', {
    users: config.users.length,
    keys: Object.keys(state.secrets).length,
    warnings: warnings.length,
  });
  return { users: config.users.length, keys: Object.keys(state.secrets).length, warnings };
}

/** Есть ли .env: панель показывает это, чтобы человек понимал, откуда взялись ключи. */
export function envFileExists(file: string = ENV_FILE): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}
