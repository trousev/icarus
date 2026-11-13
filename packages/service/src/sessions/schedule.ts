// Task schedule: "every day at 8:00" means 8:00 by the person's clock, not UTC.
//
// The model thinks in UTC, cron on the host lives in UTC, but a person's "morning" is morning in
// their zone, and in March it arrives an hour earlier in UTC than in February. So the rule
// is stored as wall-clock time (date, hours and minutes), and the service computes the instant: it
// knows the person's time zone (env.TZ from config.yaml) and can convert wall-clock
// time into an instant so that DST doesn't shift the run by an hour.
//
// No dependencies: Intl with timeZone gives the date parts in the zone, then it's calendar
// arithmetic (days, not milliseconds), so days of 23 and 25 hours don't break the count.
import type { IcarusConfig } from '../config.ts';

/** Repetition rule: wall-clock time only; the service supplies the time zone. */
export type TaskRepeat =
  /** Once: local date and time. */
  | { kind: 'once'; date: string; time: string }
  /** Every day at the specified time. */
  | { kind: 'daily'; time: string }
  /** On the selected weekdays (0 — Sunday, like Date.getDay). */
  | { kind: 'weekly'; time: string; weekdays: number[] };

export type TimeOfDay = { hour: number; minute: number };
export type CalendarDate = { year: number; month: number; day: number };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A time zone is valid if Intl accepts it: otherwise we fall back to UTC, not a TypeError. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * The person's time zone. It already lives in the config: env.TZ travels into the container so
 * dates in memory and in replies are local. The scheduler takes the same zone — otherwise
 * "remind me at 8" would fire by the container's clock, not the person's.
 */
export function taskTimeZone(config: IcarusConfig): string {
  const configured = config.env?.TZ;
  if (isValidTimeZone(configured)) return configured;
  const host = process.env.TZ;
  if (isValidTimeZone(host)) return host;
  return 'UTC';
}

export function parseTimeOfDay(value: unknown): TimeOfDay | null {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function parseCalendarDate(value: unknown): CalendarDate | null {
  if (typeof value !== 'string') return null;
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // February 31 is not a date: we check against the calendar, not a range of numbers.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Wall-clock time in the zone: what the person sees on their clock. */
export type WallClock = CalendarDate & TimeOfDay;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Date parts in the zone. Seconds are only needed for an honest offset. */
export function wallClockOf(date: Date, timeZone: string): WallClock & { second: number } {
  const parts = formatterFor(timeZone).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  // en-US with hour12:false reports midnight as "24": that's the same 00 hours, not the next day.
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') % 24,
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** How far the zone is ahead of UTC at this instant (Dublin in summer — +1 hour). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const wall = wallClockOf(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function wallValue(instantMs: number, timeZone: string): number {
  return instantMs + zoneOffsetMs(new Date(instantMs), timeZone);
}

/**
 * The instant for a wall-clock time. We take the zone offset at several points around
 * the target hour: on the day of a clock change the zone differs before and after the
 * transition, and the offset "at the target instant" alone misses — 01:30 happens twice in
 * autumn, while 02:30 doesn't happen at all in spring.
 *
 * Of two valid candidates we take the earlier one: the run must happen the first time, not
 * an hour after it. If there are no valid ones (a clock-change gap), we return the instant
 * right after the transition — "morning" will still come, and won't be lost.
 */
export function instantFromWall(clock: WallClock, timeZone: string): Date {
  const target = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  const candidates = new Set<number>();
  // Clock transitions in the world range from 30 minutes to two hours; three hours in both
  // directions is enough to see the zone offset before and after the transition.
  for (let shift = -3; shift <= 3; shift += 1) {
    const probe = target + shift * 3_600_000;
    candidates.add(target - zoneOffsetMs(new Date(probe), timeZone));
  }
  const valid = [...candidates].filter((candidate) => wallValue(candidate, timeZone) === target);
  if (valid.length > 0) return new Date(Math.min(...valid));
  const fallback = target - zoneOffsetMs(new Date(target - 3_600_000), timeZone);
  return new Date(fallback);
}

/** Shift by calendar days: via Date.UTC so 23-hour DST days don't get in the way. */
function shiftDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Weekday in the calendar: 0 — Sunday. The time zone is irrelevant here. */
function weekdayOf(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * The next run strictly after `after`. `null` — there will be no more runs
 * (a one-off task is left in the past).
 */
export function nextRunAt(repeat: TaskRepeat, after: Date, timeZone: string): Date | null {
  const time = parseTimeOfDay(repeat.time);
  if (!time) return null;
  const afterMs = after.getTime();

  if (repeat.kind === 'once') {
    const date = parseCalendarDate(repeat.date);
    if (!date) return null;
    const instant = instantFromWall({ ...date, ...time }, timeZone);
    return instant.getTime() > afterMs ? instant : null;
  }

  const today = wallClockOf(after, timeZone);
  const days = repeat.kind === 'weekly' ? (repeat.weekdays ?? []) : null;
  // A week ahead with margin: today's run may have already passed, and the chosen
  // weekday may be just about to happen. Two weeks is enough for any set of days.
  const horizon = repeat.kind === 'weekly' ? 14 : 2;
  for (let shift = 0; shift <= horizon; shift += 1) {
    const date = shiftDays(today, shift);
    if (days && !days.includes(weekdayOf(date))) continue;
    const instant = instantFromWall({ ...date, ...time }, timeZone);
    if (instant.getTime() > afterMs) return instant;
  }
  return null;
}

/** Parsing the rule from the request body: garbage must not create a "someday" task. */
export function parseRepeat(value: unknown): TaskRepeat | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const time = parseTimeOfDay(raw.time);
  if (!time) return null;
  if (raw.kind === 'once') {
    const date = parseCalendarDate(raw.date);
    return date ? { kind: 'once', date: `${raw.date}`.trim(), time: `${raw.time}`.trim() } : null;
  }
  if (raw.kind === 'daily') return { kind: 'daily', time: `${raw.time}`.trim() };
  if (raw.kind === 'weekly') {
    const weekdays = Array.isArray(raw.weekdays)
      ? [...new Set(raw.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort(
          (left, right) => left - right,
        )
      : [];
    if (weekdays.length === 0) return null;
    return { kind: 'weekly', time: `${raw.time}`.trim(), weekdays };
  }
  return null;
}
