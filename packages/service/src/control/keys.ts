// Раздел панели «Ключи»: админ правит секреты инсталляции, сервис их перечитывает.
//
// Здесь нет ни одного маршрута, который отдал бы значение секрета браузеру: панель
// показывает «задан» и хвост из четырёх знаков, а обратно принимает новое значение.
// Это не паранойя, а единственный способ не разнести ключи по кэшу браузера, логам
// прокси и случайным скриншотам.
//
// Сохранение не «положило в файл и забыло»: сервис перечитывает .env и config.yaml
// (см. runtime.ts), переписывает auth.json и mcp.json людям и помечает следующую
// сессию pi как новую. Поэтому ключ, сохранённый в панели, работает со следующего
// разговора, а не со следующего деплоя.
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findUser, isAdmin, loadConfig, ENV_FILE, PROVIDER_ENV, type IcarusConfig } from '../config.ts';
import {
  GROUP_LABELS,
  KEYS_FILE,
  type KeyGroup,
  type KeyInfo,
  effectiveSecrets,
  fullCatalog,
  isEnvName,
  normalizeValue,
  readEnvFile,
  readKeysStore,
  valueHint,
  writeEnvValue,
  writeKeysStore,
  type KeysStore,
} from '../keys.ts';
import { reloadRuntime, previewEnv } from '../runtime.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { log } from '../log.ts';

export type KeysContext = {
  config: IcarusConfig;
  /** Кто сохраняет: подпись в keys.json и проверка права. */
  userId: string;
  /** Отметить, что ресурсы человека обновились: следующая сессия pi возьмёт новый ключ. */
  bump?: (userId: string) => void;
};

type KeyRow = KeyInfo & {
  present: boolean;
  /** Откуда взялось: настройки панели сильнее, .env — рабочий файл. */
  source: 'settings' | 'env' | 'removed' | 'none';
  hint: string;
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Секреты для показа: значения не уходят, только подсказка и происхождение. */
function keysView(config: IcarusConfig, userId: string) {
  const envFile = config.envFile ?? ENV_FILE;
  const fileVars = readEnvFile(envFile);
  const store = readKeysStore(config.keysFile);
  const secrets = effectiveSecrets(fileVars, store);
  const names = new Set([...Object.keys(fileVars), ...Object.keys(store.values), ...store.removed]);
  // Ключи провайдеров, которых нет ни в одной модели, не показываем списком на
  // сорок строк: они всё равно никуда не уедут. Задать такой можно вручную —
  // формой «Добавить ключ», и тогда он появится здесь.
  const used = new Set([...config.models.map((model) => model.provider), ...(config.speech ? [config.speech.provider] : [])]);
  const providerOf = new Map(Object.entries(PROVIDER_ENV).map(([provider, name]) => [name, provider]));
  const keys: KeyRow[] = fullCatalog(names)
    .filter((info) => info.group !== 'models' || names.has(info.name) || used.has(providerOf.get(info.name) ?? ''))
    .map((info) => {
    const value = secrets[info.name] ?? '';
    const inSettings = Object.prototype.hasOwnProperty.call(store.values, info.name);
    const removed = store.removed.includes(info.name);
    const inFile = Object.prototype.hasOwnProperty.call(fileVars, info.name);
    return {
      ...info,
      present: value !== '',
      source: inSettings ? 'settings' : removed ? 'removed' : inFile ? 'env' : 'none',
      hint: valueHint(value, info.plain),
    };
  });

  return {
    user: userId,
    admin: true,
    keysFile: config.keysFile ?? KEYS_FILE,
    envFile,
    envFileExists: fs.existsSync(envFile),
    updatedAt: store.updatedAt ?? null,
    updatedBy: store.updatedBy ?? null,
    groups: Object.entries(GROUP_LABELS).map(([id, label]) => ({ id: id as KeyGroup, label })),
    keys,
    secrets: Object.keys(secrets).length,
  };
}

/** Значение из тела запроса: одна строка, без переводов строк. */
function parseValue(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, message: 'значение ключа — строка' };
  const value = normalizeValue(raw);
  if (/[\r\n]/.test(value)) return { ok: false, message: 'ключ должен быть одной строкой' };
  if (value.length > 4096) return { ok: false, message: 'значение длиннее 4096 знаков — это точно не ключ' };
  return { ok: true, value: value === '' ? null : value };
}

/**
 * Записать настройки и перечитать сервис.
 *
 * Сначала — проверка на копии окружения: битый ключ не должен оставить сервис
 * с конфигом, который не разбирается. Затем — два файла и перечитывание. .env
 * пишется для docker compose: следующая пересборка стека возьмёт то же значение,
 * а не прежнее. Ошибка записи .env не отменяет сохранённую настройку: работать
 * сервису это не мешает (значение всё равно уедет в pi из keys.json).
 */
