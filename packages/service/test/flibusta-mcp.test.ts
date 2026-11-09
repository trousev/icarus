// MCP «Флибуста»: настоящий stdio-хендшейк и разбор живых фикстур.
//
// Сеть в тестах подменяется фейковым HTTP-зеркалом: фикстуры в tools/flibusta-mcp/
// fixtures сняты с живой Флибусты 09.11.2026, разметка в них дословная. Тест,
// который ходит на настоящий сайт, зависел бы от чужого аптайма и чужих правок.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '../../../tools/flibusta-mcp');
const SERVER = path.join(HERE, 'server.mjs');
const FIXTURES = path.join(HERE, 'fixtures');

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

type Route = { body: string | Buffer; status?: number; type?: string };

/** Фейковое зеркало: отвечает только на известные пути и запоминает, что просили. */
type Mirror = { url: string; hits: string[]; close: () => Promise<void> };

async function startMirror(routes: Record<string, Route>): Promise<Mirror> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>404</body></html>');
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'text/html; charset=utf-8' });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Порт, на котором заведомо никто не слушает: так проверяем мёртвое зеркало. */
async function closedPort(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 1;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

type Rpc = {
  child: ChildProcessWithoutNullStreams;
  call: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
};

async function start(cwd: string, env: Record<string, string> = {}): Promise<Rpc> {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: { ...process.env, ...env, FLIBUSTA_SAVE_DIR: path.join(cwd, 'incoming') },
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
    child,
    call,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill(), 2000).unref();
      }),
  };
}

type ToolAnswer = { text: string; isError: boolean };

function answer(message: Record<string, unknown>): ToolAnswer {
  const result = message.result as { content?: Array<{ text?: string }>; isError?: boolean };
  return {
    text: (result.content ?? []).map((item) => item.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

async function tool(rpc: Rpc, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  return answer(await rpc.call({ method: 'tools/call', params: { name, arguments: args } }));
}

type Case = { routes?: Record<string, Route>; env?: Record<string, string>; run: (rpc: Rpc, root: string, mirror: Mirror | null) => Promise<void> };

/** Каждый тест живёт в своей временной папке: реестр и файлы не перетекают. */
async function withServer(testCase: Case, options: { mirror?: boolean } = {}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flibusta-mcp-'));
  const mirror = options.mirror === false ? null : await startMirror(testCase.routes ?? {});
  const rpc = await start(root, {
    ...(mirror === null ? {} : { FLIBUSTA_MIRROR: mirror.url, FLIBUSTA_MIRRORS: '' }),
    ...testCase.env,
  });
  try {
    await testCase.run(rpc, root, mirror);
  } finally {
    await rpc.stop();
    await mirror?.close();
  }
}

const BOOK_PAGE = fixture('book-766078.html');

function bookRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/opds/search': { body: fixture('opds-search.xml'), type: 'application/atom+xml' },
    '/booksearch': { body: fixture('html-search.html') },
    '/b/766078': { body: BOOK_PAGE },
    '/b/999999999': { body: fixture('book-not-a-book.html') },
    '/b/766078/epub': { body: Buffer.alloc(2048, 7), type: 'application/epub+zip' },
    '/b/766078/fb2': { body: Buffer.alloc(4096, 3), type: 'application/zip' },
    ...extra,
  };
}

test('хендшейк: пять инструментов, инструкции про подтверждение скачивания', async () => {
  await withServer({
    run: async (rpc) => {
      const init = await rpc.call({ method: 'initialize', params: {} });
      const info = init.result as { instructions: string; serverInfo: { name: string } };
      assert.equal(info.serverInfo.name, 'flibusta');
      assert.match(info.instructions, /book_search/);
      assert.match(info.instructions, /confirm: true/);
      assert.match(info.instructions, /library\.json/);

      const list = await rpc.call({ method: 'tools/list', params: {} });
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      assert.deepEqual(tools.map((item) => item.name).sort(), [
        'book_download',
        'book_info',
        'book_search',
        'library_list',
        'mirror_status',
      ]);
    },
  });
});

test('поиск разбирает OPDS: название, автор, форматы и id книги', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc, _root, mirror) => {
      const found = await tool(rpc, 'book_search', { query: 'Мастер и Маргарита', limit: 5 });
      assert.equal(found.isError, false);
      assert.match(found.text, /зеркало http:\/\/127\.0\.0\.1:\d+ · OPDS/);
      assert.match(found.text, /Нашлось: 2/);
      assert.match(found.text, /id 368728/);
      assert.match(found.text, /Карапетян Андрей Петрович/);
      // У первой книги сайт отдаёт только docx — в выдаче это должно быть видно.
      assert.match(found.text, /id 368728 ·[^\n]*docx/);
      assert.match(found.text, /id 890864/);
      assert.match(found.text, /fb2, epub, mobi/);
      assert.ok(mirror !== null);
      assert.ok(mirror.hits.some((hit) => hit.startsWith('/opds/search')), mirror.hits.join(','));
    },
  });
});

