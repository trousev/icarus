// Разметка ответа для Telegram: markdown модели → HTML, который понимает Bot API.
//
// Telegram сам markdown не разбирает. Без `parse_mode` он честно показывает то, что
// прислали, — звёздочки, решётки и обратные кавычки. Именно это и видит человек в
// чате, когда просит «сделай красиво».
//
// Режима три. Legacy `Markdown` не умеет ни жирного из двух звёздочек, ни цитат.
// `MarkdownV2` умеет всё, но требует экранировать полтора десятка знаков — модель
// этого не делает никогда, и одна «2+2=4» в ответе роняет отправку целиком:
// «can't parse entities». `HTML` добрее: экранировать нужно ровно `<`, `>`, `&`,
// набор тегов маленький и не меняется годами. Поэтому разметку собираем сами.
//
// Заголовков, списков и таблиц в HTML-режиме Telegram нет. Рисуем их тем, что есть:
// заголовок — жирной строкой, список — буллетами, таблица — моноширинным блоком с
// выровненными колонками: иначе на телефоне строки таблицы разъезжаются в кашу.
//
// Модель отдаёт ответ кусками («**Токе», «ны**»), и каждый кусок уезжает в Telegram
// правкой. Поэтому разбор обязан переживать недописанную разметку: незакрытая пара
// маркеров — не ошибка, а обычный текст; незакрытый блок кода закрывается в конце.
// Худшее, что может случиться, — человек на секунду увидит звёздочки. Сообщение,
// которое Telegram отказался принять, — хуже.

/** Что модели пишут как разметку: обратный слеш перед этим — штатное экранирование. */
const MARKDOWN_PUNCTUATION = new Set([
  '\\', '`', '*', '_', '~', '|', '[', ']', '(', ')', '#', '-', '+', '.', '!',
]);

/** Заборка кода: ``` или ~~~, с языком или без (язык — первое слово в хвосте). */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;
/** Заголовок: `#`, `##`, … — в Telegram их нет, изображаем жирной строкой. */
const HEADING = /^ {0,3}#{1,6}\s+(.*)$/;
/** Горизонтальная черта: `---`, `***`, `___` в начале строки. */
const DIVIDER = /^ {0,3}(?:[-*_]\s*){3,}$/;
/** Цитата: строка начинается с `>`. */
const QUOTE = /^ {0,3}>\s?/;
/** Пункт списка: `- `, `* `, `+ ` или `1. ` / `1) ` — с отступом и без. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
/** Ячейка правила под шапкой таблицы: `---`, `:--`, `--:`, `:-:`. */
const TABLE_CELL_RULE = /^:?-{1,}:?$/;
/** Чем заменить `---`: черты в HTML-режиме нет, а строка нужна. */
const DIVIDER_TEXT = '──────────';

/** Разметка внутри маркеров: пара символов и то, во что она превращается. */
type Emphasis = { marker: string; open: string; close: string };

/**
 * Порядок важен: двухсимвольные маркеры разбираются раньше односимвольных, иначе
 * `**жирный**` стал бы курсивом с лишними звёздочками внутри.
 */
const EMPHASIS: Emphasis[] = [
  { marker: '**', open: '<b>', close: '</b>' },
  { marker: '__', open: '<b>', close: '</b>' },
  { marker: '~~', open: '<s>', close: '</s>' },
  { marker: '||', open: '<span class="tg-spoiler">', close: '</span>' },
  { marker: '*', open: '<i>', close: '</i>' },
  { marker: '_', open: '<i>', close: '</i>' },
];

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Экранирование текста под HTML-режим. Telegram понимает только `&lt;`, `&gt;`,
 * `&amp;` и `&quot;` — остальные именованные сущности он не знает.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Текст из готового HTML: им подменяем сообщение, если Telegram отверг разметку. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Главный вход: markdown → HTML для `parse_mode: HTML`. Функция тотальна — на любом
 * входе возвращает строку, которую Telegram примет или (в крайнем случае) отвергнет,
 * но не бросает исключение посреди ответа.
 */
