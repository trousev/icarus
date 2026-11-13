// OPDS MCP: a universal proxy between MCP and an OPDS catalog.
//
// The server is launched as a separate process, the way pi launches it, and talks to a
// local fake catalog: the test must not depend on someone else's site. The fixtures are
// real Project Gutenberg responses (public domain), saved in
// tools/opds-mcp/fixtures; only the address in them is replaced so requests go
// to local HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const HERE = import.meta.dirname;
const SERVER = path.resolve(HERE, '../../../tools/opds-mcp/server.mjs');
const FIXTURES = path.resolve(HERE, '../../../tools/opds-mcp/fixtures');

type Rpc = {
  call: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
};

type Catalog = {
  base: string;
  requests: string[];
  close: () => Promise<void>;
};

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** The fixture was captured from a live site; we map addresses to local ones, the rest untouched. */
function localize(text: string, base: string): string {
  return text.replace(/https?:\/\/(?:www|m)\.gutenberg\.org/gi, base);
}

/** Feeds that serve books directly with file links (that's what Calibre does). */
function directFeed(base: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dcterms="http://purl.org/dc/terms/">
<title>Домашняя библиотека</title>
<entry>
  <title>Прямая книга</title>
  <id>urn:direct:1</id>
  <updated>2026-01-01T00:00:00Z</updated>
  <author><name>Тестовый Автор</name></author>
  <published>2020-01-02T00:00:00Z</published>
  <dcterms:language>ru</dcterms:language>
  <content type="text">Аннотация прямой книги.</content>
  <link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" length="2048" href="${base}/files/direct.epub"/>
</entry>
</feed>`;
}

/** Fake OPDS catalog: root, OpenSearch description, search, card and file. */
async function fakeCatalog(options: { search?: (base: string) => string } = {}): Promise<Catalog> {
  const requests: string[] = [];
  let slowTimer: NodeJS.Timeout | undefined;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url.pathname + url.search);
    const send = (type: string, body: string | Buffer) => {
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    };
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (url.pathname === '/root.opds') return send('application/atom+xml', localize(fixture('root.opds'), base));
    else if (url.pathname === '/catalog/osd-books.xml') send('application/xml', localize(fixture('osd-books.xml'), base));
    else if (url.pathname.startsWith('/ebooks/search.opds')) {
      send('application/atom+xml', options.search === undefined ? localize(fixture('search-dickens.opds'), base) : options.search(base));
    } else if (url.pathname === '/ebooks/98.opds') send('application/atom+xml', localize(fixture('book-98.opds'), base));
    else if (url.pathname.startsWith('/ebooks/98.epub')) send('application/epub+zip', Buffer.alloc(4096, 7));
    else if (url.pathname === '/files/direct.epub') send('application/epub+zip', Buffer.alloc(2048, 9));
    else if (url.pathname === '/html') send('text/html; charset=utf-8', fixture('not-opds.html'));
    else if (url.pathname === '/protected') {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('нужен пароль');
    } else if (url.pathname === '/slow') {
      slowTimer = setTimeout(() => send('application/atom+xml', localize(fixture('root.opds'), base)), 5000);
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('нет такой страницы');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        if (slowTimer !== undefined) clearTimeout(slowTimer);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function start(env: Record<string, string>): Promise<Rpc> {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OPDS_TIMEOUT_SECONDS: '5', OPDS_MAX_DOWNLOAD_MB: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let id = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  const call = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...message })}\n`);
    });
  return {
    call,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill(), 2000).unref();
      }),
  };
}

function text(message: Record<string, unknown>): string {
  const result = message.result as { content?: Array<{ text?: string }> } | undefined;
  return (result?.content ?? []).map((item) => item.text ?? '').join('\n');
}

function isError(message: Record<string, unknown>): boolean {
  return (message.result as { isError?: boolean } | undefined)?.isError === true;
}

