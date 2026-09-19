// HTTP-часть панели памяти: тонкий JSON-слой над файлами и git.
//
// Доступа по общему ключу здесь нет намеренно: один ключ на всех открывал память
// всех. Вместо него — личная ссылка от Икара: пропуск подписан секретом сервиса,
// живёт ограниченное время и называет ровно одного человека. Чей это пропуск,
// решает только он: параметр user из запроса игнорируется, поэтому чужую память
// через свою ссылку не открыть.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findUser, userPaths, type IcarusConfig } from '../config.ts';
import { readJsonBody, headerValue } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { verifyPanelCredential } from '../../../extensions/lib/panel-link.ts';
import { listFiles, readMemoryFile, removeLine, searchMemory } from './memory.ts';
import { commitAll, ensureRepo, log, revert, show } from './git.ts';
import { panelHtml } from './ui.ts';
import { log as logger } from '../log.ts';

export type PanelContext = { config: IcarusConfig; panelSecret: string };

type Scope = 'personal' | 'shared';

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

function resolveRoot(config: IcarusConfig, userId: string, scope: Scope): string | null {
  const user = findUser(config, userId);
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
    const userId = authorize(req, url, ctx);
    res.writeHead(userId ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
    res.end(panelHtml(userId ? { user: userId } : null));
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
    json(res, 200, { user: userId, scopes: ['personal', 'shared'] });
    return true;
  }

  // У GET область приходит в query, у POST — в теле. Человека в запросе нет:
  // он уже назван пропуском, и подменить его нельзя.
  const body = req.method === 'POST' ? ((await readJsonBody(req)) as Record<string, unknown>) : {};
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
