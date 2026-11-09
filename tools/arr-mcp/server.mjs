#!/usr/bin/env node
// Кинозал: Radarr и Sonarr через MCP.
//
// Задача сервера — разговор о кино, а не «качай по интонации». Поэтому чтение
// (поиск по каталогу, коллекция, очередь, диски, профили и корневые папки) и
// заказ файла разведены: первые инструменты ничего не меняют, последний —
// arr_add — требует confirm: true и явного «да» от человека. Профили качества и
// root folders не выдумываются: они читаются с уже настроенного Radarr/Sonarr,
// иначе заказ уедет не туда.
//
// Ключи — только из окружения (ARR_RADARR_KEY / ARR_SONARR_KEY): в конфиг-файл
// и git они не попадают. Адрес — ARR_RADARR_URL / ARR_SONARR_URL.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'arr', version: '1.0.0' };

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 60_000;
const LOOKUP_LIMIT = 8;
const COLLECTION_LIMIT = 20;
const QUEUE_LIMIT = 50;

const SERVICE_LIST = [
  {
    kind: 'movie',
    title: 'Radarr',
    urlEnv: 'ARR_RADARR_URL',
    keyEnv: 'ARR_RADARR_KEY',
    url: normalizeUrl(process.env.ARR_RADARR_URL),
    key: (process.env.ARR_RADARR_KEY ?? '').trim(),
    itemId: 'tmdbId',
  },
  {
    kind: 'series',
    title: 'Sonarr',
    urlEnv: 'ARR_SONARR_URL',
    keyEnv: 'ARR_SONARR_KEY',
    url: normalizeUrl(process.env.ARR_SONARR_URL),
    key: (process.env.ARR_SONARR_KEY ?? '').trim(),
    itemId: 'tvdbId',
  },
];

// Оба сервера не обязаны быть настроены: можно держать только Radarr или только
// Sonarr. Не настроен — это не ошибка старта, а честный ответ инструмента.
const SERVICES = new Map(SERVICE_LIST.map((service) => [service.kind, service]));
const TIMEOUT_MS = timeoutFromEnv(process.env.ARR_TIMEOUT_MS);

const INSTRUCTIONS = `Кинозал: Radarr (фильмы) и Sonarr (сериалы).

Что можно делать без последствий (эти инструменты только читают):
- arr_lookup — найти фильм/сериал в каталоге, посмотреть год, рейтинг, описание и признак «уже в коллекции». Ничего не заказывает.
- arr_collection — что уже добавлено, что скачано, что наблюдается, сколько занимает.
- arr_queue — очередь загрузок: что качается, сколько осталось, какие ошибки.
- arr_disk — свободное место на дисках, которые видит сервер.
- arr_quality_profiles и arr_root_folders — профили качества и корневые папки, прочитанные с самого Radarr/Sonarr. Не придумывай свои: бери id и путь оттуда.
- arr_status — настроен ли сервер, отвечает ли он и какой версии.

Заказ файла — ОТДЕЛЬНОЕ действие arr_add. Оно выполняется только с confirm: true и только после того, как человек явно сказал «добавь» / «закажи» / «скачай». Молчаливая интонация «а может, посмотрим» — это не подтверждение. До заказа покажи человеку результат arr_lookup (название, год, что уже есть) и спроси. В ответе arr_add видно, какой профиль и какая папка выбраны и запущен ли поиск.

Ключи задаются окружением MCP-сервера, не файлом: ARR_RADARR_URL, ARR_RADARR_KEY, ARR_SONARR_URL, ARR_SONARR_KEY. Если инструмент говорит «не настроен», «нет ключа» или «401» — это не поломка Икара, а отсутствующий доступ: скажи человеку, чего не хватает, и не повторяй вызов наугад.`;

function normalizeUrl(raw) {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return '';
  // Адрес копируют из браузера вместе с /api/v3 — это не база API, а её хвост.
  return value.replace(/\/api\/v3$/i, '');
}