async function withServer(
  env: Record<string, string>,
  run: (rpc: Rpc) => Promise<void>,
): Promise<void> {
  const rpc = await start(env);
  try {
    await run(rpc);
  } finally {
    await rpc.stop();
  }
}

function saveDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opds-mcp-'));
}

test('initialize returns instructions and four tools', async () => {
  await withServer({ OPDS_URL: 'http://127.0.0.1:1/opds/' }, async (rpc) => {
    const init = await rpc.call({ method: 'initialize', params: {} });
    const result = init.result as { serverInfo: { name: string }; instructions: string };
    assert.equal(result.serverInfo.name, 'opds');
    assert.match(result.instructions, /OPDS_URL/);
    assert.match(result.instructions, /confirm: true/);
    assert.match(result.instructions, /incoming/);

    const list = await rpc.call({ method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['book_download', 'book_info', 'catalog_browse', 'catalog_search']);
  });
});

test('search: the OpenSearch template comes from the root, books and sections are distinguished', async () => {
  const catalog = await fakeCatalog();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/root.opds` }, async (rpc) => {
      const answer = await rpc.call({
        method: 'tools/call',
        params: { name: 'catalog_search', arguments: { query: 'dickens', limit: 3 } },
      });
      const body = text(answer);
      assert.equal(isError(answer), false, body);
      assert.match(body, /Project Gutenberg/);
      assert.match(body, /книг 25, показаны первые 3/);
      assert.match(body, /A Tale of Two Cities — Charles Dickens/);
      assert.match(body, new RegExp(`${catalog.base}/ebooks/98\\.opds`));
      assert.match(body, /Разделы:/);
      assert.match(body, /Authors/);
      // Search order: root → OpenSearch description → the found template.
      assert.ok(catalog.requests.includes('/root.opds'));
      assert.ok(catalog.requests.includes('/catalog/osd-books.xml'), 'OSD прочитан из корня');
      assert.ok(catalog.requests.some((request) => request.startsWith('/ebooks/search.opds')), 'поиск по шаблону из OSD');
    });
  } finally {
    await catalog.close();
  }
});

test('navigation: the catalog root shows sections, not an empty result', async () => {
  const catalog = await fakeCatalog();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/root.opds` }, async (rpc) => {
      const answer = await rpc.call({
        method: 'tools/call',
        params: { name: 'catalog_browse', arguments: { limit: 4 } },
      });
      const body = text(answer);
      assert.equal(isError(answer), false, body);
      assert.match(body, /Каталог: Project Gutenberg/);
      assert.match(body, /Разделы:/);
      assert.match(body, /Popular/);
      assert.match(body, /Latest/);
      assert.doesNotMatch(body, /Книги:/, 'в корне Gutenberg только разделы');

      // A shelf is the same search feed: its entries are books, not sections.
      const shelf = await rpc.call({
        method: 'tools/call',
        params: { name: 'catalog_browse', arguments: { link: `${catalog.base}/ebooks/search.opds/?query=dickens`, limit: 2 } },
      });
      const shelfBody = text(shelf);
      assert.equal(isError(shelf), false, shelfBody);
      assert.match(shelfBody, /Книги:/);
      assert.match(shelfBody, /A Tale of Two Cities/);
    });
  } finally {
    await catalog.close();
  }
});

