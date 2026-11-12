// Расписание задачи: «каждый день в 8:00» — это 8:00 по часам человека, а не по UTC.
//
// Модель мыслит UTC, cron на хосте живёт в UTC, а «утром» у человека — это утро в его
// поясе, и в марте оно наступает на час раньше по UTC, чем в феврале. Поэтому правило
// хранится как настенное время (дата, часы и минуты), а момент считает сервис: он
// знает часовой пояс человека (env.TZ из config.yaml) и умеет переводить настенное
// время в момент так, чтобы DST не сдвигал запуск на час.
//
// Никаких зависимостей: Intl с timeZone даёт части даты в поясе, дальше — арифметика
// по календарю (дни, а не миллисекунды), поэтому сутки в 23 и 25 часов не ломают счёт.
import type { IcarusConfig } from '../config.ts';

/** Правило повтора: только настенное время, часовой пояс подставляет сервис. */
export type TaskRepeat =
  /** Один раз: локальная дата и время. */
  | { kind: 'once'; date: string; time: string }
  /** Каждый день в указанное время. */
  | { kind: 'daily'; time: string }
  /** По выбранным дням недели (0 — воскресенье, как у Date.getDay). */
  | { kind: 'weekly'; time: string; weekdays: number[] };

export type TimeOfDay = { hour: number; minute: number };
export type CalendarDate = { year: number; month: number; day: number };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Часовой пояс валиден, если его принимает Intl: иначе падаем в UTC, а не в TypeError. */
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
 * Часовой пояс человека. Он уже лежит в конфиге: env.TZ уезжает в контейнер, чтобы
 * даты в памяти и в ответах были местные. Тот же пояс берёт и планировщик — иначе
 * «напомни в 8» срабатывало бы по часам контейнера, а не человека.
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
  // 31 февраля — не дата: сверяем с календарём, а не с диапазоном чисел.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Настенное время в поясе: то, что человек видит на своих часах. */
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

/** Части даты в поясе. Секунды нужны только для честного смещения. */
export function wallClockOf(date: Date, timeZone: string): WallClock & { second: number } {
  const parts = formatterFor(timeZone).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  // en-US с hour12:false отдаёт полночь как «24»: это те же 00 часов, а не следующие сутки.
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') % 24,
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** Насколько пояс опережает UTC в этот момент (Дублин летом — +1 час). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const wall = wallClockOf(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function wallValue(instantMs: number, timeZone: string): number {
  return instantMs + zoneOffsetMs(new Date(instantMs), timeZone);
}

/**
 * Момент для настенного времени. Смещение пояса берём в нескольких точках вокруг
 * целевого часа: в день перевода часов пояс до и после перехода разный, и одно
 * только смещение «в целевой момент» промахивается — 01:30 осенью случается дважды,
 * а 02:30 весной не случается вовсе.
 *
 * Из двух годных вариантов берём ранний: запуск должен случиться в первый раз, а не
 * через час после него. Если годных нет (дыра перевода часов), отдаём момент сразу
 * после перевода — «утро» всё равно наступит, а не потеряется.
 */
export function instantFromWall(clock: WallClock, timeZone: string): Date {
  const target = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  const candidates = new Set<number>();
  // Переходы часов в мире — от 30 минут до двух часов; трёх часов в обе стороны
  // хватает, чтобы увидеть смещение пояса до и после перехода.
  for (let shift = -3; shift <= 3; shift += 1) {
    const probe = target + shift * 3_600_000;
    candidates.add(target - zoneOffsetMs(new Date(probe), timeZone));
  }
  const valid = [...candidates].filter((candidate) => wallValue(candidate, timeZone) === target);
  if (valid.length > 0) return new Date(Math.min(...valid));
  const fallback = target - zoneOffsetMs(new Date(target - 3_600_000), timeZone);
  return new Date(fallback);
}

/** Сдвиг на календарные дни: через Date.UTC, чтобы 23-часовые сутки DST не мешали. */
function shiftDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** День недели в календаре: 0 — воскресенье. Часовой пояс тут ни при чём. */
function weekdayOf(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Следующий запуск строго после `after`. `null` — запусков больше не будет
 * (одноразовая задача осталась в прошлом).
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
  // Неделя вперёд с запасом: сегодняшний запуск мог уже пройти, а выбранный день
  // недели — оказаться только что. Двух недель хватает на любой набор дней.
  const horizon = repeat.kind === 'weekly' ? 14 : 2;
  for (let shift = 0; shift <= horizon; shift += 1) {
    const date = shiftDays(today, shift);
    if (days && !days.includes(weekdayOf(date))) continue;
    const instant = instantFromWall({ ...date, ...time }, timeZone);
    if (instant.getTime() > afterMs) return instant;
  }
  return null;
}

/** Разбор правила из тела запроса: мусор не должен заводить задачу «когда-нибудь». */
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
