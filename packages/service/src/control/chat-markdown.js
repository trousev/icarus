// Markdown in the chat panel: no libraries and no build.
//
// The file is an ordinary script: chat-ui.ts inserts it into the page before chat-client.js,
// so `markdown` and `inline` are visible to the client as global functions. A separate
// file — so the markup rules can be checked by tests without launching a browser.
//
// First we escape HTML, then re-enable only those constructs that are
// actually needed in answers. Raw HTML from the model doesn't pass.
/* exported markdown, linkify */

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

/** A local image is served by the server; the browser loads an external one itself. */
function imageSrc(raw) {
  const value = String(raw ?? '').trim();
  if (/^(https?:|data:|\/panel\/api\/)/i.test(value)) return value;
  return '/panel/api/chat/image?path=' + encodeURIComponent(value);
}

/**
 * A local file from the agent's answer is served by the server as a download. The
 * person opens an external link himself, and a path inside the container is inaccessible to the browser.
 */
function fileSrc(raw) {
  const value = String(raw ?? '').trim();
  if (!/^(?:file:\/\/|\/workspaces\/|\/workspace\/|workspaces\/|\/artifacts\/|artifacts\/|incoming\/)/.test(value)) {
    return null;
  }
  return '/panel/api/chat/file?path=' + encodeURIComponent(value);
}

/**
 * The address from the link's parentheses. The markup is already escaped, so the title comes
 * as `&quot;…&quot;`, and angle brackets as `&lt;…&gt;`: we trim those too.
 */
