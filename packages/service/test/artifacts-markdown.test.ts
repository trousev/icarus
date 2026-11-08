// Markdown артефакта: документ, а не чат. Файл клиентский и без сборки, поэтому
// тест берёт исходник как есть и проверяет ровно тот код, который уедет в браузер.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../src/control/artifacts-markdown.js', import.meta.url), 'utf8');
type Options = { fileBase?: string };
const renderer = new Function(`${SOURCE}\nreturn { artifactMarkdown };`)() as {
  artifactMarkdown: (text: string, options?: Options) => string;
};
const render = renderer.artifactMarkdown;
/** Между блоками рендер ставит перевод строки: для сравнения он не важен. */
const compact = (html: string): string => html.replace(/\n/g, '');

test('заголовки документа — настоящие h1–h6, а не чатовые h3', () => {
  assert.equal(render('# План на четверг'), '<h1>План на четверг</h1>');
  assert.equal(render('## Риски'), '<h2>Риски</h2>');
  assert.equal(render('### Шаги'), '<h3>Шаги</h3>');
});

test('списки, цитата и таблица остаются структурой', () => {
  assert.equal(compact(render('1. Стендап\n2. Демо')), '<ol><li>Стендап</li><li>Демо</li></ol>');
  assert.equal(compact(render('- один\n- два')), '<ul><li>один</li><li>два</li></ul>');
  // Вложенный список живёт внутри своего пункта, а не рядом с ним.
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

test('в ячейке таблицы живёт разметка, а \\| — литеральная палка', () => {
  const html = render('| **шаг** | что |\n| --- | --- |\n| миграция | схема \\| данные |');
  assert.match(html, /<th><strong>шаг<\/strong><\/th>/);
  assert.match(html, /<td>схема \| данные<\/td>/);
  assert.doesNotMatch(html, /\\\|/);
  // Меньше ячеек, чем в шапке, — таблица не разваливается.
  assert.equal(
    compact(render('| a | b |\n| --- | --- |\n| c |')),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td></td></tr></tbody></table>',
  );
});

test('картинки и ссылки внутри артефакта ведут в его же папку', () => {
  assert.equal(
    render('![схема](images/scheme.png)', { fileBase: '/raw/site/' }),
    '<p><img src="/raw/site/images/scheme.png" alt="схема"></p>',
  );
  assert.equal(
    render('[отчёт](report.html)', { fileBase: '/raw/site/' }),
    '<p><a href="/raw/site/report.html" target="_blank" rel="noopener noreferrer">отчёт</a></p>',
  );
  // Внешние адреса не переписываются.
  assert.match(render('[сайт](https://example.com)'), /href="https:\/\/example\.com"/);
});

test('сырой HTML в markdown не проходит', () => {
  assert.equal(render('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.doesNotMatch(render('<img src=x onerror=alert(1)>'), /<img src=x/);
});

test('опасные схемы ссылок и картинок не проходят', () => {
  assert.doesNotMatch(render('[жми](javascript:alert(1))'), /javascript:/);
  assert.match(render('[жми](javascript:alert(1))'), /href="#"/);
  assert.doesNotMatch(render('![x](javascript:alert(1))'), /javascript:/);
  // data: — только для картинок и только image/*.
  assert.match(render('![x](data:image/png;base64,AAAA)'), /src="data:image\/png/);
  assert.doesNotMatch(render('[x](data:text/html;base64,AAAA)'), /data:text/);
});

test('код, жирный и зачёркнутый — без потери текста', () => {
  assert.equal(render('`npm test`'), '<p><code>npm test</code></p>');
  assert.equal(render('**готово** и ~~старое~~'), '<p><strong>готово</strong> и <del>старое</del></p>');
  assert.equal(render('```\nconst x = 1;\n```'), '<pre><code>const x = 1;</code></pre>');
});

test('горизонтальная линия и пустой документ не ломают страницу', () => {
  assert.equal(render('---'), '<hr>');
  assert.equal(render(''), '<p></p>');
});