test('пустая выдача OPDS — это «ничего не найдено», а не поломка', async () => {
  await withServer({
    routes: { '/opds/search': { body: fixture('opds-empty.xml'), type: 'application/atom+xml' } },
    run: async (rpc) => {
      const found = await tool(rpc, 'book_search', { query: 'zzzqqqxxxnonexistentbook' });
      assert.equal(found.isError, false);
      assert.match(found.text, /Ничего не найдено/);
      assert.doesNotMatch(found.text, /Парсер сломался/);
    },
  });
});

test('OPDS поменял схему — поиск честно говорит про парсер, а не про пустоту', async () => {
  await withServer({
    routes: {
      '/opds/search': { body: fixture('opds-broken.xml'), type: 'application/atom+xml' },
      '/booksearch': { body: '<html><body><h1>Новая вёрстка</h1></body></html>' },
    },
    run: async (rpc) => {
      const found = await tool(rpc, 'book_search', { query: 'Мастер и Маргарита' });
      assert.equal(found.isError, true);
      assert.match(found.text, /Парсер сломался/);
      assert.match(found.text, /OPDS: .*записей без id книги/);
      assert.match(found.text, /HTML: .*поиск Флибусты/);
      assert.doesNotMatch(found.text, /Ничего не найдено/);
    },
  });
});

test('OPDS недоступен (у flibusta.club он 404) — поиск переходит на HTML', async () => {
  await withServer({
    routes: {
      '/opds/search': { body: '<html><body>404 Not Found</body></html>', status: 404 },
      '/booksearch': { body: fixture('html-search.html') },
    },
    run: async (rpc) => {
      const found = await tool(rpc, 'book_search', { query: 'Мастер и Маргарита' });
      assert.equal(found.isError, false);
      assert.match(found.text, /· HTML/);
      assert.match(found.text, /id 368728/);
      assert.match(found.text, /Андрей Петрович Карапетян/);
    },
  });
});

test('HTML-поиск без результатов — «ничего не найдено», без выдумки', async () => {
  await withServer({
    routes: {
      '/opds/search': { body: 'нет', status: 500 },
      '/booksearch': { body: fixture('html-search-empty.html') },
    },
    run: async (rpc) => {
      const found = await tool(rpc, 'book_search', { query: 'zzzqqqxxxnonexistentbook' });
      assert.equal(found.isError, false);
      assert.match(found.text, /Ничего не найдено/);
    },
  });
});

