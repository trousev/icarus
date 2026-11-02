// Разметка для Telegram: markdown модели — в HTML, который понимает Bot API.
//
// Ничего не отправляем: проверяем только превращение текста. Половина случаев здесь
// не про красоту, а про выживание — ответ приезжает кусками, и разбор обязан
// переживать недописанные звёздочки и незакрытые блоки кода.
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, htmlToPlain, renderHtml } from '../src/telegram/format.ts';

/** Все теги закрыты и вложены правильно: иначе Telegram ответит «can't parse entities». */
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

test('жирный, курсив и код — тегами, а не звёздочками', () => {
  assert.equal(renderHtml('**Токены** и *курсив*'), '<b>Токены</b> и <i>курсив</i>');
  assert.equal(renderHtml('__тоже жирный__'), '<b>тоже жирный</b>');
  assert.equal(renderHtml('поле `client_uid` в конфиге'), 'поле <code>client_uid</code> в конфиге');
  assert.equal(renderHtml('~~стёрто~~ и ||секрет||'), '<s>стёрто</s> и <span class="tg-spoiler">секрет</span>');
  assertBalanced(renderHtml('**жирный *курсив* внутри**'));
});

test('звёздочки и подчёркивания внутри слов — это текст, а не разметка', () => {
  // snake_case в именах полей — половина ответов про код.
  assert.equal(renderHtml('client_salted_key_pass'), 'client_salted_key_pass');
  assert.equal(renderHtml('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
  assert.equal(renderHtml('файл *.ts и *.js'), 'файл *.ts и *.js');
});

test('HTML экранируется: угловые скобки модели не ломают сообщение', () => {
  assert.equal(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(renderHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  // Внутри кода экранируем так же: там теги не работают, а скобки нужны как есть.
  assert.equal(renderHtml('```\nif (a < b) {}\n```'), '<pre>if (a &lt; b) {}</pre>');
});

test('недописанная разметка — обычный текст, а не потерянный ответ', () => {
  // Так выглядит ответ, который ещё печатается: пара маркеров не закрыта.
  assert.equal(renderHtml('**Токены'), '**Токены');
  assert.equal(renderHtml('текст `без конца'), 'текст `без конца');
  assert.equal(renderHtml('**а *б'), '**а *б');
});

test('незакрытый блок кода закрывается в конце: человек видит код, а не звёздочки', () => {
  assert.equal(renderHtml('```ts\nconst a = 1'), '<pre><code class="language-ts">const a = 1</code></pre>');
  assert.equal(renderHtml('```\nстрока\n```\nпосле'), '<pre>строка</pre>\nпосле');
  // Язык подсветки — только правдоподобное слово: остальное просто кодом.
  assert.equal(renderHtml('```не язык\nx\n```'), '<pre>x</pre>');
});

test('заголовок становится жирной строкой: заголовков в Telegram нет', () => {
  assert.equal(renderHtml('## Пароль'), '<b>Пароль</b>');
  assert.equal(renderHtml('# Раз\n\nтекст'), '<b>Раз</b>\n\nтекст');
  assert.equal(renderHtml('#хештег не заголовок'), '#хештег не заголовок');
});

test('списки — буллетами, нумерованные — номерами', () => {
  assert.equal(renderHtml('- раз\n- два'), '• раз\n• два');
  assert.equal(renderHtml('1. раз\n2. два'), '1. раз\n2. два');
  assert.equal(renderHtml('- [ ] сделать\n- [x] сделано'), '• ☐ сделать\n• ☑ сделано');
  assert.equal(renderHtml('  - вложенный'), '  • вложенный');
});

test('цитата, черта и ссылка', () => {
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

test('опасные схемы ссылок не становятся ссылками', () => {
  assert.equal(renderHtml('[жми](javascript:alert(1))'), '[жми](javascript:alert(1))');
  assert.equal(renderHtml('[жми](data:text/html,привет)'), '[жми](data:text/html,привет)');
  assert.equal(renderHtml('javascript:alert(1)'), 'javascript:alert(1)');
});

test('голый адрес в тексте — тоже ссылка, а не строчка текста', () => {
  assert.equal(
    renderHtml('Радиатор: https://www.amazon.co.uk/dp/B0CFXY26H1 — €27.58'),
    'Радиатор: <a href="https://www.amazon.co.uk/dp/B0CFXY26H1">https://www.amazon.co.uk/dp/B0CFXY26H1</a> — €27.58',
  );
  assert.equal(
    renderHtml('**https://t.me/** и ещё https://x.com'),
    '<b><a href="https://t.me/">https://t.me/</a></b> и ещё <a href="https://x.com">https://x.com</a>',
  );
  // Вопросительный знак и амперсанд — часть адреса, и в HTML их надо экранировать.
  assert.equal(
    renderHtml('https://x.com/search?q=a&b=2'),
    '<a href="https://x.com/search?q=a&amp;b=2">https://x.com/search?q=a&amp;b=2</a>',
  );
  assertBalanced(renderHtml('**https://t.me/**'));
});

test('пунктуация вокруг адреса — не часть адреса', () => {
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

test('адрес в коде и в подписи ссылки не линкуется второй раз', () => {
  assert.equal(renderHtml('`https://x.com`'), '<code>https://x.com</code>');
  assert.equal(renderHtml('```\nhttps://x.com\n```'), '<pre>https://x.com</pre>');
  // Подпись ссылки — готовый `<a>`: вложенную ссылку Telegram не примет.
  assert.equal(
    renderHtml('[https://x.com](https://y.com)'),
    '<a href="https://y.com">https://x.com</a>',
  );
});

test('адрес не начинается посреди слова', () => {
  assert.equal(renderHtml('текстhttps://x.com'), 'текстhttps://x.com');
  assert.equal(renderHtml('поле field_https://x.com'), 'поле field_https://x.com');
});

test('таблица — выровненный моноширинный блок', () => {
  const html = renderHtml('| Метрика | Значение |\n|---|--:|\n| Скорость | 42 |');
  assert.match(html, /^<pre>/, 'таблица живёт в pre: иначе колонки разъезжаются');
  assert.match(html, /Метрика/);
  assert.match(html, /Скорость\s+│\s+42/, 'числа прижаты вправо');
  assertBalanced(html);
});

test('вложенная разметка остаётся вложенной: Telegram не принимает пересечения', () => {
  for (const source of [
    '**жирный _курсив_ жирный**',
    '**жирный `код` жирный**',
    '> цитата с **жирным** и [ссылкой](https://t.me/)',
    '`код с **звёздочками** внутри`',
  ]) {
    assertBalanced(renderHtml(source));
  }
});

test('htmlToPlain: откат на голый текст, если разметка не понравилась Telegram', () => {
  assert.equal(htmlToPlain('<b>Токены</b> и <code>код</code>'), 'Токены и код');
  assert.equal(htmlToPlain('a &lt; b &amp; c'), 'a < b & c');
  assert.equal(htmlToPlain(renderHtml('**жирный** и `код`')), 'жирный и код');
});

test('пустой ответ и просто текст не превращаются в разметку', () => {
  assert.equal(renderHtml(''), '');
  assert.equal(renderHtml('Привет, Саня'), 'Привет, Саня');
  assert.equal(renderHtml('готово\n\nи ещё'), 'готово\n\nи ещё');
});
