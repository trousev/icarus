// Самотест MCP кинозала: Radarr/Sonarr, только чтение и отдельный заказ.
//
//   node tools/arr-mcp/test.mjs
//
// Живого Radarr/Sonarr нет и в тестах быть не должно: поднимаем фейковый HTTP
// на node:http и проверяем, что сервер говорит с ним теми же запросами, что
// описаны в OpenAPI (X-Api-Key, /api/v3/...), и что lookup ничего не заказывает.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const TB = 1024 ** 4;

const RADARR = {
  status: { appName: 'Radarr', version: '5.2.6.8376' },
  profiles: [{ id: 4, name: 'HD-1080p', upgradeAllowed: true, cutoff: 7, items: [{ id: 7, name: 'Bluray-1080p' }] }],
  folders: [{ id: 1, path: '/movies', accessible: true, freeSpace: 120 * GB }],
  collection: [
    {
      id: 1,
      title: 'Дюна',
      tmdbId: 438631,
      year: 2021,
      hasFile: true,
      monitored: true,
      sizeOnDisk: 12 * GB,
      runtime: 155,
      ratings: { tmdb: { value: 7.8 } },
    },
  ],
  catalog: [
    {
      title: 'Дюна',
      tmdbId: 438631,
      year: 2021,
      overview: 'Пол Артреи уезжает на Арракис и оказывается между враждующими домами.',
      runtime: 155,
      ratings: { tmdb: { value: 7.8 } },
      titleSlug: 'dune-438631',
      imdbId: 'tt1160419',
    },
    {
      title: 'Прибытие',
      tmdbId: 329865,
      year: 2016,
      overview: 'Лингвист пытается понять язык пришельцев.',
      runtime: 116,
      ratings: { tmdb: { value: 7.6 } },
      titleSlug: 'arrival-329865',
      imdbId: 'tt2543164',
    },
  ],
  queue: {
    page: 1,
    pageSize: 50,
    totalRecords: 1,
    records: [
      {
        movieId: 2,
        movie: { title: 'Прибытие', year: 2016 },
        title: 'Arrival.2016.1080p.BluRay',
        status: 'downloading',
        size: 2 * GB,
        sizeleft: 512 * MB,
        timeleft: '00:10:00',
      },
    ],
  },
  disks: [{ id: 1, path: '/movies', label: 'movies', freeSpace: 1 * TB, totalSpace: 4 * TB }],
  newItemId: 7,
};

const SONARR = {
  status: { appName: 'Sonarr', version: '4.0.0.1234' },
  profiles: [{ id: 3, name: 'HD-1080p', upgradeAllowed: true, cutoff: 7, items: [{ id: 7, name: 'Bluray-1080p' }] }],
  folders: [{ id: 1, path: '/tv', accessible: true, freeSpace: 500 * GB }],
  collection: [
    {
      id: 1,
      title: 'Светлячок',
      tvdbId: 78874,
      year: 2002,
      monitored: true,
      network: 'FOX',
      statistics: { seasonCount: 1, episodeFileCount: 14, episodeCount: 14, sizeOnDisk: 8 * GB },
    },
  ],
  catalog: [
    { title: 'Светлячок', tvdbId: 78874, year: 2002, overview: 'Экипаж Серенити.', network: 'FOX' },
    { title: 'Пространство', tvdbId: 280619, year: 2015, overview: 'Планеты, политика и протомолекула.', network: 'Syfy' },
  ],
  queue: { page: 1, pageSize: 50, totalRecords: 0, records: [] },
  disks: [{ id: 1, path: '/tv', label: 'tv', freeSpace: 500 * GB, totalSpace: 2 * TB }],
  newItemId: 3,
};

/**
 * Фейковый *arr на node:http: проверяет X-Api-Key, отдаёт ровно те маршруты,
 * которые дергает сервер, и записывает все POST — по ним видно, заказали файл или нет.
 */
