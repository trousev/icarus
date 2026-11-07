// HTTP-вход роутера: GET/POST /search.
//
// Изнутри docker-сети токен не нужен: контейнер pi ходит сюда напрямую. Снаружи
// (если порт случайно оказался наружу) — только с обычным токеном сервиса.
// Ошибки — обычным для сервиса телом errorBody, чтобы клиент не разбирал два
// разных формата.
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

/**
 * Частный адрес: петля, docker-сеть или домашняя локалка.
 *
 * Токен для /search не нужен, пока запрос идёт изнутри — контейнер pi ходит в
 * сервис по docker-сети. Но порт сервиса может случайно оказаться наружу,
 * поэтому с публичного адреса токен всё-таки спрашиваем: тогда утечка порта
 * не превращается в бесплатный доступ к квотам поисковиков.
 */
export function isInternalAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') return false;
  // Node отдаёт IPv4 поверх IPv6 как ::ffff:172.18.0.2 — снимаем префикс.
  const value = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const lower = value.toLowerCase();
  if (lower === '::1') return true;
  // fc00::/7 (unique local) и fe80::/10 (link-local).
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;

  const octets = value.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  if (first === 127 || first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 169 && second === 254) return true;
  return false;
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
 * 400 — нет запроса; 401 — чужой токен снаружи;
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

  // Токен присылают снаружи; изнутри сети он не нужен вовсе (см. isInternalAddress).
  const token = bearer(req);
  if (token !== '') {
    if (token !== config.apiKey) {
      json(res, 401, errorBody('неверный токен', 'authentication_error'));
      return;
    }
  } else if (!isInternalAddress(req.socket.remoteAddress)) {
    json(res, 401, errorBody('нужен токен: запрос пришёл не из внутренней сети', 'authentication_error'));
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
