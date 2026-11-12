#!/usr/bin/env node
// OPDS-каталог: MCP-сервер, который проксирует книжный каталог по протоколу OPDS.
//
// OPDS — это Atom/XML, который читают читалки: в нём есть разделы, поиск через
// OpenSearch и ссылки на файлы. Своего API по ключу у каталогов обычно нет, зато
// OPDS отдаёт всё нужное без HTML-вёрстки. Сервер универсальный: сайт не зашит,
// адрес каталога приходит в OPDS_URL, поэтому один и тот же код работает и с
// Project Gutenberg, и с домашним Calibre, и с библиотекой на другом движке.
//
// Поиск, навигация и карточка — только чтение. Скачивание — отдельный инструмент
// с confirm: true, лимитом размера и человеческим именем файла; файл ложится в
// incoming/, который виден панели и Telegram (тот же путь, что у вложений).
//
// Главная опасность такого сервера — тихая пустая выдача: каталог поменял
// разметку или в OPDS_URL вписали HTML-страницу, а человеку сказали «ничего не
// найдено». Поэтому «ничего не найдено» — это только разобранная пустая выдача,
// а всё остальное (не Atom, 401, таймаут, нет ссылки поиска) — отдельные ошибки
// с причиной и подсказкой, что чинить.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'opds', version: '1.0.0' };
const USER_AGENT = 'Icarus/0.1 (+opds-mcp)';

const OPDS_URL = envText('OPDS_URL');
const OPDS_USER = envText('OPDS_USER');
const OPDS_PASSWORD = envText('OPDS_PASSWORD');
const OPDS_TOKEN = envText('OPDS_TOKEN');
const TIMEOUT_MS = Math.round(envNumber('OPDS_TIMEOUT_SECONDS', 15) * 1000);
const MAX_DOWNLOAD_BYTES = Math.floor(envNumber('OPDS_MAX_DOWNLOAD_MB', 25) * 1024 * 1024);
const DOWNLOAD_TIMEOUT_MS = Math.max(120_000, TIMEOUT_MS * 2);

/**
 * Куда класть скачанное: incoming человека. ICARUS_HOME уже есть в контейнере
 * (/workspaces/.icarus), поэтому путь совпадает с папкой вложений — оттуда файл
 * видно и панели, и Telegram. cwd — запасной путь для запуска руками.
 */
const ICARUS_HOME = envText('ICARUS_HOME');
const SAVE_DIR = envText('OPDS_SAVE_DIR') || path.join(ICARUS_HOME === '' ? process.cwd() : ICARUS_HOME, 'incoming');

const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 30;

function envText(name) {
  return (process.env[name] ?? '').trim();
}

