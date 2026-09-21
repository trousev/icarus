// Веб-поиск: разбор выдачи провайдеров, превращение HTML в текст и честные отказы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, parseBrave, parseSearxng, parseTavily } from '../../extensions/web-search.ts';

test('скрипты и стили выкидываются, абзацы сохраняются', () => {
  const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
    <body><h1>Заголовок</h1><p>Первый абзац</p><p>Второй &amp; последний</p></body></html>`;
  const text = htmlToText(html);
  assert.doesNotMatch(text, /alert|color:red/);
  assert.match(text, /Заголовок/);
  assert.match(text, /Первый абзац/);
  assert.match(text, /Второй & последний/);
  assert.ok(text.split('\n').length >= 3, 'абзацы должны разъехаться по строкам');
});

test('выдача Tavily разбирается: заголовок, ссылка и выдержка одной строкой', () => {
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

test('длинная выдержка Tavily обрезается, а не ломает список', () => {
  const long = 'мысль '.repeat(300);
  const [first] = parseTavily({ results: [{ title: 'T', url: 'https://t.dev', content: long }] });

  assert.ok(first.snippet, 'выдержка должна остаться');
  assert.ok(first.snippet.length <= 500, `выдержка длиннее предела: ${first.snippet.length}`);
  assert.doesNotMatch(first.snippet, /\n/);
  assert.match(first.snippet, /…$/, 'обрезанную выдержку видно по многоточию');
});

test('выдача Tavily уважает limit', () => {
  const payload = {
    results: [
      { title: 'A', url: 'https://a.dev', content: 'первый' },
      { title: 'B', url: 'https://b.dev', content: 'второй' },
    ],
  };

  assert.deepEqual(parseTavily(payload, 1), [{ title: 'A', url: 'https://a.dev', snippet: 'первый' }]);
});

test('пустая и битая выдача Tavily не ломает разбор', () => {
  assert.deepEqual(parseTavily(null), []);
  assert.deepEqual(parseTavily({ results: 'нет' }), []);
  assert.deepEqual(parseTavily({ results: [] }), []);
});

test('выдача SearXNG и Brave разбирается в общий вид', () => {
  const searx = parseSearxng({ results: [{ title: 'A', url: 'https://a.dev', content: 'описание' }] });
  assert.deepEqual(searx, [{ title: 'A', url: 'https://a.dev', snippet: 'описание' }]);

  const brave = parseBrave({ web: { results: [{ title: 'B', url: 'https://b.dev', description: '<b>жирно</b>' }] } });
  assert.deepEqual(brave, [{ title: 'B', url: 'https://b.dev', snippet: 'жирно' }]);
});

test('пустая и битая выдача SearXNG и Brave не ломает разбор', () => {
  assert.deepEqual(parseSearxng(null), []);
  assert.deepEqual(parseSearxng({ results: 'нет' }), []);
  assert.deepEqual(parseBrave({}), []);
});
