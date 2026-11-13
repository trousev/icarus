// Запланированные задачи человека: «каждый день в 8» — запустить агента с этим промптом.
//
// Задача — это расписание и промпт. По наступлении времени сервис заводит НОВЫЙ
// разговор и отправляет промпт туда: агент работает как в обычном чате, а результат
// человек читает в списке разговоров. Никаких «напоминаний» в чужой чат тут нет —
// сообщение агента всегда живёт в своём разговоре.
//
// Что здесь решено и почему:
//   - хранятся настенные правила (schedule.ts), а момент считает сервис в поясе
//     человека — иначе «в 8 утра» уезжало бы на час при переводе часов;
//   - пропущенный запуск ДОГОНЯЕМ, но один раз: после долгого простоя агент отработает
//     один раз, а не двадцать. Следующий запуск считается от текущего момента, а не
//     от пропущенного;
//   - занятость: если у человека уже идёт ход, запуск не отменяется — ждём до
//     BUSY_GRACE_MS, а потом честно пишем в задачу «пропущен»;
//   - запуск записывается в файл ДО старта агента: упавший посреди запуска сервис не
//     отработает тот же запуск ещё раз.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { nextRunAt, parseRepeat, taskTimeZone, type TaskRepeat } from './schedule.ts';

export type ScheduledTask = {
  id: string;
  /**
   * Человеческое имя задачи: по нему подписана ветка дерева «Задачи» и заголовок
   * её разговоров. Необязательное: у старых задач его нет, и тогда имя выводится
   * из первой строки промпта (см. taskName).
   */
  name?: string;
  /** Что делает агент в новом разговоре. Без промпта задачи не бывает. */
  prompt: string;
  repeat: TaskRepeat;
  /** Рабочая папка нового разговора; нет — workspace по умолчанию. */
  workspace?: string;
  enabled: boolean;
  createdAt: string;
  /** Следующий запуск; null — запусков больше не будет (одноразовая отработала). */
  nextRunAt: string | null;
  lastRunAt?: string;
  /** Разговор, который завёл прошлый запуск: из списка на него есть ссылка. */
  lastChatId?: string;
  /** Чего не вышло в прошлый запуск: честная запись вместо тишины. */
  lastError?: string;
};

/** Задача глазами панели: то же плюс «пора запускать». */
export type TaskView = ScheduledTask & {
  /** Время пришло, а запуска не было: панель подсвечивает, если тик не сработал. */
  due: boolean;
};

/** Потолок задач на человека: это расписания, а не очередь заданий. */
export const TASK_LIMIT = 100;
/** Промпт — это реплика человека: длиннее не пишут, а хранить полотно незачем. */
const PROMPT_LIMIT = 4000;
/** Имя — подпись ветки, а не абзац: длиннее в меню всё равно не прочитать. */
const NAME_LIMIT = 80;

export type TaskInput = {
  name?: string;
  prompt: string;
  repeat: TaskRepeat;
  workspace?: string;
};

/**
 * Имя задачи для человека и панели. Своё имя хранится в задаче; у старых задач
 * его нет — берём первую строку промпта и аккуратно режем, чтобы подпись ветки
 * влезала в строку меню.
 */
export function taskName(task: Pick<ScheduledTask, 'name' | 'prompt'>): string {
  const own = (task.name ?? '').replace(/\s+/g, ' ').trim();
  if (own) return own;
  const line = (task.prompt.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

function tasksFile(config: IcarusConfig, user: UserConfig): string {
  return userPaths(config, user).scheduledTasks;
}

function normalize(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id) return null;
  const repeat = parseRepeat(item.repeat);
  if (!repeat) return null;
  // Задача без промпта ничего не запускает: такой записи в файле нечего делать.
  if (typeof item.prompt !== 'string' || !item.prompt.trim()) return null;
  return {
    id: item.id,
    ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}),
    prompt: item.prompt,
    repeat,
    ...(typeof item.workspace === 'string' && item.workspace.trim() ? { workspace: item.workspace.trim() } : {}),
    enabled: item.enabled === true,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    nextRunAt: typeof item.nextRunAt === 'string' && item.nextRunAt ? item.nextRunAt : null,
    ...(typeof item.lastRunAt === 'string' && item.lastRunAt ? { lastRunAt: item.lastRunAt } : {}),
    ...(typeof item.lastChatId === 'string' && item.lastChatId ? { lastChatId: item.lastChatId } : {}),
    ...(typeof item.lastError === 'string' && item.lastError ? { lastError: item.lastError } : {}),
  };
}