export function renderHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence) {
      const block = takeCode(lines, index, fence[1] ?? '```', fence[2] ?? '');
      out.push(block.html);
      index = block.next;
      continue;
    }

    if (isTable(lines, index)) {
      const table = takeTable(lines, index);
      out.push(table.html);
      index = table.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1] ?? '')}</b>`);
      index += 1;
      continue;
    }

    if (DIVIDER.test(line)) {
      out.push(DIVIDER_TEXT);
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quote = takeQuote(lines, index);
      out.push(quote.html);
      index = quote.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = takeList(lines, index);
      out.push(list.html);
      index = list.next;
      continue;
    }

    // Пустую строку оставляем пустой: это разделитель абзацев, а не текст.
    out.push(line.trim() === '' ? '' : inline(line));
    index += 1;
  }

  return out.join('\n');
}

/** Блок кода. Незакрытая заборка — это ещё не дописанный ответ, а не ошибка. */
function takeCode(lines: string[], start: number, marker: string, language: string): { html: string; next: number } {
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const close = FENCE.exec(line);
    // Закрывающая заборка — тот же знак, без языка: «```» после «```python».
    if (close && close[1]?.startsWith(marker[0] ?? '`') && (close[2] ?? '') === '') break;
    body.push(line);
    index += 1;
  }

  const code = escapeHtml(body.join('\n'));
  // Язык подсветки — первое слово хвоста, и только правдоподобное: Telegram ждёт
  // имя языка, а не фразу вроде «не язык».
  const name = language.trim().split(/\s+/)[0] ?? '';
  const tag = /^[\w+#.-]+$/.test(name)
    ? `<pre><code class="language-${name}">${code}</code></pre>`
    : `<pre>${code}</pre>`;

  return { html: tag, next: index < lines.length ? index + 1 : index };
}

/** Цитата: подряд идущие строки с `>`. Внутри разметку разбираем как обычно. */
function takeQuote(lines: string[], start: number): { html: string; next: number } {
  const body: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!QUOTE.test(line)) break;
    body.push(inline(line.replace(QUOTE, '')));
    index += 1;
  }
  return { html: `<blockquote>${body.join('\n')}</blockquote>`, next: index };
}

/**
 * Список: подряд идущие пункты. Своего тега у Telegram нет, поэтому пункт — это
 * буллет (или номер, если человек писал нумерованный список) и отступ.
 */
function takeList(lines: string[], start: number): { html: string; next: number } {
  const out: string[] = [];
  let index = start;
  while (index < lines.length) {
    const item = LIST_ITEM.exec(lines[index] ?? '');
    if (!item) break;

    const indent = (item[1] ?? '').replace(/\t/g, '  ').length;
    const marker = item[2] ?? '-';
    const body = item[3] ?? '';

    // Флажок задачи: `- [ ]` / `- [x]`. Своего тега тоже нет — рисуем знаком.
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(body);
    const bullet = /^\d/.test(marker) ? `${marker.replace(/[.)]$/, '')}.` : '•';
    const text = task ? `${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2] ?? '')}` : inline(body);

    out.push(`${'  '.repeat(Math.min(Math.floor(indent / 2), 4))}${bullet} ${text}`);
    index += 1;
  }
  return { html: out.join('\n'), next: index };
}

/** Таблица ли это: строка с `|`, под ней линейка из `---`. */
function isTable(lines: string[], index: number): boolean {
  const head = lines[index] ?? '';
  const rule = lines[index + 1] ?? '';
  if (!head.includes('|') || !rule.includes('|')) return false;
  const cells = splitRow(rule);
  return cells.length > 0 && cells.every((cell) => TABLE_CELL_RULE.test(cell.trim()));
}

/**
 * Таблица → моноширинный блок с выровненными колонками. Так она хотя бы остаётся
 * таблицей: в обычном тексте на телефоне колонки разъезжаются в кашу.
 */
function takeTable(lines: string[], start: number): { html: string; next: number } {
  const body: string[] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.includes('|') || line.trim() === '') break;
    body.push(line);
    index += 1;
  }

  // Внутри `<pre>` другая разметка не работает, поэтому из ячеек берём голый текст.
  const grid = [lines[start] ?? '', ...body].map((line) =>
    splitRow(line).map((cell) => htmlToPlain(inline(cell))),
  );
  const columns = Math.max(...grid.map((row) => row.length), 1);
  for (const row of grid) while (row.length < columns) row.push('');

  const align = splitRow(lines[start + 1] ?? '').map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });

  const widths: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    widths.push(Math.min(28, Math.max(3, ...grid.map((row) => (row[column] ?? '').length))));
  }

  // Широкая таблица в предпросмотре всё равно не влезет в экран: не растягиваем.
  const total = widths.reduce((sum, width) => sum + width, 0) + 3 * (columns - 1);
  const rendered = total <= 72 ? padGrid(grid, widths, align) : grid.map((row) => row.join(' │ '));

  const rule = widths.map((width) => '─'.repeat(width)).join('─┼─');
  const [head, ...rest] = rendered;
  const text = [head ?? '', rule, ...rest].join('\n');
  return { html: `<pre>${escapeHtml(text)}</pre>`, next: index };
}

