// Task scheduler: what happens when the time has come.
//
// The tests do not wait for real time: the clock is stubbed, and `tick()` is called by hand.
// We check exactly what a person will notice: on schedule an agent is launched in a new
// conversation, a disabled task stays silent, being busy does not eat the launch, and a missed
// launch is caught up once, not in a batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTask,
  deleteTask,
  parseTaskInput,
  readTasks,
  setTaskEnabled,
  ScheduledTasks,
  taskView,
  type LaunchOutcome,
  type ScheduledTask,
} from '../src/sessions/scheduled.ts';
import { taskTimeZone } from '../src/sessions/schedule.ts';
import type { UserConfig } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

const DUBLIN = 'Europe/Dublin';
const DAY = 24 * 3_600_000;

type Launch = { user: UserConfig; task: ScheduledTask };

/** Launch stub: remembers whom and with which prompt it was asked to launch. */
function makeLauncher(options: { busy?: boolean; error?: string } = {}) {
  const launches: Launch[] = [];
  let busy = options.busy === true;
  return {
    launches,
    setBusy(value: boolean) {
      busy = value;
    },
    launcher: {
      busy: () => busy,
      launch: async (user: UserConfig, task: ScheduledTask): Promise<LaunchOutcome> => {
        launches.push({ user, task });
        const chatId = `web-task-${launches.length}`;
        return options.error ? { chatId, error: options.error } : { chatId };
      },
    },
  };
}

function setup(options: { busy?: boolean; error?: string; graceMs?: number } = {}) {
  const config = makeConfig({ users: [probe('probe')], env: { TZ: DUBLIN } });
  const user = probe('probe');
  const stand = makeLauncher({ ...options });
  return { config, user, ...stand, graceMs: options.graceMs };
}

test('the task is created with the next run in the user\'s time zone', () => {
  const { config, user } = setup();
  const now = new Date('2026-11-08T07:00:00Z'); // 7:00 in Dublin
  const task = createTask(
    config,
    user,
    parseTaskInput(
      {
        prompt: 'Собери сводку по проекту X и приложи список рисков',
        repeat: { kind: 'daily', time: '08:00' },
      },
      DUBLIN,
      now,
    ),
    now,
  );

  assert.equal(task.enabled, true);
  assert.equal(task.nextRunAt, '2026-11-08T08:00:00.000Z');
  assert.equal(task.prompt, 'Собери сводку по проекту X и приложи список рисков');
  assert.equal('text' in task, false, 'текста напоминания у задачи больше нет');
  assert.deepEqual(readTasks(config, user).map((item) => item.id), [task.id]);
});

test('a stranger neither sees nor deletes the task', () => {
  const { config } = setup();
  const owner = probe('probe');
  const stranger = probe('probe2');
  const task = createTask(config, owner, {
    prompt: 'Напомни про врача',
    repeat: { kind: 'daily', time: '08:00' },
  });

  assert.deepEqual(readTasks(config, stranger), []);
  assert.equal(deleteTask(config, stranger, task.id), false);
  assert.equal(readTasks(config, owner).length, 1, 'хозяин задачу не потерял');
});

test('on schedule an agent is launched: the prompt goes into the launch, not to a chat recipient', async () => {
  const { config, user, launcher, launches } = setup();
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Проверь почту и скажи, что важного', repeat: { kind: 'daily', time: '08:00' } }, created);

  const late = new Date(created.getTime() + 3_600_000);
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const outcome = await scheduler.tick();

  assert.deepEqual(outcome, { fired: 1, started: 1, failed: 0, skipped: 0 });
  assert.equal(launches.length, 1, 'агент запущен один раз');
  assert.equal(launches[0].task.prompt, 'Проверь почту и скажи, что важного');
  assert.equal(launches[0].user.id, 'probe');

  const [task] = readTasks(config, user);
  assert.equal(task.lastChatId, 'web-task-1', 'задача помнит разговор запуска');
  assert.ok(task.lastRunAt);
  assert.equal(task.lastError, undefined);
  assert.equal(task.nextRunAt, '2026-11-09T08:00:00.000Z', 'следующий запуск — завтра в 8:00');
});

test('missed runs are caught up once, not in a batch', async () => {
  const { config, user, launcher, launches } = setup();
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери утреннюю сводку', repeat: { kind: 'daily', time: '08:00' } }, created);

  // The service was down for four days: there must be exactly one catch-up launch.
  const late = new Date(created.getTime() + 4 * DAY + 5 * 3_600_000);
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const outcome = await scheduler.tick();

  assert.deepEqual(outcome, { fired: 1, started: 1, failed: 0, skipped: 0 });
  assert.equal(launches.length, 1, 'один запуск, а не четыре');
  const [task] = readTasks(config, user);
  // The next run is computed from "now": tomorrow at 8:00, not from the missed day.
  assert.equal(task.nextRunAt, '2026-11-13T08:00:00.000Z');
});

