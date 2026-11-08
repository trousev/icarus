// Markdown артефакта: без библиотек и без сборки.
//
// Файл — обычный script: artifacts-ui.ts вставляет его в страницу раньше клиента,
// поэтому `artifactMarkdown` видна как глобальная функция. Отдельным файлом — чтобы
// правила разметки проверялись тестом, не поднимая браузер.
//
// Это не чат: у документа свои заголовки h1–h6, таблицы и картинки, которые лежат
// рядом с артефактом. Сырой HTML из markdown не проходит — сначала экранируем всё,
// потом включаем обратно только нужные конструкции.
/* exported artifactMarkdown */

const artifactEscape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

/** Относительный путь внутри артефакта: ссылка должна вести в тот же бандл. */
function artifactHref(raw, base, kind) {
  const value = String(raw ?? '').trim();
  if (value === '') return value;
  if (value.startsWith('#')) return value;
  if (value.startsWith('//')) return value;
  // Только безопасные схемы: `javascript:` из markdown-файла не должен стать
  // ссылкой, по которой человек нажмёт. data: — только для картинок.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return value;
    if (kind === 'image' && scheme === 'data' && /^data:image\//i.test(value)) return value;
    return '#';
  }
  // `/images/x.png` внутри артефакта — это путь от его корня, а не от корня сайта:
  // иначе картинка уехала бы в панель и не нашлась.
  if (value.startsWith('/') && base) return base + value.replace(/^\/+/, '');
  return (base ?? '') + value.replace(/^\.\//, '');
}

/** Пунктуация и сущности не принадлежат адресу: `(см. https://x.)`. */
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

/** Голые адреса — ссылки; готовые куски можно спрятать в слот от разметки. */
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

  // Картинки раньше ссылок: у них тот же синтаксис со скобками.
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
  // `код` — раньше ссылок: адрес в примере кода ссылкой быть не должен.
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
 * Есть ли в строке граница таблицы. `\|` — это литерал внутри ячейки, а не
 * граница: строка без настоящего `|` таблицей не считается.
 */
function hasTablePipe(line) {
  return line.replace(/\\\|/g, '').includes('|');
}

/** Ячейки строки: `\|` возвращается в текст как обычный символ, обрамление срезаем. */
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

/** Строка короче шапки добивается пустыми ячейками, длиннее — обрезается. */
function fitCells(cells, width) {
  const result = cells.slice(0, width);
  while (result.length < width) result.push('');
  return result;
}

/**
 * Блочная разметка. Возвращает HTML документа: h1–h6, списки (с вложенностью по
 * отступу), цитаты, код, таблицы, горизонтальные линии и абзацы.
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
   * Дерево списка по отступу: вложенный `<ul>` обязан оказаться внутри `<li>`,
   * а не рядом с ним — иначе браузер рисует пункты на одном уровне.
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

    // Таблица: строка с | и следующая за ней линия-разделитель.
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
      // Собираем весь список целиком: так вложенность можно разложить в дерево,
      // а не гадать по одной строке, куда закрывать предыдущий `<li>`.
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
