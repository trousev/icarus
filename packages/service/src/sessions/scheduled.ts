// A person's scheduled tasks: "every day at 8" — start the agent with this prompt.
//
// A task is a schedule and a prompt. When the time comes, the service starts a NEW
// conversation and sends the prompt there: the agent works as in a regular chat, and the result
// the person reads in the conversation list. There are no "reminders" into someone else's chat here —
// the agent's message always lives in its own conversation.
//
// What was decided here and why:
//   - wall-clock rules are stored (schedule.ts), and the moment is computed by the service in the person's
//     time zone — otherwise "at 8 in the morning" would shift by an hour on a DST change;
//   - a missed run IS CAUGHT UP, but once: after a long downtime the agent runs
//     once, not twenty times. The next run is counted from the current moment, not
//     from the missed one;
//   - busy: if the person already has a turn in progress, the run isn't cancelled — we wait up to
//     BUSY_GRACE_MS, and then honestly write "skipped" into the task;
//   - the run is recorded to the file BEFORE the agent starts: a service that crashes mid-run won't
//     run the same run again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { nextRunAt, parseRepeat, taskTimeZone, type TaskRepeat } from './schedule.ts';

export type ScheduledTask = {
  id: string;
  /** What the agent does in the new conversation. A task without a prompt doesn't exist. */
  prompt: string;
  repeat: TaskRepeat;
  /** The new conversation's working folder; absent — the default workspace. */
  workspace?: string;
  enabled: boolean;
  createdAt: string;
  /** Next run; null — there will be no more runs (a one-off has fired). */
  nextRunAt: string | null;
  lastRunAt?: string;
  /** The conversation the previous run started: the list has a link to it. */
  lastChatId?: string;
  /** What failed on the previous run: an honest record instead of silence. */
  lastError?: string;
};

/** A task as the panel sees it: the same plus "time to run". */
export type TaskView = ScheduledTask & {
  /** The time has come but no run happened: the panel highlights this if the tick didn't fire. */
  due: boolean;
};

/** Cap on tasks per person: these are schedules, not a job queue. */
export const TASK_LIMIT = 100;
/** The prompt is a person's reply: nobody writes longer, and there's no reason to store a canvas. */
const PROMPT_LIMIT = 4000;

export type TaskInput = {
  prompt: string;
  repeat: TaskRepeat;
  workspace?: string;
};

function tasksFile(config: IcarusConfig, user: UserConfig): string {
  return userPaths(config, user).scheduledTasks;
}

function normalize(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id) return null;
  const repeat = parseRepeat(item.repeat);
  if (!repeat) return null;
  // A task without a prompt starts nothing: such a record has no business in the file.
  if (typeof item.prompt !== 'string' || !item.prompt.trim()) return null;
  return {
    id: item.id,
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

/** We write via a temporary file: a crash mid-write shouldn't eat all the tasks. */
export function writeTasks(config: IcarusConfig, user: UserConfig, tasks: ScheduledTask[]): void {
  const file = tasksFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ tasks }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Creation check: garbage shouldn't create a "someday" task. */
export function parseTaskInput(value: unknown, timeZone: string, now = new Date()): TaskInput {
  const raw = (value ?? {}) as Record<string, unknown>;
  const prompt = String(raw.prompt ?? '')
    .trim()
    .slice(0, PROMPT_LIMIT);
  if (!prompt) throw new Error('напиши, что должен сделать агент: задача без промпта — это не задача');
  const repeat = parseRepeat(raw.repeat);
  if (!repeat) throw new Error('расписание не разобрал: нужен день, время или правило повтора');
  // A one-off "run it yesterday" is not a task but a misunderstanding: the next run
  // would never come, and the person would be waiting in silence.
  if (nextRunAt(repeat, now, timeZone) === null) {
    throw new Error(
      repeat.kind === 'once'
        ? 'это время уже прошло — выбери будущее'
        : 'не удалось посчитать следующий запуск: проверь время и дни недели',
    );
  }
  return { prompt, repeat };
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
 * Enabling and disabling. When enabling, we recompute the run from the current moment: while
 * the task lay disabled, its time could have passed, and the "catch-up" would fire the agent
 * right after the button is pressed.
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

/** A task for the panel: whether the time is considered to have come. */
export function taskView(task: ScheduledTask, now = new Date()): TaskView {
  const next = task.nextRunAt ? new Date(task.nextRunAt) : null;
  return { ...task, due: Boolean(task.enabled && next && next.getTime() <= now.getTime()) };
}

/** How the run ended: the new conversation's id and the error if the agent didn't come up. */
export type LaunchOutcome = { chatId: string; error?: string };

/**
 * How a task launches the agent. A separate type so the scheduler knows about neither the session
 * registry nor the conversation registry: in tests it's a stub, in prod it's task-launch.ts.
 */
export type TaskLauncher = {
  /** Is the person busy: they already have a turn or a compaction in progress. */
  busy(user: UserConfig): boolean;
  /** Starts a new conversation and sends the prompt into it. Returns chatId even on error. */
  launch(user: UserConfig, task: ScheduledTask): Promise<LaunchOutcome>;
};

export type ScheduledTasksDeps = {
  launch: TaskLauncher;
  /** Clock: overridden in tests so they don't wait for Wednesday. */
  now?: () => Date;
  tickMs?: number;
  /** How long to wait for the person to free up before marking the run as skipped. */
  graceMs?: number;
};

/** How often we check: a run "in a minute" shouldn't wait five. */
const TICK_MS = 20_000;
/** How long we wait for a busy person: longer is no longer "waiting" but skipping. */
const BUSY_GRACE_MS = 10 * 60_000;

export type TickOutcome = { fired: number; started: number; failed: number; skipped: number };

const NOTHING: TickOutcome = { fired: 0, started: 0, failed: 0, skipped: 0 };

/**
 * The scheduler. It ticks on a timer, but all the work is done by `tick()` — tests and the panel
 * call it too, so behavior can be checked without waiting for real time.
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
    // The timer shouldn't keep the process alive: the service lives on its own.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over all people. Returns counters — from them you can see that the tick didn't
   * just "spin": so many tasks started the agent, so many didn't.
   */
  async tick(): Promise<TickOutcome> {
    // Two ticks must not launch one task twice.
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

      // The person is busy: we don't lose the run but wait for the next tick. Waiting forever
      // is not allowed — otherwise "gather the summary" would silently never happen; then we skip.
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
      // We record the run before the agent starts: if the service crashes mid-run, the same
      // run won't repeat on the next tick.
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
   * The next run is counted from "now", not from the missed one: if the service was down for a day,
   * the agent runs once and the next firing will be at its own time, not
   * a batch of catch-ups for every missed day.
   */
  private advance(task: ScheduledTask, now: Date, timeZone: string): void {
    const next = nextRunAt(task.repeat, now, timeZone);
    task.nextRunAt = next ? next.toISOString() : null;
    if (task.nextRunAt === null) task.enabled = false;
  }
}
