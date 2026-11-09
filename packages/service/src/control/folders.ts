// API папок в левом меню: список, создание, переименование, свёрнутость, удаление.
//
// Папка — не рабочая директория и не конфиг: только полка для разговоров. Поэтому
// здесь нет ни настроек, ни промптов, ни файлов на диске — один маленький реестр.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findUser, type IcarusConfig, type UserConfig } from '../config.ts';
import { errorBody } from '../http/sse.ts';
import { readJsonBody } from '../http/openai.ts';
import { FolderError, createFolder, deleteFolder, readFolders, renameFolder, setFolderCollapsed } from '../sessions/folders.ts';

const BASE = '/panel/api/folders';

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Битое тело пусть долетит до общего catch: там оно станет 400 с текстом,
  // а не молчаливым «менять нечего».
  return (await readJsonBody(req)) as Record<string, unknown>;
}

export async function handleFoldersApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: IcarusConfig; userId: string },
): Promise<void> {
  const user: UserConfig | undefined = findUser(ctx.config, ctx.userId);
  if (!user) {
    json(res, 404, errorBody(`пользователь ${ctx.userId} не заведён`));
    return;
  }

  const rest = url.pathname.slice(BASE.length).replace(/^\/+/, '');
  try {
    if (!rest) {
      if (req.method === 'GET') {
        json(res, 200, { folders: readFolders(ctx.config, user) });
        return;
      }
      if (req.method === 'POST') {
        const body = await bodyOf(req);
        const folder = createFolder(ctx.config, user, body.name);
        json(res, 201, { folder });
        return;
      }
      json(res, 405, errorBody('метод не поддерживается'));
      return;
    }

    const id = decodeURIComponent(rest);
    if (req.method === 'PATCH') {
      const body = await bodyOf(req);
      const changesName = body.name !== undefined;
      const changesCollapsed = typeof body.collapsed === 'boolean';
      if (!changesName && !changesCollapsed) {
        json(res, 400, errorBody('менять нечего: нужно name или collapsed'));
        return;
      }
      if (changesName) renameFolder(ctx.config, user, id, body.name);
      // Переименование и сворачивание могут прийти одним запросом: клиент шлёт
      // то, что изменилось, и не хочет двух round-trip'ов на одно действие.
      const folder = changesCollapsed
        ? setFolderCollapsed(ctx.config, user, id, body.collapsed as boolean)
        : readFolders(ctx.config, user).find((item) => item.id === id);
      json(res, 200, { folder });
      return;
    }

    if (req.method === 'DELETE') {
      const deleted = deleteFolder(ctx.config, user, id);
      json(res, 200, { ok: true, id: deleted.folder.id, movedChats: deleted.movedChats });
      return;
    }

    json(res, 405, errorBody('метод не поддерживается'));
  } catch (error) {
    if (error instanceof FolderError) {
      json(res, error.status, errorBody(error.message));
      return;
    }
    json(res, 400, errorBody(error instanceof Error ? error.message : String(error)));
  }
}
