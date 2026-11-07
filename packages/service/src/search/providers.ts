// Адаптеры поисковиков: как позвать, как разобрать ответ и чем он пахнет при отказе.
//
// Разбор выдачи вынесен в чистые функции (parse*): их проверяют тесты на реальных
// формах ответов, не поднимая ни сервера, ни сети. Сам запрос — тонкий слой поверх
// fetch: ключ, заголовки, тело, таймаут приходит снаружи.
import {
  SearchFailure,
  classifyFailure,
  type ProviderContext,
  type ProviderId,
  type SearchProvider,
  type SearchResult,
} from './types.ts';

/** Выдержка в списке результатов — одна строка: переводы строк только путают. */
const SNIPPET_LIMIT = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function squash(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > SNIPPET_LIMIT ? `${oneLine.slice(0, SNIPPET_LIMIT - 1)}…` : oneLine;
}

/** Результат из полей, в которых провайдеры расходятся: title/link/snippet/description. */
function resultOf(row: unknown, urlKeys: string[], titleKeys: string[], textKeys: string[]): SearchResult | null {
  const item = asRecord(row);
  if (!item) return null;
  const url = urlKeys.map((key) => asText(item[key])).find((value) => value !== null);
  const title = titleKeys.map((key) => asText(item[key])).find((value) => value !== null);
  if (!url || !title) return null;
  const text = textKeys.map((key) => asText(item[key])).find((value) => value !== null);
  return { title, url, ...(text ? { snippet: squash(text) } : {}) };
}

/**
 * Общий HTTP-вызов: сеть, статус, JSON.
 *
 * Отказ провайдера — это SearchFailure с телом ответа: по нему router решает,
 * банить на пять минут или на сутки, а панель показывает причину человеку.
 */
async function requestJson(url: string, init: RequestInit, ctx: ProviderContext): Promise<unknown> {
  let response: Response;
  try {
    response = await ctx.fetch(url, { ...init, signal: ctx.signal });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SearchFailure('timeout', 'провайдер не ответил вовремя');
    }
    throw new SearchFailure('network', error instanceof Error ? error.message : String(error));
  }

  let body = '';
  try {
    body = await response.text();
  } catch {
    // Тело не дочиталось — статус уже всё сказал.
  }
  if (!response.ok) {
    throw new SearchFailure(classifyFailure(response.status, body), `HTTP ${response.status}`, {
      status: response.status,
      body: body.slice(0, 400),
    });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SearchFailure('http', 'ответ провайдера не разобрался как JSON');
  }
}

// --- разбор выдачи ------------------------------------------------------------