async function fakeArr(kind, options = {}) {
  const isMovie = kind === 'movie';
  const data = structuredClone(isMovie ? RADARR : SONARR);
  if (options.profiles !== undefined) data.profiles = options.profiles;
  if (options.folders !== undefined) data.folders = options.folders;
  if (options.collection !== undefined) data.collection = options.collection;
  const key = options.key ?? (isMovie ? 'radarr-secret' : 'sonarr-secret');
  const state = { posts: [], requests: [], key };
  const prefix = '/api/v3';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    if (options.hang) return; // ответа не будет — проверяем таймаут

    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== key) return json(401, { message: 'Unauthorized' });

    const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    if (route === '/system/status' && req.method === 'GET') return json(200, data.status);

    if (isMovie) {
      if (route === '/movie/lookup/tmdb' && req.method === 'GET') {
        const movie = data.catalog.find((item) => String(item.tmdbId) === url.searchParams.get('tmdbId'));
        return movie ? json(200, movie) : json(404, { message: 'Movie not found' });
      }
      if (route === '/movie/lookup' && req.method === 'GET') {
        const term = (url.searchParams.get('term') ?? '').toLowerCase();
        return json(200, data.catalog.filter((item) => item.title.toLowerCase().includes(term)));
      }
      if (route === '/movie' && req.method === 'GET') return json(200, data.collection);
      if (route === '/movie' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          state.posts.push({ path: route, body: parsed });
          if (data.collection.some((item) => item.tmdbId === parsed.tmdbId)) {
            return json(400, [{ propertyName: 'TmdbId', errorMessage: 'This movie has already been added' }]);
          }
          json(201, { ...parsed, id: data.newItemId, path: `${parsed.rootFolderPath}/Прибытие (2016)` });
        });
        return;
      }
    } else {
      if (route === '/series/lookup' && req.method === 'GET') {
        const term = (url.searchParams.get('term') ?? '').toLowerCase();
        if (term.startsWith('tvdb:')) {
          return json(200, data.catalog.filter((item) => Number(item.tvdbId) === Number(term.slice(5))));
        }
        return json(200, data.catalog.filter((item) => item.title.toLowerCase().includes(term)));
      }
      if (route === '/series' && req.method === 'GET') return json(200, data.collection);
      if (route === '/series' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          state.posts.push({ path: route, body: parsed });
          json(200, { ...parsed, id: data.newItemId, path: `${parsed.rootFolderPath}/Пространство` });
        });
        return;
      }
    }

    if (route === '/qualityprofile' && req.method === 'GET') return json(200, data.profiles);
    if (route === '/rootfolder' && req.method === 'GET') return json(200, data.folders);
    if (route === '/queue' && req.method === 'GET') {
      return json(200, { ...data.queue, page: Number(url.searchParams.get('page') ?? 1) });
    }
    if (route === '/diskspace' && req.method === 'GET') return json(200, data.disks);

    return json(404, { message: `нет маршрута: ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cleanEnv() {
  const env = { ...process.env };
  for (const name of [
    'ARR_RADARR_URL',
    'ARR_RADARR_KEY',
    'ARR_SONARR_URL',
    'ARR_SONARR_KEY',
    'ARR_TIMEOUT_MS',
  ]) {
    delete env[name];
  }
  return env;
}

async function start(extraEnv) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...cleanEnv(), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let id = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  child.stderr.on('data', () => {
    // сервер пишет туда только диагностику; тесты на неё не опираются
  });
  const call = (message) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...message })}\n`);
    });
  const tool = async (name, args = {}) => {
    const message = await call({ method: 'tools/call', params: { name, arguments: args } });
    return {
      text: (message.result?.content ?? []).map((item) => item.text ?? '').join('\n'),
      isError: message.result?.isError === true,
    };
  };
  const stop = () =>
    new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.end();
      setTimeout(() => child.kill(), 1000).unref();
    });
  return { call, tool, stop };
}

async function withArrs(run, options = {}) {
  const radarr = await fakeArr('movie', options.radarr);
  const sonarr = await fakeArr('series', options.sonarr);
  const rpc = await start({
    ARR_RADARR_URL: radarr.url,
    ARR_RADARR_KEY: options.radarrKey ?? 'radarr-secret',
    ARR_SONARR_URL: sonarr.url,
    ARR_SONARR_KEY: 'sonarr-secret',
    ...(options.env ?? {}),
  });
  try {
    await run({ rpc, radarr, sonarr });
  } finally {
    await rpc.stop();
    await radarr.close();
    await sonarr.close();
  }
}

