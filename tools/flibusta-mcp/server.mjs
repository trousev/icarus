#!/usr/bin/env node
// Флибуста: MCP-сервер книг — поиск, описание, скачивание и мини-реестр.
//
// У Флибусты нет API по ключу, зато есть OPDS — тот же каталог, который читают
// читалки. Он отдаёт Atom/XML: название, автора, аннотацию и ссылки на форматы.
// Это заметно устойчивее HTML-вёрстки, поэтому поиск идёт через OPDS, а HTML
// остаётся запасным путём (и единственным для страницы книги: /opds/book/<id>
// не существует — на любой id сервер отдаёт корневой фид).
//
// Главная опасность такого сервера — тихая пустая выдача: сайт поменял вёрстку,
// парсер ничего не нашёл, а человеку сказали «ничего не найдено». Поэтому здесь
// «ничего не найдено» — это только разобранная пустая выдача, а несовпадение
// разметки — отдельная ошибка с именем того, что не нашлось.
//
// Поиск и описание ничего не пишут на диск. Скачивание — отдельный инструмент
// с confirm: true, лимитом размера и человеческим именем файла. Скачанное
// попадает в мини-реестр рядом с файлами (library.json): менеджера книг вроде
// Calibre в Икаре нет, а помнить «что уже есть» надо.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'flibusta', version: '1.0.0' };

const DEFAULT_MIRROR = 'https://flibusta.is';
// Зеркала переезжают: .is/.site/.club — один и тот же каталог под разными именами.
const DEFAULT_SPARE_MIRRORS = ['https://flibusta.site', 'https://flibusta.club'];
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Icarus/0.1 (+flibusta-mcp)';

/** Форматы в порядке предпочтения: fb2 — родной, остальные собирает конвертер сайта. */
const FORMATS = ['fb2', 'epub', 'mobi', 'pdf', 'djvu', 'doc', 'docx', 'txt', 'rtf', 'html'];
/** Формат по умолчанию: fb2 — исходник библиотеки, без конвертера и очереди. */
const DEFAULT_FORMAT = 'fb2';

const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 20;
/** Больше трёх авторов за один поиск — это уже перебор запросов к чужому сайту. */
const AUTHOR_FANOUT = 2;

function envText(name) {
  const value = (process.env[name] ?? '').trim();
  return value === '' ? '' : value;
}

