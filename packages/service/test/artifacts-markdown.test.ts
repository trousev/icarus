// Markdown of an artifact: a document, not a chat. The file is client-side and buildless, so
// the test takes the source as is and checks exactly the code that ships to the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../src/control/artifacts-markdown.js', import.meta.url), 'utf8');
type Options = { fileBase?: string };
const renderer = new Function(`${SOURCE}\nreturn { artifactMarkdown };`)() as {
  artifactMarkdown: (text: string, options?: Options) => string;
};
const render = renderer.artifactMarkdown;
/** Between blocks the renderer puts a newline: it does not matter for comparison. */
const compact = (html: string): string => html.replace(/\n/g, '');

test('document headings are real h1–h6, not chat h3', () => {
  assert.equal(render('# План на четверг'), '<h1>План на четверг</h1>');
  assert.equal(render('## Риски'), '<h2>Риски</h2>');
  assert.equal(render('### Шаги'), '<h3>Шаги</h3>');
});

test('lists, quote and table stay structure', () => {
  assert.equal(compact(render('1. Стендап\n2. Демо')), '<ol><li>Стендап</li><li>Демо</li></ol>');
  assert.equal(compact(render('- один\n- два')), '<ul><li>один</li><li>два</li></ul>');
  // A nested list lives inside its item, not next to it.
  assert.equal(
    compact(render('- один\n  - вложенный\n- два')),
    '<ul><li>один<ul><li>вложенный</li></ul></li><li>два</li></ul>',
  );
  assert.equal(
    compact(render('| шаг | кто |\n| --- | --- |\n| миграция | Дмитрий |')),
    '<table><thead><tr><th>шаг</th><th>кто</th></tr></thead><tbody><tr><td>миграция</td><td>Дмитрий</td></tr></tbody></table>',
  );
  assert.equal(
    compact(render('> Стоматолог перенесён')),
    '<blockquote>Стоматолог перенесён</blockquote>',
  );
});

test('markup lives in a table cell, and \\| is a literal pipe', () => {
  const html = render('| **шаг** | что |\n| --- | --- |\n| миграция | схема \\| данные |');
  assert.match(html, /<th><strong>шаг<\/strong><\/th>/);
  assert.match(html, /<td>схема \| данные<\/td>/);
  assert.doesNotMatch(html, /\\\|/);
  // Fewer cells than in the header — the table does not break apart.
  assert.equal(
    compact(render('| a | b |\n| --- | --- |\n| c |')),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td></td></tr></tbody></table>',
  );
});

test('images and links inside an artifact lead to its own folder', () => {
  assert.equal(
    render('![схема](images/scheme.png)', { fileBase: '/raw/site/' }),
    '<p><img src="/raw/site/images/scheme.png" alt="схема"></p>',
  );
  assert.equal(
    render('[отчёт](report.html)', { fileBase: '/raw/site/' }),
    '<p><a href="/raw/site/report.html" target="_blank" rel="noopener noreferrer">отчёт</a></p>',
  );
  // External addresses are not rewritten.
  assert.match(render('[сайт](https://example.com)'), /href="https:\/\/example\.com"/);
});

test('raw HTML in markdown does not pass', () => {
  assert.equal(render('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.doesNotMatch(render('<img src=x onerror=alert(1)>'), /<img src=x/);
});

test('dangerous link and image schemes do not pass', () => {
  assert.doesNotMatch(render('[жми](javascript:alert(1))'), /javascript:/);
  assert.match(render('[жми](javascript:alert(1))'), /href="#"/);
  assert.doesNotMatch(render('![x](javascript:alert(1))'), /javascript:/);
  // data: — only for images and only image/*.
  assert.match(render('![x](data:image/png;base64,AAAA)'), /src="data:image\/png/);
  assert.doesNotMatch(render('[x](data:text/html;base64,AAAA)'), /data:text/);
});

test('code, bold and strikethrough — without losing text', () => {
  assert.equal(render('`npm test`'), '<p><code>npm test</code></p>');
  assert.equal(render('**готово** и ~~старое~~'), '<p><strong>готово</strong> и <del>старое</del></p>');
  assert.equal(render('```\nconst x = 1;\n```'), '<pre><code>const x = 1;</code></pre>');
});

test('a horizontal rule and an empty document do not break the page', () => {
  assert.equal(render('---'), '<hr>');
  assert.equal(render(''), '<p></p>');
});
