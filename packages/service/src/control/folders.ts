// Folder API in the left menu: list, create, rename, collapsed state, delete.
//
// A folder is not a working directory and not config: just a shelf for conversations. That's why
// there are no settings, prompts, or files on disk here — one small registry.
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
  // Let a broken body reach the shared catch: there it becomes a 400 with text,
  // instead of a silent "nothing to change".
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
      // Rename and collapse can come in one request: the client sends
      // what changed and doesn't want two round-trips for one action.
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
