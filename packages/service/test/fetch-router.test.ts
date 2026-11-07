// Извлечение страниц: свой текущий, отказы страниц, общие с поиском кредиты.
//
// Сеть и часы подменяются: пятиминутный карантин проверяется мгновенно.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { makeConfig } from './fixtures.ts';
import type { IcarusConfig } from '../src/config.ts';
import {
  classifyFetchStatus,
  parseCloudflareMarkdown,
  parseExaContents,
  parseLinkupFetch,
  parseTavilyExtract,
  parseYouContents,
  FETCH_RATING,
} from '../src/search/fetch-providers.ts';
import { checkFetchProvider, providerForKey, searchStatus } from '../src/search/panel.ts';
import { routeFetch } from '../src/search/fetch-router.ts';
import { routeSearch } from '../src/search/router.ts';
import { mutateRouterState, readRouterState, stateFile } from '../src/search/state.ts';
import type { ProviderId } from '../src/search/types.ts';

const KEY_ENV: Record<string, string> = {
  serpapi: 'SERPAPI_API_KEY',
  exa: 'EXA_API_KEY',
  tavily: 'TAVILY_API_KEY',
  linkup: 'LINKUP_API_KEY',
  you: 'YOU_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
};

const HOSTS: Record<string, ProviderId> = {
  'serpapi.com': 'serpapi',
  'api.exa.ai': 'exa',
  'api.tavily.com': 'tavily',
  'api.linkup.so': 'linkup',
  'ydc-index.io': 'you',
  'api.cloudflare.com': 'cloudflare',
};

function configWith(keys: Record<string, string>): IcarusConfig {
  const secretEnv: Record<string, string> = {};
  for (const [id, value] of Object.entries(keys)) {
    if (value !== undefined) secretEnv[KEY_ENV[id] as string] = value;
  }
  return makeConfig({ secretEnv });
}

/** Cloudflare без account id не готов — добавляем его отдельно. */
function configWithCloudflare(extra: Record<string, string> = {}): IcarusConfig {
  const config = configWith({ cloudflare: 'cf-token', ...extra });
  config.secretEnv = { ...(config.secretEnv ?? {}), CLOUDFLARE_ACCOUNT_ID: 'acc-1' };
  return config;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PAGES: Record<string, unknown> = {
  exa: { results: [{ url: 'https://example.com', title: 'Пример', text: 'текст от Exa' }] },
  tavily: { results: [{ url: 'https://example.com', raw_content: 'текст от Tavily' }] },
  linkup: { markdown: 'текст от Linkup' },
  you: [{ url: 'https://example.com', title: 'Пример', markdown: 'текст от You.com' }],
  cloudflare: { success: true, result: 'текст от Cloudflare' },
};

type Handler = () => Response | Promise<Response>;

function fakeFetch(handlers: Partial<Record<ProviderId, Handler>>): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const id = HOSTS[url.hostname];
    const handler = id === undefined ? undefined : handlers[id];
    if (handler === undefined) throw new Error(`тест не ждал запроса к ${url.hostname}`);
    return handler();
  };
  return impl as unknown as typeof fetch;
}

function okAll(): typeof fetch {
  return fakeFetch({
    cloudflare: () => json(PAGES.cloudflare),
    exa: () => json(PAGES.exa),
    tavily: () => json(PAGES.tavily),
    linkup: () => json(PAGES.linkup),
    you: () => json(PAGES.you),
  });
}

function clockAt(start = Date.parse('2026-11-07T12:00:00Z')) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

// --- разбор ответов ----------------------------------------------------------

test('каждый fetch-адаптер разбирает свой ответ', () => {
  assert.deepEqual(parseExaContents(PAGES.exa, 100), {
    url: 'https://example.com',
    title: 'Пример',
    text: 'текст от Exa',
  });
  assert.deepEqual(parseTavilyExtract(PAGES.tavily, 100), { url: 'https://example.com', text: 'текст от Tavily' });
  assert.deepEqual(parseLinkupFetch(PAGES.linkup, 100, 'https://example.com'), {
    url: 'https://example.com',
    text: 'текст от Linkup',
  });
  assert.deepEqual(parseYouContents(PAGES.you, 100), {
    url: 'https://example.com',
    title: 'Пример',
    text: 'текст от You.com',
  });
  assert.deepEqual(parseCloudflareMarkdown(PAGES.cloudflare, 100, 'https://example.com'), {
    url: 'https://example.com',
    text: 'текст от Cloudflare',
  });
  assert.equal(parseExaContents({ results: [] }, 100), null);
  assert.equal(parseTavilyExtract({ results: [] }, 100), null);
  assert.equal(parseLinkupFetch({}, 100, 'https://example.com'), null);
  assert.equal(parseYouContents([], 100), null);
  assert.equal(parseCloudflareMarkdown({ success: false, errors: [] }, 100, 'https://example.com'), null);
});