function timeoutFromEnv(raw) {
  const parsed = Number(String(raw ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(200, Math.round(parsed)));
}

function serviceOf(kind) {
  const normalized = kind === 'radarr' ? 'movie' : kind === 'sonarr' ? 'series' : kind;
  const service = SERVICES.get(normalized);
  if (!service) {
    throw new Error(`неизвестный kind «${String(kind)}»: ожидалось movie (Radarr) или series (Sonarr)`);
  }
  ensureConfigured(service);
  return service;
}

function ensureConfigured(service) {
  if (!service.url && !service.key) {
    throw new Error(
      `${service.title} не настроен: не заданы ${service.urlEnv} и ${service.keyEnv}. ` +
        `Адрес — вида http://192.168.1.10:${service.kind === 'movie' ? '7878' : '8989'}, ключ — из Settings → General в самом ${service.title}.`,
    );
  }
  if (!service.url) {
    throw new Error(`${service.title}: не задан адрес ${service.urlEnv} (ключ есть, а куда идти — нет).`);
  }
  let parsed;
  try {
    parsed = new URL(service.url);
  } catch {
    throw new Error(`${service.title}: ${service.urlEnv} = «${service.url}» не похож на адрес. Нужен http:// или https:// с портом.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${service.title}: ${service.urlEnv} должен начинаться с http:// или https://.`);
  }
  if (!service.key) {
    throw new Error(
      `${service.title} на ${service.url} без ключа: не задан ${service.keyEnv}. ` +
        `Ключ лежит в ${service.title} → Settings → General → API Key.`,
    );
  }
}

/** Ответ *arr с ошибкой валидации — массив { propertyName, errorMessage }. */
function describeFailure(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return 'пустой ответ';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const messages = parsed
        .map((item) => String(item?.errorMessage ?? item?.message ?? '').trim())
        .filter((item) => item !== '');
      if (messages.length > 0) return messages.join('; ');
    }
    const message = String(parsed?.message ?? parsed?.error ?? '').trim();
    if (message !== '') return message;
  } catch {
    // не JSON — покажем начало тела: там обычно HTML-страница входа или 404 прокси
  }
  return raw.replace(/\s+/g, ' ').slice(0, 180);
}

