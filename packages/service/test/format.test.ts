// Telegram markup: model markdown into HTML that the Bot API understands.
//
// We send nothing: we only check text conversion. Half of the cases here are not
// about beauty but about survival — a response arrives in chunks, and parsing must
// survive unfinished asterisks and unclosed code blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, htmlToPlain, renderHtml } from '../src/telegram/format.ts';

/** All tags are closed and nested correctly: otherwise Telegram replies "can't parse entities". */
function assertBalanced(html: string): void {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    const [, closing, name] = match;
    if (closing) {
      assert.equal(stack.pop(), name, `лишний закрывающий тег </${name}> в ${html}`);
    } else {
      stack.push(name ?? '');
    }
  }
  assert.deepEqual(stack, [], `незакрытые теги в ${html}`);
}

test('bold, italics and code use tags, not asterisks', () => {
  assert.equal(renderHtml('**Токены** и *курсив*'), '<b>Токены</b> и <i>курсив</i>');
  assert.equal(renderHtml('__тоже жирный__'), '<b>тоже жирный</b>');
  assert.equal(renderHtml('поле `client_uid` в конфиге'), 'поле <code>client_uid</code> в конфиге');
  assert.equal(renderHtml('~~стёрто~~ и ||секрет||'), '<s>стёрто</s> и <span class="tg-spoiler">секрет</span>');
  assertBalanced(renderHtml('**жирный *курсив* внутри**'));
});

