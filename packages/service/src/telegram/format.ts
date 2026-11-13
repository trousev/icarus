// Response markup for Telegram: model markdown → HTML that the Bot API understands.
//
// Telegram itself does not parse markdown. Without `parse_mode` it honestly shows what
// was sent — asterisks, hashes and backticks. That is exactly what a person sees in the
// chat when asking to "make it pretty".
//
// There are three modes. Legacy `Markdown` can do neither bold from two asterisks nor quotes.
// `MarkdownV2` can do everything, but requires escaping a dozen and a half characters — the model
// never does this, and one "2+2=4" in the answer brings the whole send down:
// "can't parse entities". `HTML` is kinder: exactly `<`, `>`, `&` need escaping,
// the set of tags is small and has not changed for years. That's why we build the markup ourselves.
//
// There are no headings, lists and tables in Telegram's HTML mode. We draw them with what we have:
// a heading — with a bold line, a list — with bullets, a table — with a monospaced block with
// aligned columns: otherwise on a phone the table rows fall apart into mush.
//
// The model gives the answer in pieces ("**Токе", "ны**"), and each piece goes to Telegram as an
// edit. Therefore the parser must survive unfinished markup: an unclosed pair of
// markers is not an error but ordinary text; an unclosed code block is closed at the end.
// The worst that can happen is a person seeing asterisks for a second. A message that
// Telegram refused to accept is worse.

/** What models write as markup: a backslash before this is standard escaping. */
const MARKDOWN_PUNCTUATION = new Set([
  '\\', '`', '*', '_', '~', '|', '[', ']', '(', ')', '#', '-', '+', '.', '!',
]);

/** Code fence: ``` or ~~~, with or without a language (the language is the first word in the tail). */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;
/** Heading: `#`, `##`, … — Telegram has none, we depict them with a bold line. */
const HEADING = /^ {0,3}#{1,6}\s+(.*)$/;
/** Horizontal rule: `---`, `***`, `___` at the beginning of a line. */
const DIVIDER = /^ {0,3}(?:[-*_]\s*){3,}$/;
/** Quote: the line starts with `>`. */
const QUOTE = /^ {0,3}>\s?/;
/** List item: `- `, `* `, `+ ` or `1. ` / `1) ` — with and without indentation. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
/** Rule cell under the table header: `---`, `:--`, `--:`, `:-:`. */
const TABLE_CELL_RULE = /^:?-{1,}:?$/;
/** What to replace `---` with: there is no rule in HTML mode, but the line is needed. */
const DIVIDER_TEXT = '──────────';

/** Markup inside markers: a pair of characters and what it turns into. */
type Emphasis = { marker: string; open: string; close: string };

/**
 * Order matters: two-character markers are parsed before one-character ones, otherwise
 * `**bold**` would become italic with extra asterisks inside.
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
 * Escaping text for HTML mode. Telegram understands only `&lt;`, `&gt;`,
 * `&amp;` and `&quot;` — other named entities it does not know.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Text from ready HTML: we substitute it into the message if Telegram rejected the markup. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Main entry: markdown → HTML for `parse_mode: HTML`. The function is total — on any
 * input it returns a string that Telegram will accept or (in the worst case) reject,
 * but never throws an exception in the middle of the answer.
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

    // We leave an empty line empty: it is a paragraph separator, not text.
    out.push(line.trim() === '' ? '' : inline(line));
    index += 1;
  }

  return out.join('\n');
}

/** Code block. An unclosed fence is an answer not yet finished, not an error. */
function takeCode(lines: string[], start: number, marker: string, language: string): { html: string; next: number } {
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const close = FENCE.exec(line);
    // The closing fence is the same sign, without a language: "```" after "```python".
    if (close && close[1]?.startsWith(marker[0] ?? '`') && (close[2] ?? '') === '') break;
    body.push(line);
    index += 1;
  }

  const code = escapeHtml(body.join('\n'));
  // The highlighting language is the first word of the tail, and only a plausible one: Telegram
  // expects a language name, not a phrase like "not a language".
  const name = language.trim().split(/\s+/)[0] ?? '';
  const tag = /^[\w+#.-]+$/.test(name)
    ? `<pre><code class="language-${name}">${code}</code></pre>`
    : `<pre>${code}</pre>`;

  return { html: tag, next: index < lines.length ? index + 1 : index };
}

/** Quote: consecutive lines with `>`. Inside, markup is parsed as usual. */
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
 * List: consecutive items. Telegram has no tag of its own, so an item is a
 * bullet (or a number, if the person wrote a numbered list) and indentation.
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

    // Task checkbox: `- [ ]` / `- [x]`. There is no tag either — we draw it with a sign.
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(body);
    const bullet = /^\d/.test(marker) ? `${marker.replace(/[.)]$/, '')}.` : '•';
    const text = task ? `${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2] ?? '')}` : inline(body);

    out.push(`${'  '.repeat(Math.min(Math.floor(indent / 2), 4))}${bullet} ${text}`);
    index += 1;
  }
  return { html: out.join('\n'), next: index };
}

