// How many searches and pages each key served and how many times it failed.
//
// We don't keep history: counters are stored per day, and on every write the eighth day
// is discarded — the panel shows the sum over seven. That's enough to understand
// who spends the quota and who only pretends to work.
//
// We write on every router attempt, not on a person's request: the Linkup →
// Tavily fallback is two attempts, and both cost their money.
import fs from 'node:fs';
import path from 'node:path';
import type { IcarusConfig } from '../config.ts';
import { log } from '../log.ts';
import { stateFile } from './state.ts';
import { isProviderId, type ProviderId } from './types.ts';

/** How many days we remember. The eighth day is erased on the next write. */
export const USAGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export type UsageCapability = 'search' | 'fetch';

/** Successes and failures of one key. */
export type UsageCount = { ok: number; fail: number };

/** A day: counters per capability, inside — per provider. */
export type UsageDay = Record<UsageCapability, Record<string, UsageCount>>;

export type UsageState = { version: 1; days: Record<string, UsageDay> };

/** Window totals: what the panel sees. */
export type UsageReport = {
  days: number;
  since: string;
  through: string;
  search: Partial<Record<ProviderId, UsageCount>>;
  fetch: Partial<Record<ProviderId, UsageCount>>;
};

/** File next to the router state: in tests it's swapped together with it. */
export function usageFile(config: IcarusConfig): string {
  return path.join(path.dirname(stateFile(config)), 'search-usage.json');
}

/** We count the day in UTC: in the container that's the service calendar. */
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
 * Read the file. Broken or foreign — we start from a clean slate: statistics are not
 * a reason to break search.
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

/** Write via a temporary file: an unfinished JSON must not become statistics. */
function writeUsage(file: string, state: UsageState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Keep only today and the six previous days. */
function prune(state: UsageState, today: string): void {
  const floor = sinceKey(Date.parse(`${today}T00:00:00.000Z`));
  for (const day of Object.keys(state.days)) {
    if (day < floor) delete state.days[day];
  }
}

// In-process lock: two concurrent requests must not lose a counter.
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
 * Record an attempt: success or failure of a specific key in a specific capability.
 *
 * We swallow write errors with a warning to the log: statistics are not a reason
 * to deny a person a page.
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

/** Totals for the last seven days: one map per capability. */
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
