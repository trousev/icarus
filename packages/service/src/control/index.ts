// Панель управления Icarus: HTTP-часть — тонкий JSON-слой над файлами и git.
//
// Человека называет SSO-прокси (см. identity.ts), поэтому параметра user в запросах нет
// и подменить его нельзя: чужую память через свою сессию не открыть. Разделов у панели
// пока один — память, но устроена она как раздел: добавить следующий — это дописать
// его в SECTIONS и завести ему маршруты /panel/api/<раздел>/… рядом с памятью.
//
// Внутри памяти три части: личная, семейная и математика. Математика — не память в том
// же смысле: её файлы создаёт Maple, и панель показывает их только для чтения (ни
// «забыть», ни откатов): журнал сессии — это код, из которого сессия восстанавливается,
// и построчная правка его сломает.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { findUser, userPaths, type IcarusConfig } from '../config.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
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
import { identifyPanelUser } from './identity.ts';
import { panelHtml, type PanelSection } from './ui.ts';
import { log as logger } from '../log.ts';

export type PanelContext = { config: IcarusConfig };

/** Разделы панели: порядок здесь — порядок вкладок в шапке. */
export const SECTIONS: PanelSection[] = [{ id: 'memory', label: 'Память' }];

type Scope = 'personal' | 'shared' | 'maple';
/** Режим раздела: memory правится построчно, maple — только смотрится. */
export type ScopeMode = 'memory' | 'maple';

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
  const access = identifyPanelUser(req, config);

  if (url.pathname === '/panel' || url.pathname === '/panel/') {
    res.writeHead(access.ok ? 200 : access.denial.status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      panelHtml(
        access.ok
          ? { user: access.identity.userId, sections: SECTIONS, scopes: scopesFor(config) }
          : access.denial,
      ),
    );
    return true;
  }

  if (!url.pathname.startsWith('/panel/api/')) return false;

  if (!access.ok) {
    json(
      res,
      access.denial.status,
      errorBody(
        `${access.denial.message}. ${access.denial.hint}`,
        access.denial.status === 401 ? 'authentication_error' : 'permission_error',
      ),
    );
    return true;
  }

  const userId = access.identity.userId;
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
    json(res, 200, { user: userId, sections: SECTIONS, scopes: Object.keys(scopes), modes: scopes });
    return true;
  }

  // У GET область приходит в query, у POST — в теле. Человека в запросе нет:
  // его уже назвал прокси, и подменить его нельзя.
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