test('initialize: восемь инструментов и предупреждение о заказе', async () => {
  await withArrs(async ({ rpc }) => {
    const init = await rpc.call({ method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'arr');
    assert.match(init.result.instructions, /arr_add/);
    assert.match(init.result.instructions, /confirm: true/);
    assert.match(init.result.instructions, /только читают/);
    assert.match(init.result.instructions, /ARR_RADARR_KEY/);

    const list = await rpc.call({ method: 'tools/list', params: {} });
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name).sort(),
      [
        'arr_add',
        'arr_collection',
        'arr_disk',
        'arr_lookup',
        'arr_quality_profiles',
        'arr_queue',
        'arr_root_folders',
        'arr_status',
      ],
    );
    const add = list.result.tools.find((tool) => tool.name === 'arr_add');
    assert.match(add.description, /ЗАКАЗ ФАЙЛА/);
    assert.deepEqual(add.inputSchema.required.sort(), ['confirm', 'id']);
  });
});

test('lookup показывает каталог, отмечает коллекцию и ничего не заказывает', async () => {
  await withArrs(async ({ rpc, radarr }) => {
    const result = await rpc.tool('arr_lookup', { kind: 'movie', term: 'Дюна' });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Radarr: найдено 1/);
    assert.match(result.text, /Дюна \(2021\)/);
    assert.match(result.text, /TMDB 438631/);
    assert.match(result.text, /УЖЕ В КОЛЛЕКЦИИ \(файл есть\)/);
    assert.match(result.text, /НЕ заказан/);
    assert.equal(radarr.state.posts.length, 0, 'lookup не должен ничего POST-ить');
    assert.ok(
      radarr.state.requests.some((item) => item.path === '/api/v3/movie/lookup'),
      'lookup должен ходить в /api/v3/movie/lookup',
    );
  });
});

test('add без confirm отказывает и не ходит в POST', async () => {
  await withArrs(async ({ rpc, radarr }) => {
    const result = await rpc.tool('arr_add', { kind: 'movie', id: 329865 });
    assert.equal(result.isError, true);
    assert.match(result.text, /заказ файла/);
    assert.match(result.text, /confirm: true/);
    assert.equal(radarr.state.posts.length, 0);
  });
});

test('add с confirm берёт профиль и папку с сервера и заказывает фильм', async () => {
  await withArrs(async ({ rpc, radarr }) => {
    const result = await rpc.tool('arr_add', { kind: 'movie', id: 329865, confirm: true });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /ЗАКАЗАНО \(Radarr\): Прибытие \(2016\)/);
    assert.match(result.text, /профиль качества: HD-1080p \(id 4\)/);
    assert.match(result.text, /корневая папка: \/movies/);
    assert.match(result.text, /поиск файла запущен/);

    assert.equal(radarr.state.posts.length, 1);
    const posted = radarr.state.posts[0];
    assert.equal(posted.path, '/movie');
    assert.equal(posted.body.tmdbId, 329865);
    assert.equal(posted.body.title, 'Прибытие');
    assert.equal(posted.body.qualityProfileId, 4, 'профиль должен приехать с сервера, а не быть выдуман');
    assert.equal(posted.body.rootFolderPath, '/movies', 'папка должна приехать с сервера');
    assert.equal(posted.body.addOptions.searchForMovie, true);
  });
});