export function readTasks(config: IcarusConfig, user: UserConfig): ScheduledTask[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(tasksFile(config, user), 'utf8')) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) return [];
    return parsed.tasks.map(normalize).filter((task): task is ScheduledTask => task !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('не читаются запланированные задачи', { user: user.id, error: String(error) });
    }
    return [];
  }
}

/** Пишем через временный файл: падение посреди записи не должно съесть все задачи. */
export function writeTasks(config: IcarusConfig, user: UserConfig, tasks: ScheduledTask[]): void {
  const file = tasksFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ tasks }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Проверка создания: мусор не должен заводить задачу «когда-нибудь». */
export function parseTaskInput(value: unknown, timeZone: string, now = new Date()): TaskInput {
  const raw = (value ?? {}) as Record<string, unknown>;
  const prompt = String(raw.prompt ?? '')
    .trim()
    .slice(0, PROMPT_LIMIT);
  if (!prompt) throw new Error('напиши, что должен сделать агент: задача без промпта — это не задача');
  // Имя необязательно: пустое поле — это «назови по промпту», а не ошибка.
  const name = String(raw.name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_LIMIT);
  const repeat = parseRepeat(raw.repeat);
  if (!repeat) throw new Error('расписание не разобрал: нужен день, время или правило повтора');
  // Одноразовое «запусти вчера» — это не задача, а недоразумение: следующий запуск
  // уже не наступит, и человек ждал бы тишины.
  if (nextRunAt(repeat, now, timeZone) === null) {
    throw new Error(
      repeat.kind === 'once'
        ? 'это время уже прошло — выбери будущее'
        : 'не удалось посчитать следующий запуск: проверь время и дни недели',
    );
  }
  return { ...(name ? { name } : {}), prompt, repeat };
}

export function createTask(
  config: IcarusConfig,
  user: UserConfig,
  input: TaskInput,
  now = new Date(),
): ScheduledTask {
  const tasks = readTasks(config, user);
  if (tasks.length >= TASK_LIMIT) throw new Error(`больше ${TASK_LIMIT} задач на человека не держим`);
  const timeZone = taskTimeZone(config);
  const next = nextRunAt(input.repeat, now, timeZone);
  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    ...(input.name ? { name: input.name } : {}),
    prompt: input.prompt,
    repeat: input.repeat,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    enabled: true,
    createdAt: now.toISOString(),
    nextRunAt: next ? next.toISOString() : null,
  };
  writeTasks(config, user, [...tasks, task]);
  log.info('задача создана', { user: user.id, task: task.id, repeat: task.repeat.kind, next: task.nextRunAt });
  return task;
}

/**
 * Включение и выключение. Включая, пересчитываем запуск от текущего момента: пока
 * задача лежала выключенной, её время могло пройти, и «догон» выстрелил бы агентом
 * сразу после нажатия кнопки.
 */
export function setTaskEnabled(
  config: IcarusConfig,
  user: UserConfig,
  id: string,
  enabled: boolean,
  now = new Date(),
): ScheduledTask | null {
  const tasks = readTasks(config, user);
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  task.enabled = enabled;
  if (enabled && (task.nextRunAt === null || new Date(task.nextRunAt).getTime() <= now.getTime())) {
    const next = nextRunAt(task.repeat, now, taskTimeZone(config));
    task.nextRunAt = next ? next.toISOString() : null;
    if (task.nextRunAt === null) task.enabled = false;
  }
  writeTasks(config, user, tasks);
  return task;
}

export function deleteTask(config: IcarusConfig, user: UserConfig, id: string): boolean {
  const tasks = readTasks(config, user);
  const kept = tasks.filter((task) => task.id !== id);
  if (kept.length === tasks.length) return false;
  writeTasks(config, user, kept);
  return true;
}

/** Задача для панели: считается ли, что время уже пришло. */
export function taskView(task: ScheduledTask, now = new Date()): TaskView {
  const next = task.nextRunAt ? new Date(task.nextRunAt) : null;
  return { ...task, due: Boolean(task.enabled && next && next.getTime() <= now.getTime()) };
}

/** Чем кончился запуск: id нового разговора и ошибка, если агент не поднялся. */
export type LaunchOutcome = { chatId: string; error?: string };

/**
 * Как задача запускает агента. Отдельный тип, чтобы планировщик не знал ни про
 * реестр сессий, ни про реестр разговоров: в тестах это заглушка, в бою — task-launch.ts.
 */
export type TaskLauncher = {
  /** Занят ли человек: у него уже идёт ход или сжатие. */
  busy(user: UserConfig): boolean;
  /** Заводит новый разговор и отправляет в него промпт. Возвращает chatId даже при ошибке. */
  launch(user: UserConfig, task: ScheduledTask): Promise<LaunchOutcome>;
};