test('a disabled task is not launched even if the time has passed', async () => {
  const { config, user, launcher, launches } = setup();
  const created = new Date('2026-11-08T07:00:00Z');
  const task = createTask(config, user, { prompt: 'Проверь почту', repeat: { kind: 'daily', time: '08:00' } }, created);
  setTaskEnabled(config, user, task.id, false, created);

  const late = new Date(created.getTime() + 3_600_000);
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const outcome = await scheduler.tick();

  assert.deepEqual(outcome, { fired: 0, started: 0, failed: 0, skipped: 0 });
  assert.equal(launches.length, 0);
  assert.equal(readTasks(config, user)[0].nextRunAt, '2026-11-08T08:00:00.000Z', 'время не сдвинулось');
});

test('busy: the launch is not lost, it waits until the person is free', async () => {
  const { config, user, launcher, launches, setBusy } = setup({ busy: true });
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери сводку', repeat: { kind: 'daily', time: '08:00' } }, created);

  const late = new Date(created.getTime() + 3_600_000);
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const first = await scheduler.tick();
  assert.deepEqual(first, { fired: 0, started: 0, failed: 0, skipped: 0 });
  assert.equal(launches.length, 0, 'пока человек занят — не запускаем');
  assert.equal(readTasks(config, user)[0].nextRunAt, '2026-11-08T08:00:00.000Z', 'запуск остался в очереди');

  // The person is free: the next tick must catch up the missed time.
  setBusy(false);
  const second = await scheduler.tick();
  assert.deepEqual(second, { fired: 1, started: 1, failed: 0, skipped: 0 });
  assert.equal(launches.length, 1);
});

test('busy for too long: we mark it missed instead of waiting forever', async () => {
  const { config, user, launcher, launches } = setup({ busy: true, graceMs: 60_000 });
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери сводку', repeat: { kind: 'daily', time: '08:00' } }, created);

  // The time came ten minutes ago, and the person is still busy.
  const late = new Date('2026-11-08T08:10:00Z');
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late, graceMs: 60_000 });
  const outcome = await scheduler.tick();

  assert.deepEqual(outcome, { fired: 0, started: 0, failed: 0, skipped: 1 });
  assert.equal(launches.length, 0);
  const [task] = readTasks(config, user);
  assert.match(task.lastError ?? '', /пропущен/);
  assert.equal(task.nextRunAt, '2026-11-09T08:00:00.000Z', 'следующий запуск всё равно назначен');
});

test('a launch error is not lost: it is visible in the task together with the conversation', async () => {
  const { config, user, launcher } = setup({ error: 'контейнер icarus-user-probe не найден' });
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери сводку', repeat: { kind: 'daily', time: '08:00' } }, created);

  const late = new Date(created.getTime() + 3_600_000);
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const outcome = await scheduler.tick();

  assert.deepEqual(outcome, { fired: 1, started: 0, failed: 1, skipped: 0 });
  const [task] = readTasks(config, user);
  assert.equal(task.lastError, 'контейнер icarus-user-probe не найден');
  assert.equal(task.lastChatId, 'web-task-1', 'разговор попытки тоже записан');
});

test('a one-time task disables itself after the launch', async () => {
  const { config, user, launcher } = setup();
  const now = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери отчёт за квартал', repeat: { kind: 'once', date: '2026-11-08', time: '07:30' } }, now);

  const late = new Date('2026-11-08T07:31:00Z');
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const first = await scheduler.tick();
  assert.deepEqual(first, { fired: 1, started: 1, failed: 0, skipped: 0 });

  const [task] = readTasks(config, user);
  assert.equal(task.nextRunAt, null);
  assert.equal(task.enabled, false, 'второй раз одноразовая не сработает');
  assert.equal((await scheduler.tick()).fired, 0);
});

test('a task without a prompt is not created: there would be nothing to launch', () => {
  const { config } = setup();
  const timeZone = taskTimeZone(config);
  assert.throws(() => parseTaskInput({ prompt: '   ', repeat: { kind: 'daily', time: '08:00' } }, timeZone), /промпт/);
  assert.throws(() => parseTaskInput({ repeat: { kind: 'daily', time: '08:00' } }, timeZone), /промпт/);
  assert.throws(
    () => parseTaskInput({ prompt: 'Собери сводку', repeat: { kind: 'once', date: '2020-01-01', time: '08:00' } }, timeZone),
    /уже прошло/,
  );
});

test('the panel sees that a run is due', () => {
  const task = {
    id: 'due',
    prompt: 'Собери сводку',
    repeat: { kind: 'daily', time: '08:00' } as const,
    enabled: true,
    createdAt: '2026-11-08T07:00:00.000Z',
    nextRunAt: '2026-11-08T08:00:00.000Z',
  };
  assert.equal(taskView(task, new Date('2026-11-08T08:00:01Z')).due, true);
  assert.equal(taskView(task, new Date('2026-11-08T07:59:59Z')).due, false);
  assert.equal(taskView({ ...task, enabled: false }, new Date('2026-11-08T09:00:00Z')).due, false);
});