test('book card: author, year, languages, formats with size and annotation', async () => {
  const catalog = await fakeCatalog();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/root.opds` }, async (rpc) => {
      const answer = await rpc.call({
        method: 'tools/call',
        params: { name: 'book_info', arguments: { link: `${catalog.base}/ebooks/98.opds` } },
      });
      const body = text(answer);
      assert.equal(isError(answer), false, body);
      assert.match(body, /^A Tale of Two Cities/);
      assert.match(body, /Dickens, Charles/);
      assert.match(body, /год 1994/);
      assert.match(body, /языки: en/);
      assert.match(body, /epub \(476\.3 КБ\)/);
      assert.match(body, /mobi \(611\.8 КБ\)/);
      assert.match(body, /Public domain in the USA/);
      assert.match(body, /historical novel published in 1859/);
      // Service content fields must not land in the annotation in full.
      assert.doesNotMatch(body, /Reading Level:/);
      assert.match(body, /book_download/);
    });
  } finally {
    await catalog.close();
  }
});

test('"this is not OPDS" is an honest error, not an empty result', async () => {
  const catalog = await fakeCatalog();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/html` }, async (rpc) => {
      const answer = await rpc.call({ method: 'tools/call', params: { name: 'catalog_search', arguments: { query: 'dickens' } } });
      const body = text(answer);
      assert.equal(isError(answer), true);
      assert.match(body, /не Atom\/OPDS/);
      assert.match(body, /text\/html/);
      assert.match(body, /не HTML-страницы/);
    });
  } finally {
    await catalog.close();
  }
});

test('OPDS_URL not set and 401 are different errors with a hint what to fix', async () => {
  await withServer({ OPDS_URL: '' }, async (rpc) => {
    const answer = await rpc.call({ method: 'tools/call', params: { name: 'catalog_search', arguments: { query: 'dickens' } } });
    assert.equal(isError(answer), true);
    assert.match(text(answer), /OPDS_URL не задан/);
  });

  const catalog = await fakeCatalog();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/protected` }, async (rpc) => {
      const answer = await rpc.call({ method: 'tools/call', params: { name: 'catalog_search', arguments: { query: 'dickens' } } });
      assert.equal(isError(answer), true);
      assert.match(text(answer), /HTTP 401/);
      assert.match(text(answer), /OPDS_USER и OPDS_PASSWORD/);
      assert.match(text(answer), /OPDS_TOKEN/);
    });
  } finally {
    await catalog.close();
  }
});

test('catalog timeout is an error naming the setting, not a hang', async () => {
  const catalog = await fakeCatalog();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/slow`, OPDS_TIMEOUT_SECONDS: '0.2' }, async (rpc) => {
      const answer = await rpc.call({ method: 'tools/call', params: { name: 'catalog_browse', arguments: {} } });
      assert.equal(isError(answer), true);
      assert.match(text(answer), /не ответил/);
      assert.match(text(answer), /OPDS_TIMEOUT_SECONDS/);
    });
  } finally {
    await catalog.close();
  }
});

test('download without confirm refuses without touching the catalog', async () => {
  const catalog = await fakeCatalog();
  const dir = saveDir();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/root.opds`, OPDS_SAVE_DIR: dir }, async (rpc) => {
      const answer = await rpc.call({
        method: 'tools/call',
        params: { name: 'book_download', arguments: { link: `${catalog.base}/ebooks/98.opds`, format: 'epub' } },
      });
      assert.equal(isError(answer), true);
      assert.match(text(answer), /confirm: true/);
      assert.deepEqual(fs.readdirSync(dir), [], 'файл не создан');
      assert.ok(!catalog.requests.some((request) => request.startsWith('/ebooks/98.opds')), 'карточку даже не читали');
    });
  } finally {
    await catalog.close();
  }
});

test('the size limit stops the download', async () => {
  const catalog = await fakeCatalog();
  const dir = saveDir();
  try {
    await withServer(
      { OPDS_URL: `${catalog.base}/root.opds`, OPDS_SAVE_DIR: dir, OPDS_MAX_DOWNLOAD_MB: '0.001' },
      async (rpc) => {
        const answer = await rpc.call({
          method: 'tools/call',
          params: { name: 'book_download', arguments: { link: `${catalog.base}/ebooks/98.opds`, format: 'epub', confirm: true } },
        });
        assert.equal(isError(answer), true);
        assert.match(text(answer), /больше лимита/);
        assert.match(text(answer), /OPDS_MAX_DOWNLOAD_MB/);
        assert.deepEqual(fs.readdirSync(dir), [], 'частичный файл не остался');
      },
    );
  } finally {
    await catalog.close();
  }
});

test('download with confirm puts the file into incoming under a human-readable name', async () => {
  const catalog = await fakeCatalog();
  const dir = saveDir();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/root.opds`, OPDS_SAVE_DIR: dir }, async (rpc) => {
      const answer = await rpc.call({
        method: 'tools/call',
        params: { name: 'book_download', arguments: { link: `${catalog.base}/ebooks/98.opds`, format: 'epub', confirm: true } },
      });
      const body = text(answer);
      assert.equal(isError(answer), false, body);
      const saved = path.join(dir, 'Dickens, Charles - A Tale of Two Cities.epub');
      assert.match(body, /Скачал: A Tale of Two Cities/);
      assert.ok(fs.existsSync(saved), `ожидал файл ${saved}`);
      assert.equal(fs.statSync(saved).size, 4096);
      assert.match(body, /incoming|Dickens, Charles - A Tale of Two Cities\.epub/);
      assert.ok(fs.readdirSync(dir).every((name) => !name.endsWith('.part')), '.part убран');
    });
  } finally {
    await catalog.close();
  }
});

