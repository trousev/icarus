// API workspace'ов панели: список, создание, удаление.
//
// Workspace — это папка, а не контейнер: создание и удаление здесь — операции над
// каталогами и реестром. Docker о них не знает и пересоздавать ничего не должен.
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_WORKSPACE,
  PRIVATE_WORKSPACE,
  findUser,
  userPaths,
  type IcarusConfig,
  type UserConfig,
} from '../config.ts';
import { errorBody } from '../http/sse.ts';
import { readJsonBody } from '../http/openai.ts';
import { readChats, reassignChats } from '../sessions/chats.ts';
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  WorkspaceError,
  type Workspace,
} from '../workspaces.ts';

const BASE = '/panel/api/workspaces';

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Путь для интерфейса: домашний каталог сокращаем до `~`, как в макете. */
function displayPath(absolute: string): string {
  const home = os.homedir();
  return absolute.startsWith(`${home}/`) ? `~${absolute.slice(home.length)}` : absolute;
}

export type WorkspaceView = Workspace & {
  /** Папка на диске: показываем человеку, где искать файлы. */
  path: string;
  /** Сколько диалогов живёт в этом workspace'е. */
  chats: number;
};

function decorate(config: IcarusConfig, user: UserConfig, workspaces: Workspace[]): WorkspaceView[] {
  const chats = readChats(config, user);
  const paths = userPaths(config, user);
  return workspaces.map((workspace) => ({
    ...workspace,
    path: displayPath(path.join(paths.workspaces, workspace.slug)),
    chats: chats.filter((chat) => chat.workspace === workspace.slug).length,
  }));
}

export async function handleWorkspacesApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: IcarusConfig; userId: string },
): Promise<void> {
  const user = findUser(ctx.config, ctx.userId);
  if (!user) {
    json(res, 404, errorBody(`пользователь ${ctx.userId} не заведён`));
    return;
  }

  const rest = url.pathname.slice(BASE.length).replace(/^\/+/, '');
  try {
    if (!rest) {
      if (req.method === 'GET') {
        json(res, 200, {
          workspaces: decorate(ctx.config, user, listWorkspaces(ctx.config, user)),
          default: DEFAULT_WORKSPACE,
          private: PRIVATE_WORKSPACE,
        });
        return;
      }
      if (req.method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const workspace = createWorkspace(ctx.config, user, body.name);
        json(res, 201, { workspace: decorate(ctx.config, user, [workspace])[0] });
        return;
      }
      json(res, 405, errorBody('метод не поддерживается'));
      return;
    }

    const slug = decodeURIComponent(rest);
    if (req.method === 'DELETE') {
      const workspace = deleteWorkspace(ctx.config, user, slug);
      // Диалоги возвращаются в «Разговор», папка на диске остаётся: это данные человека.
      const moved = reassignChats(ctx.config, user, workspace.slug, DEFAULT_WORKSPACE);
      json(res, 200, { ok: true, slug: workspace.slug, movedChats: moved });
      return;
    }
    json(res, 405, errorBody('метод не поддерживается'));
  } catch (error) {
    if (error instanceof WorkspaceError) {
      json(res, error.status, errorBody(error.message));
      return;
    }
    json(res, 400, errorBody(error instanceof Error ? error.message : String(error)));
  }
}
