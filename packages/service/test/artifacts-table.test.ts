// Таблица артефакта (CSV/TSV): разбор, поиск, сортировка и разметка.
//
// Файл клиентский и без сборки, поэтому тест берёт исходник как есть и проверяет
// ровно тот код, который уедет в браузер. Монтирование проверяется на настоящем
// DOM (linkedom): сортировка и поиск — это события, а не только строки HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

const SOURCE = fs.readFileSync(new URL('../src/control/artifacts-table.js', import.meta.url), 'utf8');
type Options = { file?: string };
type Model = {
  delimiter: string;
  columns: Array<{ name: string; numeric: boolean }>;
  rows: string[][];
};
const table = new Function(`${SOURCE}\nreturn {
  artifactTableDelimiter,
  artifactTableParse,
  artifactTableModel,
  artifactTableRows,
  artifactTableHtml,
  artifactTableMount,
};`)() as {
  artifactTableDelimiter: (text: string, file?: string) => string;
  artifactTableParse: (text: string, delimiter?: string) => string[][];
  artifactTableModel: (text: string) => Model;
  artifactTableRows: (model: Model, state?: { query?: string; column?: number; direction?: string }) => string[][];
  artifactTableHtml: (text: string, options?: Options) => string;
  artifactTableMount: (root: unknown, text: string, options?: Options) => Model | null;
};

const CSV = 'кто,часы,задача\nАнна,3,стендап\nБорис,11,демо\nВера,,ревью\n';
const model = table.artifactTableModel(CSV);
const names = (rows: string[][]) => rows.map((row) => row[0]);

test('CSV: кавычки, запятые и перевод строки внутри значения', () => {
  const rows = table.artifactTableParse('кто,что\nАнна,"стендап, демо"\nБорис,"первая\nвторая"\n');
  assert.deepEqual(rows, [
    ['кто', 'что'],
    ['Анна', 'стендап, демо'],
    ['Борис', 'первая\nвторая'],
  ]);
  // Двойная кавычка внутри значения — это сама кавычка, а не конец цитаты.
  assert.deepEqual(table.artifactTableParse('a,b\n"5""","x"'), [
    ['a', 'b'],
    ['5"', 'x'],
  ]);
});

test('разделитель — по содержимому: Excel с точкой с запятой и табы TSV', () => {
  assert.equal(table.artifactTableDelimiter('кто;часы\nАнна;3\n', 'index.csv'), ';');
  assert.equal(table.artifactTableDelimiter('кто\tчасы\nАнна\t3\n', 'index.tsv'), '\t');
  assert.equal(table.artifactTableDelimiter('кто,часы\nАнна,3\n', 'index.csv'), ',');
  // В кавычках запятые не считаются: разделитель там не живёт.
  assert.equal(table.artifactTableDelimiter('"кто, часы";прочее\n', 'index.csv'), ';');
  assert.equal(table.artifactTableDelimiter('одна колонка\nзначение\n', 'index.csv'), ',');
  assert.equal(table.artifactTableDelimiter('', 'index.tsv'), '\t');
});

test('первая строка — заголовки; пустая шапка и лишние колонки не теряют данные', () => {
  const wide = table.artifactTableModel('a,,c\n1,2,3,4\n');
  assert.deepEqual(
    wide.columns.map((column) => column.name),
    ['a', 'Колонка 2', 'c', 'Колонка 4'],
  );
  assert.deepEqual(wide.rows, [['1', '2', '3', '4']]);
  // Пустые строки в данных не превращаются в строки таблицы.
  const sparse = table.artifactTableModel('a,b\n1,2\n\n,\n3,4\n');
  assert.deepEqual(sparse.rows, [
    ['1', '2'],
    ['3', '4'],
  ]);
  assert.deepEqual(table.artifactTableModel('').columns, []);
});

test('числовая колонка сортируется числами, тексты — по-русски', () => {
  assert.deepEqual(
    model.columns.map((column) => column.numeric),
    [false, true, false],
  );
  assert.deepEqual(names(table.artifactTableRows(model, { column: 1, direction: 'asc' })), [
    'Анна',
    'Борис',
    'Вера',
  ], 'пустая ячейка — внизу, а не первой');
  assert.deepEqual(names(table.artifactTableRows(model, { column: 1, direction: 'desc' })), [
    'Борис',
    'Анна',
    'Вера',
  ]);
  assert.deepEqual(names(table.artifactTableRows(model, { column: 0, direction: 'asc' })), [
    'Анна',
    'Борис',
    'Вера',
  ]);
  // Числа сравниваются как числа: 11 больше 3, хотя строка «11» меньше «3».
  const prices = table.artifactTableModel('товар,цена\nA,1 200\nB,999\n');
  assert.equal(prices.columns[1].numeric, true);
  assert.deepEqual(names(table.artifactTableRows(prices, { column: 1, direction: 'asc' })), ['B', 'A']);
});

