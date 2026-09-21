// HTTP-часть панели памяти: тонкий JSON-слой над файлами и git.
//
// Доступа по общему ключу здесь нет намеренно: один ключ на всех открывал память
// всех. Вместо него — личная ссылка от Икара: пропуск подписан секретом сервиса,
// живёт ограниченное время и называет ровно одного человека. Чей это пропуск,
// решает только он: параметр user из запроса игнорируется, поэтому чужую память
// через свою ссылку не открыть.
//
// Разделов три: личная память, семейная и математика. Математика — не память в
// том же смысле: её файлы создаёт Maple, и панель показывает их только для чтения
// (ни «забыть», ни откатов): журнал сессии — это код, из которого сессия
// восстанавливается, и построчная правка его сломает.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { findUser, userPaths, type IcarusConfig } from '../config.ts';
import { readJsonBody, headerValue } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { verifyPanelCredential } from '../../../extensions/lib/panel-link.ts';
import {
  isImageFile,
  listFiles,
  mapleExtensions,
  memoryExtensions,
  readImageFile,
  readMemoryFile,
  removeFile,
  removeLine,
  searchMemory,
} from './memory.ts';
import { commitAll, ensureRepo, log, revert, show } from './git.ts';
import { panelHtml } from './ui.ts';
import { log as logger } from '../log.ts';

export type PanelContext = { config: IcarusConfig; panelSecret: string };

