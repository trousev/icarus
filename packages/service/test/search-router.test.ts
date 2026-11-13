// Search router: rating, quarantines, "key broken" and parsing of results.
//
// Tests do not hit the network: fetch is replaced, and the clock too. That's why the five-minute
// quarantine is checked instantly rather than by waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { makeConfig } from './fixtures.ts';
import type { IcarusConfig } from '../src/config.ts';
import { PROVIDERS } from '../src/search/providers.ts';
import {
  BROKEN_AFTER,
  BROKEN_BAN_MS,
  CREDIT_BAN_MS,
  ERROR_BAN_MS,
  RATING,
  routeSearch,
} from '../src/search/router.ts';
import { mutateRouterState, readRouterState, stateFile } from '../src/search/state.ts';
import { isInternalAddress } from '../src/search/http.ts';
import { checkProvider, searchStatus } from '../src/search/panel.ts';
import { SearchFailure, classifyFailure, type ProviderId } from '../src/search/types.ts';

const KEY_ENV: Record<string, string> = {
  serpapi: 'SERPAPI_API_KEY',
  serpstack: 'SERPSTACK_API_KEY',
  brave: 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
  tavily: 'TAVILY_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  you: 'YOU_API_KEY',
  // No key: the provider is enabled by the ICARUS_SEARCH_FREE setting, not by .env.
  'you-free': 'ICARUS_SEARCH_FREE',
  linkup: 'LINKUP_API_KEY',
};

const HOSTS: Record<string, ProviderId> = {
  'serpapi.com': 'serpapi',
  'api.serpstack.com': 'serpstack',
  'api.search.brave.com': 'brave',
  'api.exa.ai': 'exa',
  'api.tavily.com': 'tavily',
  'api.firecrawl.dev': 'firecrawl',
  'ydc-index.io': 'you',
  'api.you.com': 'you-free',
  'api.linkup.so': 'linkup',
};

type Handler = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Responses per provider: an unknown host is a test error, not a silent skip. */
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

function configWith(keys: Partial<Record<ProviderId, string>>): IcarusConfig {
  const secretEnv: Record<string, string> = {};
  for (const [id, value] of Object.entries(keys)) {
    if (value !== undefined) secretEnv[KEY_ENV[id as ProviderId]] = value;
  }
  return makeConfig({ secretEnv });
}

