// HTTP-вход роутера: GET/POST /search.
//
// Один маршрут, один токен (тот же, что у /v1) и один ответ: кто ответил, что
// нашёл и кого пришлось обойти. Ошибки — обычным для сервиса телом errorBody,
// чтобы клиент не разбирал два разных формата.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IcarusConfig } from '../config.ts';
import { errorBody } from '../http/sse.ts';
import { readJsonBody } from '../http/openai.ts';
import { log } from '../log.ts';
import { routeSearch } from './router.ts';

export type SearchHttpOptions = {
  fetch?: typeof fetch;
  now?: () => number;
};

/** Пределы как у инструмента web_search: больше десяти ссылок агенту не нужно. */
const MAX_LIMIT = 10;

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

function clampLimit(raw: unknown): number {
  const value = Number(raw ?? 5);
  if (!Number.isFinite(value)) return 5;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

async function readRequest(req: IncomingMessage, url: URL): Promise<{ query: string; limit: unknown }> {
  const fromUrl = url.searchParams.get('limit');
  if (req.method === 'GET') {
    return { query: (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim(), limit: fromUrl };
  }
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const value = body.query ?? body.q;
  return {
    query: typeof value === 'string' ? value.trim() : '',
    limit: body.limit ?? fromUrl,
  };
}

/**
 * POST /search {query, limit} или GET /search?q=...&limit=...
 *
 * 200 — кто-то ответил (пустая выдача — тоже ответ);
 * 400 — нет запроса; 401 — чужой токен;
 * 502 — все настроенные провайдеры отказали; 503 — все в карантине или нет ключей.
 */
export async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: IcarusConfig,
  options: SearchHttpOptions = {},
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    json(res, 405, errorBody(`поиск не умеет ${req.method}: нужен GET или POST`, 'invalid_request_error'));
    return;
  }

  if (bearer(req) !== config.apiKey) {
    json(res, 401, errorBody('неверный токен', 'authentication_error'));
    return;
  }

  let query: string;
  let limit: number;
  try {
    const parsed = await readRequest(req, url);
    query = parsed.query;
    limit = clampLimit(parsed.limit);
  } catch (error) {
    json(res, 400, errorBody(`не разобрал запрос: ${error instanceof Error ? error.message : String(error)}`, 'invalid_request_error'));
    return;
  }
  if (query === '') {
    json(res, 400, errorBody('пустой запрос: нужен q (GET) или query (POST)', 'invalid_request_error'));
    return;
  }

  try {
    const result = await routeSearch(config, query, limit, { fetch: options.fetch, now: options.now });
    if (result.ok) {
      res.setHeader('x-search-provider', result.provider);
      json(res, 200, {
        query,
        provider: result.provider,
        current: result.current,
        results: result.results,
        ...(result.tried.length > 0 ? { tried: result.tried } : {}),
      });
      return;
    }

    const message =
      result.reason === 'no-keys'
        ? 'поиск не настроен: нет ни одного ключа провайдера'
        : result.reason === 'all-banned'
          ? 'все провайдеры в карантине'
          : 'ни один провайдер не ответил';
    const status = result.reason === 'all-failed' ? 502 : 503;
    if (result.retryAt) res.setHeader('retry-after', String(Math.max(1, Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1000))));
    json(res, status, {
      ...errorBody(message, result.reason === 'all-failed' ? 'server_error' : 'unavailable'),
      tried: result.tried,
      current: result.current,
      retryAt: result.retryAt,
    });
  } catch (error) {
    log.error('поиск упал целиком', { error: String(error) });
    json(res, 500, errorBody('поиск сломался', 'server_error'));
  }
}
