// Раздел панели «Задачи»: расписания, по которым агент запускается сам.
//
// Человека называет SSO-прокси (см. identity.ts), поэтому id человека в запросах нет:
// чужие задачи через свою сессию не увидеть и не удалить. Промпт задачи уезжает в
// новый разговор, поэтому «куда доставлять» тут нечего — проверяем только workspace:
// папка должна быть у человека и быть доступной на запись.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findUser, type IcarusConfig } from '../config.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { log } from '../log.ts';
import { findChatRecord } from '../sessions/chats.ts';
import {
  createTask,
  deleteTask,
  parseTaskInput,
  readTasks,
  setTaskEnabled,
  taskView,
  type ScheduledTask,
  type TaskView,
} from '../sessions/scheduled.ts';
import { taskTimeZone } from '../sessions/schedule.ts';
import { findSelectableWorkspace, selectableWorkspaces } from '../workspaces.ts';

export type TasksApiContext = { config: IcarusConfig; userId: string };

export type TasksApi = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: TasksApiContext) => Promise<boolean>;

/** Задача в списке: рядом с id прошлого разговора — его имя, чтобы была ссылка. */
type TaskWithChat = TaskView & { lastChat: { id: string; title: string } | null };

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function fail(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  json(res, 400, errorBody(message, 'invalid_request_error'));
}

/** Разговор прошлого запуска: по нему в списке есть ссылка «открыть». */
function lastChatOf(config: IcarusConfig, userId: string, task: ScheduledTask): TaskWithChat['lastChat'] {
  if (!task.lastChatId) return null;
  const user = findUser(config, userId);
  if (!user) return null;
  const chat = findChatRecord(config, user, task.lastChatId);
  // Разговор могли удалить вместе с файлом: задача остаётся, ссылки нет.
  return chat ? { id: chat.conversationId ?? chat.id, title: chat.title } : null;
}

/**
 * Workspace задачи: имя из формы может быть и slug'ом, и подписью папки. Приватный
 * не годится — агент там только читает, и запуск был бы пустой тратой.
 */
function workspaceOf(config: IcarusConfig, userId: string, value: unknown): string | undefined {
  const wanted = typeof value === 'string' ? value.trim() : '';
  if (!wanted) return undefined;
  const user = findUser(config, userId);
  if (!user) throw new Error(`пользователь ${userId} не заведён`);
  const found = findSelectableWorkspace(config, user, wanted);
  if (found === 'private') throw new Error('в приватном workspace агент только читает — выбери другую папку');
  if (!found) throw new Error(`нет такого workspace: ${wanted}`);
  return found.slug;
}

export const handleTasksApi: TasksApi = async (req, res, url, ctx) => {
  const { config, userId } = ctx;
  if (url.pathname !== '/panel/tasks/api' && !url.pathname.startsWith('/panel/tasks/api/')) return false;

  const user = findUser(config, userId);
  if (!user) {
    json(res, 404, errorBody(`пользователь ${userId} не заведён`));
    return true;
  }
  const timeZone = taskTimeZone(config);
  const now = new Date();

  if (req.method === 'GET' && (url.pathname === '/panel/tasks/api' || url.pathname === '/panel/tasks/api/')) {
    json(res, 200, {
      user: userId,
      timeZone,
      // Часы сервера: по ним клиент подписывает «сегодня» и «завтра», а не по часам
      // браузера, которые могут врать.
      now: now.toISOString(),
      tasks: readTasks(config, user)
        .map((task) => ({ ...taskView(task, now), lastChat: lastChatOf(config, userId, task) }))
        // Ближайшие — сверху: это то, что человек проверяет чаще всего.
        .sort((left, right) => (left.nextRunAt ?? '9999').localeCompare(right.nextRunAt ?? '9999')),
      workspaces: selectableWorkspaces(config, user).map(({ slug, name }) => ({ slug, name })),
    });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (error) {
    json(res, 400, errorBody(`не разобрал тело запроса: ${String(error)}`, 'invalid_request_error'));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/panel/tasks/api/create') {
    try {
      const input = parseTaskInput(body, timeZone, now);
      const workspace = workspaceOf(config, userId, body.workspace);
      const task = createTask(config, user, { ...input, ...(workspace ? { workspace } : {}) }, now);
      log.info('панель: задача создана', { user: userId, task: task.id });
      json(res, 200, { task: { ...taskView(task, now), lastChat: null } });
    } catch (error) {
      fail(res, error);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/panel/tasks/api/toggle') {
    const id = String(body.id ?? '');
    if (body.enabled !== true && body.enabled !== false) {
      json(res, 400, errorBody('нужно enabled: true или false', 'invalid_request_error'));
      return true;
    }
    const task = setTaskEnabled(config, user, id, body.enabled, now);
    if (!task) {
      json(res, 404, errorBody('задача не найдена'));
      return true;
    }
    log.info('панель: задача переключена', { user: userId, task: id, enabled: body.enabled });
    json(res, 200, { task: { ...taskView(task, now), lastChat: lastChatOf(config, userId, task) } });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/panel/tasks/api/delete') {
    const id = String(body.id ?? '');
    const removed = deleteTask(config, user, id);
    log.info('панель: задача удалена', { user: userId, task: id, removed });
    json(res, removed ? 200 : 404, removed ? { ok: true } : errorBody('задача не найдена'));
    return true;
  }

  json(res, 404, errorBody(`неизвестный маршрут раздела задач: ${url.pathname}`));
  return true;
};
