// Веб-поиск: разбор выдачи, превращение HTML в текст и честные отказы провайдера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, parseBrave, parseDeepSeekSearch, parseSearxng } from '../../extensions/web-search.ts';

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

test('выдача DeepSeek разбирается вместе с цитатами и без дублей', () => {
  const payload = {
    content: [
      { type: 'thinking', thinking: 'ищу' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'Лиссабон', url: 'https://lisbon.pt', page_age: '2026-09-01' },
          { type: 'web_search_result', title: 'Дубль', url: 'https://lisbon.pt' },
          { type: 'web_search_result', title: 'Второй результат', url: 'https://example.org/second' },
        ],
      },
      {
        type: 'text',
        text: 'Ответ',
        citations: [{ url: 'https://lisbon.pt', cited_text: 'Город на семи холмах' }],
      },
    ],
  };

  const outcome = parseDeepSeekSearch(payload);
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.results, [
    { title: 'Лиссабон', url: 'https://lisbon.pt', snippet: 'Город на семи холмах' },
    { title: 'Второй результат', url: 'https://example.org/second', snippet: undefined },
  ]);
});

test('выдача DeepSeek уважает limit', () => {
  const payload = {
    content: [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'A', url: 'https://a.dev' },
          { type: 'web_search_result', title: 'B', url: 'https://b.dev' },
        ],
      },
    ],
  };

  assert.deepEqual(parseDeepSeekSearch(payload, 1).results, [{ title: 'A', url: 'https://a.dev', snippet: undefined }]);
});

test('честный ноль результатов — это не ошибка', () => {
  const outcome = parseDeepSeekSearch({ content: [{ type: 'web_search_tool_result', content: [] }] });
  assert.deepEqual(outcome.results, []);
  assert.equal(outcome.error, undefined, 'пустая выдача не должна выглядеть как отказ');
});

test('поиск без вызова web_search и ошибка серверного тула — это отказ, а не пустота', () => {
  const skipped = parseDeepSeekSearch({ content: [{ type: 'text', text: 'не буду искать' }] });
  assert.match(skipped.error ?? '', /web_search/);
  assert.deepEqual(skipped.results, []);

  const failed = parseDeepSeekSearch({
    content: [
      {
        type: 'web_search_tool_result',
        content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
      },
    ],
  });
  assert.match(failed.error ?? '', /unavailable/);
  assert.deepEqual(failed.results, []);

  const broken = parseDeepSeekSearch(null);
  assert.match(broken.error ?? '', /web_search/);
});

test('выдача SearXNG и Brave разбирается в общий вид', () => {
  const searx = parseSearxng({ results: [{ title: 'A', url: 'https://a.dev', content: 'описание' }] });
  assert.deepEqual(searx, [{ title: 'A', url: 'https://a.dev', snippet: 'описание' }]);

  const brave = parseBrave({ web: { results: [{ title: 'B', url: 'https://b.dev', description: '<b>жирно</b>' }] } });
  assert.deepEqual(brave, [{ title: 'B', url: 'https://b.dev', snippet: 'жирно' }]);
});

test('пустая и битая выдача не ломает разбор', () => {
  assert.deepEqual(parseSearxng(null), []);
  assert.deepEqual(parseSearxng({ results: 'нет' }), []);
  assert.deepEqual(parseBrave({}), []);
});