async function request(service, route, options = {}) {
  const { method = 'GET', query = {}, body } = options;
  const url = new URL(`${service.url}/api/v3/${route}`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'X-Api-Key': service.key,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (caught) {
    const name = String(caught?.name ?? '');
    const code = String(caught?.cause?.code ?? caught?.code ?? '');
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        `${service.title} не ответил за ${TIMEOUT_MS} мс (${service.url}). Проверь адрес ${service.urlEnv} и что сервер запущен.`,
        { cause: caught },
      );
    }
    if (code === 'ECONNREFUSED') {
      throw new Error(`${service.title} не принял соединение (${service.url}): сервер выключен или порт другой.`, {
        cause: caught,
      });
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      throw new Error(`${service.title} не нашёл хост из ${service.urlEnv} (${service.url}): проверь имя и DNS.`, {
        cause: caught,
      });
    }
    throw new Error(`не удалось связаться с ${service.title} (${service.url}): ${String(caught?.message ?? caught)}`, {
      cause: caught,
    });
  }

  const text = await response.text();
  if (response.status === 401) {
    throw new Error(
      `${service.title} отклонил ключ (401). Проверь ${service.keyEnv}: это API Key из Settings → General.`,
    );
  }
  if (response.status === 403) {
    throw new Error(`${service.title} ответил 403: ключ принят, но действие запрещено настройками сервера.`);
  }
  if (!response.ok) {
    throw new Error(
      `${service.title} ответил ${response.status} на ${route}: ${describeFailure(text)}`,
    );
  }
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${service.title} ответил не JSON на ${route}: похоже, ${service.urlEnv} ведёт не на API. ` +
        `Начало ответа: ${describeFailure(text)}`,
    );
  }
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = [
    [1024 ** 4, 'ТБ'],
    [1024 ** 3, 'ГБ'],
    [1024 ** 2, 'МБ'],
    [1024, 'КБ'],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) return `${(bytes / size).toFixed(1).replace('.', ',')} ${unit}`;
  }
  return `${Math.round(bytes)} Б`;
}

function percentOf(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

function ratingOf(item, source = 'tmdb') {
  const value = item?.ratings?.[source]?.value ?? item?.ratings?.imdb?.value ?? item?.ratings?.tvdb?.value;
  return Number.isFinite(value) ? value.toFixed(1).replace('.', ',') : '';
}

function shorten(text, limit = 220) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function titleOf(media) {
  const title = String(media?.title ?? '').trim();
  const year = Number(media?.year);
  return Number.isFinite(year) && year > 0 ? `${title} (${year})` : title;
}

async function collectionIndex(service) {
  const items = await request(service, service.kind === 'movie' ? 'movie' : 'series');
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = Number(item?.[service.itemId]);
    if (Number.isFinite(id) && id > 0) map.set(id, item);
  }
  return map;
}

function movieFileState(item) {
  if (item?.hasFile === true) return 'файл есть';
  if (item?.monitored === true) return 'наблюдается, файла ещё нет';
  return 'файла нет, не наблюдается';
}

function sizeOf(item, service) {
  const value = service.kind === 'movie' ? item?.sizeOnDisk : item?.statistics?.sizeOnDisk;
  return Number(value ?? 0);
}

function seriesFileState(item) {
  const stats = item?.statistics ?? {};
  const have = Number(stats.episodeFileCount);
  const total = Number(stats.episodeCount);
  if (Number.isFinite(have) && Number.isFinite(total) && total > 0) {
    if (have >= total) return `все ${total} серий скачаны`;
    return `скачано ${have} из ${total} серий`;
  }
  return item?.monitored === true ? 'наблюдается' : 'не наблюдается';
}

function mediaLine(item, index, service, options = {}) {
  const bits = [];
  const id = Number(item?.[service.itemId]);
  bits.push(service.kind === 'movie' ? `TMDB ${id}` : `TVDB ${id}`);
  const rating = ratingOf(item, service.kind === 'movie' ? 'tmdb' : 'tvdb');
  if (rating !== '') bits.push(`${rating}/10`);
  if (service.kind === 'movie') {
    const runtime = Number(item?.runtime);
    if (Number.isFinite(runtime) && runtime > 0) bits.push(`${runtime} мин`);
  } else if (item?.network) {
    bits.push(String(item.network));
  }
  const note = String(options.note ?? '');
  const state =
    options.state === undefined
      ? service.kind === 'movie'
        ? movieFileState(item)
        : seriesFileState(item)
      : String(options.state);
  const head = `${index}. ${titleOf(item)} — ${bits.join(' · ')}${note === '' ? '' : ` · ${note}`}`;
  const lines = [head];
  if (state !== '') lines.push(`   ${state}`);
  const overview = shorten(item?.overview);
  if (overview !== '') lines.push(`   ${overview}`);
  return lines.join('\n');
}

async function lookup(args) {
  const service = serviceOf(args.kind ?? 'movie');
  const term = String(args.term ?? '').trim();
  if (term === '') {
    throw new Error(
      `нужен term: что искать. Например, arr_lookup({ kind: "${service.kind}", term: "Дюна" }).`,
    );
  }
  const limit = clampInt(args.limit, 1, 25, LOOKUP_LIMIT);
  const route = service.kind === 'movie' ? 'movie/lookup' : 'series/lookup';
  const found = await request(service, route, { query: { term } });
  const results = Array.isArray(found) ? found : [];
  if (results.length === 0) {
    return `${service.title}: по запросу «${term}» ничего не найдено. Уточни название или добавь год.`;
  }

  // Проверка «уже в коллекции» — отдельный запрос, и он не должен ломать поиск:
  // если каталог не отдался, честно скажем об этом, но результаты покажем.
  let collection = new Map();
  let collectionError = '';
  try {
    collection = await collectionIndex(service);
  } catch (caught) {
    collectionError = String(caught?.message ?? caught);
  }

  const lines = [`${service.title}: найдено ${results.length}, показываю ${Math.min(limit, results.length)}.`];
  results.slice(0, limit).forEach((item, index) => {
    const id = Number(item?.[service.itemId]);
    const existing = collection.get(id);
    let note = '';
    if (collectionError === '') {
      if (existing === undefined) {
        note = 'нет в коллекции';
      } else {
        const state = service.kind === 'movie' ? movieFileState(existing) : seriesFileState(existing);
        note = `УЖЕ В КОЛЛЕКЦИИ (${state})`;
      }
    }
    lines.push(mediaLine(item, index + 1, service, { note, state: '' }));
  });
  if (collectionError !== '') {
    lines.push(`(проверить коллекцию не удалось: ${collectionError})`);
  }
  const idName = service.itemId;
  lines.push(
    '',
    `Это только поиск — файл НЕ заказан. Покажи человеку название и год и спроси, добавлять ли. ` +
      `Если он сказал «да», вызывай arr_add({ kind: "${service.kind}", id: <${idName} из строки выше>, confirm: true }).`,
  );
  return lines.join('\n');
}

function collectionSection(service, items, query, limit) {
  const all = Array.isArray(items) ? items : [];
  const needle = query.toLowerCase();
  const filtered = needle === '' ? all : all.filter((item) => String(item?.title ?? '').toLowerCase().includes(needle));
  if (filtered.length === 0) {
    return needle === ''
      ? `${service.title}: коллекция пуста.`
      : `${service.title}: в коллекции нет ничего со словом «${query}» (всего ${all.length}).`;
  }

  const totalBytes = filtered.reduce((sum, item) => sum + sizeOf(item, service), 0);
  const shown = filtered.slice(0, limit);
  const lines = [
    `${service.title}: ${filtered.length}${needle === '' ? '' : ` по запросу «${query}»`} · на диске ${humanSize(totalBytes)}`,
  ];
  shown.forEach((item, index) => {
    const line = mediaLine(item, index + 1, service).split('\n')[0];
    lines.push(line);
  });
  if (filtered.length > shown.length) lines.push(`(показаны первые ${shown.length}; уточни query, чтобы сузить)`);
  return lines.join('\n');
}

async function collection(args) {
  const kind = args.kind ?? 'all';
  const query = String(args.query ?? '').trim();
  const limit = clampInt(args.limit, 1, 100, COLLECTION_LIMIT);
  const wanted = kind === 'all' ? SERVICE_LIST : [serviceOf(kind)];
  const sections = [];
  for (const service of wanted) {
    try {
      ensureConfigured(service);
      const items = await request(service, service.kind === 'movie' ? 'movie' : 'series');
      sections.push(collectionSection(service, items, query, limit));
    } catch (caught) {
      if (kind !== 'all') throw caught;
      // Текст ошибки уже начинается с имени сервиса — второй раз не добавляем.
      sections.push(String(caught?.message ?? caught));
    }
  }
  return sections.join('\n\n');
}

function queueItemLine(item, index, service) {
  const media = service.kind === 'movie' ? item?.movie : item?.series;
  const label = media?.title ? titleOf(media) : String(item?.title ?? 'без названия');
  const status = String(item?.status ?? 'unknown');
  const size = Number(item?.size);
  const left = Number(item?.sizeleft);
  const progress = percentOf(Number.isFinite(size) && Number.isFinite(left) ? size - left : NaN, size);
  const bits = [status];
  if (progress !== null) bits.push(`${progress}%`);
  if (Number.isFinite(left) && left > 0 && Number.isFinite(size)) {
    bits.push(`осталось ${humanSize(left)} из ${humanSize(size)}`);
  }
  if (item?.timeleft) bits.push(`~${String(item.timeleft)}`);
  const lines = [`${index}. ${label} — ${bits.join(' · ')}`];
  if (item?.title && item.title !== label) lines.push(`   ${String(item.title)}`);
  if (item?.errorMessage) lines.push(`   ошибка: ${shorten(item.errorMessage, 180)}`);
  const messages = Array.isArray(item?.statusMessages) ? item.statusMessages : [];
  for (const message of messages) {
    const text = shorten(message?.messages?.join?.(' ') ?? message?.title ?? '', 180);
    if (text !== '') lines.push(`   ${message?.title ? `${message.title}: ` : ''}${text}`);
  }
  return lines.join('\n');
}

async function queue(args) {
  const kind = args.kind ?? 'all';
  const wanted = kind === 'all' ? SERVICE_LIST : [serviceOf(kind)];
  const sections = [];
  for (const service of wanted) {
    try {
      ensureConfigured(service);
      const query =
        service.kind === 'movie'
          ? { page: 1, pageSize: QUEUE_LIMIT, includeUnknownMovieItems: true, includeMovie: true }
          : { page: 1, pageSize: QUEUE_LIMIT, includeUnknownSeriesItems: true, includeSeries: true, includeEpisode: true };
      const page = await request(service, 'queue', { query });
      const records = Array.isArray(page?.records) ? page.records : [];
      const total = Number(page?.totalRecords ?? records.length);
      if (records.length === 0) {
        sections.push(`${service.title}: очередь пуста — ничего не качается.`);
        continue;
      }
      const lines = [`${service.title}: в очереди ${total}${total > records.length ? ` (показаны ${records.length})` : ''}`];
      records.forEach((item, index) => lines.push(queueItemLine(item, index + 1, service)));
      sections.push(lines.join('\n'));
    } catch (caught) {
      if (kind !== 'all') throw caught;
      // Текст ошибки уже начинается с имени сервиса — второй раз не добавляем.
      sections.push(String(caught?.message ?? caught));
    }
  }
  return sections.join('\n\n');
}

function diskSection(service, disks) {
  const list = Array.isArray(disks) ? disks : [];
  if (list.length === 0) return `${service.title}: сервер не отдал ни одного диска.`;
  const lines = [`${service.title}: место на дисках`];
  list.forEach((disk, index) => {
    const free = Number(disk?.freeSpace);
    const total = Number(disk?.totalSpace);
    const usedPercent = Number.isFinite(free) && Number.isFinite(total) && total > 0 ? percentOf(total - free, total) : null;
    const label = String(disk?.label ?? '').trim();
    const path = String(disk?.path ?? '').trim();
    const where = label !== '' && path !== '' && label !== path ? `${label} (${path})` : label || path || 'без пути';
    const freeText = Number.isFinite(free) && Number.isFinite(total) ? `свободно ${humanSize(free)} из ${humanSize(total)}` : 'размер неизвестен';
    lines.push(`${index + 1}. ${where}: ${freeText}${usedPercent === null ? '' : ` (занято ${usedPercent}%)`}`);
  });
  return lines.join('\n');
}

async function disk(args) {
  const kind = args.kind ?? 'all';
  const wanted = kind === 'all' ? SERVICE_LIST : [serviceOf(kind)];
  const sections = [];
  for (const service of wanted) {
    try {
      ensureConfigured(service);
      const disks = await request(service, 'diskspace');
      sections.push(diskSection(service, disks));
    } catch (caught) {
      if (kind !== 'all') throw caught;
      // Текст ошибки уже начинается с имени сервиса — второй раз не добавляем.
      sections.push(String(caught?.message ?? caught));
    }
  }
  return sections.join('\n\n');
}

function qualityNameOf(profile, id) {
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (Number(item?.id) === Number(id)) return String(item?.name ?? item?.quality?.name ?? '').trim();
      const nested = walk(item?.items);
      if (nested !== '') return nested;
    }
    return '';
  };
  return walk(profile?.items);
}

function profileSection(service, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length === 0) {
    return `${service.title}: ни одного профиля качества. Его надо завести на сервере — я профили не придумываю.`;
  }
  const lines = [`${service.title}: профили качества (прочитаны с сервера)`];
  list.forEach((profile, index) => {
    const parts = [`${index + 1}. ${String(profile?.name ?? 'без имени')} (id ${Number(profile?.id)})`];
    if (profile?.upgradeAllowed === true) parts.push('обновление разрешено');
    const cutoff = qualityNameOf(profile, profile?.cutoff);
    if (cutoff !== '') parts.push(`cutoff: ${cutoff}`);
    lines.push(parts.join(' · '));
  });
  lines.push('', 'Эти id подставляй в arr_add({ qualityProfileId }).');
  return lines.join('\n');
}

async function qualityProfiles(args) {
  const kind = args.kind ?? 'all';
  const wanted = kind === 'all' ? SERVICE_LIST : [serviceOf(kind)];
  const sections = [];
  for (const service of wanted) {
    try {
      ensureConfigured(service);
      sections.push(profileSection(service, await request(service, 'qualityprofile')));
    } catch (caught) {
      if (kind !== 'all') throw caught;
      // Текст ошибки уже начинается с имени сервиса — второй раз не добавляем.
      sections.push(String(caught?.message ?? caught));
    }
  }
  return sections.join('\n\n');
}

function folderSection(service, folders) {
  const list = Array.isArray(folders) ? folders : [];
  if (list.length === 0) {
    return `${service.title}: ни одной корневой папки. Её надо завести на сервере — путь я не придумываю.`;
  }
  const lines = [`${service.title}: корневые папки (прочитаны с сервера)`];
  list.forEach((folder, index) => {
    const parts = [`${index + 1}. ${String(folder?.path ?? 'без пути')}`];
    parts.push(folder?.accessible === true ? 'доступна' : 'НЕДОСТУПНА серверу');
    const free = Number(folder?.freeSpace);
    if (Number.isFinite(free) && free >= 0) parts.push(`свободно ${humanSize(free)}`);
    lines.push(parts.join(' · '));
  });
  lines.push('', 'Этот path подставляй в arr_add({ rootFolderPath }).');
  return lines.join('\n');
}

async function rootFolders(args) {
  const kind = args.kind ?? 'all';
  const wanted = kind === 'all' ? SERVICE_LIST : [serviceOf(kind)];
  const sections = [];
  for (const service of wanted) {
    try {
      ensureConfigured(service);
      sections.push(folderSection(service, await request(service, 'rootfolder')));
    } catch (caught) {
      if (kind !== 'all') throw caught;
      // Текст ошибки уже начинается с имени сервиса — второй раз не добавляем.
      sections.push(String(caught?.message ?? caught));
    }
  }
  return sections.join('\n\n');
}

async function status() {
  const lines = [];
  for (const service of SERVICE_LIST) {
    try {
      ensureConfigured(service);
      const info = await request(service, 'system/status');
      lines.push(`${service.title}: OK · ${String(info?.appName ?? service.title)} ${String(info?.version ?? '?')} · ${service.url}`);
    } catch (caught) {
      // В сообщении об ошибке имя сервиса уже есть.
      lines.push(String(caught?.message ?? caught));
    }
  }
  return lines.join('\n');
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`ожидалось число, пришло «${String(value)}»`);
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function pickProfile(profiles, wantedId) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (wantedId !== undefined && wantedId !== null) {
    const profile = list.find((item) => Number(item?.id) === Number(wantedId));
    if (profile === undefined) {
      throw new Error(
        `профиля качества с id ${String(wantedId)} на сервере нет. Есть: ${list.map((item) => `${Number(item?.id)} — ${String(item?.name)}`).join(', ') || 'ни одного'}.`,
      );
    }
    return profile;
  }
  if (list.length === 1) return list[0];
  if (list.length === 0) {
    throw new Error('на сервере нет ни одного профиля качества — его надо завести в Radarr/Sonarr, я профили не выдумываю.');
  }
  throw new Error(
    `на сервере несколько профилей качества: ${list.map((item) => `${Number(item?.id)} — ${String(item?.name)}`).join(', ')}. ` +
      `Укажи qualityProfileId, какой брать.`,
  );
}

function pickRootFolder(folders, wantedPath) {
  const list = Array.isArray(folders) ? folders : [];
  if (wantedPath !== undefined && wantedPath !== null) {
    const path = String(wantedPath).trim();
    const folder = list.find((item) => String(item?.path ?? '') === path);
    if (folder === undefined) {
      throw new Error(
        `корневой папки «${path}» на сервере нет. Есть: ${list.map((item) => String(item?.path)).join(', ') || 'ни одной'}.`,
      );
    }
    if (folder.accessible !== true) throw new Error(`корневая папка «${path}» есть, но сервер её не видит (недоступна).`);
    return folder;
  }
  const accessible = list.filter((folder) => folder?.accessible === true);
  if (accessible.length === 1) return accessible[0];
  if (list.length === 0) {
    throw new Error('на сервере нет ни одной корневой папки — её надо завести в Radarr/Sonarr, путь я не выдумываю.');
  }
  if (accessible.length === 0) {
    throw new Error(
      `все корневые папки серверу недоступны: ${list.map((item) => String(item?.path)).join(', ')}. Проверь монтирование на сервере.`,
    );
  }
  throw new Error(
    `на сервере несколько корневых папок: ${accessible.map((item) => String(item?.path)).join(', ')}. Укажи rootFolderPath, куда класть.`,
  );
}

async function metadataFor(service, id) {
  if (service.kind === 'movie') {
    const movie = await request(service, 'movie/lookup/tmdb', { query: { tmdbId: id } });
    if (movie === null || Number(movie?.tmdbId) !== Number(id)) {
      throw new Error(`Radarr не нашёл фильм с TMDB id ${id} — проверь id (его даёт arr_lookup).`);
    }
    return movie;
  }
  const found = await request(service, 'series/lookup', { query: { term: `tvdb:${id}` } });
  const series = (Array.isArray(found) ? found : []).find((item) => Number(item?.tvdbId) === Number(id));
  if (series === undefined) {
    throw new Error(`Sonarr не нашёл сериал с TVDB id ${id} — проверь id (его даёт arr_lookup).`);
  }
  return series;
}

async function add(args) {
  const service = serviceOf(args.kind ?? 'movie');
  if (args.confirm !== true) {
    throw new Error(
      'arr_add — это заказ файла: добавляет в библиотеку и запускает поиск загрузки. ' +
        'Без confirm: true не выполняю. Покажи человеку arr_lookup и дождись явного «добавь»; ' +
        'потом вызови arr_add с confirm: true.',
    );
  }

  const rawId = args.id ?? (service.kind === 'movie' ? args.tmdbId : args.tvdbId);
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    throw new Error(`нужен числовой id (${service.itemId}) из arr_lookup, пришло «${String(rawId)}».`);
  }

  // Профиль и папку не изобретаем: читаем те, что уже настроены на сервере.
  const [profiles, folders] = await Promise.all([
    request(service, 'qualityprofile'),
    request(service, 'rootfolder'),
  ]);
  const profile = pickProfile(profiles, args.qualityProfileId);
  const folder = pickRootFolder(folders, args.rootFolderPath);
  const search = args.search !== false;

  let existing = null;
  try {
    existing = (await collectionIndex(service)).get(id) ?? null;
  } catch {
    // Проверка «уже есть» — подсказка, а не условие заказа: сервер сам откажет.
  }
  if (existing !== null) {
    throw new Error(
      `${titleOf(existing)} уже в коллекции (${service.kind === 'movie' ? movieFileState(existing) : seriesFileState(existing)}). ` +
        'Повторно добавлять не нужно.',
    );
  }

  const metadata = await metadataFor(service, id);
  const payload =
    service.kind === 'movie'
      ? {
          title: String(metadata.title ?? ''),
          tmdbId: id,
          year: Number(metadata.year) || 0,
          qualityProfileId: Number(profile.id),
          rootFolderPath: String(folder.path),
          monitored: true,
          addOptions: { searchForMovie: search, monitor: 'movieOnly' },
        }
      : {
          title: String(metadata.title ?? ''),
          tvdbId: id,
          year: Number(metadata.year) || 0,
          qualityProfileId: Number(profile.id),
          rootFolderPath: String(folder.path),
          monitored: true,
          seasonFolder: true,
          seriesType: String(metadata.seriesType ?? 'standard'),
          addOptions: { searchForMissingEpisodes: search, monitor: 'all' },
        };

  const created = await request(service, service.kind === 'movie' ? 'movie' : 'series', {
    method: 'POST',
    body: payload,
  });

  const lines = [
    `ЗАКАЗАНО (${service.title}): ${titleOf(created ?? payload)}`,
    `профиль качества: ${String(profile.name ?? profile.id)} (id ${Number(profile.id)})`,
    `корневая папка: ${String(folder.path)}`,
    search
      ? 'поиск файла запущен: сервер будет искать загрузку сам'
      : 'поиск НЕ запускался (search: false): добавлено только наблюдение, файл не заказан',
  ];
  const createdId = Number(created?.id);
  if (Number.isFinite(createdId) && createdId > 0) lines.push(`id в библиотеке: ${createdId}`);
  if (created?.path) lines.push(`путь: ${String(created.path)}`);
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'arr_status',
    description:
      'Проверить доступ: настроены ли Radarr/Sonarr, отвечают ли они и какой версии. Ничего не меняет. Если тут «не настроен» или «401» — скажи человеку, чего не хватает, и не повторяй наугад.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'arr_lookup',
    description:
      'Поиск фильма/сериала в каталоге Radarr/Sonarr: название, год, рейтинг, описание и признак «уже в коллекции». ТОЛЬКО ЧТЕНИЕ: файл не заказывает и ничего не добавляет.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series'], description: 'movie — Radarr, series — Sonarr. По умолчанию movie.' },
        term: { type: 'string', description: 'Название (можно с годом).' },
        limit: { type: 'integer', description: 'Сколько результатов показать, 1–25. По умолчанию 8.' },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: 'arr_collection',
    description:
      'Что уже есть в библиотеке: фильмы/сериалы, размер на диске, скачано или только наблюдается. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series', 'all'], description: 'По умолчанию all — оба сервера.' },
        query: { type: 'string', description: 'Отфильтровать по названию.' },
        limit: { type: 'integer', description: 'Сколько строк показать, 1–100. По умолчанию 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'arr_queue',
    description:
      'Очередь загрузок: что качается, на сколько процентов, сколько осталось и какие ошибки. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series', 'all'], description: 'По умолчанию all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'arr_disk',
    description: 'Свободное место на дисках, которые видит Radarr/Sonarr. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series', 'all'], description: 'По умолчанию all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'arr_quality_profiles',
    description:
      'Профили качества, уже настроенные в Radarr/Sonarr: id, название, cutoff. Читаются с сервера — не придумывай свои. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series', 'all'], description: 'По умолчанию all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'arr_root_folders',
    description:
      'Корневые папки, уже настроенные в Radarr/Sonarr: путь, доступность, свободное место. Читаются с сервера — не придумывай путь. Только чтение.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series', 'all'], description: 'По умолчанию all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'arr_add',
    description:
      'ЗАКАЗ ФАЙЛА: добавить фильм/сериал в Radarr/Sonarr и запустить поиск загрузки. Выполняется только с confirm: true и только после явного согласия человека («добавь», «закажи», «скачай»), а не по мимолётной интонации. До вызова покажи arr_lookup. Профиль и корневую папку берёт с сервера; если их несколько — попроси выбрать.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['movie', 'series'], description: 'movie — Radarr, series — Sonarr. По умолчанию movie.' },
        id: { type: 'integer', description: 'TMDB id для фильма или TVDB id для сериала — ровно тот, что вернул arr_lookup.' },
        confirm: { type: 'boolean', description: 'Обязательно true: подтверждение, что человек действительно просил заказать файл.' },
        qualityProfileId: { type: 'integer', description: 'id профиля качества с сервера; нужен, если профилей несколько.' },
        rootFolderPath: {
          type: 'string',
          description: 'Путь корневой папки с сервера; нужен, если доступных папок несколько.',
        },
        search: { type: 'boolean', description: 'Запустить поиск файла сразу. По умолчанию true; false — только добавить и наблюдать.' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  arr_status: () => status(),
  arr_lookup: (args) => lookup(args),
  arr_collection: (args) => collection(args),
  arr_queue: (args) => queue(args),
  arr_disk: (args) => disk(args),
  arr_quality_profiles: (args) => qualityProfiles(args),
  arr_root_folders: (args) => rootFolders(args),
  arr_add: (args) => add(args),
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(message) {
  process.stderr.write(`[arr] ${message}\n`);
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
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `неизвестный инструмент: ${String(name)}` }], isError: true },
      };
    }
    try {
      const text = await handler(args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (caught) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(caught?.message ?? caught) }], isError: true },
      };
    }
  }
  if (id === undefined || id === null) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
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
      if (!line) continue;
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
    await idle();
    process.exit(0);
  });
}

const MAX_HTTP_BODY = 1_000_000;

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY) {
        reject(new Error('тело запроса больше 1 МБ'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Streamable HTTP: тот же JSON-RPC, но по POST /mcp. Нужен, когда сервер живёт
 * отдельным контейнером рядом с arr-стеком, а не внутри контейнера агента.
 * Слушаем только localhost, пока явно не попросили другой адрес; наружу — только
 * с ARR_HTTP_TOKEN, иначе кто угодно в сети смог бы заказывать файлы.
 */
async function serveHttp(port, host) {
  const token = (process.env.ARR_HTTP_TOKEN ?? '').trim();
  const server = http.createServer((req, res) => {
    const sendJson = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      sendJson(200, { ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version, tools: TOOLS.length });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, GET, OPTIONS' });
      res.end();
      return;
    }
    if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
      sendJson(401, { error: 'нужен заголовок Authorization: Bearer <ARR_HTTP_TOKEN>' });
      return;
    }

    const handle = async () => {
      let raw;
      try {
        raw = await readRequestBody(req);
      } catch (caught) {
        sendJson(413, { error: String(caught?.message ?? caught) });
        return;
      }
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'тело не JSON' } });
        return;
      }
      const batch = Array.isArray(message);
      const responses = [];
      for (const item of batch ? message : [message]) {
        const response = await dispatch(item);
        if (response) responses.push(response);
      }
      // Уведомления (например, notifications/initialized) ответа не требуют.
      if (responses.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendJson(200, batch ? responses : responses[0]);
    };
    handle().catch((caught) => {
      log(`HTTP: ${String(caught?.stack ?? caught)}`);
      if (!res.headersSent) sendJson(500, { error: 'внутренняя ошибка сервера' });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actual = typeof address === 'object' && address !== null ? address.port : port;
  log(`HTTP: http://${host}:${actual}/mcp${token === '' ? ' (без токена, только localhost)' : ' (нужен Bearer-токен)'}`);
  return server;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const httpIndex = args.indexOf('--http');
  if (httpIndex === -1) {
    serveStdio();
  } else {
    const port = Number(args[httpIndex + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('--http: нужен порт, например --http 8799');
      process.exit(2);
    }
    const hostIndex = args.indexOf('--host');
    const host = hostIndex === -1 ? '127.0.0.1' : String(args[hostIndex + 1] ?? '127.0.0.1');
    serveHttp(port, host).catch((caught) => {
      log(String(caught?.stack ?? caught));
      process.exit(1);
    });
  }
}

export { INSTRUCTIONS, SERVICE_LIST, TOOLS, dispatch, humanSize, request, serveHttp };