test('поиск идёт по всем ячейкам и не зависит от регистра', () => {
  assert.deepEqual(names(table.artifactTableRows(model, { query: 'демо' })), ['Борис']);
  assert.deepEqual(names(table.artifactTableRows(model, { query: 'ВЕРА' })), ['Вера']);
  assert.deepEqual(names(table.artifactTableRows(model, { query: 'стендап' })), ['Анна']);
  assert.deepEqual(table.artifactTableRows(model, { query: 'нет такого' }), []);
  // Поиск и сортировка складываются.
  assert.deepEqual(
    names(table.artifactTableRows(model, { query: 'е', column: 0, direction: 'desc' })),
    ['Вера', 'Борис', 'Анна'],
  );
});

test('ячейки — текст, а не разметка', () => {
  const html = table.artifactTableHtml('<script>alert(1)</script>,x\n"<b>жирный</b>",1\n');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;жирный&lt;\/b&gt;/);
});

test('вёрстка: поиск, кнопки сортировки, счётчик и числовой класс', () => {
  const html = table.artifactTableHtml(CSV);
  assert.match(html, /class="art-table-q"[^>]*placeholder="Поиск по таблице"/);
  assert.match(html, /class="art-table-count">3 строки</);
  assert.match(html, /class="art-table-sort" data-col="0"/);
  assert.match(html, /<th scope="col" aria-sort="none" class="num"><button[^>]*data-col="1"/);
  assert.match(html, /<td class="num">3<\/td>/);
  assert.match(html, /<span class="art-table-kind">CSV<\/span>/);
  // Пустая таблица не рисует пустую сетку и не предлагает сортировать нечего.
  const blank = table.artifactTableHtml('');
  assert.match(blank, /В таблице нет данных/);
  assert.doesNotMatch(blank, /art-table-sort/);
  assert.match(blank, /class="art-table-q"[^>]*disabled/);
});

test('монтирование: ввод в поиск фильтрует строки, клик по шапке сортирует', () => {
  const { document, window } = parseHTML('<div id="host"></div>');
  const root = document.getElementById('host');
  assert.ok(root);
  const mounted = table.artifactTableMount(root, CSV, { file: 'index.csv' });
  assert.equal(mounted?.columns.length, 3);
  const rowNames = () => [...root.querySelectorAll('tbody tr td:first-child')].map((cell) => cell.textContent);
  assert.deepEqual(rowNames(), ['Анна', 'Борис', 'Вера']);

  const input = root.querySelector('.art-table-q') as unknown as {
    value: string;
    dispatchEvent: (event: Event) => void;
  };
  input.value = 'демо';
  input.dispatchEvent(new window.Event('input'));
  assert.deepEqual(rowNames(), ['Борис']);
  assert.match(root.querySelector('.art-table-count')?.textContent ?? '', /Найдено 1 из 3/);

  input.value = '';
  input.dispatchEvent(new window.Event('input'));
  const clickHeader = (index: number) => {
    const event = document.createEvent('Event');
    event.initEvent('click', true, true);
    root.querySelectorAll('.art-table-sort')[index].dispatchEvent(event);
  };
  clickHeader(1);
  assert.deepEqual(rowNames(), ['Анна', 'Борис', 'Вера'], 'по часам: 3, 11, пусто');
  clickHeader(1);
  assert.deepEqual(rowNames(), ['Борис', 'Анна', 'Вера'], 'по часам наоборот');
  assert.equal(
    root.querySelectorAll('th')[1].getAttribute('aria-sort'),
    'descending',
  );
  clickHeader(1);
  assert.deepEqual(rowNames(), ['Анна', 'Борис', 'Вера'], 'третий клик возвращает порядок файла');
  assert.equal(root.querySelectorAll('th')[1].getAttribute('aria-sort'), 'none');
});

test('монтирование: пустая таблица не падает и не притворяется таблицей', () => {
  const { document } = parseHTML('<div id="host"></div>');
  const root = document.getElementById('host');
  assert.ok(root);
  assert.deepEqual(table.artifactTableMount(root, ''), {
    delimiter: ',',
    columns: [],
    rows: [],
  });
  assert.match(root.innerHTML, /В таблице нет данных/);
});
