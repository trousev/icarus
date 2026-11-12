// Раздел «Задачи» в панели: страница и API расписаний.
//
// Тест идёт через живой HTTP-сервер: важно проверить весь путь — форма в панели,
// файл задачи в dataDir человека и то, что из списка видно прошлый запуск. Сам
// запуск агента проверяется отдельно (task-launch.test.ts, scheduled-tasks.test.ts):
// здесь докера нет, и поднимать его ради формы незачем.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import { createChatRecord, readChats, setChatArchived } from '../src/sessions/chats.ts';
import { readTasks, writeTasks, type ScheduledTask } from '../src/sessions/scheduled.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

const PROMPT = 'Собери сводку по проекту X и приложи список рисков';

function asUser(userId = 'probe'): Record<string, string> {
  return { [PANEL_USER_HEADER]: userId };
}

async function withServer(handler: (base: string, config: IcarusConfig) => Promise<void>): Promise<void> {
  const config = makeConfig({
    users: [probe('probe'), probe('probe2')],
    env: { TZ: 'Europe/Dublin' },
  });
  const server = createServer(config, {} as never, { draftSkills: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, config);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, body: unknown, userId = 'probe'): Promise<Response> {
  return fetch(`${base}/panel/tasks/api/${path}`, {
    method: 'POST',
    headers: { ...asUser(userId), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(base: string, userId = 'probe'): Promise<Response> {
  return fetch(`${base}/panel/tasks/api`, { headers: asUser(userId) });
}

type TaskBody = {
  timeZone: string;
  now: string;
  workspaces: Array<{ slug: string; name: string }>;
  tasks: Array<
    ScheduledTask & { due: boolean; lastChat: { id: string; title: string } | null }
  >;
};

function taskBody(response: Response): Promise<TaskBody> {
  return response.json() as Promise<TaskBody>;
}

test('раздел «Задачи» есть в сайдбаре и открывается', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/tasks`, { headers: asUser() });
    assert.equal(page.status, 200);
    const html = await page.text();

    assert.match(html, /<b>Задачи<\/b>/, 'страница называет себя');
    assert.match(html, /id="task-prompt"/, 'поле промпта на месте');
    assert.match(html, /id="task-workspace"/, 'папку запуска выбирают в форме');
    assert.match(html, /window\.__TASKS_CFG__/, 'клиент знает свой раздел');
    assert.match(html, /Europe\/Dublin/, 'человек видит, в каком поясе считается расписание');
    assert.match(html, /id="task-list"/);
    // Текста напоминания больше нет: задача — это расписание и промпт.
    assert.equal(/task-text/.test(html), false);
  });
});

test('страница задач видна в сайдбаре рядом с остальными разделами', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/panel/tasks`, { headers: asUser() })).text();
    assert.match(html, /href="\/panel\/tasks"[^>]*>Задачи/);
    // И раздел не спрятан от обычного человека: задачи — его собственные.
    assert.match(html, /href="\/panel\/memory"/);
  });
});

test('GET отдаёт задачи, пояс и рабочие папки', async () => {
  await withServer(async (base, config) => {
    const created = await post(base, 'create', {
      prompt: PROMPT,
      repeat: { kind: 'daily', time: '08:00' },
    });
    assert.equal(created.status, 200);

    const body = await taskBody(await get(base));
    assert.equal(body.timeZone, 'Europe/Dublin');
    assert.equal(body.tasks.length, 1);
    const task = body.tasks[0];
    assert.equal(task.prompt, PROMPT);
    assert.deepEqual(task.repeat, { kind: 'daily', time: '08:00' });
    assert.ok(String(task.nextRunAt) > String(body.now), 'следующий запуск в будущем');
    assert.equal(task.enabled, true);
    assert.equal(task.lastChat, null, 'запусков ещё не было');
    assert.deepEqual(body.workspaces.map((item) => item.slug), ['talk'], 'папка по умолчанию на месте');
    assert.ok(userPaths(config, probe('probe')).scheduledTasks.startsWith(config.dataDir));
  });
});

test('задача без промпта не создаётся', async () => {
  await withServer(async (base, config) => {
    const response = await post(base, 'create', {
      prompt: '   ',
      repeat: { kind: 'daily', time: '08:00' },
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: { message: string } }).error.message, /промпт/);
    assert.equal(readTasks(config, probe('probe')).length, 0);
  });
});