async function saveKey(
  res: ServerResponse,
  ctx: KeysContext,
  name: string,
  value: string | null,
): Promise<void> {
  const { config } = ctx;
  const current = readKeysStore(config.keysFile);
  const next: KeysStore = {
    version: 1,
    values: { ...current.values },
    removed: current.removed.filter((item) => item !== name),
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  };

  if (value === null) {
    delete next.values[name];
    if (!next.removed.includes(name)) next.removed.push(name);
  } else {
    next.values[name] = value;
  }

  // Копия .env для предварительной проверки: именно такой файл будет записан.
  const fileVars = readEnvFile(config.envFile);
  const candidateFile = { ...fileVars };
  if (value === null) delete candidateFile[name];
  else candidateFile[name] = value;

  if (config.configPath) {
    try {
      loadConfig(config.configPath, previewEnv(next, candidateFile));
    } catch (error) {
      json(
        res,
        400,
        errorBody(
          `с этим значением конфиг не разбирается: ${error instanceof Error ? error.message : String(error)}`,
          'invalid_request_error',
        ),
      );
      return;
    }
  }

  try {
    writeKeysStore(next, config.keysFile);
  } catch (error) {
    json(res, 500, errorBody(`не удалось сохранить настройки: ${String(error)}`, 'server_error'));
    return;
  }

  let envWarning: string | null = null;
  try {
    writeEnvValue(name, value, config.envFile);
  } catch (error) {
    envWarning = `.env не переписался (${error instanceof Error ? error.message : String(error)}): compose возьмёт значение при следующем сохранении`;
    log.warn('ключ сохранён в настройках, но .env не переписался', { key: name, error: String(error) });
  }

  let reloaded;
  try {
    reloaded = reloadRuntime(config);
  } catch (error) {
    // Настройка уже записана — откатывать её нечем и незачем: сообщаем, что для
    // полного применения нужен перезапуск.
    log.error('ключ сохранён, но сервис не перечитал конфиг', { key: name, error: String(error) });
    json(res, 500, {
      ...errorBody(
        `ключ сохранён, но сервис не перечитал конфиг: ${error instanceof Error ? error.message : String(error)} — перезапусти сервис`,
        'server_error',
      ),
      ...keysView(config, ctx.userId),
    });
    return;
  }

  applyToUsers(ctx);
  json(res, 200, {
    ...keysView(config, ctx.userId),
    reloaded,
    ...(envWarning ? { warning: envWarning } : {}),
    message: value === null ? `ключ ${name} убран` : `ключ ${name} сохранён`,
  });
}

/**
 * Следующая реплика в каждом разговоре поднимет pi заново: auth.json и mcp.json
 * уже новые, а старый процесс держит прежние ключи в памяти.
 */
function applyToUsers(ctx: KeysContext): void {
  for (const user of ctx.config.users) {
    try {
      ctx.bump?.(user.id);
    } catch (error) {
      log.warn('не удалось отметить обновление ресурсов после смены ключа', { user: user.id, error: String(error) });
    }
  }
}

export async function handleKeysApi(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: KeysContext,
): Promise<void> {
  const user = findUser(ctx.config, ctx.userId);
  if (!isAdmin(user)) {
    json(res, 403, errorBody('ключи правит только админ', 'permission_error'));
    return;
  }

  if (req.method === 'GET') {
    json(res, 200, keysView(ctx.config, ctx.userId));
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, errorBody(`ключи не умеют ${req.method}`, 'invalid_request_error'));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (error) {
    json(res, 400, errorBody(`не разобрал тело запроса: ${String(error)}`, 'invalid_request_error'));
    return;
  }

  const action = body.action;
  if (action !== undefined && action !== 'reload' && action !== 'remove' && action !== 'set') {
    json(res, 400, errorBody(`действие «${String(action)}» не понимаю: reload, set или remove`, 'invalid_request_error'));
    return;
  }

  // «Перечитать»: .env мог поправить человек руками или деплой. Ничего не пишем,
  // только заново собираем окружение и раскладываем его людям.
  if (action === 'reload') {    try {
      const reloaded = reloadRuntime(ctx.config);
      applyToUsers(ctx);
      json(res, 200, {
        ...keysView(ctx.config, ctx.userId),
        reloaded,
        message: 'ключи перечитаны из файлов',
      });
    } catch (error) {
      json(
        res,
        500,
        errorBody(`не удалось перечитать: ${error instanceof Error ? error.message : String(error)}`, 'server_error'),
      );
    }
    return;
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!isEnvName(name)) {
    json(res, 400, errorBody(`имя «${name}» не годится: заглавные буквы, цифры и «_», начиная с буквы`, 'invalid_request_error'));
    return;
  }

  const parsed = parseValue(body.value);
  if (!parsed.ok) {
    json(res, 400, errorBody(parsed.message, 'invalid_request_error'));
    return;
  }
  // Явное действие «убрать» сильнее случайного пустого поля в форме.
  const remove = action === 'remove' || (action === undefined && body.value === null);
  await saveKey(res, ctx, name, remove ? null : parsed.value);
}