test('длинная страница обрезается по maxChars', () => {
  const long = 'x'.repeat(500);
  const result = parseExaContents({ results: [{ url: 'https://e.dev', text: long }] }, 100);
  assert.ok(result?.text.startsWith('x'.repeat(100)));
  assert.match(result?.text ?? '', /обрезано/);
});

test('отказ страницы не путается с отказом ключа', () => {
  assert.equal(classifyFetchStatus(404, 'not found'), 'page');
  assert.equal(classifyFetchStatus(400, 'bad url'), 'page');
  assert.equal(classifyFetchStatus(402, 'payment'), 'credits');
  assert.equal(classifyFetchStatus(429, 'rate limit'), 'rate');
  assert.equal(classifyFetchStatus(500, 'boom'), 'http');
});

// --- роутер ------------------------------------------------------------------

test('рейтинг извлечения: Cloudflare первым, дальше обратный поисковому', () => {
  assert.deepEqual(FETCH_RATING, ['cloudflare', 'linkup', 'you', 'tavily', 'exa']);
  // Обратность остальных выводится из поискового рейтинга, а не задана списком.
  assert.deepEqual([...FETCH_RATING.slice(1)].reverse(), ['exa', 'tavily', 'you', 'linkup']);
});

test('без ключей — no-keys, а не поход в сеть', async () => {
  const config = configWith({});
  const result = await routeFetch(config, 'https://example.com', { fetch: fakeFetch({}) });
  assert.deepEqual(result, { ok: false, reason: 'no-keys', tried: [], current: null, retryAt: null });
});

test('текущий у извлечения свой и не трогает поисковый', async () => {
  const config = configWith({ linkup: 'l', exa: 'e' });
  const clock = clockAt();
  await mutateRouterState(stateFile(config), (state) => {
    state.current = 'exa';
  });

  const result = await routeFetch(config, 'https://example.com', { fetch: okAll(), now: clock.now });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.provider, 'linkup', 'страницы идут через слабейшего для поиска');

  const state = readRouterState(stateFile(config));
  assert.equal(state.current, 'exa', 'поисковый текущий не изменился');
  assert.equal(state.fetch?.current, 'linkup', 'у извлечения свой текущий');
});

test('Cloudflare сверхлипкий: пока не в бане, он всегда становится текущим', async () => {
  const config = configWithCloudflare({ exa: 'e' });
  const clock = clockAt();
  await mutateRouterState(stateFile(config), (state) => {
    state.fetch = { current: 'exa', providers: {} };
  });

  const result = await routeFetch(config, 'https://example.com', { fetch: okAll(), now: clock.now });
  assert.equal(result.ok && result.provider, 'cloudflare');
  assert.equal(readRouterState(stateFile(config)).fetch?.current, 'cloudflare', 'перетёр текущего');
});

test('в карантине Cloudflare уступает, а после разбана снова становится текущим', async () => {
  const config = configWithCloudflare({ exa: 'e' });
  const clock = clockAt();
  await mutateRouterState(stateFile(config), (state) => {
    state.fetch = {
      current: 'exa',
      providers: {
        cloudflare: {
          fails: 1,
          bannedUntil: new Date(clock.now() + 5 * 60_000).toISOString(),
          banReason: 'error',
          lastError: 'HTTP 500',
          lastErrorAt: null,
          broken: false,
          brokenAt: null,
        },
      },
    };
  });

  const first = await routeFetch(config, 'https://example.com', { fetch: okAll(), now: clock.now });
  assert.equal(first.ok && first.provider, 'exa', 'пока Cloudflare в бане — обычный порядок');

  clock.advance(5 * 60_000 + 1000);
  const second = await routeFetch(config, 'https://example.com', { fetch: okAll(), now: clock.now });
  assert.equal(second.ok && second.provider, 'cloudflare', 'разбан — и он снова липкий');
  assert.equal(readRouterState(stateFile(config)).fetch?.current, 'cloudflare');
});