test('add с явными профилем/папкой и search: false только наблюдает', async () => {
  await withArrs(async ({ rpc, radarr }) => {
    const result = await rpc.tool('arr_add', {
      kind: 'movie',
      id: 329865,
      confirm: true,
      qualityProfileId: 6,
      rootFolderPath: '/movies',
      search: false,
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Ultra-HD \(id 6\)/);
    assert.match(result.text, /поиск НЕ запускался/);
    assert.equal(radarr.state.posts[0].body.qualityProfileId, 6);
    assert.equal(radarr.state.posts[0].body.addOptions.searchForMovie, false);
  }, {
    radarr: {
      profiles: [
        { id: 4, name: 'HD-1080p', upgradeAllowed: true, cutoff: 7, items: [{ id: 7, name: 'Bluray-1080p' }] },
        { id: 6, name: 'Ultra-HD', upgradeAllowed: false, cutoff: 19, items: [{ id: 19, name: 'Bluray-2160p' }] },
      ],
    },
  });
});

test('если профилей несколько, add просит выбрать, а не угадывает', async () => {
  await withArrs(
    async ({ rpc, radarr }) => {
      const result = await rpc.tool('arr_add', { kind: 'movie', id: 329865, confirm: true });
      assert.equal(result.isError, true);
      assert.match(result.text, /несколько профилей качества/);
      assert.match(result.text, /4 — HD-1080p/);
      assert.match(result.text, /6 — Ultra-HD/);
      assert.equal(radarr.state.posts.length, 0);
    },
    {
      radarr: {
        profiles: [
          { id: 4, name: 'HD-1080p', upgradeAllowed: true, cutoff: 7, items: [{ id: 7, name: 'Bluray-1080p' }] },
          { id: 6, name: 'Ultra-HD', upgradeAllowed: false, cutoff: 19, items: [{ id: 19, name: 'Bluray-2160p' }] },
        ],
      },
    },
  );
});

test('профили качества и корневые папки читаются с сервера', async () => {
  await withArrs(async ({ rpc }) => {
    const profiles = await rpc.tool('arr_quality_profiles', { kind: 'movie' });
    assert.equal(profiles.isError, false, profiles.text);
    assert.match(profiles.text, /HD-1080p \(id 4\)/);
    assert.match(profiles.text, /cutoff: Bluray-1080p/);

    const folders = await rpc.tool('arr_root_folders', { kind: 'movie' });
    assert.equal(folders.isError, false, folders.text);
    assert.match(folders.text, /1\. \/movies · доступна/);
    assert.match(folders.text, /rootFolderPath/);
  });
});

test('сериал: lookup и add в Sonarr по TVDB id', async () => {
  await withArrs(async ({ rpc, sonarr }) => {
    const found = await rpc.tool('arr_lookup', { kind: 'series', term: 'Светлячок' });
    assert.equal(found.isError, false, found.text);
    assert.match(found.text, /Светлячок \(2002\)/);
    assert.match(found.text, /TVDB 78874/);
    assert.match(found.text, /УЖЕ В КОЛЛЕКЦИИ \(все 14 серий скачаны\)/);

    const result = await rpc.tool('arr_add', { kind: 'series', id: 280619, confirm: true });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /ЗАКАЗАНО \(Sonarr\): Пространство \(2015\)/);
    assert.match(result.text, /корневая папка: \/tv/);
    assert.equal(sonarr.state.posts.length, 1);
    assert.equal(sonarr.state.posts[0].path, '/series');
    assert.equal(sonarr.state.posts[0].body.tvdbId, 280619);
    assert.equal(sonarr.state.posts[0].body.qualityProfileId, 3);
    assert.equal(sonarr.state.posts[0].body.rootFolderPath, '/tv');
    assert.equal(sonarr.state.posts[0].body.addOptions.searchForMissingEpisodes, true);
  });
});

test('очередь загрузок и диски — человеческим текстом', async () => {
  await withArrs(async ({ rpc }) => {
    const queue = await rpc.tool('arr_queue', { kind: 'movie' });
    assert.equal(queue.isError, false, queue.text);
    assert.match(queue.text, /в очереди 1/);
    assert.match(queue.text, /Прибытие \(2016\) — downloading · 75%/);
    assert.match(queue.text, /осталось 512,0 МБ из 2,0 ГБ/);
    assert.match(queue.text, /~00:10:00/);

    const disk = await rpc.tool('arr_disk', { kind: 'movie' });
    assert.equal(disk.isError, false, disk.text);
    assert.match(disk.text, /movies \(\/movies\)/);
    assert.match(disk.text, /свободно 1,0 ТБ из 4,0 ТБ \(занято 75%\)/);
  });
});

test('401 — честно про ключ, без утечки самого ключа', async () => {
  await withArrs(
    async ({ rpc, radarr }) => {
      const status = await rpc.tool('arr_status');
      assert.match(status.text, /Radarr отклонил ключ \(401\)/);
      assert.match(status.text, /ARR_RADARR_KEY/);

      const result = await rpc.tool('arr_lookup', { term: 'Дюна' });
      assert.equal(result.isError, true);
      assert.match(result.text, /401/);
      assert.match(result.text, /ARR_RADARR_KEY/);
      assert.doesNotMatch(result.text, /wrong-key/, 'ключ не должен попадать в текст ошибки');
      assert.equal(radarr.state.posts.length, 0);
    },
    { radarrKey: 'wrong-key' },
  );
});

