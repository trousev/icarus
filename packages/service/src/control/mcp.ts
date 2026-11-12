// Панель MCP: добавить сервер, поделиться им, включить себе и настроить доступ.
//
// Человека называет SSO-прокси, поэтому userId приходит снаружи, а не из тела
// запроса. Владелец сервера — тот, кто его завёл; делиться и удалять может только
// он. Включать/выключать и вводить свои ключи может любой, кому сервер виден.
//
// OAuth проходит здесь же, но браузер уводится на authorization server, а
// callback возвращается в публичный (без заголовка SSO) маршрут: state связывает
// ответ с человеком и сервером, поэтому доверять заголовку в callback не нужно.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findUser, type IcarusConfig, type McpServerConfig } from '../config.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { log, redact } from '../log.ts';
import { prepareUser } from '../workspace.ts';
import {
  McpError,
  clearCredentials,
  clearOAuthCredentials,
  createServer,
  deleteServer,
  editorOf,
  getCredentials,
  listVisible,
  readStore,
  saveCredentials,
  saveOAuthCredentials,
  serverForUser,
  setEnabled,
  setShared,
  toPiConfig,
  updateServer,
  viewOf,
  type McpCredentials,
  type McpServerInput,
  type McpView,
} from '../mcp/registry.ts';
import {
  OAuthError,
  PENDING_TTL_MS,
  callbackUrl,
  clientMetadataDocument,
  completeAuthorization,
  credentialsFromCompleted,
  parseAuthorizationResponse,
  peekAuthorization,
  refreshAuthorization,
  startAuthorization,
  tokenIsFresh,
  type FetchLike,
} from '../mcp/oauth.ts';
import { probeMcp } from '../mcp/probe.ts';

type McpPanelContext = {
  config: IcarusConfig;
  /** Отметить, что ресурсы человека поменялись: следующий ход поднимет pi заново. */
  bump?: (userId: string) => void;
  /** Подмена сети в тестах. */
  fetchImpl?: FetchLike;
  /** Подмена времени в тестах. */
  now?: () => number;
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof McpError) {
    json(res, error.status, errorBody(error.message, error.status >= 500 ? 'server_error' : 'invalid_request_error'));
    return;
  }
  if (error instanceof OAuthError) {
    json(res, 400, errorBody(error.message, 'invalid_request_error'));
    return;
  }
  log.warn('MCP: запрос панели не вышел', { error: redact(String(error)) });
  json(res, 500, errorBody(error instanceof Error ? error.message : String(error), 'server_error'));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req);
  } catch (error) {
    throw new McpError(`не разобрал тело запроса: ${String(error)}`);
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optional(value: unknown): string | undefined {
  const text = textOf(value).trim();
  return text === '' ? undefined : text;
}

function boolOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Строки формы: объект или массив {name, value}. Пустой объект = «очистить». */
function rowsOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const name = textOf(record.name).trim();
      const entry = textOf(record.value);
      if (name !== '' && entry !== '') out[name] = entry;
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') out[name] = entry;
    }
    return out;
  }
  return undefined;
}

function argsOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  return textOf(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Секреты из формы: один заголовок/переменная или client secret. */
function credentialsOf(body: Record<string, unknown>): McpCredentials | undefined {
  const headers = rowsOf(body.credentialHeaders);
  const env = rowsOf(body.credentialEnv);
  const clientSecret = optional(body.clientSecret);
  if (headers === undefined && env === undefined && clientSecret === undefined) return undefined;
  return {
    ...(headers === undefined ? {} : { headers }),
    ...(env === undefined ? {} : { env }),
    ...(clientSecret === undefined ? {} : { oauth: { clientSecret } }),
  };
}

function inputOf(body: Record<string, unknown>): McpServerInput {
  const transport = textOf(body.transport);
  return {
    name: textOf(body.name),
    description: optional(body.description) ?? '',
    transport: transport === 'sse' || transport === 'stdio' ? transport : 'streamable-http',
    ...(optional(body.url) === undefined ? {} : { url: optional(body.url) }),
    ...(optional(body.command) === undefined ? {} : { command: optional(body.command) }),
    ...(argsOf(body.args) === undefined ? {} : { args: argsOf(body.args) }),
    ...(rowsOf(body.headers) === undefined ? {} : { headers: rowsOf(body.headers) }),
    ...(rowsOf(body.env) === undefined ? {} : { env: rowsOf(body.env) }),
    auth: textOf(body.auth) === 'oauth' ? 'oauth' : textOf(body.auth) === 'headers' ? 'headers' : 'none',
    ...(optional(body.scopes) === undefined ? {} : { scopes: optional(body.scopes) }),
    ...(optional(body.clientId) === undefined ? {} : { clientId: optional(body.clientId) }),
    ...(optional(body.authorizationEndpoint) === undefined ? {} : { authorizationEndpoint: optional(body.authorizationEndpoint) }),
    ...(optional(body.tokenEndpoint) === undefined ? {} : { tokenEndpoint: optional(body.tokenEndpoint) }),
    ...(optional(body.registrationEndpoint) === undefined ? {} : { registrationEndpoint: optional(body.registrationEndpoint) }),
    ...(optional(body.issuer) === undefined ? {} : { issuer: optional(body.issuer) }),
    ...(body.mimic === true ? { mimic: true } : {}),
    shared: body.shared === true,
  };
}

/** После любой правки: пересобрать mcp.json/AGENTS.md и перезапустить следующий ход. */
function apply(ctx: McpPanelContext, userId: string): void {
  const user = findUser(ctx.config, userId);
  if (!user) return;
  try {
    prepareUser(ctx.config, user);
  } catch (error) {
    log.warn('MCP: окружение человека не пересобралось', { user: userId, error: String(error) });
  }
  try {
    ctx.bump?.(userId);
  } catch (error) {
    log.warn('MCP: не удалось отметить обновление ресурсов', { user: userId, error: String(error) });
  }
}

function viewFor(config: IcarusConfig, userId: string, id: string): McpView | null {
  return viewOf(config, readStore(config), userId, id, Date.now());
}

/** Как сервер будет выглядеть для pi: для проверки нужен именно этот вид. */
function piConfigFor(
  config: IcarusConfig,
  userId: string,
  id: string,
): { server: McpServerConfig; credentials: ReturnType<typeof getCredentials> } | null {
  if (Object.hasOwn(config.mcp ?? {}, id)) {
    const server = config.mcp[id];
    return server ? { server, credentials: undefined } : null;
  }
  const server = serverForUser(config, userId, id);
  if (!server) return null;
  const credentials = getCredentials(config, userId, id);
  return { server: toPiConfig(server, credentials), credentials };
}

/**
 * Публичные маршруты: их зовёт не браузер с SSO-кукой, а authorization server и
 * редирект браузера. Никаких секретов в ответ не кладём.
 */
export async function handleMcpPublic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: McpPanelContext,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/panel/mcp/oauth/client-metadata.json') {
    const document = clientMetadataDocument(ctx.config.url);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' });
    res.end(JSON.stringify(document.document));
    return true;
  }
  if (url.pathname !== '/panel/mcp/oauth/callback') return false;

  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const error = url.searchParams.get('error');
  const description = url.searchParams.get('error_description');
  const back = (query: string): void => {
    res.writeHead(302, { location: `/panel/mcp?${query}` });
    res.end();
  };
  if (error) {
    log.warn('MCP: authorization server отказал', { error, description: redact(description ?? '') });
    back(`error=${encodeURIComponent(description || error)}`);
    return true;
  }
  if (!state || !code) {
    back(`error=${encodeURIComponent('сервер авторизации не вернул код')}`);
    return true;
  }
  try {
    const completed = await completeAuthorization({
      state,
      code,
      ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
      ...(ctx.now === undefined ? {} : { now: ctx.now() }),
    });
    saveOAuthCredentials(ctx.config, completed.userId, completed.serverId, credentialsFromCompleted(completed));
    apply(ctx, completed.userId);
    log.info('MCP: доступ получен', { user: completed.userId, server: completed.serverId });
    back(`connected=${encodeURIComponent(completed.serverId)}`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    log.warn('MCP: не удалось завершить авторизацию', { error: redact(message) });
    back(`error=${encodeURIComponent(message)}`);
  }
  return true;
}

