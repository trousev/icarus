// Artifact markdown: no libraries and no build.
//
// The file is a plain script: artifacts-ui.ts inserts it into the page before the client,
// so `artifactMarkdown` is visible as a global function. It is a separate file so that
// the markup rules can be tested by a test without spinning up a browser.
//
// This is not a chat: the document has its own h1–h6 headings, tables and images that live
// next to the artifact. Raw HTML from markdown does not pass — first we escape everything,
// then we turn back on only the needed constructs.
/* exported artifactMarkdown */

const artifactEscape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

/** Relative path inside the artifact: the link must lead into the same bundle. */
function artifactHref(raw, base, kind) {
  const value = String(raw ?? '').trim();
  if (value === '') return value;
  if (value.startsWith('#')) return value;
  if (value.startsWith('//')) return value;
  // Only safe schemes: `javascript:` from a markdown file must not become
  // a link that a person clicks. data: — only for images.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return value;
    if (kind === 'image' && scheme === 'data' && /^data:image\//i.test(value)) return value;
    return '#';
  }
  // `/images/x.png` inside the artifact is a path from its root, not from the site root:
  // otherwise the image would go to the panel and not be found.
  if (value.startsWith('/') && base) return base + value.replace(/^\/+/, '');
  return (base ?? '') + value.replace(/^\.\//, '');
}

/** Punctuation and entities do not belong to the address: `(see https://x.)`. */
const ARTIFACT_TAIL = /[?!.,:*_~]/;
const ARTIFACT_ENTITIES = ['&quot;', '&#39;', '&gt;', '&lt;'];

function artifactTrimUrl(raw) {
  let url = raw;
  for (;;) {
    if (ARTIFACT_ENTITIES.some((tail) => url.endsWith(tail))) {
      url = url.slice(0, -ARTIFACT_ENTITIES.find((tail) => url.endsWith(tail)).length);
      continue;
    }
    if (ARTIFACT_TAIL.test(url.slice(-1))) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** Bare addresses become links; finished pieces can be hidden in a markup slot. */
function artifactAutolink(text, hold) {
  return text.replace(/(^|[^\p{L}\p{N}_/])https?:\/\/[^\s<"\uE000]+/giu, (match, before) => {
    const raw = match.slice(before.length);
    const url = artifactTrimUrl(raw);
    if (url.length <= 'https://'.length) return match;
    const anchor =
      '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    return before + (hold ? hold(anchor) : anchor) + raw.slice(url.length);
  });
}

function artifactInline(raw, options = {}) {
  const slots = [];
  const hold = (html) => {
    slots.push(html);
    return '\uE000' + (slots.length - 1) + '\uE000';
  };
  let text = artifactEscape(raw);

  // Images before links: they have the same syntax with brackets.
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src, title) =>
    hold(
      '<img src="' +
        artifactEscape(artifactHref(src, options.fileBase, 'image')) +
        '" alt="' +
        alt +
        '"' +
        (title ? ' title="' + title + '"' : '') +
        '>',
    ),
  );
  // `code` before links: an address inside a code sample must not become a link.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold('<code>' + code + '</code>'));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, label, href, title) =>
    hold(
      '<a href="' +
        artifactEscape(artifactHref(href, options.fileBase)) +
        '"' +
        (title ? ' title="' + title + '"' : '') +
        (href.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"') +
        '>' +
        artifactEmphasize(label) +
        '</a>',
    ),
  );
  text = artifactAutolink(text, hold);
  text = artifactEmphasize(text);
  return text.replace(/\uE000(\d+)\uE000/g, (_, index) => slots[Number(index)]);
}

function artifactEmphasize(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

/**
 * Whether the line contains a table boundary. `\|` is a literal inside a cell, not a
 * boundary: a line without a real `|` is not considered a table.
 */
function hasTablePipe(line) {
  return line.replace(/\\\|/g, '').includes('|');
}

/** Cells of a line: `\|` is returned to the text as an ordinary character, the frame is trimmed. */
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

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/** A row shorter than the header is padded with empty cells, a longer one is trimmed. */
function fitCells(cells, width) {
  const result = cells.slice(0, width);
  while (result.length < width) result.push('');
  return result;
}

/**
 * Block markup. Returns the document HTML: h1–h6, lists (with nesting by
 * indent), quotes, code, tables, horizontal rules and paragraphs.
 */
function artifactMarkdown(text, options = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let quote = [];
  let code = null;

  const inline = (value) => artifactInline(value, options);
  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
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
    flushQuote();
  };

  const listMatch = (line) => {
    const bullet = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (!bullet && !numbered) return null;
    const indent = (bullet ? bullet[1] : numbered[1]).replace(/\t/g, '  ').length;
    const task = bullet ? bullet[2] : undefined;
    return {
      indent,
      tag: bullet ? 'ul' : 'ol',
      text: bullet ? bullet[3] : numbered[2],
      task,
    };
  };

  /**
   * List tree by indent: a nested `<ul>` must end up inside the `<li>`,
   * not next to it — otherwise the browser draws the items on one level.
   */
  const buildList = (items) => {
    const root = { tag: items[0].tag, indent: items[0].indent, items: [] };
    const stack = [root];
    for (const item of items) {
      while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop();
      let current = stack[stack.length - 1];
      if (item.indent > current.indent) {
        const parent = current.items[current.items.length - 1];
        if (parent) {
          const nested = { tag: item.tag, indent: item.indent, items: [] };
          parent.children.push(nested);
          stack.push(nested);
          current = nested;
        } else {
          current.indent = item.indent;
        }
      }
      current.items.push({ text: item.text, task: item.task, children: [] });
    }
    return root;
  };

  const renderList = (node) =>
    '<' +
    node.tag +
    '>' +
    node.items
      .map((item) => {
        const mark = item.task === undefined ? '' : item.task.toLowerCase() === 'x' ? '☑ ' : '☐ ';
        return (
          '<li' +
          (item.task === undefined ? '' : ' class="task"') +
          '>' +
          mark +
          inline(item.text) +
          item.children.map(renderList).join('') +
          '</li>'
        );
      })
      .join('') +
    '</' +
    node.tag +
    '>';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (code !== null) {
      if (/^\s*```/.test(line)) {
        out.push('<pre><code>' + artifactEscape(code.join('\n')) + '</code></pre>');
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }

    // Table: a line with | and the divider line following it.
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
        '<table><thead><tr>' +
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
          '</tbody></table>',
      );
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
      continue;
    }

    const blockquote = /^\s*>\s?(.*)$/.exec(line);
    if (blockquote) {
      flushPara();
      quote.push(blockquote[1]);
      continue;
    }

    const item = listMatch(line);
    if (item) {
      flushPara();
      flushQuote();
      // Collect the whole list at once: this way the nesting can be laid out into a tree,
      // rather than guessing line by line where to close the previous `<li>`.
      const items = [item];
      let next = index + 1;
      while (next < lines.length) {
        const following = listMatch(lines[next]);
        if (!following) break;
        items.push(following);
        next += 1;
      }
      out.push(renderList(buildList(items)));
      index = next - 1;
      continue;
    }

    flushPara();
    flushQuote();
    para.push(line);
  }

  if (code !== null) out.push('<pre><code>' + artifactEscape(code.join('\n')) + '</code></pre>');
  flushAll();
  return out.join('\n') || '<p></p>';
}
