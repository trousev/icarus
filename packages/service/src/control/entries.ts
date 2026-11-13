// Control panel: a memory file parsed into entries.
//
// Memory is the agent's markdown outline, not a table: headings define sections, bullets
// («- …») are the entries, and blank lines hold the rhythm. The panel shows entries as
// lines with checkboxes, so here the text is turned into a list: each entry has
// a line number in the file (by which it is deleted) and the commit date that
// added or changed that line.
//
// The order of entries is as in the file. Memory is written by meaning: the stable stuff is
// on top, the details below, and re-sorting by date would tear this order apart in front of
// the person who wrote the file. The dates are still visible — from them it's clear what
// is outdated.
import { blameLines } from './git.ts';

/** What kind of line this is: an entry with a checkbox, a section heading, or just text. */
export type EntryKind = 'note' | 'heading' | 'text';

export type MemoryEntry = {
  /** Line number in the file, one-based: the entry is deleted by it. */
  line: number;
  kind: EntryKind;
  /** Text as in the file, together with the leading «- »: in the panel it reads familiarly. */
  text: string;
  /** Day of the commit that touched the line — «when the entry appeared». */
  date: string | null;
};

export type FileEntries = {
  path: string;
  entries: MemoryEntry[];
  /** How many entries the file has in total: the list in the panel may not show all of them. */
  total: number;
  /** Not all entries were shown — the panel must say so instead of staying silent. */
  capped: boolean;
};

/** How many entries we return at once: more can't be read in the panel anyway. */
export const ENTRIES_LIMIT = 500;

/** A bullet line: both «- » and «* » and «+ » are the same to markdown. */
const BULLET = /^\s*[-*+]\s+/;
const HEADING = /^#{1,6}\s+/;

function kindOf(line: string): EntryKind {
  if (BULLET.test(line)) return 'note';
  if (HEADING.test(line)) return 'heading';
  return 'text';
}

/**
 * Parses the file content into entries, substituting dates from the history.
 *
 * Dates arrive as a separate list by line index: blame is git, not the file, and
 * mixing them in one function would mean dragging git where simple reading is needed.
 * No date (the line isn't committed yet, the file isn't in the history) — we say so: null.
 */
export function parseEntries(content: string, dates: (string | null)[] = []): {
  entries: MemoryEntry[];
  total: number;
} {
  const lines = content.split('\n');
  const entries: MemoryEntry[] = [];
  // An empty tail from the last \n doesn't count as an entry, but it isn't lost either: it just
  // isn't drawn, as in any editor.
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

/** The same, but with dates from git: the only place where the panel goes into history for text. */
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

/** Commit date as the panel shows it: 08.02.2026. In files dates are written the same way. */
export function formatDay(iso: string): string {
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}.${month}.${year}` : iso;
}
