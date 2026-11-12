// Планировщик задач: что происходит, когда время пришло.
//
// Тесты не ждут реального времени: часы подменяются, а `tick()` зовётся руками.
// Проверяем именно то, что человек заметит: по расписанию запускается агент в новом
// разговоре, выключенная задача молчит, занятость не съедает запуск, а пропущенный
// запуск догоняется один раз, а не пачкой.
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

/** Заглушка запуска: помнит, кого и с каким промптом просили запустить. */
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

test('задача создаётся со следующим запуском в поясе человека', () => {
  const { config, user } = setup();
  const now = new Date('2026-11-08T07:00:00Z'); // 7:00 по Дублину
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

test('чужой человек не видит и не удаляет задачу', () => {
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

test('по расписанию запускается агент: промпт уходит в запуск, а не в чат-получатель', async () => {
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

test('пропущенные запуски догоняются один раз, а не пачкой', async () => {
  const { config, user, launcher, launches } = setup();
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери утреннюю сводку', repeat: { kind: 'daily', time: '08:00' } }, created);

  // Сервис лежал четыре дня: догоняющих запусков должно быть одно.
  const late = new Date(created.getTime() + 4 * DAY + 5 * 3_600_000);
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const outcome = await scheduler.tick();

  assert.deepEqual(outcome, { fired: 1, started: 1, failed: 0, skipped: 0 });
  assert.equal(launches.length, 1, 'один запуск, а не четыре');
  const [task] = readTasks(config, user);
  // Следующий запуск считается от «сейчас»: завтра в 8:00, а не от пропущенного дня.
  assert.equal(task.nextRunAt, '2026-11-13T08:00:00.000Z');
});

test('выключенная задача не запускается, даже если время прошло', async () => {
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

test('занято: запуск не теряется, а ждёт, пока человек освободится', async () => {
  const { config, user, launcher, launches, setBusy } = setup({ busy: true });
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери сводку', repeat: { kind: 'daily', time: '08:00' } }, created);

  const late = new Date(created.getTime() + 3_600_000);
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late });
  const first = await scheduler.tick();
  assert.deepEqual(first, { fired: 0, started: 0, failed: 0, skipped: 0 });
  assert.equal(launches.length, 0, 'пока человек занят — не запускаем');
  assert.equal(readTasks(config, user)[0].nextRunAt, '2026-11-08T08:00:00.000Z', 'запуск остался в очереди');

  // Человек освободился: следующий тик обязан догнать пропущенное время.
  setBusy(false);
  const second = await scheduler.tick();
  assert.deepEqual(second, { fired: 1, started: 1, failed: 0, skipped: 0 });
  assert.equal(launches.length, 1);
});

test('занят слишком долго: помечаем пропущенным, а не ждём вечно', async () => {
  const { config, user, launcher, launches } = setup({ busy: true, graceMs: 60_000 });
  const created = new Date('2026-11-08T07:00:00Z');
  createTask(config, user, { prompt: 'Собери сводку', repeat: { kind: 'daily', time: '08:00' } }, created);

  // Время пришло десять минут назад, а человек всё ещё занят.
  const late = new Date('2026-11-08T08:10:00Z');
  const scheduler = new ScheduledTasks(config, { launch: launcher, now: () => late, graceMs: 60_000 });
  const outcome = await scheduler.tick();

  assert.deepEqual(outcome, { fired: 0, started: 0, failed: 0, skipped: 1 });
  assert.equal(launches.length, 0);
  const [task] = readTasks(config, user);
  assert.match(task.lastError ?? '', /пропущен/);
  assert.equal(task.nextRunAt, '2026-11-09T08:00:00.000Z', 'следующий запуск всё равно назначен');
});

test('ошибка запуска не теряется: она видна в задаче вместе с разговором', async () => {
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

test('одноразовая задача после запуска выключается сама', async () => {
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

test('задача без промпта не создаётся: запускать было бы нечего', () => {
  const { config } = setup();
  const timeZone = taskTimeZone(config);
  assert.throws(() => parseTaskInput({ prompt: '   ', repeat: { kind: 'daily', time: '08:00' } }, timeZone), /промпт/);
  assert.throws(() => parseTaskInput({ repeat: { kind: 'daily', time: '08:00' } }, timeZone), /промпт/);
  assert.throws(
    () => parseTaskInput({ prompt: 'Собери сводку', repeat: { kind: 'once', date: '2020-01-01', time: '08:00' } }, timeZone),
    /уже прошло/,
  );
});

test('панель видит, что запуск пора делать', () => {
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