export type ScheduledTasksDeps = {
  launch: TaskLauncher;
  /** Часы: в тестах подменяются, чтобы не ждать среды. */
  now?: () => Date;
  tickMs?: number;
  /** Сколько ждать, пока человек освободится, прежде чем пометить запуск пропущенным. */
  graceMs?: number;
};

/** Как часто проверяем: запуск «через минуту» не должен ждать пяти. */
const TICK_MS = 20_000;
/** Сколько ждём занятого человека: дольше — уже не «подождать», а пропустить. */
const BUSY_GRACE_MS = 10 * 60_000;

export type TickOutcome = { fired: number; started: number; failed: number; skipped: number };

const NOTHING: TickOutcome = { fired: 0, started: 0, failed: 0, skipped: 0 };

/**
 * Планировщик. Тикает по таймеру, но всю работу делает `tick()` — его же зовут
 * тесты и панель, поэтому проверять поведение можно без ожидания реального времени.
 */
export class ScheduledTasks {
  private config: IcarusConfig;
  private deps: ScheduledTasksDeps;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private now: () => Date;

  constructor(config: IcarusConfig, deps: ScheduledTasksDeps) {
    this.config = config;
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    // Таймер не должен держать процесс живым: сервис живёт сам по себе.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Один проход по всем людям. Возвращает счётчики — по ним видно, что тик не
   * просто «покрутился»: столько-то задач запустило агента, столько-то нет.
   */
  async tick(): Promise<TickOutcome> {
    // Два тика не должны запустить одну задачу дважды.
    if (this.ticking) return NOTHING;
    this.ticking = true;
    const outcome: TickOutcome = { ...NOTHING };
    const now = this.now();
    try {
      for (const user of this.config.users) {
        try {
          const result = await this.runUser(user, now);
          outcome.fired += result.fired;
          outcome.started += result.started;
          outcome.failed += result.failed;
          outcome.skipped += result.skipped;
        } catch (error) {
          log.warn('задачи: проход по человеку сорвался', { user: user.id, error: redact(String(error)) });
        }
      }
    } finally {
      this.ticking = false;
    }
    if (outcome.fired > 0) log.info('задачи: расписание сработало', outcome);
    return outcome;
  }

  private async runUser(user: UserConfig, now: Date): Promise<TickOutcome> {
    const timeZone = taskTimeZone(this.config);
    const tasks = readTasks(this.config, user);
    const result: TickOutcome = { ...NOTHING };

    for (const task of tasks) {
      if (!task.enabled || !task.nextRunAt) continue;
      const dueAt = new Date(task.nextRunAt).getTime();
      if (!Number.isFinite(dueAt) || dueAt > now.getTime()) continue;

      // Человек занят: не теряем запуск, а ждём следующего тика. Ждать бесконечно
      // нельзя — иначе «собери сводку» тихо не случится никогда; тогда пропускаем.
      if (this.deps.launch.busy(user)) {
        if (now.getTime() - dueAt < (this.deps.graceMs ?? BUSY_GRACE_MS)) continue;
        task.lastRunAt = now.toISOString();
        task.lastError = 'пропущен: агент был занят другим разговором';
        this.advance(task, now, timeZone);
        writeTasks(this.config, user, tasks);
        result.skipped += 1;
        continue;
      }

      result.fired += 1;
      task.lastRunAt = now.toISOString();
      delete task.lastError;
      // Запуск фиксируем до старта агента: если сервис упадёт посреди запуска, тот же
      // запуск не повторится на следующем тике.
      this.advance(task, now, timeZone);
      writeTasks(this.config, user, tasks);
      try {
        const outcome = await this.deps.launch.launch(user, task);
        task.lastChatId = outcome.chatId;
        if (outcome.error) {
          task.lastError = outcome.error;
          result.failed += 1;
        } else {
          result.started += 1;
        }
      } catch (error) {
        task.lastError = `не удалось запустить: ${error instanceof Error ? error.message : String(error)}`;
        result.failed += 1;
        log.warn('задача: запуск сорвался', { user: user.id, task: task.id, error: redact(String(error)) });
      }
      writeTasks(this.config, user, tasks);
    }

    return result;
  }

  /**
   * Следующий запуск — от «сейчас», а не от пропущенного: если сервис стоял сутки,
   * агент отработает один раз и следующее срабатывание будет в своё время, а не
   * пачкой догоняющих за каждый пропущенный день.
   */
  private advance(task: ScheduledTask, now: Date, timeZone: string): void {
    const next = nextRunAt(task.repeat, now, timeZone);
    task.nextRunAt = next ? next.toISOString() : null;
    if (task.nextRunAt === null) task.enabled = false;
  }
}
