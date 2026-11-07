// Учёт обращений: сколько каждый ключ отдал и сколько раз отказал за семь дней.
//
// Счётчики — не история: проверяем именно суточные корзины, обрезку восьмого дня
// и суммы, которые видит панель. Сеть подменяется, как и в остальных тестах.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeConfig } from './fixtures.ts';
import type { IcarusConfig } from '../src/config.ts';
import { routeFetch } from '../src/search/fetch-router.ts';
import { searchStatus } from '../src/search/panel.ts';
import { routeSearch } from '../src/search/router.ts';
import { stateFile } from '../src/search/state.ts';
import { USAGE_DAYS, dayKey, readUsage, recordUsage, usageFile, usageReport } from '../src/search/usage.ts';
import type { ProviderId } from '../src/search/types.ts';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const clock = () => NOW;

function configWith(keys: Record<string, string>): IcarusConfig {
  const names: Record<string, string> = {
    exa: 'EXA_API_KEY',
    tavily: 'TAVILY_API_KEY',
    linkup: 'LINKUP_API_KEY',
    you: 'YOU_API_KEY',
  };
  const secretEnv: Record<string, string> = {};
  for (const [id, value] of Object.entries(keys)) secretEnv[names[id] as string] = value;
  return makeConfig({ secretEnv });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const HOSTS: Record<string, ProviderId> = {
  'api.exa.ai': 'exa',
  'api.tavily.com': 'tavily',
  'api.linkup.so': 'linkup',
};

function fakeFetch(handlers: Partial<Record<ProviderId, () => Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const id = HOSTS[new URL(String(input)).hostname];
    if (id === undefined) throw new Error('тест не ждал запроса к чужому хосту');
    return handlers[id]!();
  }) as unknown as typeof fetch;
}

test('счётчики копятся по дням и суммируются за семь дней', async () => {
  const config = configWith({});
  await recordUsage(config, 'search', 'tavily', true, { now: clock });
  await recordUsage(config, 'search', 'tavily', true, { now: clock });
  await recordUsage(config, 'search', 'tavily', false, { now: clock });
  await recordUsage(config, 'fetch', 'linkup', true, { now: clock });
  await recordUsage(config, 'fetch', 'linkup', false, { now: clock });

  const report = usageReport(config, NOW);
  assert.deepEqual(report.search.tavily, { ok: 2, fail: 1 });
  assert.deepEqual(report.fetch.linkup, { ok: 1, fail: 1 });
  assert.equal(report.search.linkup, undefined, 'поиск и извлечение не смешиваются');
  assert.equal(report.days, USAGE_DAYS);
  assert.equal(report.through, '2026-11-07');
  assert.equal(report.since, '2026-11-01', 'окно — сегодня и шесть предыдущих дней');
});

test('восьмой день выбрасывается, а не копится', async () => {
  const config = configWith({});
  // Девять дней подряд, от сегодняшнего к самому старому, и ещё раз сегодня:
  // последняя запись — та, что обрезает хвост.
  for (let back = 0; back < 9; back += 1) {
    await recordUsage(config, 'search', 'exa', true, { now: () => NOW - back * DAY });
  }
  await recordUsage(config, 'search', 'exa', true, { now: clock });

  const state = readUsage(usageFile(config));
  const days = Object.keys(state.days).sort();
  assert.equal(days.length, USAGE_DAYS, 'в файле ровно семь дней');
  assert.equal(days[0], dayKey(NOW - 6 * DAY));
  assert.equal(days.at(-1), dayKey(NOW));
  // Сегодня записан дважды (цикл и финальная запись), остальные шесть дней — по разу.
  assert.deepEqual(usageReport(config, NOW).search.exa, { ok: 8, fail: 0 });
});

test('битый файл — не повод ломать поиск', async () => {
  const config = configWith({});
  fs.writeFileSync(usageFile(config), 'это не json');

  assert.deepEqual(readUsage(usageFile(config)).days, {});
  await recordUsage(config, 'fetch', 'tavily', true, { now: clock });
  assert.deepEqual(usageReport(config, NOW).fetch.tavily, { ok: 1, fail: 0 });
});

test('роутер извлечения пишет успех и отказ страницы в счётчики', async () => {
  const config = configWith({ linkup: 'l', exa: 'e' });
  const fetchImpl = fakeFetch({
    linkup: () => json({ error: 'unsupported content type' }, 400),
    exa: () => json({ results: [{ url: 'https://example.com', title: 'Пример', text: 'текст' }] }),
  });

  const result = await routeFetch(config, 'https://example.com/doc.md', { fetch: fetchImpl, now: clock });
  assert.equal(result.ok && result.provider, 'exa');

  const status = searchStatus(config, NOW);
  const linkup = status.fetch.providers.find((provider) => provider.id === 'linkup');
  const exa = status.fetch.providers.find((provider) => provider.id === 'exa');
  assert.deepEqual(linkup?.usage, { ok: 0, fail: 1 }, 'отказ страницы — тоже отказ ключа');
  assert.deepEqual(exa?.usage, { ok: 1, fail: 0 });
  assert.equal(linkup?.fails, 0, 'но в карантин за это не отправляем');
});

test('роутер поиска пишет отказ и успех в счётчики по провайдерам', async () => {
  const config = configWith({ exa: 'e', tavily: 't' });
  const fetchImpl = fakeFetch({
    exa: () => json({ error: 'boom' }, 500),
    tavily: () => json({ results: [{ url: 'https://example.com', title: 'Пример', content: 'сниппет' }] }),
  });

  const result = await routeSearch(config, 'запрос', 3, { fetch: fetchImpl, now: clock });
  assert.equal(result.ok && result.provider, 'tavily');

  const status = searchStatus(config, NOW);
  assert.deepEqual(
    status.providers.find((provider) => provider.id === 'exa')?.usage,
    { ok: 0, fail: 1 },
  );
  assert.deepEqual(
    status.providers.find((provider) => provider.id === 'tavily')?.usage,
    { ok: 1, fail: 0 },
  );
  assert.equal(status.usage.since, '2026-11-01');
  assert.equal(fs.existsSync(usageFile(config)), true);
  assert.equal(stateFile(config).endsWith('search-router.json'), true, 'состояние роутера отдельно');
});
