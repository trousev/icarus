// Время для Икара: часовой пояс, часть суток, дата и метка «Сейчас».
//
// Системный промпт от времени НЕ зависит: дата и часть суток приезжают отдельным
// блоком к реплике человека (см. clock.ts). Иначе промпт менялся бы на каждом ходу
// и рвал кэш — а он у нас и так собирается заново каждый ход.
//
// Пояс берём из окружения контейнера (TZ, реже ICARUS_TZ): без него контейнер живёт
// в UTC, и вечерние записи в память попадают во вчера.

const FALLBACK_ZONE = 'UTC';

/** Части суток: границы в часах локального времени. */
const DAY_PARTS: ReadonlyArray<{ until: number; name: string }> = [
  { until: 6, name: 'ночь' },
  { until: 12, name: 'утро' },
  { until: 18, name: 'день' },
  { until: 24, name: 'вечер' },
];

/**
 * Инструкция для персоны. Текст постоянный — это важно: промпт не должен меняться
 * от того, что сменилась дата или часть суток.
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

/** Пояс человека: ICARUS_TZ сильнее системного TZ, битое значение — откат на системный. */
export function resolveZone(env: NodeJS.ProcessEnv = process.env): string {
  const asked = (env.ICARUS_TZ ?? env.TZ ?? '').trim();
  if (asked && isValidZone(asked)) return asked;
  try {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (system && isValidZone(system)) return system;
  } catch {
    /* ниже — UTC */
  }
  return FALLBACK_ZONE;
}

/** Пояс задан, но не распознан: вызывающий может один раз сказать об этом в лог. */
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

/** Локальные год, месяц и день: по ним датируются факты и журнал. */
export function localParts(date: Date, zone: string): { year: number; month: number; day: number } {
  const parts = zoneParts(date, zone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return {
    year: Number(parts.year ?? '1970'),
    month: Number(parts.month ?? '1'),
    day: Number(parts.day ?? '1'),
  };
}

/** Локальная дата в виде YYYY-MM-DD. */
export function localDate(date: Date, zone: string): string {
  const { year, month, day } = localParts(date, zone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** «понедельник, 21 сентября 2026» — без хвоста «г.», который подставляет ru-RU. */
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

/** «понедельник, 21 сентября 2026, вечер» — то, что видит модель. */
export function momentLabel(date: Date, zone: string): string {
  return `${longDate(date, zone)}, ${dayPart(date, zone)}`;
}

/** Метка, которую clock.ts дописывает к реплике человека. */
export function momentLine(date: Date, zone: string): string {
  return `[Сейчас: ${momentLabel(date, zone)}]`;
}

/** Смещение пояса в виде +01:00 (для ответа тула). */
export function offsetLabel(date: Date, zone: string): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = name.replace(/^GMT/, '');
  return offset === '' ? '+00:00' : offset;
}

/** «понедельник, 21 сентября 2026, 11:02 (Europe/Dublin, UTC+01:00)» — ответ тула now. */
export function exactMoment(date: Date, zone: string): string {
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${longDate(date, zone)}, ${time} (${zone}, UTC${offsetLabel(date, zone)})`;
}
