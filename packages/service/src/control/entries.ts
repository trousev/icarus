// Панель управления: файл памяти, разобранный на записи.
//
// Память — markdown-конспект агента, а не таблица: заголовки задают разделы, пункты
// («- …») и есть записи, а пустые строки держат ритм. Панель показывает записи
// строками с галочками, поэтому здесь текст превращается в список: у каждой записи
// есть номер строки в файле (по нему её и удаляют) и дата коммита, которая эту
// строку добавила или изменила.
//
// Порядок записей — как в файле. Память пишется по смыслу: сверху устойчивое, ниже
// подробности, и пересортировка по дате разорвала бы этот порядок на глазах
// человека, который файл и писал. Даты при этом видно — по ним и понятно, что
// устарело.
import { blameLines } from './git.ts';

/** Что за строка: запись с галочкой, заголовок раздела или просто текст. */
export type EntryKind = 'note' | 'heading' | 'text';

export type MemoryEntry = {
  /** Номер строки в файле, с единицы: по нему запись удаляют. */
  line: number;
  kind: EntryKind;
  /** Текст как в файле, вместе с ведущим «- »: в панели он читается привычно. */
  text: string;
  /** День коммита, который тронул строку, — «когда запись появилась». */
  date: string | null;
};

export type FileEntries = {
  path: string;
  entries: MemoryEntry[];
  /** Сколько записей в файле всего: список в панели может быть показан не весь. */
  total: number;
  /** Показали не все записи — в панели об этом надо сказать, а не молчать. */
  capped: boolean;
};

/** Сколько записей отдаём за раз: больше в панели всё равно не прочитать. */
export const ENTRIES_LIMIT = 500;

/** Строка-пункт: и «- », и «* », и «+ » — markdown считает их одним и тем же. */
const BULLET = /^\s*[-*+]\s+/;
const HEADING = /^#{1,6}\s+/;

function kindOf(line: string): EntryKind {
  if (BULLET.test(line)) return 'note';
  if (HEADING.test(line)) return 'heading';
  return 'text';
}

/**
 * Разбирает содержимое файла на записи, подставляя даты из истории.
 *
 * Даты приходят отдельным списком по индексу строки: blame — это git, а не файл, и
 * смешивать их в одной функции значило бы тащить git туда, где нужно просто чтение.
 * Нет даты (строку ещё не коммитили, файла нет в истории) — так и говорим: null.
 */
export function parseEntries(content: string, dates: (string | null)[] = []): {
  entries: MemoryEntry[];
  total: number;
} {
  const lines = content.split('\n');
  const entries: MemoryEntry[] = [];
  // Пустой хвост от последнего \n записью не считается, но и не теряется: он просто
  // не рисуется, как и в любом редакторе.
  const lastMeaningful = content.endsWith('\n') ? lines.length - 1 : lines.length;

  for (let index = 0; index < lastMeaningful; index += 1) {
    const text = lines[index];
    const kind = kindOf(text);
    if (kind === 'text' && text.trim() === '') continue;
    entries.push({ line: index + 1, kind, text, date: dates[index] ?? null });
  }

  const notes = entries.filter((entry) => entry.kind === 'note').length;
  return { entries, total: notes };
}

/** То же, но с датами из git: единственное место, где панель ходит в историю за текстом. */
export async function readEntries(dir: string, path: string, content: string): Promise<FileEntries> {
  const dates = await blameLines(dir, path);
  const parsed = parseEntries(content, dates);
  const kept = parsed.entries.slice(0, ENTRIES_LIMIT);
  return {
    path,
    entries: kept,
    total: parsed.total,
    capped: parsed.entries.length > kept.length,
  };
}

/** Дата коммита как её показывает панель: 08.02.2026. В файлах даты пишут так же. */
export function formatDay(iso: string): string {
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}.${month}.${year}` : iso;
}
