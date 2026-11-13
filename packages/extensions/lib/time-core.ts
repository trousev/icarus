// Time for Icarus: time zone, part of day, date and the "Now" label.
//
// The system prompt does NOT depend on time: the date and part of day arrive in a separate
// block attached to the person's message (see clock.ts). Otherwise the prompt would change
// on every turn and break the cache — and it is rebuilt every turn as it is.
//
// We take the zone from the container environment (TZ, less often ICARUS_TZ): without it the
// container lives in UTC, and evening memory writes land in yesterday.

const FALLBACK_ZONE = 'UTC';

/** Parts of day: boundaries in local-time hours. */
const DAY_PARTS: ReadonlyArray<{ until: number; name: string }> = [
  { until: 6, name: 'ночь' },
  { until: 12, name: 'утро' },
  { until: 18, name: 'день' },
  { until: 24, name: 'вечер' },
];

/**
 * Instruction for the persona. The text is constant — this is important: the prompt must not
 * change because the date or part of day changed.
 */
export const TIME_INSTRUCTION = [
  '# Время',
  '- Перед репликой человека стоит метка «[Сейчас: …]»: день недели, дата и часть суток. Она настоящая.',
  '- Точный час и часовой пояс — инструментом `now`, когда это правда важно: встреча, срок, «сколько у него сейчас».',
  '- Своим внутренним догадкам о сегодняшней дате не верь: для тебя они устарели.',
].join('\n');

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The person's zone: ICARUS_TZ beats the system TZ, a broken value falls back to the system. */
export function resolveZone(env: NodeJS.ProcessEnv = process.env): string {
  const asked = (env.ICARUS_TZ ?? env.TZ ?? '').trim();
  if (asked && isValidZone(asked)) return asked;
  try {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (system && isValidZone(system)) return system;
  } catch {
    /* below — UTC */
  }
  return FALLBACK_ZONE;
}

/** Zone is set but not recognized: the caller may report it to the log once. */
export function unknownZone(env: NodeJS.ProcessEnv = process.env): string | null {
  const asked = (env.ICARUS_TZ ?? env.TZ ?? '').trim();
  return asked !== '' && !isValidZone(asked) ? asked : null;
}

function zoneParts(
  date: Date,
  zone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

export function hourIn(date: Date, zone: string): number {
  const hour = Number(zoneParts(date, zone, { hour: 'numeric', hourCycle: 'h23' }).hour ?? '0');
  return Number.isFinite(hour) ? hour % 24 : 0;
}

export function dayPart(date: Date, zone: string): string {
  const hour = hourIn(date, zone);
  return DAY_PARTS.find((part) => hour < part.until)?.name ?? 'вечер';
}

/** Local year, month and day: facts and the journal are dated by them. */
export function localParts(date: Date, zone: string): { year: number; month: number; day: number } {
  const parts = zoneParts(date, zone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return {
    year: Number(parts.year ?? '1970'),
    month: Number(parts.month ?? '1'),
    day: Number(parts.day ?? '1'),
  };
}

/** Local date as YYYY-MM-DD. */
export function localDate(date: Date, zone: string): string {
  const { year, month, day } = localParts(date, zone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "понедельник, 21 сентября 2026" — without the trailing "г." that ru-RU appends. */
function longDate(date: Date, zone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
    .format(date)
    .replace(/\s*г\.\s*$/, '');
}

/** "понедельник, 21 сентября 2026, вечер" — what the model sees. */
export function momentLabel(date: Date, zone: string): string {
  return `${longDate(date, zone)}, ${dayPart(date, zone)}`;
}

/** Label that clock.ts appends to the person's message. */
export function momentLine(date: Date, zone: string): string {
  return `[Сейчас: ${momentLabel(date, zone)}]`;
}

/** Zone offset as +01:00 (for the tool response). */
export function offsetLabel(date: Date, zone: string): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = name.replace(/^GMT/, '');
  return offset === '' ? '+00:00' : offset;
}

/** "понедельник, 21 сентября 2026, 11:02 (Europe/Dublin, UTC+01:00)" — the now tool response. */
export function exactMoment(date: Date, zone: string): string {
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${longDate(date, zone)}, ${time} (${zone}, UTC${offsetLabel(date, zone)})`;
}
