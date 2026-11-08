// Таблица артефакта: CSV/TSV без библиотек и без сборки.
//
// Файл — обычный script: artifacts-ui.ts вставляет его в страницу раньше клиента
// раздела, поэтому `artifactTableMount` видна как глобальная функция, а «без
// панели» и публичная страница вставляют его сами. Отдельным файлом — чтобы
// разбор, поиск и сортировка проверялись тестом, не поднимая браузер.
//
// Люди пишут CSV по-разному: Excel в русской локали — через `;`, кто-то — табами,
// а значения бывают в кавычках с запятыми и переводами строк внутри. Поэтому
// разделитель определяется по содержимому, а расширение — только подсказка.
/* exported artifactTableDelimiter, artifactTableParse, artifactTableModel,
   artifactTableRows, artifactTableHtml, artifactTableMount */

const tableEscape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

/** Разделитель по первой строке: считаем только то, что вне кавычек. */
function artifactTableDelimiter(text, file) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of source) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '\n' || char === '\r') break;
    if (Object.hasOwn(counts, char)) counts[char] += 1;
  }
  const hint = /\.tsv$/i.test(String(file ?? '')) ? '\t' : ',';
  const best = Object.entries(counts).sort((left, right) => right[1] - left[1])[0];
  if (!best || best[1] === 0) return hint;
  // Ничья — редкость; в ней верим расширению, иначе выбор был бы случайным.
  if (Object.values(counts).filter((count) => count === best[1]).length > 1) return hint;
  return best[0];
}

/**
 * Разбор CSV/TSV в массив строк. Кавычка открывает значение только в его начале:
 * `5"` внутри числа — это дюймы, а не начало цитаты.
 */
function artifactTableParse(text, delimiter) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (source.trim() === '') return [];
  const separator = typeof delimiter === 'string' && delimiter !== '' ? delimiter : artifactTableDelimiter(source, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
      continue;
    }
    if (char === separator) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }
  row.push(cell);
  // Последний перевод строки не делает из файла лишнюю пустую строку.
  if (!(row.length === 1 && row[0] === '')) rows.push(row);
  return rows;
}