test('asterisks and underscores inside words are text, not markup', () => {
  // snake_case in field names makes up half of the answers about code.
  assert.equal(renderHtml('client_salted_key_pass'), 'client_salted_key_pass');
  assert.equal(renderHtml('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
  assert.equal(renderHtml('файл *.ts и *.js'), 'файл *.ts и *.js');
});

test('HTML is escaped: the model angle brackets do not break the message', () => {
  assert.equal(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(renderHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  // Inside code we escape the same way: tags do not work there, and brackets are needed as is.
  assert.equal(renderHtml('```\nif (a < b) {}\n```'), '<pre>if (a &lt; b) {}</pre>');
});

test('unfinished markup is plain text, not a lost response', () => {
  // This is what a response still being typed looks like: a couple of markers unclosed.
  assert.equal(renderHtml('**Токены'), '**Токены');
  assert.equal(renderHtml('текст `без конца'), 'текст `без конца');
  assert.equal(renderHtml('**а *б'), '**а *б');
});

test('an unclosed code block is closed at the end: the human sees code, not asterisks', () => {
  assert.equal(renderHtml('```ts\nconst a = 1'), '<pre><code class="language-ts">const a = 1</code></pre>');
  assert.equal(renderHtml('```\nстрока\n```\nпосле'), '<pre>строка</pre>\nпосле');
  // The highlight language is only a plausible word: everything else is just code.
  assert.equal(renderHtml('```не язык\nx\n```'), '<pre>x</pre>');
});

test('a heading becomes a bold line: Telegram has no headings', () => {
  assert.equal(renderHtml('## Пароль'), '<b>Пароль</b>');
  assert.equal(renderHtml('# Раз\n\nтекст'), '<b>Раз</b>\n\nтекст');
  assert.equal(renderHtml('#хештег не заголовок'), '#хештег не заголовок');
});

test('lists use bullets, ordered lists use numbers', () => {
  assert.equal(renderHtml('- раз\n- два'), '• раз\n• два');
  assert.equal(renderHtml('1. раз\n2. два'), '1. раз\n2. два');
  assert.equal(renderHtml('- [ ] сделать\n- [x] сделано'), '• ☐ сделать\n• ☑ сделано');
  assert.equal(renderHtml('  - вложенный'), '  • вложенный');
});

test('quote, rule and link', () => {
  assert.equal(renderHtml('> цитата\n> вторая строка'), '<blockquote>цитата\nвторая строка</blockquote>');
  assert.equal(renderHtml('---'), '──────────');
  assert.equal(
    renderHtml('смотри [документацию](https://core.telegram.org/bots/api)'),
    'смотри <a href="https://core.telegram.org/bots/api">документацию</a>',
  );
  assert.equal(
    renderHtml('**жирная [ссылка](https://t.me/) внутри**'),
    '<b>жирная <a href="https://t.me/">ссылка</a> внутри</b>',
  );
});

test('dangerous link schemes do not become links', () => {
  assert.equal(renderHtml('[жми](javascript:alert(1))'), '[жми](javascript:alert(1))');
  assert.equal(renderHtml('[жми](data:text/html,привет)'), '[жми](data:text/html,привет)');
  assert.equal(renderHtml('javascript:alert(1)'), 'javascript:alert(1)');
});

test('a bare address in the text is also a link, not a line of text', () => {
  assert.equal(
    renderHtml('Радиатор: https://www.amazon.co.uk/dp/B0CFXY26H1 — €27.58'),
    'Радиатор: <a href="https://www.amazon.co.uk/dp/B0CFXY26H1">https://www.amazon.co.uk/dp/B0CFXY26H1</a> — €27.58',
  );
  assert.equal(
    renderHtml('**https://t.me/** и ещё https://x.com'),
    '<b><a href="https://t.me/">https://t.me/</a></b> и ещё <a href="https://x.com">https://x.com</a>',
  );
  // The question mark and ampersand are part of the address, and in HTML they must be escaped.
  assert.equal(
    renderHtml('https://x.com/search?q=a&b=2'),
    '<a href="https://x.com/search?q=a&amp;b=2">https://x.com/search?q=a&amp;b=2</a>',
  );
  assertBalanced(renderHtml('**https://t.me/**'));
});

test('punctuation around an address is not part of the address', () => {
  assert.equal(
    renderHtml('смотри (https://x.com/a_(b)).'),
    'смотри (<a href="https://x.com/a_(b)">https://x.com/a_(b)</a>).',
  );
  assert.equal(
    renderHtml('<https://x.com>'),
    '&lt;<a href="https://x.com">https://x.com</a>&gt;',
  );
  assert.equal(renderHtml('конец https://x.com.'), 'конец <a href="https://x.com">https://x.com</a>.');
});

test('an address in code and in a link label is not linked a second time', () => {
  assert.equal(renderHtml('`https://x.com`'), '<code>https://x.com</code>');
  assert.equal(renderHtml('```\nhttps://x.com\n```'), '<pre>https://x.com</pre>');
  // A link label is a ready `<a>`: Telegram will not accept a nested link.
  assert.equal(
    renderHtml('[https://x.com](https://y.com)'),
    '<a href="https://y.com">https://x.com</a>',
  );
});

test('an address does not start in the middle of a word', () => {
  assert.equal(renderHtml('текстhttps://x.com'), 'текстhttps://x.com');
  assert.equal(renderHtml('поле field_https://x.com'), 'поле field_https://x.com');
});

test('a table is an aligned monospace block', () => {
  const html = renderHtml('| Метрика | Значение |\n|---|--:|\n| Скорость | 42 |');
  assert.match(html, /^<pre>/, 'таблица живёт в pre: иначе колонки разъезжаются');
  assert.match(html, /Метрика/);
  assert.match(html, /Скорость\s+│\s+42/, 'числа прижаты вправо');
  assertBalanced(html);
});

test('nested markup stays nested: Telegram does not accept overlaps', () => {
  for (const source of [
    '**жирный _курсив_ жирный**',
    '**жирный `код` жирный**',
    '> цитата с **жирным** и [ссылкой](https://t.me/)',
    '`код с **звёздочками** внутри`',
  ]) {
    assertBalanced(renderHtml(source));
  }
});

test('htmlToPlain: fall back to bare text if Telegram did not like the markup', () => {
  assert.equal(htmlToPlain('<b>Токены</b> и <code>код</code>'), 'Токены и код');
  assert.equal(htmlToPlain('a &lt; b &amp; c'), 'a < b & c');
  assert.equal(htmlToPlain(renderHtml('**жирный** и `код`')), 'жирный и код');
});

test('an empty response and plain text do not turn into markup', () => {
  assert.equal(renderHtml(''), '');
  assert.equal(renderHtml('Привет, Саня'), 'Привет, Саня');
  assert.equal(renderHtml('готово\n\nи ещё'), 'готово\n\nи ещё');
});
