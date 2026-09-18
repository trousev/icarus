// HTTP-часть панели памяти: тонкий JSON-слой над файлами и git.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { readJsonBody, headerValue } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { listFiles, readMemoryFile, removeLine, searchMemory } from './memory.ts';
import { commitAll, ensureRepo, log, revert, show } from './git.ts';
import { panelHtml } from './ui.ts';
import { log as logger } from '../log.ts';

export type PanelContext = { config: IcarusConfig };

type Scope = 'personal' | 'shared';

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function authorized(req: IncomingMessage, url: URL, config: IcarusConfig): boolean {
  const key = config.panelKey;
  if (!key) return false;
  const header = headerValue(req, 'authorization');
  if (header === `Bearer ${key}`) return true;
  return url.searchParams.get('key') === key;
}

function resolveRoot(config: IcarusConfig, userId: string, scope: Scope): string | null {
  const user: UserConfig | undefined = findUser(config, userId);
  if (!user) return null;
  const paths = userPaths(config, user);
  return scope === 'shared' ? paths.sharedMemory : paths.memory;
}

export async function handlePanel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PanelContext,
): Promise<boolean> {
  const { config } = ctx;

  if (url.pathname === '/panel' || url.pathname === '/panel/') {
    if (!authorized(req, url, config)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(panelHtml(false));
      return true;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(panelHtml(true));
    return true;
  }

  if (!url.pathname.startsWith('/panel/api/')) return false;

  if (!authorized(req, url, config)) {
    json(res, 401, errorBody('нужен ключ панели', 'authentication_error'));
    return true;
  }

  const route = url.pathname.slice('/panel/api/'.length);

  if (req.method === 'GET' && route === 'state') {
    await Promise.all(config.users.map((user) => ensureRepo(userPaths(config, user).memory)));
    await ensureRepo(userPaths(config, config.users[0]).sharedMemory);
    json(res, 200, {
      users: config.users.map((user) => user.id),
      scopes: ['personal', 'shared'],
    });
    return true;
  }

  // У GET пользователь приходит в query, у POST — в теле.
  const body = req.method === 'POST' ? ((await readJsonBody(req)) as Record<string, unknown>) : {};
  const userId = url.searchParams.get('user') ?? String(body.user ?? '');
  const scope: Scope = (url.searchParams.get('scope') ?? String(body.scope ?? '')) === 'shared' ? 'shared' : 'personal';
  const root = resolveRoot(config, userId, scope);
  if (!root) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return true;
  }

  if (req.method === 'GET' && route === 'files') {
    await ensureRepo(root);
    json(res, 200, { user: userId, scope, root, files: listFiles(root) });
    return true;
  }

  if (req.method === 'GET' && route === 'file') {
    const relative = url.searchParams.get('path') ?? '';
    const content = readMemoryFile(root, relative);
    if (content === null) {
      json(res, 404, errorBody('файл не найден или недоступен'));
      return true;
    }
    json(res, 200, { path: relative, content });
    return true;
  }

  if (req.method === 'GET' && route === 'history') {
    json(res, 200, { commits: await log(root) });
    return true;
  }

  if (req.method === 'GET' && route === 'show') {
    json(res, 200, await show(root, url.searchParams.get('commit') ?? ''));
    return true;
  }

  if (req.method === 'GET' && route === 'search') {
    const query = url.searchParams.get('q') ?? '';
    json(res, 200, { query, hits: searchMemory(root, query) });
    return true;
  }

  if (req.method === 'POST' && route === 'revert') {
    const result = await revert(root, String(body.commit ?? ''));
    logger.info('панель: откат коммита', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (req.method === 'POST' && route === 'forget') {
    const result = removeLine(root, String(body.path ?? ''), String(body.line ?? ''));
    if (result.ok) {
      await commitAll(root, `memory: забыть «${String(body.line ?? '').slice(0, 60)}»`);
    }
    logger.info('панель: забывание', { user: userId, scope, ok: result.ok });
    json(res, result.ok ? 200 : 400, result);
    return true;
  }

  json(res, 404, errorBody(`неизвестный маршрут панели: ${route}`));
  return true;
}
