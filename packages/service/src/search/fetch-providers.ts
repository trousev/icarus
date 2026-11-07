// Извлечение страниц: только те провайдеры, у которых есть настоящий fetch API.
//
// Brave и Serpstack не умеют, Firecrawl и SerpApi намеренно не подключены:
// Firecrawl дорогой по кредитам, а SerpApi ест те же 250, что и поиск, и
// соблюдает robots.txt. Остаются четыре: Exa, Tavily, Linkup, You.com.
import {
  SearchFailure,
  classifyFailure,
  type FailureKind,
  type FetchProvider,
  type FetchResult,
  type ProviderId,
} from './types.ts';
import { RATING } from './router.ts';
import { requestJson } from './request.ts';

/** Сколько знаков страницы отдаём модели: больше всё равно не влезет. */
export const FETCH_MAX_CHARS = 20_000;

/** Кто из провайдеров умеет извлекать страницы (Firecrawl и SerpApi — нет). */
const FETCH_CAPABLE: readonly ProviderId[] = ['exa', 'tavily', 'linkup', 'you'];

/**
 * Рейтинг извлечения — обратный рейтингу поиска.
 *
 * Страницы гоняем через тех, кем не жалко потратить квоту (Linkup, You.com),
 * а Exa и Tavily бережём для поиска, где они полезнее. Порядок выводится из
 * RATING, чтобы обращения не разъезжались при правке поискового рейтинга.
 */
export const FETCH_RATING: readonly ProviderId[] = [...FETCH_CAPABLE].sort(
  (a, b) => RATING.indexOf(b) - RATING.indexOf(a),
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (обрезано)` : text;
}

/**
 * Отказ страницы — это не поломка ключа: 404, robots, пейволл, «слишком большой
 * PDF». Такие ответы не банят провайдера, а просто передают ход следующему.
 */
export function classifyFetchStatus(status: number, body: string): FailureKind {
  if (status === 400 || status === 404 || status === 410 || status === 422) return 'page';
  return classifyFailure(status, body);
}

function pageFailure(detail: string): SearchFailure {
  return new SearchFailure('page', detail);
}

// --- разбор ответов ----------------------------------------------------------

/** Tavily: results[].raw_content; неудачные URL лежат в failed_results. */
export function parseTavilyExtract(payload: unknown, maxChars: number): FetchResult | null {
  const root = asRecord(payload);
  const first = asRecord(asList(root?.results)[0]);
  const text = asText(first?.raw_content);
  if (!first || !text) return null;
  return {
    url: asText(first.url) ?? '',
    ...(asText(first.title) ? { title: String(first.title) } : {}),
    text: truncate(text, maxChars),
  };
}

/** Причина отказа Tavily: per-URL error, а не HTTP-статус. */
export function tavilyFailureDetail(payload: unknown): string {
  const failed = asRecord(asList(asRecord(payload)?.failed_results)[0]);
  return asText(failed?.error) ?? 'страница не отдалась';
}

/** Exa: results[].text; статус каждой страницы — в statuses[]. */
export function parseExaContents(payload: unknown, maxChars: number): FetchResult | null {
  const root = asRecord(payload);
  const first = asRecord(asList(root?.results)[0]);
  const text = asText(first?.text);
  if (!first || !text) return null;
  return {
    url: asText(first.url) ?? asText(first.id) ?? '',
    ...(asText(first.title) ? { title: String(first.title) } : {}),
    text: truncate(text, maxChars),
  };
}

/** Linkup: markdown — обязательное поле ответа /v1/fetch. */
export function parseLinkupFetch(payload: unknown, maxChars: number, requestedUrl: string): FetchResult | null {
  const root = asRecord(payload);
  const text = asText(root?.markdown);
  if (!text) return null;
  return {
    url: requestedUrl,
    ...(asText(root?.title) ? { title: String(root?.title) } : {}),
    text: truncate(text, maxChars),
  };
}

/** You.com: массив объектов, по одному на URL. */
export function parseYouContents(payload: unknown, maxChars: number): FetchResult | null {
  const first = asRecord(asList(payload)[0]);
  const text = asText(first?.markdown);
  if (!first || !text) return null;
  return {
    url: asText(first.url) ?? '',
    ...(asText(first.title) ? { title: String(first.title) } : {}),
    text: truncate(text, maxChars),
  };
}

// --- провайдеры --------------------------------------------------------------

const exa: FetchProvider = {
  id: 'exa',
  label: 'Exa Contents',
  keyNames: ['EXA_API_KEY'],
  async fetch(url, ctx) {
    const payload = await requestJson(
      'https://api.exa.ai/contents',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        body: JSON.stringify({ ids: [url], text: { maxCharacters: ctx.maxChars } }),
      },
      ctx,
      classifyFetchStatus,
    );
    const result = parseExaContents(payload, ctx.maxChars);
    if (!result) {
      const status = asRecord(asList(asRecord(payload)?.statuses)[0]);
      throw pageFailure(asText(status?.status) === 'error' ? 'Exa не смогла прочитать страницу' : 'страница без текста');
    }
    return result;
  },
};

const tavily: FetchProvider = {
  id: 'tavily',
  label: 'Tavily Extract',
  keyNames: ['TAVILY_API_KEY'],
  async fetch(url, ctx) {
    const payload = await requestJson(
      'https://api.tavily.com/extract',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        body: JSON.stringify({ urls: [url], format: 'markdown', extract_depth: 'basic' }),
      },
      ctx,
      classifyFetchStatus,
    );
    const result = parseTavilyExtract(payload, ctx.maxChars);
    if (!result) throw pageFailure(tavilyFailureDetail(payload));
    return result;
  },
};

const linkup: FetchProvider = {
  id: 'linkup',
  label: 'Linkup Fetch',
  keyNames: ['LINKUP_API_KEY'],
  async fetch(url, ctx) {
    const payload = await requestJson(
      'https://api.linkup.so/v1/fetch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        body: JSON.stringify({ url, mode: 'standard', renderJs: false }),
      },
      ctx,
      classifyFetchStatus,
    );
    const result = parseLinkupFetch(payload, ctx.maxChars, url);
    if (!result) throw pageFailure('страница без текста');
    return result;
  },
};

const you: FetchProvider = {
  id: 'you',
  label: 'You.com Contents',
  keyNames: ['YOU_API_KEY', 'YDC_API_KEY'],
  async fetch(url, ctx) {
    const payload = await requestJson(
      'https://ydc-index.io/v1/contents',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': ctx.key },
        body: JSON.stringify({ urls: [url], formats: ['markdown'] }),
      },
      ctx,
      classifyFetchStatus,
    );
    const result = parseYouContents(payload, ctx.maxChars);
    if (!result) throw pageFailure('страница без текста');
    return result;
  },
};

/** Только умеющие fetch — по рейтингу роутера. */
export const FETCH_PROVIDERS: Record<string, FetchProvider> = { exa, tavily, linkup, you };