test('без account id Cloudflare не считается настроенным и не банится', async () => {
  const config = configWith({ cloudflare: 'cf-token', exa: 'e' });
  const clock = clockAt();
  const fetch = fakeFetch({ exa: () => json(PAGES.exa) });

  const result = await routeFetch(config, 'https://example.com', { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'exa');
  const state = readRouterState(stateFile(config));
  assert.equal(state.fetch?.providers.cloudflare, undefined, 'провайдер просто пропущен');
});

test('дневной лимит Browser Run — сутки карантина, а не пять минут', async () => {
  const config = configWithCloudflare({ exa: 'e' });
  const clock = clockAt();
  const fetch = fakeFetch({
    cloudflare: () =>
      json({ success: false, errors: [{ message: 'Browser time limit exceeded for today' }] }, 429),
    exa: () => json(PAGES.exa),
  });

  const result = await routeFetch(config, 'https://example.com', { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'exa');
  const state = readRouterState(stateFile(config));
  const provider = state.fetch?.providers.cloudflare;
  assert.equal(provider?.banReason, 'credits');
  assert.equal(Date.parse(provider?.bannedUntil ?? ''), clock.now() + 24 * 60 * 60_000);
  assert.equal(state.providers.cloudflare, undefined, 'поисковых провайдеров это не касается');
});

test('правка любого секрета Cloudflare находит провайдера', () => {
  assert.equal(providerForKey('CLOUDFLARE_API_TOKEN'), 'cloudflare');
  assert.equal(providerForKey('CLOUDFLARE_ACCOUNT_ID'), 'cloudflare');
  assert.equal(providerForKey('YOU_API_KEY'), 'you');
  assert.equal(providerForKey('НЕТ_ТАКОГО'), null);
});

test('отказ провайдера — пять минут карантина и переход к следующему', async () => {
  const config = configWith({ linkup: 'l', exa: 'e' });
  const clock = clockAt();
  const fetch = fakeFetch({
    linkup: () => json({ error: 'boom' }, 500),
    exa: () => json(PAGES.exa),
  });

  const result = await routeFetch(config, 'https://example.com', { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'exa');
  assert.deepEqual(result.tried.map((item) => item.provider), ['linkup']);
  const state = readRouterState(stateFile(config));
  assert.equal(state.fetch?.providers.linkup?.banReason, 'error');
  assert.equal(state.fetch?.current, 'exa');
});

test('404 страницы не банит провайдера: это свойство URL, а не ключа', async () => {
  const config = configWith({ linkup: 'l', exa: 'e' });
  const clock = clockAt();
  const fetch = fakeFetch({
    linkup: () => json({ error: 'not found' }, 404),
    exa: () => json(PAGES.exa),
  });

  const result = await routeFetch(config, 'https://example.com/missing', { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'exa');
  const state = readRouterState(stateFile(config));
  assert.equal(state.fetch?.providers.linkup, undefined, 'у Linkup не появилось отказов');
});

test('402 банит и извлечение, и поиск: кредиты общие', async () => {
  const config = configWith({ linkup: 'l', exa: 'e' });
  const clock = clockAt();
  const fetch = fakeFetch({
    linkup: () => json({ error: 'Payment Required' }, 402),
    exa: () => json(PAGES.exa),
  });

  const result = await routeFetch(config, 'https://example.com', { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'exa');
  const state = readRouterState(stateFile(config));
  assert.equal(state.fetch?.providers.linkup?.banReason, 'credits');
  assert.equal(state.providers.linkup?.banReason, 'credits', 'поиск тоже не должен биться в тот же ключ');
});

test('файл v1 сбрасывает старый fetch.current, но оставляет карантины', () => {
  const config = configWith({});
  const file = stateFile(config);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      current: 'serpapi',
      providers: {},
      fetch: {
        current: 'exa',
        providers: {
          exa: {
            fails: 2,
            bannedUntil: null,
            banReason: 'error',
            lastError: 'HTTP 500',
            lastErrorAt: null,
            broken: false,
            brokenAt: null,
          },
        },
      },
    }),
  );

  const state = readRouterState(file);
  assert.equal(state.version, 2);
  assert.equal(state.current, 'serpapi', 'поисковый текущий не тронут');
  assert.equal(state.fetch?.current, null, 'старый текущий сброшен: рейтинг сменился');
  assert.equal(state.fetch?.providers.exa?.fails, 2, 'история отказов осталась');
});

test('все в карантине — all-banned с ближайшим разбаном', async () => {
  const config = configWith({ linkup: 'l' });
  const clock = clockAt();
  const fetch = fakeFetch({ linkup: () => json({}, 500) });

  await routeFetch(config, 'https://example.com', { fetch, now: clock.now });
  const second = await routeFetch(config, 'https://example.com', { fetch, now: clock.now });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.reason, 'all-banned');
  assert.ok(!second.ok && second.retryAt);
});

test('поиск и извлечение могут жить на разных провайдерах одновременно', async () => {
  const config = configWith({ serpapi: 's', linkup: 'l' });
  const clock = clockAt();
  const fetch = fakeFetch({
    serpapi: () => json({ organic_results: [{ title: 'S', link: 'https://s.dev', snippet: 'x' }] }),
    linkup: () => json(PAGES.linkup),
  });

  const search = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(search.ok && search.provider, 'serpapi', 'поиск выбрал SerpApi');
  const page = await routeFetch(config, 'https://example.com', { fetch, now: clock.now });
  assert.equal(page.ok && page.provider, 'linkup', 'извлечение выбрало Linkup');

  const state = readRouterState(stateFile(config));
  assert.equal(state.current, 'serpapi');
  assert.equal(state.fetch?.current, 'linkup');
});

// --- панель ------------------------------------------------------------------

test('панель показывает извлечение отдельным блоком', async () => {
  const config = configWith({ exa: 'e' });
  const clock = clockAt();
  const fetch = fakeFetch({ exa: () => json({}, 500) });
  await routeFetch(config, 'https://example.com', { fetch, now: clock.now });

  const status = searchStatus(config, clock.now());
  assert.equal(status.fetch.providers.length, 5);
  assert.equal(status.fetch.providers[0]?.id, 'cloudflare', 'Cloudflare первым в списке');
  assert.equal(status.fetch.providers[0]?.present, false, 'без account id он не готов');
  assert.equal(status.fetch.current, 'exa');
  const exa = status.fetch.providers.find((provider) => provider.id === 'exa');
  assert.equal(exa?.present, true);
  assert.equal(exa?.banReason, 'error');
  assert.equal(status.providers.some((provider) => provider.id === 'firecrawl'), true, 'поиск не потерял свои восемь');
});

test('проверка извлечения из панели снимает карантин', async () => {
  const config = configWith({ exa: 'e' });
  const clock = clockAt();
  const failing = fakeFetch({ exa: () => json({}, 500) });
  await routeFetch(config, 'https://example.com', { fetch: failing, now: clock.now });
  assert.equal(readRouterState(stateFile(config)).fetch?.providers.exa?.banReason, 'error');

  const check = await checkFetchProvider(config, 'exa', {
    fetch: fakeFetch({ exa: () => json(PAGES.exa) }),
    now: clock.now,
  });
  assert.equal(check.ok, true);
  assert.ok(check.chars > 0);
  assert.equal(readRouterState(stateFile(config)).fetch?.providers.exa?.bannedUntil, null);
});

// --- HTTP /fetch -------------------------------------------------------------

function startServer(config: IcarusConfig, fetchImpl: typeof fetch) {
  const registry = { bumpResources: () => {}, list: () => [], oneShot: async () => '' };
  const server = createServer(config, registry as never, { search: { fetch: fetchImpl } });
  return new Promise<{ base: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test('GET /fetch изнутри сети отдаёт текст и провайдера', async () => {
  const config = configWith({ exa: 'e' });
  const box = await startServer(config, okAll());
  try {
    const response = await fetch(`${box.base}/fetch?url=${encodeURIComponent('https://example.com')}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-fetch-provider'), 'exa');
    const body = (await response.json()) as { text: string; provider: string };
    assert.equal(body.provider, 'exa');
    assert.match(body.text, /текст от Exa/);

    const wrong = await fetch(`${box.base}/fetch?url=${encodeURIComponent('https://example.com')}`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrong.status, 401);
  } finally {
    box.close();
  }
});

test('POST /fetch понимает url и не пускает внутрь сети', async () => {
  const config = configWith({ exa: 'e' });
  const box = await startServer(config, okAll());
  try {
    const ok = await fetch(`${box.base}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.equal(ok.status, 200);

    for (const url of ['http://192.168.1.1/', 'http://localhost:8081/', 'file:///etc/passwd']) {
      const denied = await fetch(`${box.base}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      assert.equal(denied.status, 400, `${url} должен быть отвергнут`);
    }
  } finally {
    box.close();
  }
});
