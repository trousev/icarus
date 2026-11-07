// Сколько поисков и страниц отдал каждый ключ и сколько раз отказал.
//
// Историю не ведём: счётчики лежат по дням, при каждой записи восьмой день
// выбрасывается — панель показывает сумму за семь. Этого хватает, чтобы понять,
// кто тратит квоту, а кто только делает вид, что работает.
//
// Пишем на каждую попытку роутера, а не на запрос человека: fallback Linkup →
// Tavily — это две попытки, и обе стоят своих денег.
import fs from 'node:fs';
import path from 'node:path';
import type { IcarusConfig } from '../config.ts';
import { log } from '../log.ts';
import { stateFile } from './state.ts';
import { isProviderId, type ProviderId } from './types.ts';

/** Сколько дней помним. Восьмой день стирается при следующей записи. */
export const USAGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export type UsageCapability = 'search' | 'fetch';

/** Успехи и отказы одного ключа. */
export type UsageCount = { ok: number; fail: number };

/** День: счётчики по возможностям, внутри — по провайдерам. */
export type UsageDay = Record<UsageCapability, Record<string, UsageCount>>;

export type UsageState = { version: 1; days: Record<string, UsageDay> };

/** Суммы за окно: то, что видит панель. */
export type UsageReport = {
  days: number;
  since: string;
  through: string;
  search: Partial<Record<ProviderId, UsageCount>>;
  fetch: Partial<Record<ProviderId, UsageCount>>;
};

/** Файл рядом с состоянием роутера: в тестах подменяется вместе с ним. */
export function usageFile(config: IcarusConfig): string {
  return path.join(path.dirname(stateFile(config)), 'search-usage.json');
}

/** День считаем по UTC: в контейнере это и есть календарь сервиса. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function sinceKey(now: number): string {
  return dayKey(now - (USAGE_DAYS - 1) * DAY_MS);
}

function emptyDay(): UsageDay {
  return { search: {}, fetch: {} };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readCounts(value: unknown): UsageCount {
  const raw = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return { ok: count(raw.ok), fail: count(raw.fail) };
}

/**
 * Прочитать файл. Битый или чужой — начинаем с чистого листа: статистика не
 * повод ломать поиск.
 */
export function readUsage(file: string): UsageState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return { version: 1, days: {} };
  }
  const root = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const days: Record<string, UsageDay> = {};
  const rawDays = root.days !== null && typeof root.days === 'object' ? (root.days as Record<string, unknown>) : {};
  for (const [day, value] of Object.entries(rawDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const raw = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const bucket = emptyDay();
    for (const capability of ['search', 'fetch'] as const) {
      const providers = raw[capability];
      if (providers === null || typeof providers !== 'object') continue;
      for (const [id, counts] of Object.entries(providers as Record<string, unknown>)) {
        if (!isProviderId(id)) continue;
        bucket[capability][id] = readCounts(counts);
      }
    }
    days[day] = bucket;
  }
  return { version: 1, days };
}

/** Запись через временный файл: недописанный JSON не должен стать статистикой. */
function writeUsage(file: string, state: UsageState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Оставить только сегодня и шесть предыдущих дней. */
function prune(state: UsageState, today: string): void {
  const floor = sinceKey(Date.parse(`${today}T00:00:00.000Z`));
  for (const day of Object.keys(state.days)) {
    if (day < floor) delete state.days[day];
  }
}

// Замок внутри процесса: два одновременных запроса не должны потерять счётчик.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, task: () => T): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(
    file,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Записать попытку: успех или отказ конкретного ключа в конкретной возможности.
 *
 * Ошибки записи глотаем с предупреждением в лог: статистика — не причина
 * отказывать человеку в странице.
 */
export async function recordUsage(
  config: IcarusConfig,
  capability: UsageCapability,
  provider: ProviderId,
  ok: boolean,
  options: { now?: () => number } = {},
): Promise<void> {
  const file = usageFile(config);
  const now = options.now ?? (() => Date.now());
  try {
    await withLock(file, () => {
      const state = readUsage(file);
      const today = dayKey(now());
      const day = (state.days[today] ??= emptyDay());
      const counts = (day[capability][provider] ??= { ok: 0, fail: 0 });
      if (ok) counts.ok += 1;
      else counts.fail += 1;
      prune(state, today);
      writeUsage(file, state);
    });
  } catch (error) {
    log.warn('не записался счётчик обращений к поисковику', { provider, capability, error: String(error) });
  }
}

/** Суммы за последние семь дней: по одной карте на каждую возможность. */
export function usageReport(config: IcarusConfig, now: number = Date.now()): UsageReport {
  const state = readUsage(usageFile(config));
  const through = dayKey(now);
  const since = sinceKey(now);
  const search: Partial<Record<ProviderId, UsageCount>> = {};
  const fetch: Partial<Record<ProviderId, UsageCount>> = {};

  for (const [day, bucket] of Object.entries(state.days)) {
    if (day < since || day > through) continue;
    for (const capability of ['search', 'fetch'] as const) {
      const target = capability === 'search' ? search : fetch;
      for (const [id, counts] of Object.entries(bucket[capability])) {
        if (!isProviderId(id)) continue;
        const total = (target[id] ??= { ok: 0, fail: 0 });
        total.ok += counts.ok;
        total.fail += counts.fail;
      }
    }
  }

  return { days: USAGE_DAYS, since, through, search, fetch };
}
