// Web search: parsing provider results, turning HTML into text and honest refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToText,
  parseBrave,
  parseFetchRouter,
  parseRouter,
  parseRouterMeta,
  parseSearxng,
  parseTavily,
} from '../../extensions/web-search.ts';

test('scripts and styles are dropped, paragraphs are preserved', () => {
  const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
    <body><h1>Заголовок</h1><p>Первый абзац</p><p>Второй &amp; последний</p></body></html>`;
  const text = htmlToText(html);
  assert.doesNotMatch(text, /alert|color:red/);
  assert.match(text, /Заголовок/);
  assert.match(text, /Первый абзац/);
  assert.match(text, /Второй & последний/);
  assert.ok(text.split('\n').length >= 3, 'абзацы должны разъехаться по строкам');
});

test('Tavily results are parsed: title, link and snippet on one line', () => {
  const payload = {
    query: 'лиссабон',
    results: [
      { title: 'Лиссабон', url: 'https://lisbon.pt', content: 'Город\nна семи   холмах', score: 0.9 },
      { title: 'Без выдержки', url: 'https://example.org/second' },
      { title: 'Без ссылки', content: 'мимо' },
    ],
  };

  assert.deepEqual(parseTavily(payload), [
    { title: 'Лиссабон', url: 'https://lisbon.pt', snippet: 'Город на семи холмах' },
    { title: 'Без выдержки', url: 'https://example.org/second', snippet: undefined },
  ]);
});

test('a long Tavily snippet is truncated instead of breaking the list', () => {
  const long = 'мысль '.repeat(300);
  const [first] = parseTavily({ results: [{ title: 'T', url: 'https://t.dev', content: long }] });

  assert.ok(first.snippet, 'выдержка должна остаться');
  assert.ok(first.snippet.length <= 500, `выдержка длиннее предела: ${first.snippet.length}`);
  assert.doesNotMatch(first.snippet, /\n/);
  assert.match(first.snippet, /…$/, 'обрезанную выдержку видно по многоточию');
});

test('Tavily results respect the limit', () => {
  const payload = {
    results: [
      { title: 'A', url: 'https://a.dev', content: 'первый' },
      { title: 'B', url: 'https://b.dev', content: 'второй' },
    ],
  };

  assert.deepEqual(parseTavily(payload, 1), [{ title: 'A', url: 'https://a.dev', snippet: 'первый' }]);
});

test('an empty and broken Tavily response does not break parsing', () => {
  assert.deepEqual(parseTavily(null), []);
  assert.deepEqual(parseTavily({ results: 'нет' }), []);
  assert.deepEqual(parseTavily({ results: [] }), []);
});

test('SearXNG and Brave results are parsed into a common shape', () => {
  const searx = parseSearxng({ results: [{ title: 'A', url: 'https://a.dev', content: 'описание' }] });
  assert.deepEqual(searx, [{ title: 'A', url: 'https://a.dev', snippet: 'описание' }]);

  const brave = parseBrave({ web: { results: [{ title: 'B', url: 'https://b.dev', description: '<b>жирно</b>' }] } });
  assert.deepEqual(brave, [{ title: 'B', url: 'https://b.dev', snippet: 'жирно' }]);
});

test('an empty and broken SearXNG and Brave response does not break parsing', () => {
  assert.deepEqual(parseSearxng(null), []);
  assert.deepEqual(parseSearxng({ results: 'нет' }), []);
  assert.deepEqual(parseBrave({}), []);
});

test('service router results are parsed like ordinary results', () => {
  const payload = {
    query: 'лиссабон',
    provider: 'serpapi',
    results: [
      { title: 'Лиссабон', url: 'https://lisbon.pt', snippet: 'Город\nна семи   холмах' },
      { title: 'Без выдержки', url: 'https://example.org/second' },
      { title: 'Без ссылки', snippet: 'мимо' },
    ],
  };
  assert.deepEqual(parseRouter(payload), [
    { title: 'Лиссабон', url: 'https://lisbon.pt', snippet: 'Город на семи холмах' },
    { title: 'Без выдержки', url: 'https://example.org/second' },
  ]);
  assert.deepEqual(parseRouter(null), []);
  assert.deepEqual(parseRouter({ results: 'нет' }), []);
  assert.equal(parseRouter(payload, 1).length, 1);
});

test('the router response says who answered and who was skipped', () => {  assert.deepEqual(parseRouterMeta({ provider: 'brave', results: [] }), { upstream: 'brave' });
  assert.deepEqual(
    parseRouterMeta({
      provider: 'tavily',
      tried: [
        { provider: 'serpapi', reason: 'HTTP 429: out of credits' },
        { provider: 'brave', reason: 'провайдер не ответил вовремя' },
      ],
    }),
    {
      upstream: 'tavily',
      tried: [
        { provider: 'serpapi', reason: 'HTTP 429: out of credits' },
        { provider: 'brave', reason: 'провайдер не ответил вовремя' },
      ],
    },
  );
  // An ordinary response without metadata must not pretend to be from the router.
  assert.deepEqual(parseRouterMeta({ results: [] }), {});
  assert.deepEqual(parseRouterMeta(null), {});
  assert.deepEqual(parseRouterMeta({ provider: 42, tried: 'нет' }), {});
});

test('the /fetch response is parsed: text, title and who read it', () => {
  assert.deepEqual(parseFetchRouter({ text: 'тело страницы', title: 'Заголовок', provider: 'exa' }), {
    text: 'тело страницы',
    title: 'Заголовок',
    upstream: 'exa',
  });
  assert.deepEqual(
    parseFetchRouter({
      text: 'тело',
      provider: 'tavily',
      tried: [{ provider: 'exa', reason: 'HTTP 404' }],
    }),
    { text: 'тело', upstream: 'tavily', tried: [{ provider: 'exa', reason: 'HTTP 404' }] },
  );
  assert.deepEqual(parseFetchRouter({}), { text: '' });
  assert.deepEqual(parseFetchRouter(null), { text: '' });
});

