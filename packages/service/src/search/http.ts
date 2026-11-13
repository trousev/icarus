// HTTP entrance of the router: GET/POST /search and /fetch.
//
// From inside the docker network no token is needed: the pi container goes here directly. From outside
// (if the port accidentally ended up exposed) — only with the service's usual token.
// Errors — with the service's usual errorBody body, so the client doesn't parse two
// different formats.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IcarusConfig } from '../config.ts';
import { errorBody } from '../http/sse.ts';
import { readJsonBody } from '../http/openai.ts';
import { log } from '../log.ts';
import { FETCH_MAX_CHARS } from './fetch-providers.ts';
import { routeFetch } from './fetch-router.ts';
import { routeSearch } from './router.ts';

export type SearchHttpOptions = {
  fetch?: typeof fetch;
  now?: () => number;
};

/** Limits as in the web_search tool: the agent doesn't need more than ten links. */
const MAX_LIMIT = 10;
const MAX_FETCH_CHARS = 50_000;

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
 * A private address: loopback, docker network, or home LAN.
 *
 * The token for /search is not needed while the request comes from inside — the pi container goes to
 * the service over the docker network. But the service port may accidentally end up exposed,
 * so from a public address we still ask for the token: then a port leak
 * doesn't turn into free access to the search engines' quotas.
 */
export function isInternalAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') return false;
  // Node serves IPv4 over IPv6 as ::ffff:172.18.0.2 — we strip the prefix.
  const value = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const lower = value.toLowerCase();
  if (lower === '::1') return true;
  // fc00::/7 (unique local) and fe80::/10 (link-local).
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

function clampChars(raw: unknown): number {
  const value = Number(raw ?? FETCH_MAX_CHARS);
  if (!Number.isFinite(value)) return FETCH_MAX_CHARS;
  return Math.min(Math.max(Math.trunc(value), 1_000), MAX_FETCH_CHARS);
}

/** Result: empty — allow, a string — reason for denial. */
function authorize(req: IncomingMessage, config: IcarusConfig): string | null {
  const token = bearer(req);
  if (token !== '') return token === config.apiKey ? null : 'неверный токен';
  return isInternalAddress(req.socket.remoteAddress) ? null : 'нужен токен: запрос пришёл не из внутренней сети';
}

/**
 * An address that must not be given to a provider: loopback, LAN, cloud metadata.
 *
 * Providers download the page on their side, so they can't reach our network, but
 * a request "read http://192.168.1.1" still looks like an error, not like
 * work. At the same time it's protection if a local fallback ever appears.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host === 'metadata' || host === 'metadata.google.internal' || host === 'instance-data') return true;
  if (host === '0.0.0.0' || host === '::') return true;
  return isInternalAddress(host);
}

/** Check the URL before going to the provider: only http(s) and not into the network. */
export function targetUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'нужен обычный http(s)-адрес' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'умею только http и https' };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { error: 'внутренние адреса не открываем' };
  }
  return { url: parsed.toString() };
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
 * POST /search {query, limit} or GET /search?q=...&limit=...
 *
 * 200 — someone answered (an empty result is also an answer);
 * 400 — no query; 401 — a foreign token from outside;
 * 502 — all configured providers failed; 503 — all are quarantined or there are no keys.
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

  // The token is sent from outside; from inside the network it's not needed at all (see isInternalAddress).
  const denied = authorize(req, config);
  if (denied !== null) {
    json(res, 401, errorBody(denied, 'authentication_error'));
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

async function readFetchRequest(req: IncomingMessage, url: URL): Promise<{ url: string; maxChars: number }> {
  const fromUrl = url.searchParams.get('maxChars');
  if (req.method === 'GET') {
    return { url: (url.searchParams.get('url') ?? '').trim(), maxChars: clampChars(fromUrl) };
  }
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const value = body.url;
  return {
    url: typeof value === 'string' ? value.trim() : '',
    maxChars: clampChars(body.maxChars ?? fromUrl),
  };
}

/**
 * POST /fetch {url, maxChars?} or GET /fetch?url=...
 *
 * 200 — the page arrived; 400 — wrong address; 401 — a foreign token from outside;
 * 502 — all providers failed; 503 — no keys or all are quarantined.
 */
export async function handleFetch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: IcarusConfig,
  options: SearchHttpOptions = {},
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    json(res, 405, errorBody(`извлечение не умеет ${req.method}: нужен GET или POST`, 'invalid_request_error'));
    return;
  }

  const denied = authorize(req, config);
  if (denied !== null) {
    json(res, 401, errorBody(denied, 'authentication_error'));
    return;
  }

  let requested: string;
  let maxChars: number;
  try {
    const parsed = await readFetchRequest(req, url);
    requested = parsed.url;
    maxChars = parsed.maxChars;
  } catch (error) {
    json(res, 400, errorBody(`не разобрал запрос: ${error instanceof Error ? error.message : String(error)}`, 'invalid_request_error'));
    return;
  }
  if (requested === '') {
    json(res, 400, errorBody('пустой адрес: нужен url (GET) или url в теле (POST)', 'invalid_request_error'));
    return;
  }
  const target = targetUrl(requested);
  if ('error' in target) {
    json(res, 400, errorBody(target.error, 'invalid_request_error'));
    return;
  }

  try {
    const result = await routeFetch(config, target.url, {
      fetch: options.fetch,
      now: options.now,
      maxChars,
    });
    if (result.ok) {
      res.setHeader('x-fetch-provider', result.provider);
      json(res, 200, {
        url: target.url,
        finalUrl: result.result.url || target.url,
        ...(result.result.title ? { title: result.result.title } : {}),
        provider: result.provider,
        current: result.current,
        text: result.result.text,
        ...(result.tried.length > 0 ? { tried: result.tried } : {}),
      });
      return;
    }

    const message =
      result.reason === 'no-keys'
        ? 'извлечение страниц не настроено: нет ключа ни у Exa, Tavily, Linkup или You.com'
        : result.reason === 'all-banned'
          ? 'все провайдеры извлечения в карантине'
          : 'ни один провайдер не смог прочитать страницу';
    const status = result.reason === 'all-failed' ? 502 : 503;
    if (result.retryAt) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1000))));
    }
    json(res, status, {
      ...errorBody(message, result.reason === 'all-failed' ? 'server_error' : 'unavailable'),
      tried: result.tried,
      current: result.current,
      retryAt: result.retryAt,
    });
  } catch (error) {
    log.error('извлечение страницы упало целиком', { error: String(error) });
    json(res, 500, errorBody('извлечение сломалось', 'server_error'));
  }
}