function hrefOf(inside) {
  return String(inside ?? '')
    .trim()
    .replace(/\s+(?:"[^"]*"|&quot;[\s\S]*?&quot;)$/, '')
    .replace(/^(?:<|&lt;)|(?:>|&gt;)$/g, '')
    .trim();
}

/** What can be put at the end of an address but does not belong to the address. */
const URL_TAIL = /[?!.,:*_~]/;
/** Paired bracket: a closing one stays in the address only if the opening one is present too. */
const URL_BRACKETS = { ')': '(', ']': '[', '}': '{' };

/** Entities around an address: `«<https://x>»` after escaping ends with `&gt;`. */
const URL_ENTITIES = ['&quot;', '&#39;', '&gt;', '&lt;'];

/** Trailing punctuation and extra brackets are not part of the link: `(see https://x.com.)`. */
function trimUrl(raw) {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    const entity = URL_ENTITIES.find((tail) => url.endsWith(tail));
    if (entity) {
      url = url.slice(0, -entity.length);
      continue;
    }
    if (URL_TAIL.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = URL_BRACKETS[last];
    if (opener && count(url, last) > count(url, opener)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function count(text, char) {
  return text.split(char).length - 1;
}

/**
 * A bare link: `https://…` in the text is also a link. A finished link can be
 * hidden in a slot (`hold`) — then italics and asterisks from the address itself won't touch it.
 */
function autolink(text, hold) {
  return text.replace(/(^|[^\p{L}\p{N}_/])https?:\/\/[^\s<"\uE000]+/giu, (match, before) => {
    const raw = match.slice(before.length);
    const url = trimUrl(raw);
    if (url.length <= 'https://'.length) return match;
    const anchor = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    return (
      before +
      (hold ? hold(anchor) : anchor) +
      // The trimmed punctuation is returned to the text: a period at the end of a sentence is not an address.
      raw.slice(url.length)
    );
  });
}

/** Text without markup — the person's message: we escape it and enable only links. */
function linkify(text) {
  return autolink(escapeHtml(text));
}

/** Bold, italics, strikethrough: without code and links — they are already hidden in slots. */
function emphasize(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

/**
 * Inline markup. We put ready-made pieces (images, code, links) into slots:
 * otherwise asterisks from an address or angle brackets from a code example would break the neighboring
 * markup. A slot is an invisible character from the private use area (U+E000)
 * with a number; at the end we put everything back in place.
 */
function inline(raw) {
  const slots = [];
  const hold = (html) => {
    slots.push(html);
    return '\uE000' + (slots.length - 1) + '\uE000';
  };

  let text = escapeHtml(raw);
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
    hold('<img class="md-image" src="' + imageSrc(hrefOf(src)) + '" alt="' + alt + '">'),
  );
  // `code` — before links: an address in a code example must not be a link.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold('<code>' + code + '</code>'));
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, inside) => {
    // File names can contain spaces: `[estimate](…/estimate for March.pdf)` is also a link.
    const href = hrefOf(inside);
    if (/^https?:\/\/\S+$/.test(href)) {
      return hold(
        '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + emphasize(label) + '</a>',
      );
    }
    // A link to a file the agent made by hand: we serve it as a download instead of
    // leaving raw markdown in the text — otherwise the person sees brackets and a dead path.
    const local = fileSrc(href);
    if (!local) return whole;
    return hold(
      '<a class="md-file" href="' + local + '" download>📎 ' + emphasize(label) + '</a>',
    );
  });
  // Bare addresses also go into slots: otherwise `_` or `*` inside an address would become italics.
  text = autolink(text, hold);

  text = emphasize(text);
  return text.replace(/\uE000(\d+)\uE000/g, (_, index) => slots[Number(index)]);
}

/**
 * Whether the line has a table boundary. `\|` is a literal inside a cell, not a
 * boundary: a line without a real `|` doesn't count as a table.
 */
function hasTablePipe(line) {
  return line.replace(/\\\|/g, '').includes('|');
}

/** Cells of a line: `\|` is returned to the text as an ordinary character, we trim the framing. */
function tableCells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** Between the header and the body: `| --- | --- |`, with or without alignment colons. */
function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/** A row shorter than the header is padded with empty cells, a longer one is truncated. */
function fitCells(cells, width) {
  const result = cells.slice(0, width);
  while (result.length < width) result.push('');
  return result;
}

function markdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  let quote = [];
  let code = null;

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push('</' + list + '>');
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push('<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>');
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }

    // A table: a line with `|`, and a divider line beneath it. Without the divider it's
    // an ordinary paragraph — a pipe occurs both in text and in commands.
    if (hasTablePipe(line) && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flushAll();
      const head = tableCells(line);
      index += 1;
      const rows = [];
      while (
        index + 1 < lines.length &&
        hasTablePipe(lines[index + 1]) &&
        lines[index + 1].trim() !== ''
      ) {
        index += 1;
        rows.push(tableCells(lines[index]));
      }
      out.push(
        '<div class="md-table"><table><thead><tr>' +
          head.map((cell) => '<th>' + inline(cell) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows
            .map(
              (row) =>
                '<tr>' +
                fitCells(row, head.length)
                  .map((cell) => '<td>' + inline(cell) + '</td>')
                  .join('') +
                '</tr>',
            )
            .join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length + 2;
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
      continue;
    }

    const blockquote = /^>\s?(.*)$/.exec(line);
    if (blockquote) {
      flushPara();
      flushList();
      quote.push(blockquote[1]);
      continue;
    }

    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const bullet = task ? null : /^[-*+]\s+(.*)$/.exec(line);
    if (task || bullet) {
      flushPara();
      flushQuote();
      if (list !== 'ul') {
        flushList();
        out.push('<ul>');
        list = 'ul';
      }
      const body = task ? task[2] : bullet[1];
      const mark = task ? (task[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') : '';
      out.push('<li' + (task ? ' class="task"' : '') + '>' + mark + inline(body) + '</li>');
      continue;
    }

    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      flushQuote();
      if (list !== 'ol') {
        flushList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push('<li>' + inline(numbered[1]) + '</li>');
      continue;
    }

    flushList();
    flushQuote();
    para.push(line);
  }

  if (code !== null) out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
  flushAll();
  return out.join('') || '<p></p>';
}
