// The "Tasks" section in the panel: the page and the schedules API.
//
// The test goes through a live HTTP server: it is important to check the whole path — the form in the panel,
// the task file in the person's dataDir and the fact that the last run is visible from the list. The agent
// launch itself is checked separately (task-launch.test.ts, scheduled-tasks.test.ts):
// there is no docker here, and there is no point starting it for the form.
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

test('the "Tasks" section is in the sidebar and opens', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/tasks`, { headers: asUser() });
    assert.equal(page.status, 200);
    const html = await page.text();

    assert.match(html, /<b>Задачи<\/b>/, 'страница называет себя');
    assert.match(html, /id="task-name"/, 'у задачи есть своё название');
    assert.match(html, /id="task-prompt"/, 'поле промпта на месте');
    assert.match(html, /id="task-workspace"/, 'папку запуска выбирают в форме');
    assert.match(html, /window\.__TASKS_CFG__/, 'клиент знает свой раздел');
    assert.match(html, /Europe\/Dublin/, 'человек видит, в каком поясе считается расписание');
    assert.match(html, /id="task-list"/);
    // The reminder text is gone: a task is a schedule and a prompt.
    assert.equal(/task-text/.test(html), false);
  });
});

test('the tasks page is visible in the sidebar next to the other sections', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/panel/tasks`, { headers: asUser() })).text();
    assert.match(html, /href="\/panel\/tasks"[^>]*>Задачи/);
    // And the section is not hidden from an ordinary person: the tasks are their own.
    assert.match(html, /href="\/panel\/memory"/);
  });
});

test('GET returns tasks, the time zone and workspaces', async () => {
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

test('a task name is saved and visible in the list', async () => {
  await withServer(async (base) => {
    const created = await post(base, 'create', {
      name: 'Сводка по проекту',
      prompt: PROMPT,
      repeat: { kind: 'daily', time: '08:00' },
    });
    assert.equal(created.status, 200);
    const body = await taskBody(await get(base));
    assert.equal(body.tasks[0].name, 'Сводка по проекту');
  });
});

test('a task without a prompt is not created', async () => {
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

test('a past time for a one-off task is not accepted', async () => {
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

test('a run in an unknown or private folder is not accepted', async () => {
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

test('the list shows the last run and its chat', async () => {
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

test('disable and delete via the API', async () => {
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

test("another person's task is not visible, cannot be disabled or deleted", async () => {
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

test('without SSO the tasks section is not served', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/tasks`);
    assert.equal(page.status, 401);
    const api = await fetch(`${base}/panel/tasks/api`);
    assert.equal(api.status, 401);
  });
});

test('an archived chat of the last run stays a link but does not interfere with the list', async () => {
  await withServer(async (base, config) => {
    const user = probe('probe');
    const chat = createChatRecord(config, user, 'talk', new Date(), { title: 'Старая сводка' });
    setChatArchived(config, user, chat.id, true, new Date());
    // Archiving must not turn the task into "unknown": the caption comes from the registry.
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