test('первое зеркало молчит — пробуем запасное и говорим, что оно ответило', async () => {
  const spare = await startMirror(bookRoutes());
  const dead = await closedPort();
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flibusta-mcp-'));
    const rpc = await start(root, { FLIBUSTA_MIRROR: dead, FLIBUSTA_MIRRORS: spare.url });
    try {
      const found = await tool(rpc, 'book_search', { query: 'Мастер и Маргарита' });
      assert.equal(found.isError, false);
      assert.match(found.text, new RegExp(`зеркало ${spare.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(found.text, /id 890864/);
    } finally {
      await rpc.stop();
    }
  } finally {
    await spare.close();
  }
});

test('все зеркала молчат — ошибка про зеркала, а не про «ничего не найдено»', async () => {
  const deadOne = await closedPort();
  const deadTwo = await closedPort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flibusta-mcp-'));
  const rpc = await start(root, { FLIBUSTA_MIRROR: deadOne, FLIBUSTA_MIRRORS: deadTwo });
  try {
    const found = await tool(rpc, 'book_search', { query: 'Мастер и Маргарита' });
    assert.equal(found.isError, true);
    assert.match(found.text, /Зеркала не ответили/);
    assert.match(found.text, /FLIBUSTA_MIRROR/);
    assert.doesNotMatch(found.text, /Ничего не найдено/);
  } finally {
    await rpc.stop();
  }
});

test('описание книги: авторы, жанры, размер, форматы и аннотация', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc) => {
      const info = await tool(rpc, 'book_info', { id: '766078' });
      assert.equal(info.isError, false);
      assert.match(info.text, /Мастер и Маргарита/);
      assert.match(info.text, /Михаил Афанасьевич Булгаков/);
      assert.match(info.text, /Жанры: Классическая проза/);
      assert.match(info.text, /5008K, 415 с\./);
      assert.match(info.text, /Форматы: fb2, epub, mobi \(по умолчанию fb2\)/);
      assert.match(info.text, /fb2\.zip/);
      assert.match(info.text, /Сатана правит бал/);
      assert.match(info.text, /book_download с id 766078 и format "fb2", confirm: true/);
    },
  });
});

test('неверный id: сайт подменяет страницу поиском — говорим «это не книга», а не «парсер сломался»', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc) => {
      const info = await tool(rpc, 'book_info', { id: '999999999' });
      assert.equal(info.isError, true);
      assert.match(info.text, /отдало не книгу, а «Книги по названию 999999999»/);
      assert.match(info.text, /книга удалена|Книгу могли удалить/);
      assert.doesNotMatch(info.text, /Парсер сломался/);
    },
  });
});

test('страница книги сменила вёрстку — парсер сломался, и это сказано словами', async () => {
  await withServer({
    routes: { '/b/766078': { body: fixture('book-broken.html') } },
    run: async (rpc) => {
      const info = await tool(rpc, 'book_info', { id: '766078' });
      assert.equal(info.isError, true);
      assert.match(info.text, /Парсер сломался/);
      assert.match(info.text, /нет <h1 class="title">/);
      // Ошибка парсера не должна притворяться пустой выдачей: «ничего не найдено»
      // здесь только в пояснении, чего мы НЕ говорим.
      assert.doesNotMatch(info.text, /^Ничего не найдено/m);
    },
  });
});

test('id не число — сразу отказ, без похода на сайт', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc, _root, mirror) => {
      const info = await tool(rpc, 'book_info', { id: 'мастер' });
      assert.equal(info.isError, true);
      assert.match(info.text, /нужен числовой id книги/);
      assert.deepEqual(mirror?.hits, []);
    },
  });
});

test('скачивание без confirm отказывает и не ходит в сеть', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc, root, mirror) => {
      const denied = await tool(rpc, 'book_download', { id: '766078', format: 'epub' });
      assert.equal(denied.isError, true);
      assert.match(denied.text, /confirm: true/);
      assert.deepEqual(mirror?.hits, []);
      assert.equal(fs.existsSync(path.join(root, 'incoming')), false);
    },
  });
});

test('скачивание с confirm: человеческое имя файла и запись в реестр', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc, root) => {
      const saved = await tool(rpc, 'book_download', { id: '766078', format: 'epub', confirm: true });
      assert.equal(saved.isError, false);
      const file = path.join(root, 'incoming', 'Михаил Афанасьевич Булгаков - Мастер и Маргарита.epub');
      assert.equal(fs.readFileSync(file).length, 2048);
      assert.match(saved.text, /Михаил Афанасьевич Булгаков - Мастер и Маргарита\.epub/);
      assert.match(saved.text, /2\.0 КБ/);
      assert.match(saved.text, /теперь 1 книг/);

      const registry = JSON.parse(fs.readFileSync(path.join(root, 'incoming', 'library.json'), 'utf8')) as {
        version: number;
        books: Array<Record<string, unknown>>;
      };
      assert.equal(registry.version, 1);
      assert.equal(registry.books.length, 1);
      assert.deepEqual(
        {
          id: registry.books[0]?.id,
          title: registry.books[0]?.title,
          author: registry.books[0]?.author,
          format: registry.books[0]?.format,
          bytes: registry.books[0]?.bytes,
        },
        {
          id: '766078',
          title: 'Мастер и Маргарита',
          author: 'Михаил Афанасьевич Булгаков',
          format: 'epub',
          bytes: 2048,
        },
      );

      const listed = await tool(rpc, 'library_list');
      assert.match(listed.text, /Библиотека: 1 книг\(и\)/);
      assert.match(listed.text, /Мастер и Маргарита — Михаил Афанасьевич Булгаков · epub/);
    },
  });
});

test('повторное скачивание заменяет файл, а не плодит копии', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc, root) => {
      await tool(rpc, 'book_download', { id: '766078', format: 'epub', confirm: true });
      const again = await tool(rpc, 'book_download', { id: '766078', format: 'epub', confirm: true });
      assert.equal(again.isError, false);
      assert.match(again.text, /перезаписал прежний/);
      const files = fs.readdirSync(path.join(root, 'incoming')).sort();
      assert.deepEqual(files, ['library.json', 'Михаил Афанасьевич Булгаков - Мастер и Маргарита.epub']);
      const registry = JSON.parse(fs.readFileSync(path.join(root, 'incoming', 'library.json'), 'utf8')) as {
        books: unknown[];
      };
      assert.equal(registry.books.length, 1);
    },
  });
});

test('файл больше лимита: отказ и никакого обрезанного файла', async () => {
  await withServer({
    routes: bookRoutes({
      '/b/766078/epub': { body: Buffer.alloc(50_000, 9), type: 'application/epub+zip' },
    }),
    env: { FLIBUSTA_MAX_BYTES: '10000' },
    run: async (rpc, root) => {
      const saved = await tool(rpc, 'book_download', { id: '766078', format: 'epub', confirm: true });
      assert.equal(saved.isError, true);
      assert.match(saved.text, /больше лимита/);
      assert.match(saved.text, /FLIBUSTA_MAX_BYTES/);
      const incoming = path.join(root, 'incoming');
      assert.deepEqual(fs.readdirSync(incoming), []);
    },
  });
});

test('формата, которого нет на странице, не качаем', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc) => {
      const saved = await tool(rpc, 'book_download', { id: '766078', format: 'pdf', confirm: true });
      assert.equal(saved.isError, true);
      assert.match(saved.text, /формата «pdf» у книги 766078 нет/);
      assert.match(saved.text, /fb2, epub, mobi/);
    },
  });
});

test('битый реестр не мешает скачивать: старый откладывается в сторону', async () => {
  await withServer({
    routes: bookRoutes(),
    run: async (rpc, root) => {
      const incoming = path.join(root, 'incoming');
      fs.mkdirSync(incoming, { recursive: true });
      fs.writeFileSync(path.join(incoming, 'library.json'), '{ это не json');
      const saved = await tool(rpc, 'book_download', { id: '766078', format: 'fb2', confirm: true });
      assert.equal(saved.isError, false);
      assert.match(saved.text, /Старый реестр был битым/);
      const files = fs.readdirSync(incoming).sort();
      assert.equal(files.filter((name) => name.includes('.broken-')).length, 1);
      assert.ok(files.includes('library.json'));
      const registry = JSON.parse(fs.readFileSync(path.join(incoming, 'library.json'), 'utf8')) as {
        books: Array<{ format: string; file: string }>;
      };
      assert.equal(registry.books[0]?.format, 'fb2');
      assert.match(registry.books[0]?.file ?? '', /\.fb2\.zip$/);
    },
  });
});

test('library_list на пустой папке честно говорит, что скачанного нет', async () => {
  await withServer({
    run: async (rpc, root) => {
      const listed = await tool(rpc, 'library_list');
      assert.equal(listed.isError, false);
      assert.match(listed.text, /Библиотека пуста/);
      assert.match(listed.text, new RegExp(`${path.join(root, 'incoming').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    },
  });
});

test('mirror_status показывает живое и мёртвое зеркало', async () => {
  const alive = await startMirror({ '/': { body: '<html><body>Флибуста</body></html>' } });
  const dead = await closedPort();
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flibusta-mcp-'));
    const rpc = await start(root, { FLIBUSTA_MIRROR: alive.url, FLIBUSTA_MIRRORS: dead });
    try {
      const status = await tool(rpc, 'mirror_status');
      assert.equal(status.isError, false);
      assert.match(status.text, new RegExp(`✓ ${alive.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(status.text, new RegExp(`✗ ${dead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(status.text, /Текущее:/);
    } finally {
      await rpc.stop();
    }
  } finally {
    await alive.close();
  }
});