test('a catalog serves books directly with file links: the card is taken from the result', async () => {
  const catalog = await fakeCatalog({ search: (base) => directFeed(base) });
  const dir = saveDir();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/root.opds`, OPDS_SAVE_DIR: dir }, async (rpc) => {
      const search = await rpc.call({
        method: 'tools/call',
        params: { name: 'catalog_search', arguments: { query: 'прямая' } },
      });
      const found = text(search);
      assert.equal(isError(search), false, found);
      assert.match(found, /Прямая книга — Тестовый Автор/);
      assert.match(found, /epub \(2\.0 КБ\)/, 'формат видно уже в выдаче');
      const link = `${catalog.base}/files/direct.epub`;
      assert.ok(found.includes(link), `ссылка на файл в выдаче: ${found}`);

      const info = await rpc.call({ method: 'tools/call', params: { name: 'book_info', arguments: { link } } });
      const card = text(info);
      assert.equal(isError(info), false, card);
      assert.match(card, /^Прямая книга/);
      assert.match(card, /Тестовый Автор/);
      assert.match(card, /год 2020/);
      assert.match(card, /языки: ru/);
      assert.match(card, /epub \(2\.0 КБ\)/);
      assert.match(card, /Аннотация прямой книги/);

      const download = await rpc.call({
        method: 'tools/call',
        params: { name: 'book_download', arguments: { link, format: 'epub', confirm: true } },
      });
      assert.equal(isError(download), false, text(download));
      const saved = path.join(dir, 'Тестовый Автор - Прямая книга.epub');
      assert.ok(fs.existsSync(saved), `ожидал файл ${saved}`);
      assert.equal(fs.statSync(saved).size, 2048);

      const stale = await rpc.call({
        method: 'tools/call',
        params: { name: 'book_info', arguments: { link: `${catalog.base}/files/other.epub` } },
      });
      assert.equal(isError(stale), true);
      assert.match(text(stale), /ведёт на файл, а не на карточку/);
    });
  } finally {
    await catalog.close();
  }
});


test('format not found — says which ones exist and downloads nothing', async () => {
  const catalog = await fakeCatalog();
  const dir = saveDir();
  try {
    await withServer({ OPDS_URL: `${catalog.base}/root.opds`, OPDS_SAVE_DIR: dir }, async (rpc) => {
      const answer = await rpc.call({
        method: 'tools/call',
        params: { name: 'book_download', arguments: { link: `${catalog.base}/ebooks/98.opds`, format: 'djvu', confirm: true } },
      });
      assert.equal(isError(answer), true);
      assert.match(text(answer), /формата «djvu»/);
      assert.match(text(answer), /epub, mobi/);
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  } finally {
    await catalog.close();
  }
});