/** Число из ячейки: пробелы-разделители тысяч, запятая как десятичная. */
function tableNumber(value) {
  const clean = String(value ?? '')
    .replace(/[\s\u00a0]/g, '')
    .replace(/%$/, '')
    .replace(',', '.');
  if (!/^[+-]?\d+(\.\d+)?$/.test(clean)) return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

const TABLE_NUMBER = /^[+-]?\d+([.,]\d+)?%?$/;

/**
 * Шапка — первая непустая строка, данные — остальные. Если колонок в строке
 * больше, чем в шапке, имя придумывается: терять данные из-за кривой шапки нельзя.
 */
function artifactTableModel(text, options = {}) {
  const delimiter = artifactTableDelimiter(text, options.file);
  const parsed = artifactTableParse(text, delimiter).filter((row) =>
    row.some((cell) => String(cell).trim() !== ''),
  );
  const header = parsed.length > 0 ? parsed[0] : [];
  const body = parsed.slice(1);
  const width = Math.max(header.length, ...body.map((row) => row.length), 0);
  const columns = [];
  for (let index = 0; index < width; index += 1) {
    const name = String(header[index] ?? '').trim();
    const values = body
      .map((row) => String(row[index] ?? '').trim())
      .filter((value) => value !== '')
      .map((value) => value.replace(/[\s\u00a0]/g, ''));
    columns.push({
      name: name === '' ? 'Колонка ' + (index + 1) : name,
      numeric: values.length > 0 && values.every((value) => TABLE_NUMBER.test(value)),
    });
  }
  return {
    delimiter,
    columns,
    rows: body.map((row) => columns.map((_, index) => String(row[index] ?? '').trim())),
  };
}

/** Поиск по всем ячейкам и сортировка по колонке: пустые ячейки всегда внизу. */
function artifactTableRows(model, state = {}) {
  const query = String(state.query ?? '').trim().toLowerCase();
  const column = Number.isInteger(state.column) ? state.column : -1;
  const direction = state.direction === 'desc' ? 'desc' : state.direction === 'asc' ? 'asc' : '';
  let rows = model.rows.map((row, index) => ({ row, index }));
  if (query !== '') {
    rows = rows.filter(({ row }) => row.some((cell) => cell.toLowerCase().includes(query)));
  }
  if (direction !== '' && column >= 0 && column < model.columns.length) {
    const numeric = model.columns[column].numeric;
    const sign = direction === 'desc' ? -1 : 1;
    rows = rows.slice().sort((left, right) => {
      const a = left.row[column] ?? '';
      const b = right.row[column] ?? '';
      if (a === '' && b !== '') return 1;
      if (b === '' && a !== '') return -1;
      if (numeric) {
        const first = tableNumber(a);
        const second = tableNumber(b);
        if (first !== null && second !== null && first !== second) return (first - second) * sign;
        if (first !== null && second === null) return -sign;
        if (first === null && second !== null) return sign;
      }
      const compared = a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
      if (compared !== 0) return compared * sign;
      return left.index - right.index;
    });
  }
  return rows.map(({ row }) => row);
}

/** 1 строка, 2 строки, 5 строк — иначе счётчик выглядит машинным. */
function tablePlural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function tableCountLabel(shown, total) {
  if (shown !== total) return 'Найдено ' + shown + ' из ' + total;
  return total + ' ' + tablePlural(total, 'строка', 'строки', 'строк');
}

function artifactTableBodyHtml(model, rows) {
  if (rows.length === 0) {
    return (
      '<tr class="art-table-empty"><td colspan="' +
      Math.max(model.columns.length, 1) +
      '">Ничего не нашлось</td></tr>'
    );
  }
  return rows
    .map(
      (row) =>
        '<tr>' +
        row
          .map(
            (cell, index) =>
              '<td' + (model.columns[index]?.numeric ? ' class="num"' : '') + '>' + tableEscape(cell) + '</td>',
          )
          .join('') +
        '</tr>',
    )
    .join('');
}

/** Готовая разметка: используется и панелью, и публичной страницей, и тестом. */
function artifactTableHtml(text, options = {}) {
  const model = artifactTableModel(text, options);
  const rows = artifactTableRows(model, {});
  const head = model.columns
    .map(
      (column, index) =>
        '<th scope="col" aria-sort="none"' +
        (column.numeric ? ' class="num"' : '') +
        '><button type="button" class="art-table-sort" data-col="' +
        index +
        '">' +
        tableEscape(column.name) +
        '</button></th>',
    )
    .join('');
  const kind = model.delimiter === '\t' ? 'TSV' : model.delimiter === ';' ? 'CSV · ;' : 'CSV';
  const hint =
    model.columns.length === 0
      ? ''
      : '<span class="art-table-hint">клик по заголовку — сортировка</span>';
  const grid =
    model.columns.length === 0
      ? '<div class="art-table-blank">В таблице нет данных</div>'
      : '<div class="art-table-scroll"><table class="art-table-grid"><thead><tr>' +
        head +
        '</tr></thead><tbody>' +
        artifactTableBodyHtml(model, rows) +
        '</tbody></table></div>';
  return (
    '<div class="art-table">' +
    '<div class="art-table-bar">' +
    '<input type="search" class="art-table-q" placeholder="Поиск по таблице" aria-label="Поиск по таблице" autocomplete="off"' +
    (model.columns.length === 0 ? ' disabled' : '') +
    '>' +
    '<span class="art-table-count">' +
    tableCountLabel(rows.length, model.rows.length) +
    '</span>' +
    '<span class="art-table-kind">' + kind + '</span>' +
    hint +
    '</div>' +
    grid +
    '</div>'
  );
}

/**
 * Поставить таблицу в контейнер и включить поиск с сортировкой. Возвращает
 * модель — она же пригодится тесту и отладке, но жить без неё можно.
 */
function artifactTableMount(root, text, options = {}) {
  if (!root) return null;
  const model = artifactTableModel(text, options);
  const state = { query: '', column: -1, direction: '' };
  root.innerHTML = artifactTableHtml(text, options);
  if (model.columns.length === 0) return model;

  const input = root.querySelector('.art-table-q');
  const tbody = root.querySelector('tbody');
  const count = root.querySelector('.art-table-count');
  const heads = [...root.querySelectorAll('.art-table-sort')];

  const paint = () => {
    const rows = artifactTableRows(model, state);
    if (tbody) tbody.innerHTML = artifactTableBodyHtml(model, rows);
    if (count) count.textContent = tableCountLabel(rows.length, model.rows.length);
    for (const button of heads) {
      const index = Number(button.dataset.col);
      const active = index === state.column && state.direction !== '';
      button.classList.toggle('active', active);
      button.classList.toggle('desc', active && state.direction === 'desc');
      const cell = button.closest('th');
      if (cell) {
        cell.setAttribute(
          'aria-sort',
          active ? (state.direction === 'desc' ? 'descending' : 'ascending') : 'none',
        );
      }
    }
  };

  if (input) {
    input.addEventListener('input', () => {
      state.query = input.value;
      paint();
    });
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest ? event.target.closest('.art-table-sort') : null;
    if (!button) return;
    const index = Number(button.dataset.col);
    if (index === state.column) {
      state.direction = state.direction === 'asc' ? 'desc' : state.direction === 'desc' ? '' : 'asc';
      if (state.direction === '') state.column = -1;
    } else {
      state.column = index;
      state.direction = 'asc';
    }
    paint();
  });
  return model;
}
