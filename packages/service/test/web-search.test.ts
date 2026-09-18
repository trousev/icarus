// Веб-поиск: разбор выдачи и превращение HTML в текст.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDuckDuckGoUrl,
  htmlToText,
  parseBrave,
  parseDuckDuckGo,
  parseSearxng,
} from '../../extensions/web-search.ts';

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

test('ссылка-редирект DuckDuckGo разворачивается', () => {
  assert.equal(
    decodeDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc'),
    'https://example.com/page',
  );
  assert.equal(decodeDuckDuckGoUrl('https://example.com/direct'), 'https://example.com/direct');
});

test('выдача DuckDuckGo разбирается вместе с выдержками', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flisbon.pt">Лиссабон</a>
    <a class="result__snippet">Город на семи холмах</a>
    <a class="result__a" href="https://example.org/second">Второй результат</a>
    <a class="result__snippet">Короткое описание</a>
  `;
  const results = parseDuckDuckGo(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://lisbon.pt');
  assert.equal(results[0].title, 'Лиссабон');
  assert.equal(results[0].snippet, 'Город на семи холмах');
  assert.equal(results[1].url, 'https://example.org/second');
});

test('выдача SearXNG и Brave разбирается в общий вид', () => {
  const searx = parseSearxng({ results: [{ title: 'A', url: 'https://a.dev', content: 'описание' }] });
  assert.deepEqual(searx, [{ title: 'A', url: 'https://a.dev', snippet: 'описание' }]);

  const brave = parseBrave({ web: { results: [{ title: 'B', url: 'https://b.dev', description: '<b>жирно</b>' }] } });
  assert.deepEqual(brave, [{ title: 'B', url: 'https://b.dev', snippet: 'жирно' }]);
});

test('пустая и битая выдача не ломает разбор', () => {
  assert.deepEqual(parseDuckDuckGo('<html></html>'), []);
  assert.deepEqual(parseSearxng(null), []);
  assert.deepEqual(parseSearxng({ results: 'нет' }), []);
  assert.deepEqual(parseBrave({}), []);
});
