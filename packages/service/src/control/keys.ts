// Panel section "Keys": the admin edits installation secrets, the service re-reads them.
//
// There is not a single route here that would give a secret value to the browser: the panel
// shows "set" and the last four characters, and accepts a new value back.
// This is not paranoia but the only way not to scatter keys across the browser cache, proxy
// logs and random screenshots.
//
// Saving is not "put it in a file and forget it": the service re-reads .env and config.yaml
// (see runtime.ts), rewrites auth.json and mcp.json for users and marks the next pi
// session as new. That is why a key saved in the panel works from the next
// conversation, not from the next deploy.
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
import { FETCH_PROVIDERS } from '../search/fetch-providers.ts';
import { PROVIDERS } from '../search/providers.ts';
import type { SearchProviderId } from '../search/types.ts';
import {
  asProviderId,
  checkFetchProvider,
  checkProvider,
  clearProviderState,
  providerForKey,
  searchStatus,
} from '../search/panel.ts';

export type KeysContext = {
  config: IcarusConfig;
  /** Who saves: the label in keys.json and the permission check. */
  userId: string;
  /** Mark that the person's resources have been updated: the next pi session will take the new key. */
  bump?: (userId: string) => void;
};

type KeyRow = KeyInfo & {
  present: boolean;
  /** Where it came from: panel settings are stronger, .env is the working file. */
  source: 'settings' | 'env' | 'removed' | 'none';
  hint: string;
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Secrets for display: values do not leave, only the hint and the origin. */
function keysView(config: IcarusConfig, userId: string) {
  const envFile = config.envFile ?? ENV_FILE;
  const fileVars = readEnvFile(envFile);
  const store = readKeysStore(config.keysFile);
  const secrets = effectiveSecrets(fileVars, store);
  const names = new Set([...Object.keys(fileVars), ...Object.keys(store.values), ...store.removed]);
  // Provider keys that are in no model are not shown as a list of
  // forty lines: they will not go anywhere anyway. You can set one manually with
  // the "Add key" form, and then it will appear here.
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
    // Search router: who is current, who is quarantined and who has a "broken key".
    // The page shows this above the list of keys so that a person immediately sees
    // what exactly to check.
    search: searchStatus(config),
  };
}

/** Value from the request body: a single line, without line breaks. */
function parseValue(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, message: 'значение ключа — строка' };
  const value = normalizeValue(raw);
  if (/[\r\n]/.test(value)) return { ok: false, message: 'ключ должен быть одной строкой' };
  if (value.length > 4096) return { ok: false, message: 'значение длиннее 4096 знаков — это точно не ключ' };
  return { ok: true, value: value === '' ? null : value };
}

/**
 * Write the settings and re-read the service.
 *
 * First comes a check on a copy of the environment: a broken key must not leave the service
 * with a config that does not parse. Then the two files and a re-read. .env
 * is written for docker compose: the next rebuild of the stack will take the same value,
 * not the previous one. An error writing .env does not cancel the saved setting: it does
 * not prevent the service from working (the value will go to pi from keys.json anyway).
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

  // A copy of .env for a preliminary check: this is exactly the file that will be written.
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
    // The setting is already written — there is nothing to roll it back with and no reason to:
    // we report that a restart is needed for it to fully apply.
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
  // A search key was changed — old quarantines no longer apply to it:
  // the person may have fixed exactly the thing for which the router disabled it.
  const provider = providerForKey(name);
  if (provider !== null) {
    try {
      await clearProviderState(ctx.config, provider);
    } catch (error) {
      log.warn('ключ сохранён, но карантин поисковика не снялся', { key: name, error: String(error) });
    }
  }
  json(res, 200, {
    ...keysView(config, ctx.userId),
    reloaded,
    ...(envWarning ? { warning: envWarning } : {}),
    message: value === null ? `ключ ${name} убран` : `ключ ${name} сохранён`,
  });
}

/**
 * The next turn in each conversation will start pi anew: auth.json and mcp.json
 * are already new, and the old process keeps the previous keys in memory.
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
  if (action !== undefined && action !== 'reload' && action !== 'remove' && action !== 'set' && action !== 'check') {
    json(
      res,
      400,
      errorBody(`действие «${String(action)}» не понимаю: reload, set, remove или check`, 'invalid_request_error'),
    );
    return;
  }

  // "Check": a real search through the selected provider. Success lifts
  // the quarantine and the "broken key" flag, a refusal sets them again. This is the only
  // way to check a key without waiting for the router to reach it on its own.
  if (action === 'check') {
    const provider = asProviderId(typeof body.provider === 'string' ? body.provider : '');
    if (provider === null) {
      json(res, 400, errorBody(`неизвестный провайдер «${String(body.provider)}»`, 'invalid_request_error'));
      return;
    }
    // For Cloudflare the label is only in the fetch map, for the rest it is in the search one.
    const label =
      FETCH_PROVIDERS[provider]?.label ??
      (provider in PROVIDERS ? PROVIDERS[provider as SearchProviderId].label : provider);

    // capability=fetch checks page extraction, otherwise it is a regular search.
    if (body.capability === 'fetch') {
      const check = await checkFetchProvider(ctx.config, provider);
      json(res, 200, {
        ...keysView(ctx.config, ctx.userId),
        check: { ...check, capability: 'fetch' },
        message: check.ok
          ? `${label}: прочитал ${check.chars} знаков за ${check.ms} мс`
          : `${label}: не смог прочитать — ${check.error ?? 'без причины'}`,
      });
      return;
    }

    const check = await checkProvider(ctx.config, provider);
    json(res, 200, {
      ...keysView(ctx.config, ctx.userId),
      check: { ...check, capability: 'search' },
      message: check.ok
        ? `${label}: ответил за ${check.ms} мс, результатов ${check.results}`
        : `${label}: не ответил — ${check.error ?? 'без причины'}`,
    });
    return;
  }

  // "Re-read": .env could have been edited by a person by hand or by a deploy. We write nothing,
  // we only rebuild the environment and distribute it to users.
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
  // An explicit "remove" action is stronger than an accidental empty field in the form.
  const remove = action === 'remove' || (action === undefined && body.value === null);
  await saveKey(res, ctx, name, remove ? null : parsed.value);
}