/** SerpApi: organic_results[].link/snippet. */
export function parseSerpApi(payload: unknown, limit = 6): SearchResult[] {
  return asList(asRecord(payload)?.organic_results)
    .map((row) => resultOf(row, ['link', 'url'], ['title'], ['snippet']))
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

/** Serpstack (APILayer): organic_results[].url/description. */
export function parseSerpStack(payload: unknown, limit = 6): SearchResult[] {
  return asList(asRecord(payload)?.organic_results)
    .map((row) => resultOf(row, ['url', 'link'], ['title'], ['description', 'snippet']))
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

/** Brave: web.results[].description — это HTML с подсветкой, чистим до текста. */
export function parseBrave(payload: unknown, limit = 6): SearchResult[] {
  const rows = asList(asRecord(asRecord(payload)?.web)?.results);
  return rows
    .map((row) => resultOf(row, ['url'], ['title'], ['description']))
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

/** Exa: results[].highlights[] — выдержки, релевантные запросу; иначе просто text. */
export function parseExa(payload: unknown, limit = 6): SearchResult[] {
  return asList(asRecord(payload)?.results)
    .map((row) => {
      const item = asRecord(row);
      if (!item) return null;
      const url = asText(item.url) ?? asText(item.id);
      const title = asText(item.title);
      if (!url || !title) return null;
      const highlight = asList(item.highlights).map(asText).find((value) => value !== null);
      const text = highlight ?? asText(item.text) ?? undefined;
      return { title, url, ...(text ? { snippet: squash(text) } : {}) };
    })
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

/** Tavily: results[].content. */
export function parseTavily(payload: unknown, limit = 6): SearchResult[] {
  return asList(asRecord(payload)?.results)
    .map((row) => resultOf(row, ['url'], ['title'], ['content']))
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

/** Firecrawl: v1 отдаёт data[], v2 — data.web[]. Понимаем оба. */
export function parseFirecrawl(payload: unknown, limit = 6): SearchResult[] {
  const data = asRecord(payload)?.data;
  const rows = asList(data).length > 0 ? asList(data) : asList(asRecord(data)?.web);
  return rows
    .map((row) => resultOf(row, ['url'], ['title'], ['description']))
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

/** You.com: results.web[].description или первая snippets[]. */
export function parseYou(payload: unknown, limit = 6): SearchResult[] {
  const rows = asList(asRecord(asRecord(payload)?.results)?.web);
  return rows
    .map((row) => {
      const item = asRecord(row);
      if (!item) return null;
      const result = resultOf(item, ['url'], ['title'], ['description']);
      if (!result || result.snippet) return result;
      const snippet = asList(item.snippets).map(asText).find((value) => value !== null);
      return snippet ? { ...result, snippet: squash(snippet) } : result;
    })
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

/** Linkup: results[].name/content. */
export function parseLinkup(payload: unknown, limit = 6): SearchResult[] {
  return asList(asRecord(payload)?.results)
    .map((row) => resultOf(row, ['url'], ['name'], ['content']))
    .filter((item): item is SearchResult => item !== null)
    .slice(0, limit);
}

// --- провайдеры --------------------------------------------------------------

const serpapi: SearchProvider = {
  id: 'serpapi',
  label: 'SerpApi · выдача Google',
  keyNames: ['SERPAPI_API_KEY'],
  async search(query, limit, ctx) {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(limit));
    url.searchParams.set('api_key', ctx.key);
    url.searchParams.set('output', 'json');
    const payload = await requestJson(url.toString(), { headers: { accept: 'application/json' } }, ctx);
    return parseSerpApi(payload, limit);
  },
};

const serpstack: SearchProvider = {
  id: 'serpstack',
  label: 'Serpstack · выдача Google',
  keyNames: ['SERPSTACK_API_KEY'],
  async search(query, limit, ctx) {
    const url = new URL('https://api.serpstack.com/search');
    url.searchParams.set('access_key', ctx.key);
    url.searchParams.set('query', query);
    url.searchParams.set('num', String(limit));
    const payload = await requestJson(url.toString(), { headers: { accept: 'application/json' } }, ctx);
    return parseSerpStack(payload, limit);
  },
};

const brave: SearchProvider = {
  id: 'brave',
  label: 'Brave Search',
  keyNames: ['BRAVE_API_KEY'],
  async search(query, limit, ctx) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const payload = await requestJson(
      url.toString(),
      { headers: { accept: 'application/json', 'x-subscription-token': ctx.key } },
      ctx,
    );
    return parseBrave(payload, limit);
  },
};

const exa: SearchProvider = {
  id: 'exa',
  label: 'Exa · семантический поиск',
  keyNames: ['EXA_API_KEY'],
  async search(query, limit, ctx) {
    const payload = await requestJson(
      'https://api.exa.ai/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        // highlights — выдержки под запрос; по цене входят в сам поиск.
        body: JSON.stringify({ query, numResults: limit, type: 'auto', contents: { highlights: true } }),
      },
      ctx,
    );
    return parseExa(payload, limit);
  },
};

const tavily: SearchProvider = {
  id: 'tavily',
  label: 'Tavily',
  keyNames: ['TAVILY_API_KEY'],
  async search(query, limit, ctx) {
    const payload = await requestJson(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
      },
      ctx,
    );
    return parseTavily(payload, limit);
  },
};

const firecrawl: SearchProvider = {
  id: 'firecrawl',
  label: 'Firecrawl Search',
  keyNames: ['FIRECRAWL_API_KEY'],
  async search(query, limit, ctx) {
    // v1 отдаёт data[] с title/description/url; v2 кладёт то же в data.web[].
    const payload = await requestJson(
      'https://api.firecrawl.dev/v1/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        body: JSON.stringify({ query, limit }),
      },
      ctx,
    );
    return parseFirecrawl(payload, limit);
  },
};

const you: SearchProvider = {
  id: 'you',
  label: 'You.com',
  keyNames: ['YOU_API_KEY', 'YDC_API_KEY'],
  async search(query, limit, ctx) {
    const payload = await requestJson(
      'https://ydc-index.io/v1/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': ctx.key },
        body: JSON.stringify({ query, count: limit }),
      },
      ctx,
    );
    return parseYou(payload, limit);
  },
};

const linkup: SearchProvider = {
  id: 'linkup',
  label: 'Linkup',
  keyNames: ['LINKUP_API_KEY'],
  async search(query, limit, ctx) {
    const payload = await requestJson(
      'https://api.linkup.so/v1/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${ctx.key}` },
        body: JSON.stringify({ q: query, depth: 'standard', outputType: 'searchResults', maxResults: limit }),
      },
      ctx,
    );
    return parseLinkup(payload, limit);
  },
};

/**
 * Все провайдеры по id. Рейтинг (в каком порядке пробовать) живёт в router.ts:
 * здесь только сами адаптеры, чтобы рейтинг можно было менять, не трогая запросы.
 */
export const PROVIDERS: Record<ProviderId, SearchProvider> = {
  serpapi,
  serpstack,
  brave,
  exa,
  tavily,
  firecrawl,
  you,
  linkup,
};