/** The free MCP response: JSON-RPC in SSE, inside — the shape of You.com's REST results. */
function mcpJson(payload: unknown): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: payload });
  return new Response(`event: message\ndata: ${body}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const okYouFree = () =>
  mcpJson({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ results: { web: [{ title: 'Free', url: 'https://free.dev', description: 'x' }] } }),
      },
    ],
  });

/** This is what an exhausted daily quota looks like: 200 OK, but result.isError. */
const quotaYouFree = () =>
  mcpJson({ isError: true, content: [{ type: 'text', text: 'Error: Free tier limit exceeded.' }] });

const okSerpApi = () =>
  json({
    organic_results: [
      { title: 'Раз', link: 'https://one.dev', snippet: 'первый' },
      { title: 'Два', link: 'https://two.dev', snippet: 'второй' },
    ],
  });

function clockAt(start = Date.parse('2026-11-07T12:00:00Z')) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

// --- provider selection ------------------------------------------------------

test('rating: SerpApi comes first, Linkup last, the free MCP next to You.com', () => {
  assert.deepEqual(RATING, [
    'serpapi',
    'serpstack',
    'brave',
    'exa',
    'tavily',
    'firecrawl',
    'you',
    'you-free',
    'linkup',
  ]);
});

test('the current one is the first by rating with a key, and does not change on its own', async () => {
  const config = configWith({ brave: 'b', serpapi: 's' });
  const clock = clockAt();
  const fetch = fakeFetch({ serpapi: okSerpApi, brave: okSerpApi });

  const first = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.provider, 'serpapi');
  assert.equal(readRouterState(stateFile(config)).current, 'serpapi');

  // A repeated request goes to the same current one: nobody banned it.
  const second = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(second.ok && second.provider, 'serpapi');
});

test('without keys — an honest no-keys, not a network call', async () => {
  const config = configWith({});
  const fetch = fakeFetch({});
  const result = await routeSearch(config, 'запрос', 2, { fetch });
  assert.deepEqual(result, { ok: false, reason: 'no-keys', tried: [], current: null, retryAt: null });
});

test('the free MCP searches without a single key', async () => {
  const config = makeConfig({ env: { ICARUS_SEARCH_FREE: 'on' } });
  const result = await routeSearch(config, 'запрос', 2, { fetch: fakeFetch({ 'you-free': okYouFree }) });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.provider, 'you-free');
  assert.equal(result.ok && result.results[0]?.url, 'https://free.dev');
});

test('the free MCP is on by default: empty env — and search still exists', async () => {
  const config = makeConfig({ env: {} });
  const result = await routeSearch(config, 'запрос', 1, { fetch: fakeFetch({ 'you-free': okYouFree }) });
  assert.equal(result.ok && result.provider, 'you-free');
});

test('ICARUS_SEARCH_FREE=off disables the free provider', async () => {
  const config = makeConfig({ env: { ICARUS_SEARCH_FREE: 'off' } });
  const result = await routeSearch(config, 'запрос', 2, { fetch: fakeFetch({}) });
  assert.deepEqual(result, { ok: false, reason: 'no-keys', tried: [], current: null, retryAt: null });
});

test('the free quota ran out — quarantine until UTC midnight, not a full 24 hours', async () => {
  const config = makeConfig({ env: { ICARUS_SEARCH_FREE: 'on' } });
  const clock = clockAt();
  const result = await routeSearch(config, 'запрос', 1, { fetch: fakeFetch({ 'you-free': quotaYouFree }), now: clock.now });
  assert.equal(result.ok, false);

  const state = readRouterState(stateFile(config));
  assert.equal(state.providers['you-free']?.banReason, 'credits');
  assert.equal(
    Date.parse(state.providers['you-free']?.bannedUntil ?? ''),
    Date.parse('2026-11-08T00:01:00Z'),
    'квота вернётся в полночь, а не через 24 часа от отказа',
  );
});

test('a provider without a key is skipped, the current one moves to a live one', async () => {
  const config = configWith({ brave: 'b' });
  const fetch = fakeFetch({ brave: okSerpApi });
  const result = await routeSearch(config, 'запрос', 2, { fetch });
  assert.equal(result.ok && result.provider, 'brave');
  assert.equal(readRouterState(stateFile(config)).current, 'brave');
});

// --- quarantines ---------------------------------------------------------------

test('failure: five minutes of quarantine, the request goes to the next one', async () => {
  const config = configWith({ serpapi: 's', brave: 'b' });
  const clock = clockAt();
  const fetch = fakeFetch({
    serpapi: () => json({ error: 'boom' }, 500),
    brave: okSerpApi,
  });

  const result = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.provider, 'brave');
  assert.deepEqual(result.tried.map((item) => item.provider), ['serpapi']);

  const state = readRouterState(stateFile(config));
  assert.equal(state.current, 'brave');
  const ban = state.providers.serpapi;
  assert.equal(ban?.banReason, 'error');
  assert.equal(Date.parse(ban?.bannedUntil ?? ''), clock.now() + ERROR_BAN_MS);
});

test('402 — a day of quarantine: credits will not return in five minutes', async () => {
  const config = configWith({ serpapi: 's', brave: 'b' });
  const clock = clockAt();
  const fetch = fakeFetch({
    serpapi: () => json({ error: 'Payment Required' }, 402),
    brave: okSerpApi,
  });

  const result = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'brave');
  const ban = readRouterState(stateFile(config)).providers.serpapi;
  assert.equal(ban?.banReason, 'credits');
  assert.equal(Date.parse(ban?.bannedUntil ?? ''), clock.now() + CREDIT_BAN_MS);
});

test('429 about credits — a day, 429 about rate — five minutes', () => {
  assert.equal(classifyFailure(429, '{"error":"insufficient credits"}'), 'credits');
  assert.equal(classifyFailure(429, '{"error":"rate limit exceeded"}'), 'rate');
  assert.equal(classifyFailure(403, 'Not enough credits on balance'), 'credits');
  assert.equal(classifyFailure(401, 'invalid api key'), 'http');
  assert.equal(classifyFailure(401, 'Your account has run out of searches'), 'credits');
  assert.equal(classifyFailure(432, 'plan limit reached'), 'credits');
  assert.equal(classifyFailure(433, 'This request exceeds the pay-as-you-go limit'), 'credits');
});

test('429 with credit-related text bans for a day', async () => {
  const config = configWith({ serpapi: 's', brave: 'b' });
  const clock = clockAt();
  const fetch = fakeFetch({
    serpapi: () => json({ error: 'out of credits' }, 429),
    brave: okSerpApi,
  });

  await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  const ban = readRouterState(stateFile(config)).providers.serpapi;
  assert.equal(ban?.banReason, 'credits');
  assert.equal(Date.parse(ban?.bannedUntil ?? ''), clock.now() + CREDIT_BAN_MS);
});

test('timeout — a usual five-minute quarantine', async () => {
  const config = configWith({ serpapi: 's', brave: 'b' });
  const clock = clockAt();
  const fetch = fakeFetch({
    serpapi: () => {
      throw new DOMException('timeout', 'TimeoutError');
    },
    brave: okSerpApi,
  });

  const result = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'brave');
  const ban = readRouterState(stateFile(config)).providers.serpapi;
  assert.equal(ban?.banReason, 'error');
  assert.equal(Date.parse(ban?.bannedUntil ?? ''), clock.now() + ERROR_BAN_MS);
});

test('everyone is quarantined: all-banned and the nearest unban time', async () => {
  const config = configWith({ serpapi: 's' });
  const clock = clockAt();
  const fetch = fakeFetch({ serpapi: () => json({}, 500) });

  await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  const second = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.reason, 'all-banned');
  assert.equal(!second.ok && second.retryAt, new Date(clock.now() + ERROR_BAN_MS).toISOString());
});

// --- 50 failures and "key broken" ---------------------------------------------

test('50 failures in a row: the key is broken and seven days of quarantine', async () => {
  const config = configWith({ serpapi: 's' });
  const clock = clockAt();
  const fetch = fakeFetch({ serpapi: () => json({ error: 'boom' }, 500) });

  for (let attempt = 1; attempt <= BROKEN_AFTER; attempt += 1) {
    if (attempt > 1) clock.advance(ERROR_BAN_MS + 1000);
    const result = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
    assert.equal(result.ok, false);
  }

  const provider = readRouterState(stateFile(config)).providers.serpapi;
  assert.equal(provider?.fails, BROKEN_AFTER);
  assert.equal(provider?.broken, true);
  assert.equal(provider?.banReason, 'broken');
  assert.equal(Date.parse(provider?.bannedUntil ?? ''), clock.now() + BROKEN_BAN_MS);
});

test('a success after seven days clears both the flag and the quarantine', async () => {
  const config = configWith({ serpapi: 's' });
  const clock = clockAt();
  let broken = false;
  const fetch = fakeFetch({ serpapi: () => (broken ? okSerpApi() : json({}, 500)) });

  for (let attempt = 1; attempt <= BROKEN_AFTER; attempt += 1) {
    if (attempt > 1) clock.advance(ERROR_BAN_MS + 1000);
    await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  }

  broken = true;
  clock.advance(BROKEN_BAN_MS + 1000);
  const result = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  assert.equal(result.ok && result.provider, 'serpapi');

  const provider = readRouterState(stateFile(config)).providers.serpapi;
  assert.equal(provider?.broken, false);
  assert.equal(provider?.fails, 0);
  assert.equal(provider?.bannedUntil, null);
});

test('a broken key is checked by itself after seven days and clears the flag', async () => {
  const config = configWith({ serpapi: 's', brave: 'b' });
  const clock = clockAt();
  // The state as after 50 failures, but seven days have already passed.
  await mutateRouterState(stateFile(config), (state) => {
    state.current = 'brave';
    state.providers.serpapi = {
      fails: BROKEN_AFTER,
      bannedUntil: new Date(clock.now() - 1000).toISOString(),
      banReason: 'broken',
      lastError: 'HTTP 500',
      lastErrorAt: new Date(clock.now() - BROKEN_BAN_MS).toISOString(),
      broken: true,
      brokenAt: new Date(clock.now() - BROKEN_BAN_MS).toISOString(),
    };
  });

  const fetch = fakeFetch({ serpapi: okSerpApi, brave: okSerpApi });
  const result = await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });

  assert.equal(result.ok && result.provider, 'serpapi', 'воскресшего проверили настоящим запросом');
  const state = readRouterState(stateFile(config));
  assert.equal(state.providers.serpapi?.broken, false);
  assert.equal(state.current, 'brave', 'текущий сам по себе не меняется');
});

test('a success resets the failure counter', async () => {  const config = configWith({ serpapi: 's' });
  const clock = clockAt();
  let fail = true;
  const fetch = fakeFetch({ serpapi: () => (fail ? json({}, 500) : okSerpApi()) });

  await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });
  clock.advance(ERROR_BAN_MS + 1000);
  fail = false;
  await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });

  const provider = readRouterState(stateFile(config)).providers.serpapi;
  assert.equal(provider?.fails, 0);
  assert.equal(provider?.bannedUntil, null);
});

// --- state and panel ----------------------------------------------------------

test('the state survives config recreation: the quarantine lives in JSON', async () => {
  const config = configWith({ serpapi: 's' });
  const clock = clockAt();
  const fetch = fakeFetch({ serpapi: () => json({}, 500) });
  await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });

  const again = readRouterState(stateFile(config));
  assert.equal(again.providers.serpapi?.banReason, 'error');
  assert.ok(again.providers.serpapi?.bannedUntil);
});

test('broken JSON does not crash the router, and unknown providers are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-search-state-'));
  const file = path.join(dir, 'search-router.json');
  fs.writeFileSync(file, '{это не json');
  assert.equal(readRouterState(file).current, null);

  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      current: 'неведомый',
      providers: { serpapi: { fails: 2, bannedUntil: 'когда-нибудь' }, неведомый: { fails: 9 } },
    }),
  );
  const state = readRouterState(file);
  assert.equal(state.current, null, 'неизвестный текущий сбрасывается');
  assert.equal(state.providers.serpapi?.fails, 2);
  assert.equal(state.providers.serpapi?.bannedUntil, null, 'битая дата — не карантин');
  assert.equal(state.providers['неведомый'], undefined);
});

test('the panel sees the current one, the quarantine and a broken key', async () => {
  const config = configWith({ serpapi: 's', brave: 'b' });
  const clock = clockAt();
  const fetch = fakeFetch({ serpapi: () => json({}, 500), brave: okSerpApi });
  await routeSearch(config, 'запрос', 2, { fetch, now: clock.now });

  const status = searchStatus(config, clock.now());
  assert.equal(status.current, 'brave');
  const serpapi = status.providers.find((provider) => provider.id === 'serpapi');
  assert.equal(serpapi?.present, true);
  assert.equal(serpapi?.banReason, 'error');
  const you = status.providers.find((provider) => provider.id === 'you');
  assert.equal(you?.present, false);
  assert.equal(you?.current, false);
});

test('a check from the panel clears the quarantine if the provider responded', async () => {
  const config = configWith({ serpapi: 's' });
  const clock = clockAt();
  const failing = fakeFetch({ serpapi: () => json({}, 500) });
  await routeSearch(config, 'запрос', 2, { fetch: failing, now: clock.now });
  assert.equal(readRouterState(stateFile(config)).providers.serpapi?.banReason, 'error');

  const check = await checkProvider(config, 'serpapi', {
    fetch: fakeFetch({ serpapi: okSerpApi }),
    now: clock.now,
  });
  assert.equal(check.ok, true);
  const provider = readRouterState(stateFile(config)).providers.serpapi;
  assert.equal(provider?.bannedUntil, null);
  assert.equal(provider?.fails, 0);
});

test('the panel sees a provider without a key: keyless, present, empty keyName', () => {
  const config = makeConfig({ env: { ICARUS_SEARCH_FREE: 'on' } });
  const row = searchStatus(config).providers.find((provider) => provider.id === 'you-free');
  assert.equal(row?.keyless, true);
  assert.equal(row?.present, true);
  assert.equal(row?.keyName, '');
  assert.match(row?.note ?? '', /100 поисков в сутки/);
});

test('You.com without a key is labeled "optional" while the free MCP works', () => {
  const on = searchStatus(makeConfig({ env: { ICARUS_SEARCH_FREE: 'on' } }));
  const you = on.providers.find((provider) => provider.id === 'you');
  assert.equal(you?.present, false);
  assert.equal(you?.optional, true, 'ключа нет, но роутер и без него ищет');
  assert.match(you?.note ?? '', /через бесплатный MCP/);

  const off = searchStatus(makeConfig({ env: { ICARUS_SEARCH_FREE: 'off' } }));
  const alone = off.providers.find((provider) => provider.id === 'you');
  assert.equal(alone?.optional, false, 'бесплатный выключен — ключ снова нужен');
  assert.equal(alone?.note, null);

  const keyed = searchStatus(makeConfig({ env: { ICARUS_SEARCH_FREE: 'on' }, secretEnv: { YOU_API_KEY: 'k' } }));
  const withKey = keyed.providers.find((provider) => provider.id === 'you');
  assert.equal(withKey?.present, true);
  assert.equal(withKey?.optional, false, 'ключ есть — подсказка не нужна');
});

test('a check from the panel calls the provider without a key instead of refusing', async () => {
  const config = makeConfig({ env: { ICARUS_SEARCH_FREE: 'on' } });
  const result = await checkProvider(config, 'you-free', { fetch: fakeFetch({ 'you-free': okYouFree }) });
  assert.equal(result.ok, true);
  assert.equal(result.results, 1);
});

test('a check from the panel without a key does not hit the network and says so directly', async () => {
  const config = configWith({});
  const check = await checkProvider(config, 'serpapi', {
    fetch: fakeFetch({}),
    now: () => Date.now(),
  });
  assert.equal(check.ok, false);
  assert.equal(check.error, 'ключ не задан');
});

test('SearchFailure by default is a usual failure, not credits', () => {
  const failure = new SearchFailure('network', 'сеть легла');
  assert.equal(failure.kind, 'network');
  assert.equal(failure.status, null);
});

// --- HTTP /search ------------------------------------------------------------

function startServer(config: IcarusConfig, fetchImpl?: typeof fetch) {
  const registry = { bumpResources: () => {}, list: () => [], oneShot: async () => '' };
  const server = createServer(config, registry as never, {
    ...(fetchImpl === undefined ? {} : { search: { fetch: fetchImpl } }),
  });
  return new Promise<{ base: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test('GET /search: from inside the network without a token, from outside — only with a token', async () => {
  const config = configWith({ serpapi: 's' });
  const box = await startServer(config, fakeFetch({ serpapi: okSerpApi }));
  try {
    const response = await fetch(`${box.base}/search?q=лиссабон&limit=2`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-search-provider'), 'serpapi');
    const body = (await response.json()) as { results: Array<{ title: string }>; provider: string };
    assert.equal(body.provider, 'serpapi');
    assert.equal(body.results.length, 2);

    // The loopback is the internal network: the pi container reaches here without any tokens.
    const internal = await fetch(`${box.base}/search?q=лиссабон`);
    assert.equal(internal.status, 200);

    // But a wrong token is not accepted even from inside: that's no longer "no token".
    const wrong = await fetch(`${box.base}/search?q=лиссабон`, { headers: { authorization: 'Bearer wrong-token' } });
    assert.equal(wrong.status, 401);
  } finally {
    box.close();
  }
});

test('internal addresses are recognized, public ones — not', () => {
  for (const address of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.1.1',
    'fd00::1',
    'fe80::1',
  ]) {
    assert.equal(isInternalAddress(address), true, `${address} должен быть внутренним`);
  }
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '2001:db8::1', '', undefined]) {
    assert.equal(isInternalAddress(address), false, `${String(address)} не должен быть внутренним`);
  }
});

test('POST /search understands query and rejects an empty request', async () => {
  const config = configWith({ serpapi: 's' });
  const box = await startServer(config, fakeFetch({ serpapi: okSerpApi }));
  try {
    const ok = await fetch(`${box.base}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'лиссабон', limit: 1 }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { results: unknown[] };
    assert.equal(body.results.length, 1);

    const empty = await fetch(`${box.base}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '   ' }),
    });
    assert.equal(empty.status, 400);
  } finally {
    box.close();
  }
});

// --- parsing of results ------------------------------------------------------

test('SerpApi and Serpstack: organic_results', async () => {
  const { parseSerpApi, parseSerpStack } = await import('../src/search/providers.ts');
  const payload = {
    organic_results: [
      { title: 'A', link: 'https://a.dev', snippet: 'сниппет' },
      { title: 'B', url: 'https://b.dev', description: 'описание' },
    ],
  };
  assert.deepEqual(parseSerpApi(payload), [
    { title: 'A', url: 'https://a.dev', snippet: 'сниппет' },
    { title: 'B', url: 'https://b.dev' },
  ]);
  assert.deepEqual(parseSerpStack(payload), [
    { title: 'A', url: 'https://a.dev', snippet: 'сниппет' },
    { title: 'B', url: 'https://b.dev', snippet: 'описание' },
  ]);
});

test('Brave, Exa, Tavily, Firecrawl, You, Linkup are parsed into a common shape', async () => {
  const { parseBrave, parseExa, parseTavily, parseFirecrawl, parseYou, parseLinkup } = await import(
    '../src/search/providers.ts'
  );

  assert.deepEqual(parseBrave({ web: { results: [{ title: 'B', url: 'https://b.dev', description: '<b>жирно</b>' }] } }), [
    { title: 'B', url: 'https://b.dev', snippet: 'жирно' },
  ]);
  assert.deepEqual(parseExa({ results: [{ title: 'E', url: 'https://e.dev', highlights: ['выдержка'] }] }), [
    { title: 'E', url: 'https://e.dev', snippet: 'выдержка' },
  ]);
  assert.deepEqual(parseTavily({ results: [{ title: 'T', url: 'https://t.dev', content: 'текст' }] }), [
    { title: 'T', url: 'https://t.dev', snippet: 'текст' },
  ]);
  assert.deepEqual(parseFirecrawl({ data: [{ title: 'F', url: 'https://f.dev', description: 'описание' }] }), [
    { title: 'F', url: 'https://f.dev', snippet: 'описание' },
  ]);
  assert.deepEqual(parseYou({ results: { web: [{ title: 'Y', url: 'https://y.dev', snippets: ['кусок'] }] } }), [
    { title: 'Y', url: 'https://y.dev', snippet: 'кусок' },
  ]);
  assert.deepEqual(parseLinkup({ results: [{ name: 'L', url: 'https://l.dev', content: 'контент' }] }), [
    { title: 'L', url: 'https://l.dev', snippet: 'контент' },
  ]);
});

test('broken results do not break parsing and respect limit', async () => {
  const { parseSerpApi, parseBrave, parseExa, parseFirecrawl, parseYou, parseLinkup } = await import(
    '../src/search/providers.ts'
  );
  for (const parse of [parseSerpApi, parseBrave, parseExa, parseFirecrawl, parseYou, parseLinkup]) {
    assert.deepEqual(parse(null), []);
    assert.deepEqual(parse({ results: 'нет' }), []);
    assert.deepEqual(parse({ organic_results: [{ title: 'без ссылки' }] }), []);
  }
  const many = {
    organic_results: [
      { title: 'A', link: 'https://a.dev' },
      { title: 'B', link: 'https://b.dev' },
    ],
  };
  assert.equal(parseSerpApi(many, 1).length, 1);
});

test('each adapter sends the key where it should and parses the response', async () => {
  const responses: Record<string, unknown> = {
    serpapi: { organic_results: [{ title: 'S', link: 'https://s.dev', snippet: 'x' }] },
    serpstack: { organic_results: [{ title: 'S', url: 'https://s.dev', description: 'x' }] },
    brave: { web: { results: [{ title: 'B', url: 'https://b.dev', description: 'x' }] } },
    exa: { results: [{ title: 'E', url: 'https://e.dev', highlights: ['x'] }] },
    tavily: { results: [{ title: 'T', url: 'https://t.dev', content: 'x' }] },
    firecrawl: { data: [{ title: 'F', url: 'https://f.dev', description: 'x' }] },
    you: { results: { web: [{ title: 'Y', url: 'https://y.dev', description: 'x' }] } },
    // The free MCP responds not with a REST body but with JSON-RPC: the result lies
    // as a string in content[0].text, and inside — the same results.web shape.
    'you-free': {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ results: { web: [{ title: 'Y', url: 'https://y.dev', description: 'x' }] } }) }],
      },
    },
    linkup: { results: [{ name: 'L', url: 'https://l.dev', content: 'x' }] },
  };
  const seen = new Map<ProviderId, { url: URL; init: RequestInit }>();

  for (const id of RATING) {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.set(id, { url: new URL(String(input)), init: init ?? {} });
      return json(responses[id]);
    }) as unknown as typeof fetch;
    const results = await PROVIDERS[id].search('лиссабон', 3, { key: 'secret-key', fetch: fetchImpl });
    assert.equal(results.length, 1, `${id}: ответ разобрался`);
  }

  const serpapi = seen.get('serpapi');
  assert.equal(serpapi?.url.hostname, 'serpapi.com');
  assert.equal(serpapi?.url.searchParams.get('api_key'), 'secret-key');
  assert.equal(serpapi?.url.searchParams.get('q'), 'лиссабон');

  const brave = seen.get('brave');
  assert.equal(brave?.url.hostname, 'api.search.brave.com');
  assert.equal((brave?.init.headers as Record<string, string>)['x-subscription-token'], 'secret-key');

  for (const id of ['exa', 'tavily', 'firecrawl', 'linkup'] as const) {
    const call = seen.get(id);
    assert.equal(call?.init.method, 'POST', `${id}: шлёт POST`);
    assert.match(String((call?.init.headers as Record<string, string>).authorization), /^Bearer secret-key$/, id);
    assert.match(String(call?.init.body), /лиссабон/, `${id}: запрос уехал в теле`);
  }

  const you = seen.get('you');
  assert.equal(you?.url.hostname, 'ydc-index.io');
  assert.equal((you?.init.headers as Record<string, string>)['x-api-key'], 'secret-key');
  assert.match(String(you?.init.body), /лиссабон/);

  // The free MCP: the same You.com, but without a key at all — no header, no query.
  const free = seen.get('you-free');
  assert.equal(free?.url.hostname, 'api.you.com');
  assert.equal(free?.url.searchParams.get('profile'), 'free');
  assert.equal((free?.init.headers as Record<string, string>).authorization, undefined);
  assert.equal((free?.init.headers as Record<string, string>)['x-api-key'], undefined);
  assert.equal(JSON.parse(String(free?.init.body)).params.name, 'you-search');
});

test('providers are registered exactly in rating order', () => {
  assert.deepEqual(Object.keys(PROVIDERS), [...RATING]);
});