function padGrid(grid: string[][], widths: number[], align: string[]): string[] {
  return grid.map((row) =>
    row
      .map((cell, column) => {
        const width = widths[column] ?? cell.length;
        const cut = cell.length > width ? `${cell.slice(0, width - 1)}…` : cell;
        const gap = width - cut.length;
        if (align[column] === 'right') return `${' '.repeat(gap)}${cut}`;
        if (align[column] === 'center') {
          const left = Math.floor(gap / 2);
          return `${' '.repeat(left)}${cut}${' '.repeat(gap - left)}`;
        }
        return `${cut}${' '.repeat(gap)}`;
      })
      .join(' │ '),
  );
}

/** Ячейки строки таблицы: `| a | b |` → ['a', 'b']; пустые края отбрасываем. */
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((cell) => cell.trim());
}

/** Разметка в строке: код, ссылки, жирный, курсив, зачёркнутый, спойлер. */
function inline(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? '';

    // Обратный слеш — штатное экранирование markdown: `\*` — это звёздочка, не курсив.
    const next = text[index + 1];
    if (char === '\\' && next !== undefined && MARKDOWN_PUNCTUATION.has(next)) {
      out += escapeHtml(next);
      index += 2;
      continue;
    }

    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index + 1) {
        out += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (char === '[') {
      const link = linkAt(text, index);
      if (link) {
        out += link.html;
        index = link.next;
        continue;
      }
    }

    const emphasis = emphasisAt(text, index);
    if (emphasis) {
      out += emphasis.html;
      index = emphasis.next;
      continue;
    }

    out += escapeHtml(char);
    index += 1;
  }

  return out;
}

/** Ссылка `[текст](адрес)`. Прочие схемы не пропускаем: `javascript:` в чате не нужен. */
function linkAt(text: string, index: number): { html: string; next: number } | null {
  const label = text.indexOf(']', index + 1);
  if (label === -1 || text[label + 1] !== '(') return null;
  const end = text.indexOf(')', label + 2);
  if (end === -1) return null;

  const url = text.slice(label + 2, end).trim();
  if (!/^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(url)) return null;

  const href = escapeHtml(url).replace(/"/g, '&quot;');
  return { html: `<a href="${href}">${inline(text.slice(index + 1, label))}</a>`, next: end + 1 };
}

/** Пара маркеров вокруг текста — если она в этой строке закрыта. */
function emphasisAt(text: string, index: number): { html: string; next: number } | null {
  for (const { marker, open, close } of EMPHASIS) {
    if (!text.startsWith(marker, index)) continue;
    // `**` разбирается раньше `*`: одиночный маркер не должен открывать половину пары.
    if (marker.length === 1 && text.startsWith(marker + marker, index)) continue;
    if (!canOpen(text, index, marker)) continue;

    const end = findClose(text, index + marker.length, marker);
    if (end === -1) continue;
    return { html: `${open}${inline(text.slice(index + marker.length, end))}${close}`, next: end + marker.length };
  }
  return null;
}

/**
 * Может ли маркер открыть разметку: за ним идёт текст, а перед ним — не буква.
 * Второе правило бережёт `snake_case` и `x_y_z` от превращения в курсив.
 */
function canOpen(text: string, index: number, marker: string): boolean {
  const after = text[index + marker.length];
  if (after === undefined || /\s/.test(after)) return false;
  const before = text[index - 1];
  if (before !== undefined && isWordChar(before)) return false;
  return true;
}

/** Может ли маркер закрыть разметку: перед ним текст, а не пробел. */
function canClose(text: string, index: number): boolean {
  const before = text[index - 1];
  if (before === undefined || /\s/.test(before)) return false;
  return true;
}

/** Ищем закрывающий маркер в той же строке: код и экранирование внутри не считаем. */
function findClose(text: string, from: number, marker: string): number {
  let index = from;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith(marker, index)) {
      // Одиночный маркер не должен съесть половину двойного: `**a**` — это жирный.
      const doubled = marker.length === 1 && (text[index + 1] === marker || text[index - 1] === marker);
      if (!doubled && canClose(text, index)) return index;
    }
    index += 1;
  }
  return -1;
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}
