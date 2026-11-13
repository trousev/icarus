// Chat panel markup: model markdown into safe HTML. The file is client-side and
// build-free, so we take its source as is and extract functions from the scope —
// the test checks exactly the code that ships to the browser.
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

/** This is what a link looks like in the panel: new tab and no access to opener. */
const link = (url: string): string =>
  `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;

test('a bare address becomes a link, not text', () => {
  assert.equal(
    markdown('https://www.amazon.co.uk/dp/B0CFXY26H1 — €27.58'),
    `<p>${link('https://www.amazon.co.uk/dp/B0CFXY26H1')} — €27.58</p>`,
  );
  assert.equal(
    markdown('- https://a.com/x\n- https://b.com/y'),
    `<ul><li>${link('https://a.com/x')}</li><li>${link('https://b.com/y')}</li></ul>`,
  );
});

test('link markup still takes precedence over a bare address', () => {
  assert.equal(
    markdown('смотри [документацию](https://core.telegram.org/bots/api)'),
    '<p>смотри <a href="https://core.telegram.org/bots/api" target="_blank" rel="noopener noreferrer">документацию</a></p>',
  );
  // An address in the label is label text, not a nested link.
  assert.equal(
    inline('[https://x.com](https://y.com)'),
    '<a href="https://y.com" target="_blank" rel="noopener noreferrer">https://x.com</a>',
  );
});

test('punctuation around an address is not part of the address', () => {
  assert.equal(
    inline('смотри (https://x.com/a_(b)).'),
    `смотри (${link('https://x.com/a_(b)')}).`,
  );
  assert.equal(inline('<https://x.com>'), `&lt;${link('https://x.com')}&gt;`);
  assert.equal(inline('конец https://x.com.'), `конец ${link('https://x.com')}.`);
});

test('an address in code stays code, not a link', () => {
  assert.equal(inline('`https://x.com`'), '<code>https://x.com</code>');
  assert.equal(markdown('```\nhttps://x.com\n```'), '<pre><code>https://x.com</code></pre>');
});

test('an address is escaped: an ampersand does not break the link or open HTML', () => {
  assert.equal(
    inline('https://x.com/search?q=a&b=2'),
    `<a href="https://x.com/search?q=a&amp;b=2" target="_blank" rel="noopener noreferrer">https://x.com/search?q=a&amp;b=2</a>`,
  );
  // Raw HTML from the model still does not pass.
  assert.equal(inline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('bold around an address does not break the link', () => {
  assert.equal(inline('**https://t.me/**'), `<strong>${link('https://t.me/')}</strong>`);
});

test('asterisks and underscores inside an address are part of the address, not italics', () => {
  assert.equal(inline('https://x.com/a*b*c'), link('https://x.com/a*b*c'));
  assert.equal(
    inline('https://en.wikipedia.org/wiki/Foo_bar'),
    link('https://en.wikipedia.org/wiki/Foo_bar'),
  );
});

test('dangerous schemes are not linked', () => {
  assert.equal(inline('javascript:alert(1)'), 'javascript:alert(1)');
  assert.equal(inline('[жми](javascript:alert(1))'), '[жми](javascript:alert(1))');
  assert.equal(inline('data:text/html,привет'), 'data:text/html,привет');
});

test('a local file from the response is a download link, not raw markdown', () => {
  const href = '/panel/api/chat/file?path=' + encodeURIComponent('/workspaces/talk/смета.pdf');
  assert.equal(inline('[смета за март](/workspaces/talk/смета.pdf)'), `<a class="md-file" href="${href}" download>📎 смета за март</a>`);
  // A space in the file name is no reason to leave the link as text.
  const spaced = '/panel/api/chat/file?path=' + encodeURIComponent('/workspaces/talk/смета за март.pdf');
  assert.equal(
    inline('[смета](/workspaces/talk/смета за март.pdf)'),
    `<a class="md-file" href="${spaced}" download>📎 смета</a>`,
  );
  // Someone else's path does not become a file: the server will not serve it
  // anyway, and there is no point pretending it is a link — it stays text, as before.
  assert.equal(inline('[что-то](/etc/passwd)'), '[что-то](/etc/passwd)');
  // And an external link still opens in a new tab.
  assert.equal(
    inline('[сайт](https://example.com)'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">сайт</a>',
  );
  // A link title is not part of the address.
  assert.equal(
    inline('[сайт](https://example.com "Example")'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">сайт</a>',
  );
});

test('a human message: HTML is escaped, but an address is still a link', () => {
  // A human message has no markdown — only line breaks and links.
  assert.equal(
    linkify('вот <b>адрес</b>: https://x.com.'),
    `вот &lt;b&gt;адрес&lt;/b&gt;: ${link('https://x.com')}.`,
  );
});

test('a table from the model response is a real table, not a paragraph with pipes', () => {
  assert.equal(
    markdown('| Кто | Телефон |\n| --- | --- |\n| Plumber | +353 87 123 |'),
    '<div class="md-table"><table><thead><tr><th>Кто</th><th>Телефон</th></tr></thead>' +
      '<tbody><tr><td>Plumber</td><td>+353 87 123</td></tr></tbody></table></div>',
  );
  // A line with | but no separator row is plain text: a pipe also occurs in it.
  assert.equal(markdown('a | b'), '<p>a | b</p>');
});

test('markup lives inside a cell, and \\| is a literal pipe', () => {
  const html = markdown('| **Имя** | Что делал |\n| --- | --- |\n| Аттила | пианино \\| настройка |');
  assert.match(html, /<th><strong>Имя<\/strong><\/th>/);
  assert.match(html, /<td>пианино \| настройка<\/td>/);
  // The slash is eaten: the text keeps a pipe, not `\|`.
  assert.doesNotMatch(html, /\\\|/);
});

test('missing cells are padded with empty ones: the table does not fall apart', () => {
  assert.equal(
    markdown('| a | b |\n| --- | --- |\n| c |'),
    '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead>' +
      '<tbody><tr><td>c</td><td></td></tr></tbody></table></div>',
  );
});