function envNumber(name, fallback) {
  const value = Number(envText(name));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function mirrorList() {
  const raw = [envText('FLIBUSTA_MIRROR'), ...envText('FLIBUSTA_MIRRORS').split(',')]
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const mirrors = [];
  for (const item of raw.length > 0 ? raw : [DEFAULT_MIRROR, ...DEFAULT_SPARE_MIRRORS]) {
    // Без схемы непонятно, куда идти: молча выкидываем, а не угадываем.
    if (!/^https?:\/\//i.test(item)) continue;
    const base = item.replace(/\/+$/, '');
    if (!mirrors.includes(base)) mirrors.push(base);
  }
  return mirrors.length > 0 ? mirrors : [DEFAULT_MIRROR];
}

const MIRRORS = mirrorList();
// 12 с — с запасом: живая страница отвечает за секунду, а мёртвое зеркало не должно
// съедать минуту ожидания (в списке их несколько).
const TIMEOUT_MS = envNumber('FLIBUSTA_TIMEOUT_MS', 12_000);
/** Скачивание большого файла дольше одного запроса страницы. */
const DOWNLOAD_TIMEOUT_MS = envNumber('FLIBUSTA_DOWNLOAD_TIMEOUT_MS', 180_000);
const MAX_BYTES = envNumber('FLIBUSTA_MAX_BYTES', 25 * 1024 * 1024);

/**
 * Куда класть книги: incoming человека. ICARUS_HOME уже есть в контейнере
 * (/workspaces/.icarus), поэтому по умолчанию совпадает с папкой вложений —
 * оттуда файл видно и панели, и Telegram. cwd — запасной путь для запуска руками.
 */
const ICARUS_HOME = envText('ICARUS_HOME');
const SAVE_DIR = envText('FLIBUSTA_SAVE_DIR') || path.join(ICARUS_HOME === '' ? process.cwd() : ICARUS_HOME, 'incoming');
const LIBRARY_FILE = envText('FLIBUSTA_LIBRARY') || path.join(SAVE_DIR, 'library.json');

/** Какое зеркало отвечало последним: следующие запросы начинаем с него, а не с мёртвого. */
let activeMirror = 0;

// --- ошибки ------------------------------------------------------------------

/** Разметка не совпала: сайт переехал на другую вёрстку. Отдельный класс, чтобы
 *  не путать это с «ничего не найдено» и с «зеркало молчит». */
class MarkupError extends Error {}

/** Страница пришла, но это не книга: сайт подменяет неверный id страницей поиска. */
class NotFoundError extends Error {}

// --- текст и сущности --------------------------------------------------------

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
};

function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * HTML/XML — в читаемый текст. Сущности разбираем ДО снятия тегов: OPDS отдаёт
 * аннотацию как &lt;p&gt;…&lt;br/&gt;, и без этого абзацы слиплись бы в одну строку.
 */
function plainText(raw) {
  const decoded = decodeEntities(raw);
  const withBreaks = decoded
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n\n');
  return tidy(withBreaks.replace(/<[^>]+>/g, ''));
}

function tidy(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attr(tag, name) {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match === null ? '' : (match[2] ?? match[3] ?? match[4] ?? '');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

// --- сеть --------------------------------------------------------------------

async function getText(base, pathname, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${pathname}`, {
      headers: { accept, 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`не ответило за ${Math.round(TIMEOUT_MS / 1000)} с`, { cause: error });
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Прочитать страницу с первого живого зеркала и разобрать её.
 *
 * Мёртвое зеркало — не приговор: следующий запрос идёт с того, что ответило.
 * Несовпадение разметки — повод попробовать следующее зеркало (одно может отдать
 * заглушку), но если разметка не сошлась нигде, это честная поломка парсера.
 * «Страницы нет» (NotFoundError) не повторяем: каталог у зеркал один.
 */
async function readPage(pathname, parse, { accept, what }) {
  const tried = [];
  let markupError = null;
  for (let step = 0; step < MIRRORS.length; step += 1) {
    const index = (activeMirror + step) % MIRRORS.length;
    const base = MIRRORS[index];
    let body;
    try {
      body = await getText(base, pathname, accept);
    } catch (error) {
      tried.push(`${base} — ${error.message}`);
      continue;
    }
    try {
      const value = parse(body, base);
      activeMirror = index;
      return { value, base, tried };
    } catch (error) {
      if (!(error instanceof MarkupError)) throw error;
      markupError = error;
      tried.push(`${base} — ${error.message}`);
    }
  }
  const details = tried.length > 0 ? `\nПробовал: ${tried.join('; ')}` : '';
  if (markupError !== null) {
    throw new Error(`Парсер сломался: ${what} — ${markupError.message}. Это не «ничего не найдено»: сайт сменил разметку.${details}`);
  }
  throw new Error(`Зеркала не ответили: ${what}.${details}\nПроверь сеть и зеркала (mirror_status), при необходимости задай FLIBUSTA_MIRROR/FLIBUSTA_MIRRORS.`);
}

// --- разбор OPDS -------------------------------------------------------------

function assertFeed(xml) {
  if (!/<feed\b/.test(xml) || !/xmlns:opds=/.test(xml)) {
    throw new MarkupError('ответ не похож на OPDS-фид (нет <feed> с пространством opds)');
  }
}

function opdsEntries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1]);
}

function formatFromType(type) {
  const lower = type.toLowerCase();
  if (lower.includes('fb2')) return 'fb2';
  if (lower.includes('epub')) return 'epub';
  if (lower.includes('mobipocket')) return 'mobi';
  if (lower.includes('pdf')) return 'pdf';
  if (lower.includes('djvu')) return 'djvu';
  if (lower.includes('docx') || lower.includes('wordprocessingml') || lower.includes('msword')) return 'docx';
  if (lower.includes('text/plain')) return 'txt';
  if (lower.includes('rtf')) return 'rtf';
  if (lower.includes('html')) return 'html';
  return '';
}

/** Форматы книги из ссылок на скачивание внутри записи OPDS. */
function opdsFormats(entry, id) {
  const found = [];
  for (const link of entry.matchAll(/<link\b[^>]*>/g)) {
    const tag = link[0];
    if (!/acquisition\/open-access/.test(tag)) continue;
    const href = attr(tag, 'href');
    const fromHref = new RegExp(`^/b/${id}/([a-z0-9]+)`).exec(href)?.[1] ?? '';
    const name = FORMATS.includes(fromHref) ? fromHref : formatFromType(attr(tag, 'type'));
    if (name !== '' && !found.includes(name)) found.push(name);
  }
  return FORMATS.filter((name) => found.includes(name));
}

/**
 * Аннотация из OPDS часто заканчивается служебным хвостом «Год издания / Формат /
 * Размер / Скачиваний». Хвост в текст ответа не тащим, но размер и год забираем.
 */
function splitAnnotation(raw) {
  const text = plainText(raw);
  const size = /Размер:\s*([\d.,]+\s*[KMG]?[bб])/i.exec(text)?.[1] ?? '';
  const year = /Год издания:\s*(\d{4})/.exec(text)?.[1] ?? '';
  const cut = text.search(/\n(?:Год издания|Формат|Язык|Размер|Скачиваний):/);
  return { text: (cut > 0 ? text.slice(0, cut) : text).trim(), size, year };
}

function parseOpdsBooks(xml) {
  assertFeed(xml);
  const books = [];
  let skipped = 0;
  for (const entry of opdsEntries(xml)) {
    const id = /\/b\/(\d+)/.exec(entry)?.[1] ?? '';
    const title = plainText(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '');
    if (id === '' || title === '') {
      skipped += 1;
      continue;
    }
    const authors = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/g)]
      .map((match) => plainText(/<name>([\s\S]*?)<\/name>/.exec(match[1])?.[1] ?? ''))
      .filter((name) => name !== '');
    const annotation = splitAnnotation(/<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] ?? '');
    books.push({
      id,
      title,
      authors,
      annotation: annotation.text,
      size: annotation.size,
      year: annotation.year,
      formats: opdsFormats(entry, id),
      source: 'opds',
    });
  }
  // Пустой фид — законный ответ «ничего не найдено». А записи, которые не
  // разобрались, — уже сломанная схема: молча вернуть пусто значит соврать.
  if (books.length === 0 && skipped > 0) {
    throw new MarkupError(`OPDS: ${skipped} записей без id книги или названия`);
  }
  return books;
}

function parseOpdsAuthors(xml) {
  assertFeed(xml);
  const authors = [];
  let skipped = 0;
  for (const entry of opdsEntries(xml)) {
    const id = /\/opds\/author\/(\d+)/.exec(entry)?.[1] ?? '';
    const name = plainText(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '');
    if (id === '' || name === '') {
      skipped += 1;
      continue;
    }
    const count = /<content[^>]*>\s*(\d+)\s+книг/i.exec(entry)?.[1] ?? '';
    authors.push({ id, name, count, books: count === '' ? 0 : Number(count), source: 'opds' });
  }
  if (authors.length === 0 && skipped > 0) {
    throw new MarkupError(`OPDS: ${skipped} записей без id автора или имени`);
  }
  return authors;
}

// --- разбор HTML -------------------------------------------------------------

function parseHtmlSearch(html) {
  if (!/booksearch|Поиск книг/i.test(html)) {
    throw new MarkupError('HTML-поиск: страница не похожа на поиск Флибусты');
  }
  if (/Ничего не найдено/i.test(html)) return [];
  const header = /<h3[^>]*>\s*Найденные книги[^<]*<\/h3>/i.exec(html);
  if (header === null) throw new MarkupError('HTML-поиск: нет заголовка «Найденные книги»');
  const listStart = html.indexOf('<ul>', header.index);
  const listEnd = html.indexOf('</ul>', listStart);
  if (listStart === -1 || listEnd === -1) {
    throw new MarkupError('HTML-поиск: заголовок «Найденные книги» есть, а списка после него нет');
  }
  const books = [];
  for (const item of html.slice(listStart, listEnd).matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const id = /href="\/b\/(\d+)"/.exec(item[1])?.[1] ?? '';
    const title = /<a href="\/b\/\d+"[^>]*>([\s\S]*?)<\/a>/.exec(item[1])?.[1] ?? '';
    if (id === '' || title === '') continue;
    // Первая ссылка на автора — автор; вторая и дальше бывают иллюстраторами.
    const author = /<a href="\/a\/\d+"[^>]*>([\s\S]*?)<\/a>/.exec(item[1])?.[1] ?? '';
    books.push({
      id,
      title: plainText(title),
      authors: author === '' ? [] : [plainText(author)],
      annotation: '',
      size: '',
      year: '',
      formats: [],
      source: 'html',
    });
  }
  if (books.length === 0) {
    throw new MarkupError('HTML-поиск: заголовок «Найденные книги» есть, а книг в списке не нашлось');
  }
  return books;
}

function parseBookPage(html, expectedId) {
  const idMatch = /var bookId = (\d+)/.exec(html);
  const titleMatch = /<h1 class="title">([\s\S]*?)<\/h1>/.exec(html);
  if (titleMatch === null) {
    throw new MarkupError('страница книги: нет <h1 class="title">');
  }
  if (idMatch === null) {
    // Неверный id сайт не отдаёт как 404: он подставляет страницу поиска по числу.
    throw new NotFoundError(
      `зеркало отдало не книгу, а «${plainText(titleMatch[1])}»: такого id нет (сайт подменяет неверный id поиском). Книгу могли удалить — поищи её заново через book_search`,
    );
  }
  const id = idMatch[1];
  if (expectedId !== undefined && id !== String(expectedId)) {
    throw new NotFoundError(`на /b/${expectedId} лежит книга ${id}: зеркало ответило не тем`);
  }
  const heading = plainText(titleMatch[1]);
  const title = heading.replace(/\s*\((?:[a-z0-9+]{2,6})\)$/i, '').trim();
  const headStart = (titleMatch.index ?? 0) + titleMatch[0].length;
  const stamp = html.indexOf('<div class="fb2info', headStart);
  const headEnd = stamp === -1 ? headStart + 800 : stamp;
  const head = html.slice(headStart, headEnd);
  const authors = [...head.matchAll(/<a href="\/a\/(\d+)">([\s\S]*?)<\/a>/g)].map((match) => plainText(match[2]));
  const genres = [...html.matchAll(/<a href="\/g\/\d+" class="genre"[^>]*>([\s\S]*?)<\/a>/g)].map((match) =>
    plainText(match[1]),
  );
  const size = plainText(/<span[^>]*style=["']?size["']?[^>]*>([^<]*)<\/span>/i.exec(html)?.[1] ?? '');
  const downloadFrom = html.indexOf('скачать:');
  const downloadBlock = downloadFrom === -1 ? '' : html.slice(downloadFrom, downloadFrom + 2000);
  const formats = FORMATS.filter((name) => new RegExp(`/b/${id}/${name}"`).test(downloadBlock));
  const annotationHeading = /<h2>\s*Аннотация\s*<\/h2>/i.exec(html);
  let annotation = '';
  if (annotationHeading !== null) {
    const start = annotationHeading.index + annotationHeading[0].length;
    const end = html.indexOf('<hr', start);
    annotation = plainText(html.slice(start, end === -1 ? start + 6000 : end))
      // Хвост «(обсуждается на форуме — 265 сообщений)» — ссылка на форум, а не
      // часть описания книги; в ответе агента она только мешает.
      .replace(/\s*\(обсуждается на форуме[^)]*\)/gi, '')
      .trim();
  }
  const series = [...html.matchAll(/издано в серии\s*<a href="\/s\/\d+">([\s\S]*?)<\/a>/g)].map((match) =>
    plainText(match[1]),
  );
  const edition = /издание\s+(\d{4})\s+г\./.exec(html)?.[1] ?? '';
  const added = /Добавлена:\s*([\d.]{8,10})/.exec(html)?.[1] ?? '';
  return {
    id,
    title,
    authors,
    genres,
    size,
    formats,
    annotation,
    series,
    edition,
    added,
    source: 'html',
  };
}

// --- поиск и описание --------------------------------------------------------

function shownFormats(book) {
  return book.formats.length > 0 ? book.formats.join(', ') : 'форматы не показаны в выдаче';
}

function searchLine(book, index) {
  const author = book.authors.length > 0 ? book.authors.join(', ') : 'автор не указан';
  const extra = [shownFormats(book), book.size, book.year === '' ? '' : `${book.year} г.`].filter((part) => part !== '');
  return `${index + 1}. ${book.title} — ${author} · id ${book.id}${extra.length > 0 ? ` · ${extra.join(' · ')}` : ''}`;
}

async function searchBooks(query, { by = 'any', limit = LIMIT_DEFAULT } = {}) {
  if (by === 'author') return searchByAuthor(query, limit);
  const encoded = encodeURIComponent(query);
  let opdsError;
  try {
    const page = await readPage(`/opds/search?searchType=books&searchTerm=${encoded}`, (body) => parseOpdsBooks(body), {
      accept: 'application/atom+xml',
      what: `поиск «${query}» через OPDS`,
    });
    return { books: page.value.slice(0, limit), total: page.value.length, base: page.base, source: 'OPDS' };
  } catch (error) {
    opdsError = error;
  }
  // OPDS есть не у всех зеркал (flibusta.club отвечает на него 404), а HTML-поиск
  // есть везде. Если не вышло ни то ни другое — показываем ОБЕ причины, иначе
  // человек чинит не то.
  try {
    const page = await readPage(`/booksearch?ask=${encoded}`, (body) => parseHtmlSearch(body), {
      accept: 'text/html',
      what: `поиск «${query}» через HTML`,
    });
    return { books: page.value.slice(0, limit), total: page.value.length, base: page.base, source: 'HTML' };
  } catch (error) {
    const reason = (problem) => (problem instanceof Error ? problem.message : String(problem));
    throw new Error(`Не смог найти книги: ни OPDS, ни HTML-поиск не разобрались — это поломка парсера, а не пустая выдача.\nOPDS: ${reason(opdsError)}\nHTML: ${reason(error)}`, {
      cause: error,
    });
  }
}

async function searchByAuthor(query, limit) {
  const authorsPath = `/opds/search?searchType=authors&searchTerm=${encodeURIComponent(query)}`;
  const authors = await readPage(authorsPath, (body) => parseOpdsAuthors(body), {
    accept: 'application/atom+xml',
    what: `поиск авторов «${query}» через OPDS`,
  });
  // Сортировка по числу книг, а не по алфавиту: на «Булгаков» фид отдаёт
  // двадцать однофамильцев, и человек почти всегда имеет в виду того, у кого
  // книг двести сорок семь, а не «Булгаков Андрей» с одной.
  const ranked = [...authors.value].sort((first, second) => second.books - first.books);
  const chosen = ranked.slice(0, AUTHOR_FANOUT);
  const books = [];
  const unavailable = [];
  for (const author of chosen) {
    if (books.length >= limit) break;
    let feed;
    try {
      // Не /opds/author/<id>: там навигационный фид («Об авторе», «Книги по сериям»),
      // а сами книги — в /alphabet.
      feed = await readPage(`/opds/author/${author.id}/alphabet`, (body) => parseOpdsBooks(body), {
        accept: 'application/atom+xml',
        what: `книги автора ${author.name}`,
      });
    } catch (error) {
      // Один тяжёлый или битый автор не должен отменять весь поиск: остальных
      // показываем, а про этого честно говорим, что фид не открылся.
      unavailable.push(`${author.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const book of feed.value) {
      // В фиде автора автор может быть не проставлен — берём имя, по которому пришли.
      books.push({ ...book, authors: book.authors.length > 0 ? book.authors : [author.name] });
      if (books.length >= limit) break;
    }
  }
  const also = ranked.slice(AUTHOR_FANOUT, AUTHOR_FANOUT + 5).map((author) => `${author.name} (id ${author.id})`);
  return {
    books: books.slice(0, limit),
    total: books.length,
    base: authors.base,
    tried: authors.tried,
    source: 'OPDS',
    authors: ranked,
    also,
    unavailable,
  };
}

async function bookInfo(rawId) {
  const id = String(rawId ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) {
    throw new Error(`нужен числовой id книги, например 766078 (id даёт book_search), а пришло «${id}»`);
  }
  const { value, base, tried } = await readPage(`/b/${id}`, (body) => parseBookPage(body, id), {
    accept: 'text/html',
    what: `страница книги ${id}`,
  });
  return { book: value, base, tried };
}

function infoText(book, base) {
  const lines = [book.title];
  if (book.authors.length > 0) lines.push(book.authors.join(', '));
  if (book.genres.length > 0) lines.push(`Жанры: ${book.genres.join(', ')}`);
  const facts = [
    book.size,
    book.edition === '' ? '' : `издание ${book.edition} г.`,
    book.added === '' ? '' : `добавлена ${book.added}`,
    book.series.length > 0 ? `серия: ${book.series.join(', ')}` : '',
  ].filter((part) => part !== '');
  if (facts.length > 0) lines.push(facts.join(' · '));
  if (book.formats.length === 0) {
    lines.push('Форматы: сайт не показал ссылок на скачивание — скачать нечего, попробуй другое издание');
  } else {
    const preferred = book.formats.includes(DEFAULT_FORMAT) ? DEFAULT_FORMAT : book.formats[0];
    lines.push(`Форматы: ${book.formats.join(', ')} (по умолчанию ${preferred})`);
    if (book.formats.includes('fb2')) lines.push('fb2 сайт отдаёт архивом .fb2.zip: внутри один .fb2, читалки открывают такой архив как книгу');
  }
  lines.push(`зеркало: ${base}`);
  lines.push('');
  lines.push(book.annotation === '' ? 'Аннотации на странице нет.' : `Аннотация:\n${book.annotation}`);
  lines.push('');
  if (book.formats.length > 0) {
    const format = book.formats.includes(DEFAULT_FORMAT) ? DEFAULT_FORMAT : book.formats[0];
    lines.push(`Скачать: book_download с id ${book.id} и format "${format}", confirm: true — только если человек об этом попросил.`);
  }
  return lines.join('\n');
}

// --- реестр скачанного -------------------------------------------------------

/**
 * Реестр — не «менеджер книг», а список файлов рядом с ними: что уже скачано,
 * в каком формате и откуда. Читается глазами, правится руками, ломаться нечему.
 */
function libraryState() {
  let raw;
  try {
    raw = fs.readFileSync(LIBRARY_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { books: [], broken: null, existed: false };
    return { books: [], broken: `реестр не читается: ${error?.message ?? error}`, existed: true };
  }
  try {
    const parsed = JSON.parse(raw);
    const books = Array.isArray(parsed?.books) ? parsed.books : [];
    return { books: books.filter((entry) => entry && typeof entry.file === 'string'), broken: null, existed: true };
  } catch (error) {
    // Битый JSON не повод отказывать в скачивании: откладываем файл в сторону,
    // начинаем новый реестр и говорим об этом человеку.
    return { books: [], broken: `реестр не разобрался как JSON: ${error?.message ?? error}`, existed: true };
  }
}

function writeLibrary(books, broken) {
  fs.mkdirSync(path.dirname(LIBRARY_FILE), { recursive: true });
  let note = '';
  if (broken !== null) {
    const aside = `${LIBRARY_FILE}.broken-${Date.now()}`;
    fs.renameSync(LIBRARY_FILE, aside);
    note = `\n[!] Старый реестр был битым, отложил его в ${aside} и начал новый.`;
  }
  fs.writeFileSync(LIBRARY_FILE, `${JSON.stringify({ version: 1, books }, null, 2)}\n`);
  return note;
}

function libraryListText() {
  const state = libraryState();
  if (state.broken !== null) return `${state.broken}\nФайл: ${LIBRARY_FILE}`;
  if (state.books.length === 0) {
    return `Библиотека пуста: ${LIBRARY_FILE} (скачанного ещё нет).`;
  }
  const lines = state.books.map((entry, index) => {
    const author = entry.author === undefined || entry.author === '' ? 'автор неизвестен' : entry.author;
    return `${index + 1}. ${entry.title} — ${author} · ${entry.format} · ${formatBytes(entry.bytes)} · ${entry.savedAt} · ${entry.file}`;
  });
  return [`Библиотека: ${state.books.length} книг(и) в ${SAVE_DIR}`, ...lines].join('\n');
}

// --- скачивание --------------------------------------------------------------

function cleanName(text) {
  const cleaned = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 160) === '' ? 'книга' : cleaned.slice(0, 160);
}

function fileNameFor(book, format) {
  const author = book.authors[0] ?? '';
  const base = [author, book.title].filter((part) => part !== '').join(' - ');
  // fb2 у Флибусты всегда упакован в zip: расширение честное, иначе файл не откроется.
  return `${cleanName(base)}.${format === 'fb2' ? 'fb2.zip' : format}`;
}

function withSuffix(file, suffix) {
  const index = file.lastIndexOf('.');
  if (index <= 0) return `${file}${suffix}`;
  return `${file.slice(0, index)}${suffix}${file.slice(index)}`;
}

function targetFileFor(book, format) {
  const state = libraryState();
  const existing = state.books.find((entry) => entry.id === book.id && entry.format === format);
  if (existing !== undefined && fs.existsSync(path.join(SAVE_DIR, existing.file))) {
    // Уже качали этот формат — перезаписываем тот же файл, а не плодим копии.
    return { file: existing.file, replace: true, broken: state.broken };
  }
  const name = fileNameFor(book, format);
  let candidate = name;
  for (let index = 2; fs.existsSync(path.join(SAVE_DIR, candidate)); index += 1) {
    candidate = withSuffix(name, ` (${index})`);
  }
  return { file: candidate, replace: false, broken: state.broken };
}

async function downloadTo(target, pathname) {
  const base = MIRRORS[activeMirror];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const part = `${target}.part`;
  try {
    const response = await fetch(`${base}${pathname}`, {
      headers: { accept: '*/*', 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) throw new Error(`${base} ответило HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`файл ${formatBytes(declared)} больше лимита ${formatBytes(MAX_BYTES)} (FLIBUSTA_MAX_BYTES)`);
    }
    let written = 0;
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        written += chunk.length;
        if (written > MAX_BYTES) {
          done(new Error(`файл больше лимита ${formatBytes(MAX_BYTES)} (FLIBUSTA_MAX_BYTES) — скачивание остановлено`));
          return;
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(part));
    fs.renameSync(part, target);
    return written;
  } catch (error) {
    fs.rmSync(part, { force: true });
    if (controller.signal.aborted) {
      throw new Error(`скачивание не уложилось в ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} с`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBook({ id, format, confirm }) {
  if (confirm !== true) {
    throw new Error(
      'скачивание — это запись файла на диск и трафик: повтори с confirm: true. Без подтверждения человека не качаем',
    );
  }
  const info = await bookInfo(id);
  const book = info.book;
  const wanted = String(format ?? '').trim() === '' ? (book.formats.includes(DEFAULT_FORMAT) ? DEFAULT_FORMAT : book.formats[0] ?? '') : String(format).trim();
  if (wanted === '') throw new Error(`у книги ${id} нет ни одного формата для скачивания`);
  if (!book.formats.includes(wanted)) {
    throw new Error(`формата «${wanted}» у книги ${id} нет: сайт предлагает ${book.formats.join(', ')}`);
  }
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const target = targetFileFor(book, wanted);
  const full = path.join(SAVE_DIR, target.file);
  const bytes = await downloadTo(full, `/b/${id}/${wanted}`);
  const savedAt = new Date().toISOString().slice(0, 10);
  const state = libraryState();
  const entry = {
    id: book.id,
    title: book.title,
    author: book.authors.join(', '),
    format: wanted,
    file: target.file,
    bytes,
    savedAt,
    mirror: MIRRORS[activeMirror],
  };
  const books = [entry, ...state.books.filter((item) => !(item.id === book.id && item.format === wanted))];
  const note = writeLibrary(books, target.broken);
  const lines = [
    `Скачал: ${book.title}${book.authors.length > 0 ? ` — ${book.authors.join(', ')}` : ''}`,
    `Файл: ${full} (${formatBytes(bytes)}${target.replace ? ', перезаписал прежний' : ''}), зеркало ${MIRRORS[activeMirror]}`,
    `Формат: ${wanted}${wanted === 'fb2' ? ' (архив zip, внутри один .fb2)' : ''}`,
    `Реестр: ${LIBRARY_FILE} — теперь ${books.length} книг(и).`,
  ];
  if (note !== '') lines.push(note.trim());
  lines.push('Скачивай только то, что человек попросил, и не выкладывай файлы в общий доступ.');
  return lines.join('\n');
}

// --- зеркала -----------------------------------------------------------------

async function mirrorStatusText() {
  const lines = ['Зеркала Флибусты (FLIBUSTA_MIRROR, FLIBUSTA_MIRRORS):'];
  for (const base of MIRRORS) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(`${base}/`, {
          headers: { accept: 'text/html', 'user-agent': USER_AGENT },
          redirect: 'follow',
          signal: controller.signal,
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
      lines.push(`✓ ${base} — ${Date.now() - started} мс`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lines.push(`✗ ${base} — ${reason}`);
    }
  }
  lines.push(`Текущее: ${MIRRORS[activeMirror]}`);
  return lines.join('\n');
}

// --- инструменты MCP ---------------------------------------------------------

const INSTRUCTIONS = `Книги во Флибусте. Флибуста — библиотека без API по ключу: сервер сам ходит на сайт (OPDS и HTML) и разбирает ответ. Отсюда правила:

1. book_search(query) — только чтение, ничего не качает. Ищет по названию и автору сразу; by: "author" — сначала находит автора, потом его книги. Отдаёт id книг — дальше работай по ним, id не выдумывай.
2. book_info(id) — описание: авторы, жанры, размер, форматы (fb2/epub/mobi) и аннотация.
3. book_download(id, format, confirm: true) — единственный инструмент, который пишет файл на диск. Качай только по прямой просьбе человека; без confirm сервер откажет. Файл ложится в папку вложений (incoming) человеческим именем «Автор - Название.формат», а не в библиотеку Calibre: её здесь нет. fb2 сайт отдаёт архивом .fb2.zip — это нормально, внутри один .fb2.
4. library_list() — мини-реестр скачанного (library.json рядом с файлами): что уже есть, в каком формате. Нужен, чтобы не качать одно и то же и чтобы человек видел свою полку.
5. mirror_status() — какие зеркала живы и какое отвечает сейчас.

Форматы: по умолчанию fb2 (родной формат библиотеки), epub и mobi собирает конвертер сайта на лету. Конвертер иногда занят — тогда epub/mobi может не скачаться, а fb2 скачается.

Ошибки не склеивай: «ничего не найдено» — это разобранная пустая выдача; «парсер сломался» — сайт сменил разметку, и это надо сказать человеку честно; «зеркала не ответили» — сеть или зеркало. Не предлагай человеку искать вручную, пока не позвал mirror_status.`;

const TOOLS = [
  {
    name: 'book_search',
    description:
      'Поиск книг во Флибусте по названию или автору. Только чтение: ничего не качает. Отдаёт id книг, авторов и доступные форматы.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название книги или имя автора.' },
        by: { type: 'string', enum: ['any', 'author'], description: 'any — искать книги по названию/автору; author — сначала найти автора, потом его книги.' },
        limit: { type: 'number', description: `Сколько книг вернуть, 1–${LIMIT_MAX} (по умолчанию ${LIMIT_DEFAULT}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_info',
    description:
      'Описание книги по id: авторы, жанры, размер, форматы для скачивания (fb2/epub/mobi) и аннотация. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Числовой id книги из book_search, например 766078.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_download',
    description:
      'Скачать книгу в выбранном формате в папку вложений incoming и записать её в мини-реестр. Записывает файл на диск — требует confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Числовой id книги из book_search.' },
        format: { type: 'string', description: 'Формат: fb2, epub, mobi (те, что book_info показал для этой книги).' },
        confirm: { type: 'boolean', description: 'true — человек правда попросил скачать. Без этого сервер откажет.' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'library_list',
    description: 'Мини-реестр скачанного: название, автор, формат, размер и файл. Читает library.json рядом с книгами.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mirror_status',
    description: 'Проверить зеркала Флибусты: какое живо, какое отвечает сейчас. Только чтение.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function clampLimit(raw) {
  const value = Number(raw ?? LIMIT_DEFAULT);
  if (!Number.isFinite(value)) return LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), 1), LIMIT_MAX);
}

function searchArgs(args) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query === '') throw new Error('пустой запрос: нужен query — название книги или имя автора');
  return { query, by: args.by === 'author' ? 'author' : 'any', limit: clampLimit(args.limit) };
}

async function searchText(args) {
  const { query, by, limit } = searchArgs(args);
  const result = await searchBooks(query, { by, limit });
  const head = [
    `Запрос: «${query}»${by === 'author' ? ' (по автору)' : ''} · зеркало ${result.base} · ${result.source}`,
  ];
  if (result.authors !== undefined && by === 'author') {
    head.push(
      `Авторы по числу книг: ${result.authors
        .slice(0, 3)
        .map((author) => `${author.name}${author.count === '' ? '' : ` (${author.count} книг)`}`)
        .join('; ')}`,
    );
  }
  if (result.books.length === 0) {
    head.push('Ничего не найдено. Разметка разобралась, выдача пустая — попробуй другое написание или book_search с by: "author".');
    if (result.unavailable !== undefined && result.unavailable.length > 0) {
      head.push(`Не открылись: ${result.unavailable.join('; ')}`);
    }
    return head.join('\n');
  }
  head.push(`Нашлось: ${result.books.length}${result.total > result.books.length ? ` из ${result.total}` : ''}`);
  result.books.forEach((book, index) => head.push(searchLine(book, index)));
  if (result.also !== undefined && result.also.length > 0) {
    const more = (result.authors?.length ?? 0) > AUTHOR_FANOUT + 5 ? ', …' : '';
    head.push(`Ещё авторы: ${result.also.join('; ')}${more}`);
  }
  if (result.unavailable !== undefined && result.unavailable.length > 0) {
    head.push(`Не открылись: ${result.unavailable.join('; ')}`);
  }
  head.push('');
  head.push('Дальше: book_info с id — аннотация и форматы; book_download с confirm: true — скачать (только по просьбе человека).');
  return head.join('\n');
}

async function infoTextFor(args) {
  const { book, base } = await bookInfo(args.id);
  return infoText(book, base);
}

async function downloadText(args) {
  return downloadBook({ id: args.id, format: args.format, confirm: args.confirm === true });
}

const HANDLERS = {
  book_search: searchText,
  book_info: infoTextFor,
  book_download: downloadText,
  library_list: () => libraryListText(),
  mirror_status: () => mirrorStatusText(),
};

// --- протокол ----------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  process.stderr.write(`[flibusta] ${message}\n`);
}

async function dispatch(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    };
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = HANDLERS[name];
    if (handler === undefined) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `неизвестный инструмент: ${name}` }], isError: true },
      };
    }
    try {
      const text = await handler(args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true },
      };
    }
  }
  if (id === undefined || id === null) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

function serveStdio() {
  let buffer = '';
  let inflight = 0;
  const idle = (maxMs = 10_000) =>
    new Promise((resolve) => {
      const deadline = Date.now() + maxMs;
      const tick = () => (inflight === 0 || Date.now() > deadline ? resolve() : setTimeout(tick, 20));
      tick();
    });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      inflight += 1;
      dispatch(message)
        .then((response) => {
          if (response) send(response);
        })
        .catch((error) => log(String(error?.stack ?? error)))
        .finally(() => {
          inflight -= 1;
        });
    }
  });
  process.stdin.on('end', async () => {
    // Ждём не «десять секунд от балды»: запрос к чужому сайту и скачивание файла
    // живут дольше, и обрывать их на полуслове значит потерять уже сделанную работу.
    await idle(Math.max(60_000, DOWNLOAD_TIMEOUT_MS + 5_000));
    process.exit(0);
  });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) serveStdio();

export {
  INSTRUCTIONS,
  LIBRARY_FILE,
  MIRRORS,
  SAVE_DIR,
  TOOLS,
  fileNameFor,
  parseBookPage,
  parseHtmlSearch,
  parseOpdsAuthors,
  parseOpdsBooks,
  plainText,
};