test('нет ключа — понятная ошибка и ни одного запроса', async () => {
  const radarr = await fakeArr('movie');
  const rpc = await start({ ARR_RADARR_URL: radarr.url });
  try {
    const result = await rpc.tool('arr_lookup', { term: 'Дюна' });
    assert.equal(result.isError, true);
    assert.match(result.text, /без ключа/);
    assert.match(result.text, /ARR_RADARR_KEY/);
    assert.equal(radarr.state.requests.length, 0);
  } finally {
    await rpc.stop();
    await radarr.close();
  }
});

test('сервер не настроен — это не падение, а объяснение', async () => {
  const rpc = await start({});
  try {
    const result = await rpc.tool('arr_lookup', { term: 'Дюна' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Radarr не настроен/);
    assert.match(result.text, /ARR_RADARR_URL/);
    assert.match(result.text, /ARR_RADARR_KEY/);

    const status = await rpc.tool('arr_status');
    assert.equal(status.isError, false);
    assert.match(status.text, /Radarr не настроен/);
    assert.match(status.text, /Sonarr не настроен/);
  } finally {
    await rpc.stop();
  }
});

test('таймаут — понятный текст, а не вечное ожидание', async () => {
  const radarr = await fakeArr('movie', { hang: true });
  const rpc = await start({
    ARR_RADARR_URL: radarr.url,
    ARR_RADARR_KEY: 'radarr-secret',
    ARR_TIMEOUT_MS: '200',
  });
  try {
    const result = await rpc.tool('arr_lookup', { term: 'Дюна' });
    assert.equal(result.isError, true);
    assert.match(result.text, /Radarr не ответил за 200 мс/);
    assert.match(result.text, /ARR_RADARR_URL/);
  } finally {
    await rpc.stop();
    await radarr.close();
  }
});

test('выключенный сервер — «не принял соединение»', async () => {
  const radarr = await fakeArr('movie');
  const url = radarr.url;
  await radarr.close();
  const rpc = await start({ ARR_RADARR_URL: url, ARR_RADARR_KEY: 'radarr-secret' });
  try {
    const result = await rpc.tool('arr_lookup', { term: 'Дюна' });
    assert.equal(result.isError, true);
    assert.match(result.text, /не принял соединение/);
  } finally {
    await rpc.stop();
  }
});

test('status показывает версии обоих серверов', async () => {
  await withArrs(async ({ rpc }) => {
    const result = await rpc.tool('arr_status');
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Radarr: OK · Radarr 5\.2\.6\.8376/);
    assert.match(result.text, /Sonarr: OK · Sonarr 4\.0\.0\.1234/);
  });
});

function startHttp(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--http', '0'], {
      env: { ...cleanEnv(), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`HTTP-сервер не поднялся: ${stderr}`));
    }, 5000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /HTTP: (http:\/\/[^\s]+)/.exec(stderr);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        url: match[1],
        stop: () =>
          new Promise((done) => {
            child.once('exit', done);
            child.kill();
          }),
      });
    });
  });
}

function postRpc(url, message, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(message),
  });
}

test('HTTP-режим: initialize, уведомление и tools/list', async () => {
  const http = await startHttp({});
  try {
    const init = await postRpc(http.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    assert.equal(init.status, 200);
    const initBody = await init.json();
    assert.equal(initBody.result.serverInfo.name, 'arr');

    const notified = await postRpc(http.url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notified.status, 202, 'уведомление не должно требовать ответа');

    const listed = await postRpc(http.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.equal(listBody.result.tools.length, 8);
  } finally {
    await http.stop();
  }
});

test('HTTP наружу — только с ARR_HTTP_TOKEN', async () => {
  const http = await startHttp({ ARR_HTTP_TOKEN: 'http-secret' });
  try {
    const denied = await postRpc(http.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(denied.status, 401);

    const allowed = await postRpc(
      http.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { authorization: 'Bearer http-secret' },
    );
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.result.tools.length, 8);
  } finally {
    await http.stop();
  }
});