/** Is this a table: a line with `|`, under it a ruler of `---`. */
function isTable(lines: string[], index: number): boolean {
  const head = lines[index] ?? '';
  const rule = lines[index + 1] ?? '';
  if (!head.includes('|') || !rule.includes('|')) return false;
  const cells = splitRow(rule);
  return cells.length > 0 && cells.every((cell) => TABLE_CELL_RULE.test(cell.trim()));
}

/**
 * Table → monospaced block with aligned columns. This way it at least remains a
 * table: in ordinary text on a phone the columns fall apart into mush.
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

  // Inside `<pre>` other markup does not work, so from the cells we take bare text.
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

  // A wide table will not fit the screen in the preview anyway: we do not stretch it.
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

/** Table row cells: `| a | b |` → ['a', 'b']; we drop empty edges. */
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((cell) => cell.trim());
}

/** Markup in a line: code, links, bold, italic, strikethrough, spoiler. */
function inline(text: string, links = true): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? '';

    // A backslash is standard markdown escaping: `\*` is an asterisk, not italic.
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

    // Inside a link label we do not open a second link: Telegram does not accept
    // nested `<a>` and rejects the markup entirely.
    if (links && char === '[') {
      const link = linkAt(text, index);
      if (link) {
        out += link.html;
        index = link.next;
        continue;
      }
    }

    if (links) {
      const link = urlAt(text, index);
      if (link) {
        out += link.html;
        index = link.next;
        continue;
      }
    }

    const emphasis = emphasisAt(text, index, links);
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

/** Link `[text](address)`. We do not allow other schemes: `javascript:` is not needed in chat. */
function linkAt(text: string, index: number): { html: string; next: number } | null {
  const label = text.indexOf(']', index + 1);
  if (label === -1 || text[label + 1] !== '(') return null;
  const end = text.indexOf(')', label + 2);
  if (end === -1) return null;

  const url = text.slice(label + 2, end).trim();
  if (!/^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(url)) return null;

  const href = escapeHtml(url).replace(/"/g, '&quot;');
  return { html: `<a href="${href}">${inline(text.slice(index + 1, label), false)}</a>`, next: end + 1 };
}

/** What can be placed at the end of an address but does not belong to it. */
const URL_TAIL = /[?!.,:*_~]/;
/** Paired bracket: the closing one stays in the address only if the opening one is also there. */
const URL_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * A bare address in the text: `https://…` is a link, even if the model forgot about
 * `[text](…)`. Without this a person sees an address that cannot be clicked.
 */
function urlAt(text: string, index: number): { html: string; next: number } | null {
  if (!/^https?:\/\//i.test(text.slice(index, index + 8))) return null;
  // Inside a word (`foohttps://…`, `field_https://…`) an address does not begin.
  const before = text[index - 1];
  if (before !== undefined && /[\p{L}\p{N}_]/u.test(before)) return null;

  const match = /^https?:\/\/[^\s<>"]+/i.exec(text.slice(index));
  if (!match) return null;

  const url = trimUrl(match[0]);
  if (url.length <= 'https://'.length) return null;

  const href = escapeHtml(url).replace(/"/g, '&quot;');
  return { html: `<a href="${href}">${escapeHtml(url)}</a>`, next: index + url.length };
}

/** Trailing punctuation and extra brackets are not part of the link: `see https://x.com.` */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    if (last && URL_TAIL.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = URL_BRACKETS[last];
    if (opener && countChar(url, last) > countChar(url, opener)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function countChar(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** A pair of markers around text — if it is closed in this line. */
function emphasisAt(text: string, index: number, links: boolean): { html: string; next: number } | null {
  for (const { marker, open, close } of EMPHASIS) {
    if (!text.startsWith(marker, index)) continue;
    // `**` is parsed before `*`: a single marker must not open half a pair.
    if (marker.length === 1 && text.startsWith(marker + marker, index)) continue;
    if (!canOpen(text, index, marker)) continue;

    const end = findClose(text, index + marker.length, marker);
    if (end === -1) continue;
    return {
      html: `${open}${inline(text.slice(index + marker.length, end), links)}${close}`,
      next: end + marker.length,
    };
  }
  return null;
}

/**
 * Whether a marker can open markup: after it there is text, and before it — not a letter.
 * The second rule saves `snake_case` and `x_y_z` from turning into italic.
 */
function canOpen(text: string, index: number, marker: string): boolean {
  const after = text[index + marker.length];
  if (after === undefined || /\s/.test(after)) return false;
  const before = text[index - 1];
  if (before !== undefined && isWordChar(before)) return false;
  return true;
}

/** Whether a marker can close markup: before it there is text, not a space. */
function canClose(text: string, index: number): boolean {
  const before = text[index - 1];
  if (before === undefined || /\s/.test(before)) return false;
  return true;
}

/** We look for the closing marker in the same line: we do not count code and escaping inside. */
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
      // A single marker must not eat half of a double one: `**a**` is bold.
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
