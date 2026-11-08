// Markdown в панели чата: без библиотек и без сборки.
//
// Файл — обычный script: chat-ui.ts вставляет его в страницу раньше chat-client.js,
// поэтому `markdown` и `inline` видны клиенту как глобальные функции. Отдельным
// файлом — чтобы правила разметки можно было проверять тестами, не поднимая браузер.
//
// Сначала экранируем HTML, потом включаем обратно только те конструкции, которые
// реально нужны в ответах. Сырой HTML от модели не проходит.
/* exported markdown, linkify */

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

/** Локальную картинку отдаёт сервер; внешнюю браузер грузит сам. */
function imageSrc(raw) {
  const value = String(raw ?? '').trim();
  if (/^(https?:|data:|\/panel\/api\/)/i.test(value)) return value;
  return '/panel/api/chat/image?path=' + encodeURIComponent(value);
}

/** Что можно поставить в конец адреса, но что адресу не принадлежит. */
const URL_TAIL = /[?!.,:*_~]/;
/** Парная скобка: закрывающая остаётся в адресе, только если открывающая тоже есть. */
const URL_BRACKETS = { ')': '(', ']': '[', '}': '{' };

/** Сущности вокруг адреса: `«<https://x>»` после экранирования кончается на `&gt;`. */
const URL_ENTITIES = ['&quot;', '&#39;', '&gt;', '&lt;'];

/** Хвостовая пунктуация и лишние скобки — не часть ссылки: `(см. https://x.com.)`. */
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
 * Ссылка без разметки: `https://…` в тексте — тоже ссылка. Готовую ссылку можно
 * спрятать в слот (`hold`) — тогда курсив и звёздочки из самого адреса её не тронут.
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
      // Срезанная пунктуация возвращается в текст: точка в конце предложения — не адрес.
      raw.slice(url.length)
    );
  });
}

/** Текст без разметки — реплика человека: экранируем и включаем только ссылки. */
function linkify(text) {
  return autolink(escapeHtml(text));
}

/** Жирный, курсив, зачёркнутый: без кода и ссылок — они уже спрятаны в слоты. */
function emphasize(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

/**
 * Разметка внутри строки. Готовые куски (картинки, код, ссылки) складываем в слоты:
 * иначе звёздочки из адреса или угловые скобки из примера кода ломали бы соседнюю
 * разметку. Слот — невидимый символ из области частного использования (U+E000)
 * с номером, в конце возвращаем всё на место.
 */
function inline(raw) {
  const slots = [];
  const hold = (html) => {
    slots.push(html);
    return '\uE000' + (slots.length - 1) + '\uE000';
  };

  let text = escapeHtml(raw);
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) =>
    hold('<img class="md-image" src="' + imageSrc(src) + '" alt="' + alt + '">'),
  );
  // `код` — раньше ссылок: адрес в примере кода ссылкой быть не должен.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold('<code>' + code + '</code>'));
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) =>
    hold(
      '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + emphasize(label) + '</a>',
    ),
  );
  // Голые адреса — тоже в слоты: иначе `_` или `*` внутри адреса станут курсивом.
  text = autolink(text, hold);

  text = emphasize(text);
  return text.replace(/\uE000(\d+)\uE000/g, (_, index) => slots[Number(index)]);
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

/** Между шапкой и телом: `| --- | --- |`, с двоеточиями выравнивания или без. */
function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/** Строка короче шапки добивается пустыми ячейками, длиннее — обрезается. */
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

    // Таблица: строка с `|`, а под ней линия-разделитель. Без разделителя это
    // обычный абзац — пайп встречается и в тексте, и в командах.
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