function envNumber(name, fallback) {
  const value = Number(envText(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

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
 * описание как &lt;p&gt;…&lt;br/&gt;, и без этого абзацы слиплись бы в строку.
 */
function plainText(raw) {
  const decoded = decodeEntities(raw);
  const withBreaks = decoded.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n\n');
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

// --- разбор Atom/OPDS --------------------------------------------------------

/** Префикс пространства имён необязателен: dcterms, dc, atom — у всех каталогов по-разному. */
const PREFIX = '(?:[\\w.-]+:)?';
const ENTRY_RE = new RegExp(`<${PREFIX}entry\\b[^>]*>([\\s\\S]*?)</${PREFIX}entry>`, 'gi');
const LINK_RE = new RegExp(`<${PREFIX}link\\b[^>]*>`, 'gi');

function tagText(xml, name) {
  const match = new RegExp(`<${PREFIX}${name}\\b[^>]*>([\\s\\S]*?)</${PREFIX}${name}>`, 'i').exec(xml);
  return match === null ? '' : match[1];
}

function parseLinks(xml) {
  return [...xml.matchAll(LINK_RE)].map((match) => {
    const tag = match[0];
    return {
      rel: attr(tag, 'rel').trim(),
      href: attr(tag, 'href').trim(),
      type: attr(tag, 'type').trim(),
      title: attr(tag, 'title').trim(),
      length: Number(attr(tag, 'length')) || 0,
    };
  });
}

/** Ответ не Atom/OPDS — это не каталог: HTML-страница, JSON ошибки, что угодно. */
function assertFeed(xml, url, contentType) {
  const head = xml.slice(0, 4000);
  const isFeed = new RegExp(`<${PREFIX}feed\\b`, 'i').test(head) && /xmlns(?::[\w.-]+)?\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(head);
  if (!isFeed) {
    throw new Error(
      `ответ не Atom/OPDS — это не каталог: ${url} (content-type: ${contentType === '' ? 'не указан' : contentType}). ` +
        'В OPDS_URL нужен адрес OPDS-каталога (обычно заканчивается на .opds/ или /opds/), а не HTML-страницы.',
    );
  }
}

/** Ссылка на карточку записи: сначала раздел/подкаталог, потом сам OPDS-фид, потом id. */
function detailHref(entry, feedUrl) {
  const catalog = entry.links.filter((link) => /opds-catalog|application\/atom\+xml/i.test(link.type) || /subsection/i.test(link.rel));
  const preferred =
    catalog.find((link) => /subsection/i.test(link.rel)) ??
    catalog.find((link) => /opds-catalog/i.test(link.type)) ??
    catalog.find((link) => /application\/atom\+xml/i.test(link.type));
  if (preferred !== undefined && preferred.href !== '') return resolveUrl(feedUrl, preferred.href);
  if (/^https?:\/\//i.test(entry.id)) return entry.id;
  const alternate = entry.links.find((link) => /alternate/i.test(link.rel) && link.href !== '');
  return alternate === undefined ? '' : resolveUrl(feedUrl, alternate.href);
}

function parseEntry(xml, feedUrl) {
  const links = parseLinks(xml);
  const authors = [...xml.matchAll(new RegExp(`<${PREFIX}author\\b[^>]*>([\\s\\S]*?)</${PREFIX}author>`, 'gi'))]
    .map((match) => plainText(tagText(match[1], 'name')))
    .filter((name) => name !== '');
  const languages = [...xml.matchAll(new RegExp(`<(${PREFIX}language)\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi'))]
    .map((match) => plainText(match[2]))
    .filter((name) => name !== '');
  const entry = {
    title: plainText(tagText(xml, 'title')),
    id: plainText(tagText(xml, 'id')),
    published: plainText(tagText(xml, 'published')),
    authors: [...new Set(authors)],
    languages: [...new Set(languages)],
    content: plainText(tagText(xml, 'content')),
    summary: plainText(tagText(xml, 'summary')),
    extent: plainText(tagText(xml, 'extent')),
    rights: plainText(tagText(xml, 'rights')),
    links,
    acquisitions: links
      .filter((link) => /acquisition/i.test(link.rel) && link.href !== '')
      .map((link) => ({ ...link, href: resolveUrl(feedUrl, link.href) })),
  };
  entry.detail = detailHref(entry, feedUrl);
  return entry;
}

function parseFeed(xml, url, contentType = '') {
  assertFeed(xml, url, contentType);
  const firstEntry = xml.search(new RegExp(`<${PREFIX}entry\\b`, 'i'));
  const header = firstEntry === -1 ? xml : xml.slice(0, firstEntry);
  const entries = [...xml.matchAll(ENTRY_RE)].map((match) => parseEntry(match[1], url));
  return {
    url,
    title: plainText(tagText(header, 'title')),
    links: parseLinks(header),
    entries,
  };
}

// --- сеть --------------------------------------------------------------------

function resolveUrl(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function authHeaders() {
  if (OPDS_TOKEN !== '') return { authorization: `Bearer ${OPDS_TOKEN}` };
  if (OPDS_USER !== '' || OPDS_PASSWORD !== '') {
    return { authorization: `Basic ${Buffer.from(`${OPDS_USER}:${OPDS_PASSWORD}`).toString('base64')}` };
  }
  return {};
}

function endpoint() {
  if (OPDS_URL === '') {
    throw new Error(
      'OPDS_URL не задан: впиши адрес OPDS-каталога в переменные окружения сервера, например https://www.gutenberg.org/ebooks.opds/ (у домашнего Calibre — http://<адрес>:8080/opds/).',
    );
  }
  let parsed;
  try {
    parsed = new URL(OPDS_URL);
  } catch {
    throw new Error(`OPDS_URL — не адрес: «${OPDS_URL}». Нужен http(s)-адрес корня OPDS-каталога.`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`OPDS_URL должен быть http(s)-адресом, а не ${parsed.protocol}`);
  }
  return parsed.href;
}

async function getText(url, { accept = 'application/atom+xml,application/xml;q=0.9,*/*;q=0.1', timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: { accept, 'user-agent': USER_AGENT, ...authHeaders() },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`каталог не ответил за ${Math.round(timeoutMs / 1000)} с (OPDS_TIMEOUT_SECONDS): ${url}`, { cause: error });
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`каталог не ответил: ${url} — ${reason}. Проверь адрес и сеть из контейнера.`, { cause: error });
    }
    if (!response.ok) throw httpError(url, response.status);
    return { text: await response.text(), url: response.url || url, contentType: response.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(timer);
  }
}

function httpError(url, status) {
  if (status === 401 || status === 403) {
    return new Error(
      `каталог требует авторизации (HTTP ${status}): ${url}. Задай OPDS_USER и OPDS_PASSWORD (basic) или OPDS_TOKEN (Bearer) в переменных окружения сервера.`,
    );
  }
  if (status === 404) {
    return new Error(`HTTP 404 — адрес не найден: ${url}. Проверь OPDS_URL: нужен корень каталога, обычно он заканчивается на .opds/ или /opds/.`);
  }
  return new Error(`каталог ответил HTTP ${status}: ${url}`);
}

async function fetchFeed(url, what) {
  const page = await getText(url);
  try {
    return parseFeed(page.text, page.url, page.contentType);
  } catch (error) {
    throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// --- корень каталога и поиск -------------------------------------------------

let rootCache = null;
let templateCache = null;

async function rootFeed() {
  if (rootCache !== null) return rootCache;
  const url = endpoint();
  rootCache = await fetchFeed(url, 'корневой каталог OPDS');
  return rootCache;
}

/**
 * Шаблон поиска по правилам OPDS: link rel="search" с {searchTerms} прямо в href
 * либо ссылка на OpenSearch Description, внутри которой есть <Url type="application/atom+xml">.
 * Если шаблона нет — не выдумываем его молча, а возвращаем null: вызывающий
 * попробует стандартные пути и честно перечислит, что не сработало.
 */
async function searchTemplate() {
  if (templateCache !== null) return templateCache;
  const root = await rootFeed();
  for (const link of root.links) {
    if (!/\bsearch\b/i.test(link.rel) || link.href === '') continue;
    if (link.href.includes('{searchTerms}')) {
      templateCache = resolveUrl(root.url, link.href);
      return templateCache;
    }
    if (/opensearchdescription/i.test(link.type)) {
      const osdUrl = resolveUrl(root.url, link.href);
      const osd = await getText(osdUrl, { accept: 'application/opensearchdescription+xml,application/xml;q=0.9,*/*;q=0.1' });
      const urls = [...osd.text.matchAll(new RegExp(`<${PREFIX}Url\\b[^>]*>`, 'gi'))].map((match) => match[0]);
      const withTemplate = urls.filter((tag) => attr(tag, 'template').includes('{searchTerms}'));
      const chosen = withTemplate.find((tag) => /application\/atom\+xml/i.test(attr(tag, 'type'))) ?? withTemplate[0];
      if (chosen !== undefined) {
        templateCache = resolveUrl(osd.url, attr(chosen, 'template'));
        return templateCache;
      }
    }
  }
  return null;
}

function fillTemplate(template, query) {
  const encoded = encodeURIComponent(query);
  // Необязательные параметры OpenSearch ({startIndex?}, {count?}) не подставляем:
  // без них каталог отдаёт первую страницу, а битый шаблон — повод для ошибки.
  return template
    .replace(/\{searchTerms\}/g, encoded)
    .replace(/[?&][^=&#]+=\{[^}]*\?[^}]*\}/g, '');
}

async function searchFeed(query) {
  const root = await rootFeed();
  const own = await searchTemplate();
  const candidates =
    own === null
      ? [resolveUrl(root.url, 'search?q={searchTerms}'), resolveUrl(root.url, 'search.opds?query={searchTerms}')]
      : [own];
  const failures = [];
  for (const candidate of candidates) {
    const url = fillTemplate(candidate, query);
    try {
      return { feed: await fetchFeed(url, `поиск «${query}»`), url };
    } catch (error) {
      failures.push(`${url} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (own === null) {
    throw new Error(
      `каталог не умеет искать: в корневом фиде нет шаблона rel="search" с {searchTerms}, а стандартные пути не ответили.\nПробовал:\n- ${failures.join('\n- ')}\nЭто ограничение каталога, а не пустая выдача.`,
    );
  }
  throw new Error(`поиск «${query}» не удался:\n- ${failures.join('\n- ')}`);
}

// --- формат и описание -------------------------------------------------------

const MIME_FORMATS = {
  'application/epub+zip': 'epub',
  'application/x-mobipocket-ebook': 'mobi',
  'application/pdf': 'pdf',
  'application/x-fictionbook+xml': 'fb2',
  'application/x-fictionbook': 'fb2',
  'text/html': 'html',
  'text/plain': 'txt',
  'application/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-djvu': 'djvu',
  'image/vnd.djvu': 'djvu',
  'application/x-cbr': 'cbr',
  'application/vnd.amazon.ebook': 'azw3',
};

/** Порядок предпочтения: EPUB открывает всё, PDF не перевёрстан, дальше по вкусу. */
const FORMAT_ORDER = ['epub', 'fb2', 'pdf', 'mobi', 'azw3', 'djvu', 'docx', 'doc', 'rtf', 'txt', 'html', 'zip', 'cbr'];

function formatOf(link) {
  const type = (link.type.split(';')[0] ?? '').trim().toLowerCase();
  if (MIME_FORMATS[type] !== undefined) return MIME_FORMATS[type];
  const ext = (/\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(link.href)?.[1] ?? '').toLowerCase();
  if (ext !== '' && FORMAT_ORDER.includes(ext)) return ext;
  const subtype = (type.split('/')[1] ?? '').replace(/^x-/, '').replace(/\+.*$/, '');
  return subtype === '' ? (ext === '' ? 'file' : ext) : subtype;
}

/** Формат, под которым файл реально скачать: тот же, что в MIME/расширении, иначе — расширение. */
function extensionOf(format, link) {
  if (/^[a-z0-9]{1,8}$/i.test(format)) return format.toLowerCase();
  return (/\.([a-z0-9]{1,8})(?:[?#]|$)/i.exec(link.href)?.[1] ?? 'bin').toLowerCase();
}

function acquisitionInfo(link) {
  const format = formatOf(link);
  return {
    format,
    ext: extensionOf(format, link),
    type: link.type,
    title: link.title,
    bytes: link.length,
    href: link.href,
  };
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function preferredFormat(formats) {
  for (const name of FORMAT_ORDER) {
    const found = formats.find((format) => format.format === name);
    if (found !== undefined) return found.format;
  }
  return formats[0]?.format ?? '';
}

/** «Аннотация:» среди служебных полей content — обычное дело в OPDS. Берём её и до следующей метки. */
function annotationOf(content) {
  if (content === '') return '';
  const lines = content.split('\n');
  const label = /^(?:Summary|Аннотация|Annotation|Описание|Description|Abstract)\s*:\s*(.*)$/i;
  const start = lines.findIndex((line) => label.test(line.trim()));
  let body = content;
  if (start >= 0) {
    const first = label.exec(lines[start].trim())[1];
    const rest = [first, ...lines.slice(start + 1)];
    // Следующая служебная метка вида «Reading Level:» или «Автор:» — уже не аннотация.
    const stop = rest.findIndex((line, index) => index > 0 && /^[A-ZА-ЯЁ][^:\n]{0,40}:/.test(line.trim()));
    body = (stop > 0 ? rest.slice(0, stop) : rest).join('\n').trim();
  }
  return body.length > 1200 ? `${body.slice(0, 1200).trim()}…` : body;
}

/** Короткая подпись из content, если автора в записи нет: в выдаче бывает только «Charles Dickens». */
function authorHint(entry) {
  if (entry.authors.length > 0) return entry.authors.join(', ');
  const text = entry.content;
  if (text !== '' && text.length <= 120 && !text.includes('\n') && !/[.!?]$/.test(text)) return text;
  return '';
}

function bookHref(entry) {
  // Запись с готовыми ссылками на файлы — это уже книга (так отдаёт поиск
  // Calibre): карточка не нужна, все данные пришли в самой записи.
  if (entry.acquisitions.length > 0) return entry.acquisitions[0].href;
  return entry.detail;
}

/** Форматы записи одной строкой: в выдаче бывает сразу ссылка на файл, без карточки. */
function entryFormats(entry) {
  return uniqueBy(entry.acquisitions.map((link) => ({ format: formatOf(link), bytes: link.length })), (item) => item.format)
    .map((item) => `${item.format}${item.bytes > 0 ? ` (${formatBytes(item.bytes)})` : ''}`)
    .join(', ');
}

/**
 * Запоминаем книги, которые пришли сразу со ссылками на файлы: у Calibre поиск
 * отдаёт acquisition-записи, и отдельного Atom-фида карточки у них нет. Тогда
 * book_info/book_download берут карточку из памяти, а не пытаются скачать фид с
 * адреса файла. Ключ — ссылка на файл, её и показывает выдача.
 */
const entryCache = new Map();

function rememberEntries(feed) {
  for (const entry of feed.entries) {
    for (const link of entry.acquisitions) entryCache.set(link.href, entry);
  }
}

function isSection(entry, feedUrl) {
  const href = bookHref(entry);
  return entry.acquisitions.length === 0 && /\/search(?:\.opds)?(?:[/?]|$)/i.test(href) && href !== feedUrl;
}

function cardFromEntries(entries, url, feedTitle) {
  const withFiles = entries.filter((entry) => entry.acquisitions.length > 0);
  const source = withFiles.length > 0 ? withFiles : entries;
  const primary = source[0] ?? entries[0];
  const formats = uniqueBy(
    source.flatMap((entry) => entry.acquisitions.map(acquisitionInfo)),
    (format) => format.format,
  );
  const annotation = entries.map((entry) => annotationOf(entry.summary !== '' ? entry.summary : entry.content)).find((text) => text !== '') ?? '';
  return {
    url,
    title: primary.title !== '' ? primary.title : feedTitle,
    authors: [...new Set(source.flatMap((entry) => entry.authors))],
    year: (/\d{4}/.exec(primary.published)?.[0] ?? ''),
    languages: [...new Set(source.flatMap((entry) => entry.languages))],
    extent: primary.extent,
    formats,
    annotation,
    rights: primary.rights,
  };
}

/** Похоже ли на прямую ссылку на файл: тогда фид с неё не придёт. */
function looksLikeFile(url) {
  return new RegExp(`\\.(${FORMAT_ORDER.join('|')})(?:[?#]|$)`, 'i').test(url);
}

async function readCard(link) {
  const href = String(link ?? '').trim();
  if (href === '') throw new Error('нужен link — ссылка на карточку книги из catalog_search или catalog_browse');
  const url = resolveUrl(endpoint(), href);
  const cached = entryCache.get(href) ?? entryCache.get(url);
  if (cached !== undefined) return cardFromEntries([cached], url, '');
  if (looksLikeFile(url)) {
    throw new Error(
      `ссылка ведёт на файл, а не на карточку: ${url}. Карточку такой книги знает только выдача — повтори catalog_search и передай link оттуда (сервер запоминает книги, которые каталог отдаёт сразу ссылками на файлы).`,
    );
  }
  const feed = await fetchFeed(url, 'карточка книги');
  if (feed.entries.length === 0) {
    throw new Error(`в фиде нет ни одной записи: ${url}. Это не карточка книги — проверь ссылку (link из выдачи).`);
  }
  return cardFromEntries(feed.entries, url, feed.title);
}

// --- вывод инструментов ------------------------------------------------------

function searchText(feed, query, limit, catalogTitle) {
  const sections = feed.entries.filter((entry) => isSection(entry, feed.url));
  const books = feed.entries.filter((entry) => !isSection(entry, feed.url));
  const shown = books.slice(0, limit);
  const lines = [`Поиск «${query}» в ${catalogTitle === '' ? 'каталоге' : catalogTitle}: книг ${books.length}${books.length > shown.length ? `, показаны первые ${shown.length}` : ''}${sections.length > 0 ? ` · разделов ${sections.length}` : ''}`];
  if (sections.length > 0) {
    lines.push('', 'Разделы:');
    for (const section of sections.slice(0, limit)) {
      const note = section.content === '' ? '' : ` — ${section.content}`;
      lines.push(`- ${section.title}${note} · ${bookHref(section)}`);
    }
  }
  if (shown.length === 0 && sections.length === 0) {
    lines.push('', 'Ничего не найдено: разметка разобралась, выдача пустая. Попробуй другое написание.');
    return lines.join('\n');
  }
  if (shown.length > 0) {
    lines.push('', 'Книги:');
    shown.forEach((entry, index) => {
      const author = authorHint(entry);
      const formats = entryFormats(entry);
      const link = bookHref(entry);
      lines.push(
        `${index + 1}. ${entry.title}${author === '' ? '' : ` — ${author}`}${formats === '' ? '' : ` · ${formats}`}${link === '' ? '' : ` · ${link}`}`,
      );
    });
  }
  lines.push('', 'Дальше: book_info с link — карточка и форматы; book_download с confirm: true — скачать (только по просьбе человека).');
  return lines.join('\n');
}

function browseText(feed, limit) {
  // В корне разделы ведут на поисковые фиды — это разделы; в фиде полки записи
  // ведут на карточки книг — это книги. Различаем по той же ссылке, что и в поиске.
  const sections = feed.entries.filter((entry) => entry.acquisitions.length === 0 && isSection(entry, feed.url));
  const books = feed.entries.filter((entry) => entry.acquisitions.length > 0 || !isSection(entry, feed.url));
  const lines = [`Каталог: ${feed.title === '' ? '(без названия)' : feed.title}`, `Ссылка: ${feed.url}`];
  if (sections.length > 0) {
    lines.push('', 'Разделы:');
    for (const entry of sections.slice(0, limit)) {
      const note = entry.content === '' ? '' : ` — ${entry.content}`;
      const link = bookHref(entry);
      lines.push(`- ${entry.title}${note}${link === '' ? '' : ` · ${link}`}`);
    }
  }
  if (books.length > 0) {
    lines.push('', 'Книги:');
    books.slice(0, limit).forEach((entry, index) => {
      const author = authorHint(entry);
      const formats = entryFormats(entry);
      const link = bookHref(entry);
      lines.push(
        `${index + 1}. ${entry.title}${author === '' ? '' : ` — ${author}`}${formats === '' ? '' : ` · ${formats}`}${link === '' ? '' : ` · ${link}`}`,
      );
    });
  }
  if (feed.entries.length === 0) lines.push('', 'В этом фиде нет записей: каталог пуст или раздел без содержимого.');
  lines.push('', 'Дальше: catalog_browse с link раздела — глубже; catalog_search с query — поиск по всему каталогу.');
  return lines.join('\n');
}

function cardText(card) {
  const lines = [card.title];
  lines.push(card.authors.length > 0 ? card.authors.join(', ') : 'автор не указан в каталоге');
  const facts = [card.year === '' ? '' : `год ${card.year}`, card.languages.length > 0 ? `языки: ${card.languages.join(', ')}` : ''].filter((part) => part !== '');
  if (facts.length > 0) lines.push(facts.join(' · '));
  if (card.formats.length === 0) {
    lines.push(`Форматы: каталог не дал ссылок на скачивание${card.extent === '' ? '' : ` (объём: ${card.extent})`} — скачать нечего.`);
  } else {
    const described = card.formats.map((format) => {
      const size = format.bytes > 0 ? formatBytes(format.bytes) : '';
      return `${format.format}${size === '' ? '' : ` (${size})`}`;
    });
    lines.push(`Форматы: ${described.join(', ')}`);
    if (card.extent !== '' && card.formats.every((format) => format.bytes === 0)) lines.push(`Объём: ${card.extent}`);
  }
  if (card.rights !== '') lines.push(`Права: ${card.rights}`);
  lines.push(`Источник: ${card.url}`, '');
  lines.push(card.annotation === '' ? 'Аннотации в каталоге нет.' : `Аннотация:\n${card.annotation}`);
  if (card.formats.length > 0) {
    const wanted = preferredFormat(card.formats);
    lines.push('', `Скачать: book_download с link "${card.url}", format "${wanted}", confirm: true — только если человек об этом попросил.`);
  }
  return lines.join('\n');
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

function withSuffix(file, suffix) {
  const index = file.lastIndexOf('.');
  if (index <= 0) return `${file}${suffix}`;
  return `${file.slice(0, index)}${suffix}${file.slice(index)}`;
}

function targetFileFor(card, format) {
  const author = card.authors[0] ?? '';
  const base = [author, card.title].filter((part) => part !== '').join(' - ');
  const name = `${cleanName(base)}.${format.ext}`;
  let candidate = name;
  for (let index = 2; fs.existsSync(path.join(SAVE_DIR, candidate)); index += 1) {
    candidate = withSuffix(name, ` (${index})`);
  }
  return candidate;
}

async function downloadTo(url, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const part = `${target}.part`;
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: '*/*', 'user-agent': USER_AGENT, ...authHeaders() },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`скачивание не уложилось в ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} с`, { cause: error });
      throw new Error(`файл не скачался: ${url} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!response.ok) throw httpError(url, response.status);
    if (response.body === null) throw new Error(`каталог отдал пустой ответ на ${url}`);
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`файл ${formatBytes(declared)} больше лимита ${formatBytes(MAX_DOWNLOAD_BYTES)} (OPDS_MAX_DOWNLOAD_MB) — скачивание остановлено`);
    }
    let written = 0;
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        written += chunk.length;
        if (written > MAX_DOWNLOAD_BYTES) {
          done(new Error(`файл больше лимита ${formatBytes(MAX_DOWNLOAD_BYTES)} (OPDS_MAX_DOWNLOAD_MB) — скачивание остановлено`));
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
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBook(args) {
  if (args.confirm !== true) {
    throw new Error('скачивание — это запись файла на диск: повтори с confirm: true. Без подтверждения человека не качаем.');
  }
  const card = await readCard(args.link);
  if (card.formats.length === 0) throw new Error(`у книги «${card.title}» нет ни одного формата для скачивания: ${card.url}`);
  const requested = typeof args.format === 'string' ? args.format.trim().toLowerCase() : '';
  let chosen;
  if (requested === '') {
    chosen = card.formats.find((format) => format.format === preferredFormat(card.formats)) ?? card.formats[0];
  } else {
    chosen = card.formats.find((format) => format.format === requested || format.ext === requested);
    if (chosen === undefined) {
      throw new Error(`формата «${requested}» у книги нет: каталог предлагает ${card.formats.map((format) => format.format).join(', ')}`);
    }
  }
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const file = targetFileFor(card, chosen);
  const full = path.join(SAVE_DIR, file);
  const bytes = await downloadTo(chosen.href, full);
  const lines = [
    `Скачал: ${card.title}${card.authors.length > 0 ? ` — ${card.authors.join(', ')}` : ''}`,
    `Файл: ${full} (${formatBytes(bytes)})`,
    `Формат: ${chosen.format}${chosen.title === '' ? '' : ` (${chosen.title})`} · ${chosen.href}`,
    'Скачивай только то, что человек попросил, и не выкладывай файлы в общий доступ.',
  ];
  if (card.rights !== '') lines.push(`Права: ${card.rights}`);
  return lines.join('\n');
}

// --- инструменты MCP ---------------------------------------------------------

const INSTRUCTIONS = `OPDS-каталог книг по адресу из OPDS_URL. Сервер универсальный: он не привязан к сайту и разбирает Atom/OPDS-фид, который отдаёт каталог.

1. catalog_search(query) — поиск по каталогу, только чтение. Отдаёт книги с авторами и ссылкой link на карточку, а также разделы каталога (авторы, темы), если каталог их подмешивает в выдачу.
2. catalog_browse(link) — навигация: без аргументов показывает корень каталога, с link раздела — его содержимое. Ссылки link бери только из ответов сервера, не выдумывай.
3. book_info(link) — карточка книги: авторы, год, языки, форматы, размер и аннотация. link — из catalog_search или catalog_browse.
4. book_download(link, format, confirm: true) — единственный инструмент, который пишет файл на диск. Качай только по прямой просьбе человека; без confirm сервер откажет. Файл ложится в incoming/ (папка вложений) человеческим именем «Автор - Название.формат» и виден панели и Telegram.

Ошибки не склеивай: «ничего не найдено» — это разобранная пустая выдача; «не Atom/OPDS» — в OPDS_URL вписан не тот адрес (например, HTML-страница каталога); 401 — нужны OPDS_USER/OPDS_PASSWORD или OPDS_TOKEN; таймаут — каталог не отвечает. Так и скажи человеку, а не предлагай искать вручную.`;

const TOOLS = [
  {
    name: 'catalog_search',
    description: 'Поиск книг по OPDS-каталогу. Только чтение: ничего не качает. Отдаёт ссылки link для book_info и book_download.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название книги, имя автора или тема.' },
        limit: { type: 'number', description: `Сколько книг вернуть, 1–${LIMIT_MAX} (по умолчанию ${LIMIT_DEFAULT}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'catalog_browse',
    description: 'Навигация по разделам OPDS-каталога: без link — корень, с link из ответа — выбранный раздел. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'Ссылка на раздел из catalog_browse или catalog_search. Не задана — корень каталога.' },
        limit: { type: 'number', description: `Сколько записей показать, 1–${LIMIT_MAX} (по умолчанию ${LIMIT_DEFAULT}).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'book_info',
    description: 'Карточка книги по link из поиска: авторы, год, языки, форматы со размером и аннотация. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: { link: { type: 'string', description: 'Ссылка на карточку из catalog_search или catalog_browse.' } },
      required: ['link'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_download',
    description: 'Скачать книгу в формате из карточки в папку вложений incoming. Записывает файл на диск — требует confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'Ссылка на карточку из catalog_search или catalog_browse.' },
        format: { type: 'string', description: 'Формат: epub, fb2, pdf, mobi и т. п. — те, что показал book_info.' },
        confirm: { type: 'boolean', description: 'true — человек правда попросил скачать. Без этого сервер откажет.' },
      },
      required: ['link', 'confirm'],
      additionalProperties: false,
    },
  },
];

function clampLimit(raw) {
  const value = Number(raw ?? LIMIT_DEFAULT);
  if (!Number.isFinite(value)) return LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), 1), LIMIT_MAX);
}

const HANDLERS = {
  async catalog_search(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query === '') throw new Error('пустой запрос: нужен query — название книги, автор или тема');
    const { feed } = await searchFeed(query);
    const root = await rootFeed();
    rememberEntries(feed);
    return searchText(feed, query, clampLimit(args.limit), root.title);
  },
  async catalog_browse(args) {
    const link = typeof args.link === 'string' ? args.link.trim() : '';
    const feed = link === '' ? await rootFeed() : await fetchFeed(resolveUrl(endpoint(), link), 'раздел каталога');
    rememberEntries(feed);
    return browseText(feed, clampLimit(args.limit));
  },
  async book_info(args) {
    return cardText(await readCard(args.link));
  },
  book_download: downloadBook,
};

// --- протокол ----------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  process.stderr.write(`[opds] ${message}\n`);
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
    // Не обрываем запрос к чужому каталогу на полуслове: скачивание живёт дольше.
    await idle(Math.max(60_000, DOWNLOAD_TIMEOUT_MS + 5_000));
    process.exit(0);
  });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (OPDS_URL === '') log('OPDS_URL не задан: инструменты ответят ошибкой, пока адрес каталога не вписан');
  serveStdio();
}

export {
  INSTRUCTIONS,
  SAVE_DIR,
  TOOLS,
  annotationOf,
  formatOf,
  parseFeed,
  plainText,
  preferredFormat,
  searchTemplate,
};