test('прошедшее время у одноразовой задачи не принимается', async () => {
  await withServer(async (base, config) => {
    const response = await post(base, 'create', {
      prompt: PROMPT,
      repeat: { kind: 'once', date: '2020-01-01', time: '09:00' },
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: { message: string } }).error.message, /уже прошло/);
    assert.equal(readTasks(config, probe('probe')).length, 0);
  });
});

test('запуск в неизвестной или приватной папке не принимается', async () => {
  await withServer(async (base, config) => {
    const missing = await post(base, 'create', {
      prompt: PROMPT,
      repeat: { kind: 'daily', time: '08:00' },
      workspace: 'нет-такой-папки',
    });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: { message: string } }).error.message, /workspace/);

    const priv = await post(base, 'create', {
      prompt: PROMPT,
      repeat: { kind: 'daily', time: '08:00' },
      workspace: 'private',
    });
    assert.equal(priv.status, 400);
    assert.match(((await priv.json()) as { error: { message: string } }).error.message, /приватн/);
    assert.equal(readTasks(config, probe('probe')).length, 0);
  });
});

test('в списке видно прошлый запуск и его разговор', async () => {
  await withServer(async (base, config) => {
    const user = probe('probe');
    const chat = createChatRecord(config, user, 'talk', new Date(), { title: 'Сводка по X' });
    const task: ScheduledTask = {
      id: 'ran',
      prompt: PROMPT,
      repeat: { kind: 'daily', time: '08:00' },
      enabled: true,
      createdAt: '2026-11-08T07:00:00.000Z',
      nextRunAt: '2030-01-16T08:00:00.000Z',
      lastRunAt: '2030-01-15T08:00:00.000Z',
      lastChatId: chat.id,
    };
    writeTasks(config, user, [task]);

    const body = await taskBody(await get(base));
    assert.deepEqual(body.tasks[0].lastChat, { id: chat.id, title: 'Сводка по X' });
    assert.equal(body.tasks[0].lastRunAt, '2030-01-15T08:00:00.000Z');
  });
});

test('выключение и удаление через API', async () => {
  await withServer(async (base, config) => {
    await post(base, 'create', { prompt: PROMPT, repeat: { kind: 'daily', time: '09:00' } });
    const id = readTasks(config, probe('probe'))[0].id;

    const off = await post(base, 'toggle', { id, enabled: false });
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as { task: { enabled: boolean } }).task.enabled, false);
    assert.equal(readTasks(config, probe('probe'))[0].enabled, false);

    const removed = await post(base, 'delete', { id });
    assert.equal(removed.status, 200);
    assert.equal(readTasks(config, probe('probe')).length, 0);
    assert.equal((await post(base, 'delete', { id })).status, 404, 'второй раз — уже нет');
  });
});

test('задача другого человека не видна, не выключается и не удаляется', async () => {
  await withServer(async (base, config) => {
    await post(base, 'create', { prompt: PROMPT, repeat: { kind: 'daily', time: '08:00' } });
    const taskId = readTasks(config, probe('probe'))[0].id;

    const foreign = await taskBody(await get(base, 'probe2'));
    assert.deepEqual(foreign.tasks, [], 'чужих задач не видно');
    assert.equal((await post(base, 'delete', { id: taskId }, 'probe2')).status, 404);
    assert.equal((await post(base, 'toggle', { id: taskId, enabled: false }, 'probe2')).status, 404);
    assert.equal(readTasks(config, probe('probe')).length, 1);
  });
});

test('без SSO раздел задач не отдаётся', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/tasks`);
    assert.equal(page.status, 401);
    const api = await fetch(`${base}/panel/tasks/api`);
    assert.equal(api.status, 401);
  });
});

test('архивный разговор прошлого запуска остаётся ссылкой, но не мешает списку', async () => {
  await withServer(async (base, config) => {
    const user = probe('probe');
    const chat = createChatRecord(config, user, 'talk', new Date(), { title: 'Старая сводка' });
    setChatArchived(config, user, chat.id, true, new Date());
    // Архив не должен превращать задачу в «неизвестную»: подпись берётся из реестра.
    assert.equal(readChats(config, user).length, 1);
    writeTasks(config, user, [
      {
        id: 'ran',
        prompt: PROMPT,
        repeat: { kind: 'daily', time: '08:00' },
        enabled: true,
        createdAt: '2026-11-08T07:00:00.000Z',
        nextRunAt: '2030-01-16T08:00:00.000Z',
        lastChatId: chat.id,
      },
    ]);
    const body = await taskBody(await get(base));
    assert.equal(body.tasks[0].lastChat?.title, 'Старая сводка');
  });
});
