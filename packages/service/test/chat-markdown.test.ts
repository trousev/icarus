// Разметка панели чата: markdown модели в безопасный HTML. Файл клиентский и без
// сборки, поэтому берём его исходник как есть и достаём функции из области
// видимости — тест проверяет ровно тот код, который уедет в браузер.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../src/control/chat-markdown.js', import.meta.url), 'utf8');

type Renderer = {
  markdown: (text: string) => string;
  inline: (text: string) => string;
  linkify: (text: string) => string;
};

const renderer = new Function(`${SOURCE}\nreturn { markdown, inline, linkify };`)() as Renderer;
const { markdown, inline, linkify } = renderer;

/** Так выглядит ссылка в панели: новая вкладка и без доступа к opener. */
const link = (url: string): string =>
  `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;

test('голый адрес становится ссылкой, а не текстом', () => {
  assert.equal(
    markdown('https://www.amazon.co.uk/dp/B0CFXY26H1 — €27.58'),
    `<p>${link('https://www.amazon.co.uk/dp/B0CFXY26H1')} — €27.58</p>`,
  );
  assert.equal(
    markdown('- https://a.com/x\n- https://b.com/y'),
    `<ul><li>${link('https://a.com/x')}</li><li>${link('https://b.com/y')}</li></ul>`,
  );
});

test('разметка ссылки по-прежнему главнее голого адреса', () => {
  assert.equal(
    markdown('смотри [документацию](https://core.telegram.org/bots/api)'),
    '<p>смотри <a href="https://core.telegram.org/bots/api" target="_blank" rel="noopener noreferrer">документацию</a></p>',
  );
  // Адрес в подписи — текст подписи, а не вложенная ссылка.
  assert.equal(
    inline('[https://x.com](https://y.com)'),
    '<a href="https://y.com" target="_blank" rel="noopener noreferrer">https://x.com</a>',
  );
});

test('пунктуация вокруг адреса — не часть адреса', () => {
  assert.equal(
    inline('смотри (https://x.com/a_(b)).'),
    `смотри (${link('https://x.com/a_(b)')}).`,
  );
  assert.equal(inline('<https://x.com>'), `&lt;${link('https://x.com')}&gt;`);
  assert.equal(inline('конец https://x.com.'), `конец ${link('https://x.com')}.`);
});

test('адрес в коде остаётся кодом, а не ссылкой', () => {
  assert.equal(inline('`https://x.com`'), '<code>https://x.com</code>');
  assert.equal(markdown('```\nhttps://x.com\n```'), '<pre><code>https://x.com</code></pre>');
});

test('адрес экранируется: амперсанд не ломает ссылку и не открывает HTML', () => {
  assert.equal(
    inline('https://x.com/search?q=a&b=2'),
    `<a href="https://x.com/search?q=a&amp;b=2" target="_blank" rel="noopener noreferrer">https://x.com/search?q=a&amp;b=2</a>`,
  );
  // Сырой HTML от модели по-прежнему не проходит.
  assert.equal(inline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('жирный вокруг адреса не мешает ссылке', () => {
  assert.equal(inline('**https://t.me/**'), `<strong>${link('https://t.me/')}</strong>`);
});

test('звёздочки и подчёркивания внутри адреса — часть адреса, а не курсив', () => {
  assert.equal(inline('https://x.com/a*b*c'), link('https://x.com/a*b*c'));
  assert.equal(
    inline('https://en.wikipedia.org/wiki/Foo_bar'),
    link('https://en.wikipedia.org/wiki/Foo_bar'),
  );
});

test('опасные схемы не линкуются', () => {
  assert.equal(inline('javascript:alert(1)'), 'javascript:alert(1)');
  assert.equal(inline('[жми](javascript:alert(1))'), '[жми](javascript:alert(1))');
  assert.equal(inline('data:text/html,привет'), 'data:text/html,привет');
});

test('локальный файл из ответа — ссылка на скачивание, а не сырой markdown', () => {
  const href = '/panel/api/chat/file?path=' + encodeURIComponent('/workspaces/talk/смета.pdf');
  assert.equal(inline('[смета за март](/workspaces/talk/смета.pdf)'), `<a class="md-file" href="${href}" download>📎 смета за март</a>`);
  // Пробел в имени файла — не повод оставить ссылку текстом.
  const spaced = '/panel/api/chat/file?path=' + encodeURIComponent('/workspaces/talk/смета за март.pdf');
  assert.equal(
    inline('[смета](/workspaces/talk/смета за март.pdf)'),
    `<a class="md-file" href="${spaced}" download>📎 смета</a>`,
  );
  // Чужой путь файлом не становится: сервер его всё равно не отдаст, но и
  // притворяться ссылкой незачем — остаётся текстом, как раньше.
  assert.equal(inline('[что-то](/etc/passwd)'), '[что-то](/etc/passwd)');
  // А внешняя ссылка по-прежнему открывается в новой вкладке.
  assert.equal(
    inline('[сайт](https://example.com)'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">сайт</a>',
  );
  // Заголовок ссылки — не часть адреса.
  assert.equal(
    inline('[сайт](https://example.com "Example")'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">сайт</a>',
  );
});

test('реплика человека: HTML экранируется, а адрес всё равно ссылка', () => {
  // У реплики нет markdown — только переводы строк и ссылки.
  assert.equal(
    linkify('вот <b>адрес</b>: https://x.com.'),
    `вот &lt;b&gt;адрес&lt;/b&gt;: ${link('https://x.com')}.`,
  );
});

test('таблица из ответа модели — настоящая таблица, а не абзац с палками', () => {
  assert.equal(
    markdown('| Кто | Телефон |\n| --- | --- |\n| Plumber | +353 87 123 |'),
    '<div class="md-table"><table><thead><tr><th>Кто</th><th>Телефон</th></tr></thead>' +
      '<tbody><tr><td>Plumber</td><td>+353 87 123</td></tr></tbody></table></div>',
  );
  // Строка с | без линии-разделителя — обычный текст: пайп встречается и в нём.
  assert.equal(markdown('a | b'), '<p>a | b</p>');
});

test('внутри ячейки живёт разметка, а \\| — это литеральная палка', () => {
  const html = markdown('| **Имя** | Что делал |\n| --- | --- |\n| Аттила | пианино \\| настройка |');
  assert.match(html, /<th><strong>Имя<\/strong><\/th>/);
  assert.match(html, /<td>пианино \| настройка<\/td>/);
  // Слэш съеден: в тексте остаётся палка, а не `\|`.
  assert.doesNotMatch(html, /\\\|/);
});

test('недостающие ячейки добиваются пустыми: таблица не разваливается', () => {
  assert.equal(
    markdown('| a | b |\n| --- | --- |\n| c |'),
    '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead>' +
      '<tbody><tr><td>c</td><td></td></tr></tbody></table></div>',
  );
});
