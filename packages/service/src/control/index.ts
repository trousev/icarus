// Панель управления Icarus: HTTP-часть — тонкий JSON-слой над файлами и git.
//
// Человека называет SSO-прокси (см. identity.ts), поэтому параметра user в запросах нет
// и подменить его нельзя: чужую память через свою сессию не открыть.
//
// Разделы живут по своим адресам: /panel/memory — память, /panel/maple — математика.
// Внутри памяти три области: личная, семейная и математика; математика — не память в
// том же смысле: её файлы создаёт Maple, и панель показывает их только для чтения
// (ни «забыть», ни откатов): журнал сессии — это код, из которого сессия
// восстанавливается, и построчная правка его сломает.
//
// Старые адреса (/panel/api/*) остаются рабочими: браузер держит открытую страницу
// панели живой, и после обновления сервиса она не должна осыпаться на полуслове.
// Новые маршруты короче и называют раздел явно — их и рисует сама панель.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { findUser, userPaths, type IcarusConfig } from '../config.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import {
  countFiles,
  isImageFile,
  listFiles,
  mapleExtensions,
  memoryExtensions,
  readImageFile,
  readMemoryFile,
  removeFile,
  removeLine,
  removeLines,
  searchMemory,
} from './memory.ts';
import { parseEntries, readEntries } from './entries.ts';
import { commitAll, ensureRepo, fileHistory, log, revert, show } from './git.ts';
import { identifyPanelUser } from './identity.ts';
import { panelHtml, type PanelPage, type PanelSession } from './ui.ts';
import { log as logger } from '../log.ts';

export type PanelContext = { config: IcarusConfig };

/** Разделы панели: порядок здесь — порядок в сайдбаре. */
export const SECTIONS: { id: string; label: string }[] = [
  { id: 'memory', label: 'Память' },
  { id: 'maple', label: 'Математика' },
];

type Scope = 'personal' | 'shared' | 'maple';
/** Режим раздела: memory правится построчно, maple — только смотрится. */
export type ScopeMode = 'memory' | 'maple';

