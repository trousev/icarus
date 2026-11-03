// Локальный прокси для OAuth-MCP: pi ходит в сервис, сервис — в настоящий MCP.
//
// Зачем: authorization server может выдать access token на пять минут. pi читает
// mcp.json один раз и держит Authorization весь разговор, поэтому вклеенный Bearer
// протухает прямо в треде, и mcp_connect не помогает — конфиг уже загружен.
//
// Прокси решает это на каждом HTTP-запросе: смотрит срок токена, при необходимости
// молча обновляет его по refresh_token и только потом идёт в MCP. Токен вообще не
// попадает в mcp.json — оттуда уезжает только непрозрачный proxyKey.
//
// Прокси живёт на том же сервисе, поэтому стриминг SSE не буферизуем: тело
// запроса читаем целиком (это JSON-RPC), ответ пайпим как есть.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { IcarusConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { findOAuthByProxyKey } from './registry.ts';
import { freshOAuthForServer } from './refresh.ts';
import { mcpReauthUrl } from './reauth.ts';

const PREFIX = '/mcp-proxy/';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

class ProxyError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
  }
}

function jsonError(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
  reauthUrl?: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error, error_description: description, ...(reauthUrl ? { reauth_url: reauthUrl } : {}) }));
}

/** Тело ответа для человеческой ошибки: не тянем в память мегабайты. */
async function responseText(upstream: IncomingMessage, limit = 2000): Promise<string> {
  let text = '';
  try {
    for await (const chunk of upstream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk as Uint8Array).toString('utf8');
      if (text.length >= limit) {
        upstream.destroy();
        break;
      }
    }
  } catch {
    // тело могло оборваться — для сообщения хватит того, что успели
  }
  return text.slice(0, limit);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new ProxyError(`тело запроса больше ${MAX_BODY_BYTES} байт`, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Заголовки запроса к MCP: всё, кроме hop-by-hop и нашего Authorization. */
function requestHeaders(
  req: IncomingMessage,
  token: string,
  target: URL,
  bodyLength: number,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === 'host' ||
      lower === 'authorization' ||
      lower === 'content-length' ||
      lower === 'accept-encoding' ||
      lower === 'cookie'
    ) {
      continue;
    }
    headers[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  headers.host = target.host;
  headers.authorization = `Bearer ${token}`;
  if (bodyLength > 0) headers['content-length'] = String(bodyLength);
  return headers;
}

function forward(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    let request: http.ClientRequest;
    try {
      request = client.request(target, { method, headers, signal }, (response) => resolve(response));
    } catch (error) {
      reject(error);
      return;
    }
    request.on('error', reject);
    request.end(body.length > 0 ? body : undefined);
  });
}

/** Ответ MCP отдаём как есть: SSE, JSON, коды и mcp-session-id важны клиенту. */
function pipeResponse(res: ServerResponse, upstream: IncomingMessage): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'content-length' || lower === 'transfer-encoding') continue;
    headers[name] = value;
  }
  res.writeHead(upstream.statusCode ?? 502, headers);
  upstream.pipe(res);
  upstream.on('error', () => res.destroy());
  res.on('close', () => upstream.destroy());
}

/**
 * Обрабатывает /mcp-proxy/<key>. Ключ случаен и живёт в credentials.json; токен
 * и refresh здесь же. Ошибки не содержат секретов — только причину.
 */
export async function handleMcpProxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: IcarusConfig,
): Promise<void> {
  if (!url.pathname.startsWith(PREFIX)) {
    jsonError(res, 404, 'not_found', 'нет такого прокси-маршрута');
    return;
  }
  const key = url.pathname.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(key)) {
    jsonError(res, 404, 'not_found', 'нет такого прокси-маршрута');
    return;
  }

  let found: ReturnType<typeof findOAuthByProxyKey>;
  try {
    found = findOAuthByProxyKey(config, key);
  } catch (error) {
    jsonError(res, 500, 'server_error', error instanceof Error ? error.message : String(error));
    return;
  }
  const serverUrl = found?.server.url;
  if (!found || !serverUrl) {
    jsonError(res, 404, 'not_found', 'MCP не найден по этому ключу');
    return;
  }
  const server = found.server;

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (error) {
    const status = error instanceof ProxyError ? error.status : 400;
    jsonError(res, status, 'invalid_request', error instanceof Error ? error.message : String(error));
    return;
  }

  let oauth;
  try {
    oauth = await freshOAuthForServer(config, found.userId, server.id, { marginMs: 60_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('MCP proxy: нет свежего токена', { user: found.userId, server: server.id, error: redact(message) });
    jsonError(res, 401, 'invalid_token', message, mcpReauthUrl(config, server.id));
    return;
  }

  let target: URL;
  try {
    target = new URL(serverUrl);
    if (url.search) target.search = url.search;
  } catch (error) {
    jsonError(res, 502, 'server_error', `адрес MCP сломан: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const method = req.method ?? 'GET';
  // Клиент (pi) мог отвалиться по своему таймауту: не держим запрос к MCP вечно.
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    let upstream = await forward(
      target,
      method,
      requestHeaders(req, oauth.accessToken ?? '', target, body.length),
      body,
      controller.signal,
    );
    // Токен мог протухнуть между проверкой и запросом или сервер его уже не
    // признаёт: обновляем принудительно и повторяем ровно один раз.
    if (upstream.statusCode === 401) {
      upstream.resume();
      upstream.destroy();
      try {
        oauth = await freshOAuthForServer(config, found.userId, server.id, { force: true });
        upstream = await forward(
          target,
          method,
          requestHeaders(req, oauth.accessToken ?? '', target, body.length),
          body,
          controller.signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('MCP proxy: повтор после 401 не вышел', {
          user: found.userId,
          server: server.id,
          error: redact(message),
        });
        jsonError(res, 401, 'invalid_token', message, mcpReauthUrl(config, server.id));
        return;
      }
    }
    // Повтор не помог — тоже отдаём нашу ошибку со ссылкой, а не сырое тело
    // сервера: человеку нужен вход, а не текст про bearer token.
    if (upstream.statusCode === 401) {
      const detail = await responseText(upstream);
      jsonError(
        res,
        401,
        'invalid_token',
        detail.trim() || 'MCP не принял токен — нужен повторный вход',
        mcpReauthUrl(config, server.id),
      );
      return;
    }
    pipeResponse(res, upstream);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('MCP proxy: запрос к серверу не вышел', { user: found.userId, server: server.id, error: redact(message) });
    jsonError(res, 502, 'server_error', message);
  }
}