type Scope = 'personal' | 'shared' | 'maple';
/** Режим раздела: memory правится построчно, maple — только смотрится. */
export type ScopeMode = 'memory' | 'maple';

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Пропуск приходит заголовком (запросы API) или в самой ссылке (страница). */
function credentialOf(req: IncomingMessage, url: URL): string | null {
  const header = headerValue(req, 'authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return url.searchParams.get('t');
}

/** Чей это пропуск и не истёк ли он. null — доступа нет. */
function authorize(req: IncomingMessage, url: URL, ctx: PanelContext): string | null {
  const credential = credentialOf(req, url);
  if (!credential) return null;
  const verified = verifyPanelCredential(ctx.panelSecret, credential);
  if (!verified.ok) return null;
  return findUser(ctx.config, verified.userId) ? verified.userId : null;
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

/** Какие разделы есть у человека и что в них можно делать. */
function scopesFor(config: IcarusConfig): Record<Scope, ScopeMode> {
  const scopes: Record<Scope, ScopeMode> = { personal: 'memory', shared: 'memory', maple: 'maple' };
  // Каталог математики не заводим без Maple: пустой раздел только путал бы.
  if (!config.mcp?.maple) delete (scopes as Partial<Record<Scope, ScopeMode>>).maple;
  return scopes;
}

export async function handlePanel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PanelContext,
): Promise<boolean> {
  const { config } = ctx;

  if (url.pathname === '/panel' || url.pathname === '/panel/') {
    const userId = authorize(req, url, ctx);
    res.writeHead(userId ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
    res.end(panelHtml(userId ? { user: userId, scopes: scopesFor(config) } : null));
    return true;
  }

  if (!url.pathname.startsWith('/panel/api/')) return false;

  const userId = authorize(req, url, ctx);
  if (!userId) {
    json(res, 401, errorBody('ссылка неверна или истекла — попроси у Икара свежую', 'authentication_error'));
    return true;
  }

  const route = url.pathname.slice('/panel/api/'.length);

  if (req.method === 'GET' && route === 'state') {
    const user = findUser(config, userId);
    if (!user) {
      json(res, 404, errorBody(`пользователь ${userId} не заведён`));
      return true;
    }
    const paths = userPaths(config, user);
    await ensureRepo(paths.memory);
    await ensureRepo(paths.sharedMemory);
    // Математику в git не берём: журналы переписываются на каждом шаге расчёта,
    // и коммит на каждый вызов Maple — это история ни о чём. Панель её и не
    // показывает, а репозиторий заводить «на будущее» незачем.
    if (config.mcp?.maple) fs.mkdirSync(paths.maple, { recursive: true });
    const scopes = scopesFor(config);
    json(res, 200, { user: userId, scopes: Object.keys(scopes), modes: scopes });
    return true;
  }

  // У GET область приходит в query, у POST — в теле. Человека в запросе нет:
  // он уже назван пропуском, и подменить его нельзя.
  const body = req.method === 'POST' ? ((await readJsonBody(req)) as Record<string, unknown>) : {};
  const scope = parseScope(url.searchParams.get('scope') ?? body.scope);
  const mode = modeFor(scope);
  const resolved = resolveScope(config, userId, scope);
  if (!resolved) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return true;
  }
  const { root, allowed } = resolved;
  // Maple выключили из конфига, а старые файлы на диске остались. Раздел ему не
  // показывается — значит, и через API его не должно быть видно.
  if (scope === 'maple' && !config.mcp?.maple) {
    json(res, 404, errorBody('раздел математики выключен: в конфиге нет mcp.maple'));
    return true;
  }

  if (req.method === 'GET' && route === 'files') {
    // Память — под git (её правки в панели откатываются коммитами), математика —
    // просто каталог, который надо завести, если человек ещё ничего не считал.
    if (mode === 'memory') await ensureRepo(root);
    else fs.mkdirSync(root, { recursive: true });
    json(res, 200, { user: userId, scope, mode, root, files: listFiles(root, '', allowed) });
    return true;
  }

  if (req.method === 'GET' && route === 'file') {
    const relative = url.searchParams.get('path') ?? '';
    // raw=1 — за картинкой: график отдаём байтами, а не строкой в JSON.
    if (url.searchParams.get('raw') === '1' && isImageFile(relative)) {
      const image = readImageFile(root, relative, allowed);
      if (!image) {
        json(res, 404, errorBody('картинка не найдена или недоступна'));
        return true;
      }
      res.writeHead(200, { 'content-type': image.type, 'cache-control': 'private, max-age=300' });
      fs.createReadStream(image.file).pipe(res);
      return true;
    }
    const content = readMemoryFile(root, relative, allowed);
    if (content === null) {
      json(res, 404, errorBody('файл не найден или недоступен'));
      return true;
    }
    json(res, 200, { path: relative, content });
    return true;
  }

  if (mode === 'memory' && req.method === 'GET' && route === 'history') {
    json(res, 200, { commits: await log(root) });
    return true;
  }

  if (mode === 'memory' && req.method === 'GET' && route === 'show') {
    json(res, 200, await show(root, url.searchParams.get('commit') ?? ''));
    return true;
  }

  if (req.method === 'GET' && route === 'search') {
    const query = url.searchParams.get('q') ?? '';
    json(res, 200, { query, hits: searchMemory(root, query, 50, allowed) });
    return true;
  }

  if (mode === 'memory' && req.method === 'POST' && route === 'revert') {
    const result = await revert(root, String(body.commit ?? ''));
    logger.info('панель: откат коммита', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (mode === 'memory' && req.method === 'POST' && route === 'forget') {
    const result = removeLine(root, String(body.path ?? ''), String(body.line ?? ''), allowed);
    if (result.ok) {
      await commitAll(root, `memory: забыть «${String(body.line ?? '').slice(0, 60)}»`);
    }
    logger.info('панель: забывание', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return true;
  }

  // Удаление файла целиком — тоже коммит: пропажу видно в истории, и её можно
  // вернуть обратным коммитом, как и любую другую правку памяти.
  if (mode === 'memory' && req.method === 'POST' && route === 'delete') {
    const relative = String(body.path ?? '');
    const result = removeFile(root, relative, allowed);
    if (result.ok) {
      await commitAll(root, `memory: удалить файл «${relative.slice(0, 80)}»`);
    }
    logger.info('панель: удаление файла', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (mode === 'maple' && req.method === 'POST' && (route === 'revert' || route === 'forget' || route === 'delete')) {
    json(res, 400, errorBody('математика только для чтения: журналы и графики создаёт Maple', 'invalid_request_error'));
    return true;
  }

  json(res, 404, errorBody(`неизвестный маршрут панели: ${route}`));
  return true;
}