/** Заголовки областей памяти: их рисует панель, и держать их в браузере незачем. */
const SCOPE_LABELS: Record<string, string> = {
  personal: 'Личная',
  shared: 'Семейная',
  maple: 'Математика',
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Раздел запроса: всё незнакомое — личная память, как и раньше. */
function parseScope(raw: unknown): Scope {
  return raw === 'shared' || raw === 'maple' ? raw : 'personal';
}

function modeFor(scope: Scope): ScopeMode {
  return scope === 'maple' ? 'maple' : 'memory';
}

/** Корень раздела и набор расширений, которые в нём вообще допустимы. */
function resolveScope(config: IcarusConfig, userId: string, scope: Scope) {
  const user = findUser(config, userId);
  if (!user) return null;
  const paths = userPaths(config, user);
  if (scope === 'shared') return { root: paths.sharedMemory, allowed: memoryExtensions };
  if (scope === 'maple') return { root: paths.maple, allowed: mapleExtensions };
  return { root: paths.memory, allowed: memoryExtensions };
}

/** Какие области есть у человека и что в них можно делать. */
function scopesFor(config: IcarusConfig): Record<string, ScopeMode> {
  const scopes: Record<string, ScopeMode> = { personal: 'memory', shared: 'memory', maple: 'maple' };
  // Каталог математики не заводим без Maple: пустой раздел только путал бы.
  if (!config.mcp?.maple) delete scopes.maple;
  return scopes;
}

/** Репозитории и каталоги, без которых раздел не открыть: панель их и заводит. */
async function prepare(config: IcarusConfig, userId: string): Promise<void> {
  const user = findUser(config, userId);
  if (!user) return;
  const paths = userPaths(config, user);
  await ensureRepo(paths.memory);
  await ensureRepo(paths.sharedMemory);
  // Математику в git не берём: журналы переписываются на каждом шаге расчёта,
  // и коммит на каждый вызов Maple — это история ни о чём. Панель её и не
  // показывает, а репозиторий заводить «на будущее» незачем.
  if (config.mcp?.maple) fs.mkdirSync(paths.maple, { recursive: true });
}

/** Сколько файлов в каждой области: панель показывает это числом у раздела. */
function countsFor(config: IcarusConfig, userId: string): Record<string, number> {
  const user = findUser(config, userId);
  if (!user) return {};
  const paths = userPaths(config, user);
  const counts: Record<string, number> = {
    personal: countFiles(paths.memory, memoryExtensions),
    shared: countFiles(paths.sharedMemory, memoryExtensions),
  };
  if (config.mcp?.maple) counts.maple = countFiles(paths.maple, mapleExtensions);
  return counts;
}

export async function handlePanel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PanelContext,
): Promise<boolean> {
  const { config } = ctx;
  const access = identifyPanelUser(req, config);

  // Старый адрес панели: он и раньше вёл на память, и в закладках у людей он есть.
  if (url.pathname === '/panel' || url.pathname === '/panel/') {
    if (!access.ok) {
      res.writeHead(access.denial.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(panelHtml(access.denial));
      return true;
    }
    const scope = parseScope(url.searchParams.get('scope'));
    const query = new URLSearchParams({ scope });
    const file = url.searchParams.get('file');
    if (file) query.set('file', file);
    if (url.searchParams.get('tab') === 'history') query.set('tab', 'history');
    res.writeHead(302, { location: `/panel/memory?${query}` });
    res.end();
    return true;
  }

  const page = routePage(url.pathname);
  if (page) {
    const html = access.ok ? await sectionPage(config, access.identity.userId, page, url) : panelHtml(access.denial);
    res.writeHead(access.ok ? 200 : access.denial.status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  if (url.pathname.startsWith('/panel/api/') || routeApi(url.pathname)) {
    await handleApi(req, res, url, ctx, access);
    return true;
  }

  return false;
}

/** Раздел из адреса: /panel/memory и /panel/maple. Всё прочее — не наша страница. */
function routePage(pathname: string): PanelPage | null {
  const match = /^\/panel\/(memory|maple)\/?$/.exec(pathname);
  return match ? { section: match[1] } : null;
}

/** Маршрут API из адреса: /panel/<раздел>/<имя>. */
function routeApi(pathname: string): { section: string; name: string } | null {
  const match = /^\/panel\/(memory|maple)\/([\w-]+)$/.exec(pathname);
  return match ? { section: match[1], name: match[2] } : null;
}

async function sectionPage(
  config: IcarusConfig,
  userId: string,
  page: PanelPage,
  url: URL,
): Promise<string> {
  await prepare(config, userId);
  const session: PanelSession = {
    user: userId,
    sections: SECTIONS,
    scopes: scopesFor(config),
    scopeLabels: SCOPE_LABELS,
    model: config.models[0]?.id ?? '—',
    storage: 'git · local',
  };
  return panelHtml(session, {
    ...page,
    scope: parseScope(url.searchParams.get('scope')),
    file: url.searchParams.get('file') ?? undefined,
    tab: url.searchParams.get('tab') === 'history' ? 'history' : 'notes',
  });
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PanelContext,
  access: ReturnType<typeof identifyPanelUser>,
): Promise<void> {
  const { config } = ctx;
  if (!access.ok) {
    json(
      res,
      access.denial.status,
      errorBody(
        `${access.denial.message}. ${access.denial.hint}`,
        access.denial.status === 401 ? 'authentication_error' : 'permission_error',
      ),
    );
    return;
  }

  const userId = access.identity.userId;
  const route = routeApi(url.pathname);
  const name = route?.name ?? url.pathname.slice('/panel/api/'.length);

  if (req.method === 'GET' && name === 'state') {
    const user = findUser(config, userId);
    if (!user) {
      json(res, 404, errorBody(`пользователь ${userId} не заведён`));
      return;
    }
    await prepare(config, userId);
    const scopes = scopesFor(config);
    json(res, 200, {
      user: userId,
      sections: SECTIONS,
      scopes: Object.keys(scopes),
      modes: scopes,
      labels: SCOPE_LABELS,
      counts: countsFor(config, userId),
    });
    return;
  }

  // У GET область приходит в query, у POST — в теле. Человека в запросе нет:
  // его уже назвал прокси, и подменить его нельзя.
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch (error) {
      // Битое тело — это отказ в запросе, а не падение панели: чинить его нечем.
      json(res, 400, errorBody(`не разобрал тело запроса: ${String(error)}`, 'invalid_request_error'));
      return;
    }
  }
  // Раздел в адресе главнее области: /panel/maple/… — это математика.
  const scope = route?.section === 'maple' ? 'maple' : parseScope(url.searchParams.get('scope') ?? body.scope);
  const mode = modeFor(scope);
  const resolved = resolveScope(config, userId, scope);
  if (!resolved) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return;
  }
  const { root, allowed } = resolved;
  // Maple выключили из конфига, а старые файлы на диске остались. Раздел ему не
  // показывается — значит, и через API его не должно быть видно.
  if (scope === 'maple' && !config.mcp?.maple) {
    json(res, 404, errorBody('раздел математики выключен: в конфиге нет mcp.maple'));
    return;
  }

  if (req.method === 'GET' && name === 'files') {
    // Память — под git (её правки в панели откатываются коммитами), математика —
    // просто каталог, который надо завести, если человек ещё ничего не считал.
    if (mode === 'memory') await ensureRepo(root);
    else fs.mkdirSync(root, { recursive: true });
    json(res, 200, { user: userId, scope, mode, root, files: listFiles(root, '', allowed) });
    return;
  }

  // Записи файла: строки с номерами и датами из истории — то, из чего панель рисует
  // список с галочками. Файл целиком остаётся отдельным маршрутом: его читает
  // подсветка картинок и старые вкладки панели.
  if (req.method === 'GET' && name === 'entries') {
    const relative = url.searchParams.get('path') ?? '';
    const content = readMemoryFile(root, relative, allowed);
    if (content === null) {
      json(res, 404, errorBody('файл не найден или недоступен'));
      return;
    }
    json(res, 200, mode === 'memory' ? await readEntries(root, relative, content) : { ...parseEntries(content), path: relative, capped: false });
    return;
  }

  if (req.method === 'GET' && (name === 'file' || name === 'file-raw')) {
    const relative = url.searchParams.get('path') ?? '';
    const raw = name === 'file-raw' || url.searchParams.get('raw') === '1';
    // raw=1 — за картинкой: график отдаём байтами, а не строкой в JSON.
    if (raw && isImageFile(relative)) {
      const image = readImageFile(root, relative, allowed);
      if (!image) {
        json(res, 404, errorBody('картинка не найдена или недоступна'));
        return;
      }
      res.writeHead(200, { 'content-type': image.type, 'cache-control': 'private, max-age=300' });
      fs.createReadStream(image.file).pipe(res);
      return;
    }
    const content = readMemoryFile(root, relative, allowed);
    if (content === null) {
      json(res, 404, errorBody('файл не найден или недоступен'));
      return;
    }
    json(res, 200, { path: relative, content });
    return;
  }

  if (mode === 'memory' && req.method === 'GET' && name === 'file-history') {
    json(res, 200, { commits: await fileHistory(root, url.searchParams.get('path') ?? '') });
    return;
  }

  if (mode === 'memory' && req.method === 'GET' && name === 'history') {
    json(res, 200, { commits: await log(root) });
    return;
  }

  if (mode === 'memory' && req.method === 'GET' && name === 'show') {
    json(res, 200, await show(root, url.searchParams.get('commit') ?? ''));
    return;
  }

  if (req.method === 'GET' && name === 'search') {
    const query = url.searchParams.get('q') ?? '';
    json(res, 200, { query, hits: searchMemory(root, query, 50, allowed) });
    return;
  }

  if (mode === 'memory' && req.method === 'POST' && name === 'revert') {
    const result = await revert(root, String(body.commit ?? ''));
    logger.info('панель: откат коммита', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  if (mode === 'memory' && req.method === 'POST' && name === 'forget') {
    const result = removeLine(root, String(body.path ?? ''), String(body.line ?? ''), allowed);
    if (result.ok) {
      await commitAll(root, `memory: забыть «${String(body.line ?? '').slice(0, 60)}»`);
    }
    logger.info('панель: забывание', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // Пачка записей, отмеченных галочками: удаляем одним коммитом, чтобы в истории
  // это было одним осмысленным действием, а не десятком «забыть строку».
  if (mode === 'memory' && req.method === 'POST' && name === 'forget-many') {
    const relative = String(body.path ?? '');
    const lines = Array.isArray(body.lines) ? body.lines.map(Number) : [];
    const refused = guardEntries(root, relative, lines, allowed);
    if (refused) {
      json(res, 400, errorBody(refused, 'invalid_request_error'));
      return;
    }
    const result = removeLines(root, relative, lines, allowed);
    if (result.ok) {
      await commitAll(root, `memory: убрать записей из «${relative.slice(0, 60)}»: ${lines.length}`);
    }
    logger.info('панель: забывание пачки', { user: userId, scope, count: lines.length, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  // Удаление файла целиком — тоже коммит: пропажу видно в истории, и её можно
  // вернуть обратным коммитом, как и любую другую правку памяти.
  if (mode === 'memory' && req.method === 'POST' && name === 'delete') {
    const relative = String(body.path ?? '');
    const result = removeFile(root, relative, allowed);
    if (result.ok) {
      await commitAll(root, `memory: удалить файл «${relative.slice(0, 80)}»`);
    }
    logger.info('панель: удаление файла', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  if (mode === 'maple' && req.method === 'POST' && ['revert', 'forget', 'forget-many', 'delete'].includes(name)) {
    json(res, 400, errorBody('математика только для чтения: журналы и графики создаёт Maple', 'invalid_request_error'));
    return;
  }

  json(res, 404, errorBody(`неизвестный маршрут панели: ${name}`));
}

/**
 * Проверяет, что удалять собираются ровно записи: заголовок раздела — не запись,
 * и «убрать» его значит снести раздел вместе со всем, что под ним написано.
 * Заодно ловим случай, когда файл успел измениться: тогда номера уже не те.
 */
function guardEntries(
  root: string,
  relative: string,
  lines: number[],
  allowed: ReadonlySet<string>,
): string | null {
  const content = readMemoryFile(root, relative, allowed);
  if (content === null) return 'файл не найден или недоступен';
  // Даты тут не нужны: разбор идёт по строкам файла, а история приедет в панель.
  const entries = new Map(parseEntries(content).entries.map((entry) => [entry.line, entry.kind]));
  for (const line of lines) {
    const kind = entries.get(line);
    if (kind === undefined) return `строки ${line} в файле уже нет`;
    if (kind !== 'note') return `строка ${line} — не запись: заголовки и текст не удаляем`;
  }
  return null;
}