export async function handleMcpApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: McpPanelContext,
  userId: string,
): Promise<void> {
  const { config } = ctx;
  const name = url.pathname.startsWith('/panel/mcp/') ? url.pathname.slice('/panel/mcp/'.length) : '';
  try {
    if (req.method === 'GET' && name === 'servers') {
      const list = listVisible(config, readStore(config), userId);
      json(res, 200, {
        user: userId,
        ...list,
        publicUrl: config.url,
        callbackUrl: callbackUrl(config.url),
      });
      return;
    }

    if (req.method === 'GET' && name === 'server') {
      const id = url.searchParams.get('id') ?? '';
      const editor = editorOf(config, userId, id);
      if (!editor) {
        json(res, 404, errorBody('такого MCP нет или он не твой', 'not_found'));
        return;
      }
      json(res, 200, editor);
      return;
    }

    if (req.method !== 'POST') {
      json(res, 404, errorBody(`неизвестный маршрут раздела MCP: ${name}`, 'not_found'));
      return;
    }

    const body = await bodyOf(req);
    const id = textOf(body.id);

    if (name === 'add') {
      if (!findUser(config, userId)) throw new McpError('пользователь не заведён', 404);
      const credentials = credentialsOf(body);
      // Секреты сохраняются одним заходом с описанием: если ключ не прошёл
      // проверку, сервер не должен остаться полузаведённым.
      const server = createServer(config, userId, {
        ...inputOf(body),
        ...(credentials === undefined ? {} : { credentials }),
      });
      apply(ctx, userId);
      const view = viewFor(config, userId, server.id);
      json(res, 200, { server: view });
      return;
    }

    if (name === 'update') {
      if (!id) throw new McpError('не указан id');
      const server = updateServer(config, userId, id, inputOf(body));
      const credentials = credentialsOf(body);
      if (credentials !== undefined) saveCredentials(config, userId, server.id, credentials);
      apply(ctx, userId);
      json(res, 200, { server: viewFor(config, userId, server.id) });
      return;
    }

    if (name === 'delete') {
      deleteServer(config, userId, id);
      apply(ctx, userId);
      json(res, 200, { ok: true });
      return;
    }

    if (name === 'toggle') {
      const enabled = boolOf(body.enabled);
      if (enabled === undefined) throw new McpError('enabled: ожидалось true или false');
      setEnabled(config, userId, id, enabled);
      apply(ctx, userId);
      json(res, 200, { server: viewFor(config, userId, id) });
      return;
    }

    if (name === 'share') {
      const shared = boolOf(body.shared);
      if (shared === undefined) throw new McpError('shared: ожидалось true или false');
      setShared(config, userId, id, shared);
      apply(ctx, userId);
      json(res, 200, { server: viewFor(config, userId, id) });
      return;
    }

    if (name === 'credentials') {
      if (!id) throw new McpError('не указан id');
      if (body.clear === true) {
        clearCredentials(config, userId, id);
      } else {
        const headers = rowsOf(body.headers);
        const env = rowsOf(body.env);
        const clientSecret = optional(body.clientSecret);
        if (headers === undefined && env === undefined && clientSecret === undefined) {
          throw new McpError('нечего сохранять: нужны headers, env или clientSecret');
        }
        saveCredentials(config, userId, id, {
          ...(headers === undefined ? {} : { headers }),
          ...(env === undefined ? {} : { env }),
          ...(clientSecret === undefined ? {} : { oauth: { clientSecret } }),
        });
      }
      apply(ctx, userId);
      json(res, 200, { server: viewFor(config, userId, id) });
      return;
    }

    if (name === 'oauth/start') {
      if (!id) throw new McpError('не указан id');
      const server = serverForUser(config, userId, id);
      if (!server) throw new McpError('такого MCP нет или он не расшарен', 404);
      if (server.auth !== 'oauth') throw new McpError('этот MCP не использует OAuth');
      const credentials = getCredentials(config, userId, id);
      const started = await startAuthorization({
        server,
        userId,
        publicUrl: config.url,
        ...(credentials === undefined ? {} : { credentials }),
        ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
        ...(ctx.now === undefined ? {} : { now: ctx.now() }),
      });
      json(res, 200, {
        url: started.url,
        state: started.state,
        redirectUri: started.redirectUri,
        // Мимикрия: панель не уводит вкладку, а показывает адрес и ждёт вставки.
        mimic: started.mimic,
        expiresIn: Math.round(PENDING_TTL_MS / 1000),
      });
      return;
    }

    if (name === 'oauth/complete') {
      // Ручное завершение: человек вставил адрес из строки браузера после того,
      // как его вернуло на мёртвый loopback. Всё остальное — как в callback.
      if (!id) throw new McpError('не указан id');
      const server = serverForUser(config, userId, id);
      if (!server) throw new McpError('такого MCP нет или он не расшарен', 404);
      if (server.auth !== 'oauth') throw new McpError('этот MCP не использует OAuth');
      const pasted = textOf(body.url).trim();
      if (pasted === '') throw new McpError('вставь адрес из строки браузера');
      const parsed = parseAuthorizationResponse(pasted);
      if (parsed.error !== undefined) {
        throw new OAuthError(
          `authorization server отказал: ${parsed.errorDescription ?? parsed.error}`,
          parsed.error,
        );
      }
      if (parsed.state === undefined) throw new OAuthError('в адресе нет state — скопируй его целиком');
      if (parsed.code === undefined) throw new OAuthError('в адресе нет code — скопируй его целиком');
      const now = ctx.now === undefined ? Date.now() : ctx.now();
      const info = peekAuthorization(parsed.state, now);
      if (!info) throw new OAuthError('ссылка авторизации устарела или уже использована — начни заново');
      // state живёт в памяти сервиса и связывает вход с человеком и сервером:
      // чужой адрес не должен завершить вход, даже если он валиден.
      if (info.userId !== userId) throw new McpError('этот вход начал другой человек', 403);
      if (info.serverId !== server.id) throw new McpError('этот вход относится к другому MCP-серверу');
      if (parsed.redirect !== undefined) {
        const expected = new URL(info.redirectUri);
        const actual = new URL(parsed.redirect);
        if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
          throw new OAuthError(
            `это адрес от другого входа: мы ждём ${expected.origin}${expected.pathname}. ` +
              'Скопируй адрес из строки браузера после входа в этот сервер',
          );
        }
      }
      const completed = await completeAuthorization({
        state: parsed.state,
        code: parsed.code,
        ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
        now,
      });
      saveOAuthCredentials(config, completed.userId, completed.serverId, credentialsFromCompleted(completed));
      apply(ctx, completed.userId);
      log.info('MCP: доступ получен вставкой адреса', { user: completed.userId, server: completed.serverId });
      json(res, 200, { server: viewFor(config, userId, server.id) });
      return;
    }

    if (name === 'oauth/disconnect') {
      if (!id) throw new McpError('не указан id');
      clearOAuthCredentials(config, userId, id);
      apply(ctx, userId);
      json(res, 200, { server: viewFor(config, userId, id) });
      return;
    }

    if (name === 'test') {
      if (!id) throw new McpError('не указан id');
      // Просроченный токен обновляем здесь же: иначе проверка честно скажет «401»,
      // хотя через секунду он бы обновился перед сессией.
      const credentials = getCredentials(config, userId, id);
      if (credentials?.oauth && !tokenIsFresh(credentials.oauth) && credentials.oauth.refreshToken) {
        try {
          const next = await refreshAuthorization({
            oauth: credentials.oauth,
            ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
            ...(ctx.now === undefined ? {} : { now: ctx.now() }),
          });
          saveOAuthCredentials(config, userId, id, next);
          apply(ctx, userId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          saveOAuthCredentials(config, userId, id, { error: message });
          // Просроченный сервер сразу убираем из mcp.json: держать там токен,
          // который уже не пустят, значит обещать модели инструменты без доступа.
          apply(ctx, userId);
        }
      }
      const prepared = piConfigFor(config, userId, id);
      if (!prepared) throw new McpError('такого MCP нет или он не расшарен', 404);
      const result = await probeMcp({
        server: prepared.server,
        ...(prepared.credentials === undefined ? {} : { credentials: prepared.credentials }),
        ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
      });
      json(res, 200, result);
      return;
    }

    json(res, 404, errorBody(`неизвестный маршрут раздела MCP: ${name}`, 'not_found'));
  } catch (error) {
    fail(res, error);
  }
}
