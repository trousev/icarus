// Page extraction: only those providers that have a real fetch API.
//
// Brave and Serpstack don't know how, Firecrawl and SerpApi are deliberately not connected:
// Firecrawl is expensive in credits, and SerpApi eats the same 250 as search and
// respects robots.txt. The capable ones: Cloudflare Browser Run, Exa, Tavily, Linkup,
// You.com. Cloudflare is the cheapest of all (browser time) and therefore «sticky»:
// as long as it's not banned, it's always current.
import {
  SearchFailure,
  classifyFailure,
  type FailureKind,
  type FetchProvider,
  type FetchResult,
  type ProviderId,
  type SearchProviderId,
} from './types.ts';
import { RATING } from './router.ts';
import { requestJson } from './request.ts';

/** How many characters of the page we give to the model: more won't fit anyway. */
export const FETCH_MAX_CHARS = 20_000;

/** Which providers can extract pages (Firecrawl and SerpApi cannot). */
const FETCH_CAPABLE: readonly SearchProviderId[] = ['exa', 'tavily', 'linkup', 'you'];

/**
 * Fetch rating — the reverse of the search rating, but Cloudflare is always first.
 *
 * It pays for browser time, not for pages, so it's more profitable than all; as long as
 * it's not quarantined, fetch makes it current by force (see fetch-router).
 * After that comes the reverse of the search order: Linkup and You.com first, while Exa and
 * Tavily are saved for search.
 */
export const FETCH_RATING: readonly ProviderId[] = [
  'cloudflare',
  ...[...FETCH_CAPABLE].sort((a, b) => RATING.indexOf(b) - RATING.indexOf(a)),
];

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
 * A page failure is not a broken key: 404, robots, paywall, «PDF too large».
 * Such responses don't ban the provider, they just pass the turn to the next one.
 */
export function classifyFetchStatus(status: number, body: string): FailureKind {
  if (status === 400 || status === 404 || status === 410 || status === 422) return 'page';
  return classifyFailure(status, body);
}

/**
 * Cloudflare returns the daily browser-time limit as a 429 with this text.
 * This is not «rate», but a quota: there's nothing to do until the next UTC day.
 */
function classifyCloudflare(status: number, body: string): FailureKind {
  if (status === 429 && /browser time limit/i.test(body)) return 'credits';
  return classifyFetchStatus(status, body);
}

function pageFailure(detail: string): SearchFailure {
  return new SearchFailure('page', detail);
}

// --- parsing responses -------------------------------------------------------

/** Tavily: results[].raw_content; failed URLs are in failed_results. */
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

/** Tavily failure reason: a per-URL error, not the HTTP status. */
export function tavilyFailureDetail(payload: unknown): string {
  const failed = asRecord(asList(asRecord(payload)?.failed_results)[0]);
  return asText(failed?.error) ?? 'страница не отдалась';
}

/** Exa: results[].text; the status of each page is in statuses[]. */
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

/** Linkup: markdown is a required field of the /v1/fetch response. */
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

/** You.com: an array of objects, one per URL. */
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

/** Cloudflare Browser Run: { success, result } — markdown is returned right away. */
export function parseCloudflareMarkdown(
  payload: unknown,
  maxChars: number,
  requestedUrl: string,
): FetchResult | null {
  const root = asRecord(payload);
  const text = asText(root?.result);
  if (!root || root.success === false || !text) return null;
  return { url: requestedUrl, text: truncate(text, maxChars) };
}

/** Cloudflare failure reason: errors[].message, not the HTTP status. */
export function cloudflareFailureDetail(payload: unknown): string {
  const error = asRecord(asList(asRecord(payload)?.errors)[0]);
  return asText(error?.message) ?? 'Cloudflare не отдал markdown';
}

// --- providers ---------------------------------------------------------------

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

const cloudflare: FetchProvider = {
  id: 'cloudflare',
  label: 'Cloudflare Browser Run',
  keyNames: ['CLOUDFLARE_API_TOKEN'],
  requires: ['CLOUDFLARE_ACCOUNT_ID'],
  async fetch(url, ctx) {
    const account = ctx.secret('CLOUDFLARE_ACCOUNT_ID');
    if (!account) throw new SearchFailure('http', 'не задан CLOUDFLARE_ACCOUNT_ID');
    const payload = await requestJson(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/browser-run/markdown`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        // Without gotoOptions: default loading is cheaper in browser time, and
        // a heavy SPA is fine with the page having time to render.
        body: JSON.stringify({ url }),
      },
      ctx,
      classifyCloudflare,
    );
    const result = parseCloudflareMarkdown(payload, ctx.maxChars, url);
    if (!result) throw pageFailure(cloudflareFailureDetail(payload));
    return result;
  },
};

/** Only those capable of fetch — by the router rating. */
export const FETCH_PROVIDERS: Record<string, FetchProvider> = { cloudflare, exa, tavily, linkup, you };
