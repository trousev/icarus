// Control panel, memory section: reading files, search, targeted forgetting and deleting
// a whole file. Everything that comes from the browser is checked for escaping the memory
// directory.
//
// Memory is markdown that the agent edits by hand; skills have their own directory and their
// own rule (the whole file). The set of allowed extensions is therefore passed into the function,
// not chosen locally: the panel must not open a .jsonl journal as memory
// with buttons that should not be there.
import fs from 'node:fs';
import path from 'node:path';

export type MemoryFile = { path: string; size: number; modified: string; ext: string };
export type SearchHit = { path: string; line: number; text: string };

/** Memory extensions: it is edited by the agent, and in the panel it has "forget a line". */
const MEMORY_EXTENSIONS = new Set(['.md']);

/** Formats that the browser will display as an image, not as text. */
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpg', '.jpeg', '.bmp']);

export const memoryExtensions = MEMORY_EXTENSIONS;

/** Whether a file is considered an image: the panel renders it via <img>, not as text. */
export function isImageFile(relative: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

/**
 * Brings a path to a safe form inside root or returns null.
 * allowed — which extensions to let through: memory and skills have different ones, and mixing
 * them is not allowed, otherwise "/file?path=SKILL.md" would open as memory — with buttons
 * that should not be there.
 */
export function resolveInside(
  root: string,
  relative: string,
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): string | null {
  if (!relative || relative.includes('\u0000')) return null;
  // We discard an absolute path before any manipulations: otherwise "/etc/passwd.md"
  // would turn into the relative "etc/passwd.md" and quietly go inside memory.
  if (path.isAbsolute(relative)) return null;
  const normalized = path.normalize(relative);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  if (!allowed.has(path.extname(normalized).toLowerCase())) return null;
  const full = path.resolve(root, normalized);
  const rootWithSep = path.resolve(root) + path.sep;
  return full.startsWith(rootWithSep) ? full : null;
}

export function listFiles(
  root: string,
  prefix = '',
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): MemoryFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: MemoryFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative, allowed));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!allowed.has(ext)) continue;
    const stat = fs.statSync(path.join(root, relative));
    files.push({ path: relative, size: stat.size, modified: stat.mtime.toISOString(), ext });
  }
  return files;
}

export function readMemoryFile(
  root: string,
  relative: string,
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): string | null {
  const full = resolveInside(root, relative, allowed);
  if (!full || !fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

/** We read an image as bytes: a graphic cannot be given as text. */
export function readImageFile(
  root: string,
  relative: string,
  allowed: ReadonlySet<string> = IMAGE_EXTENSIONS,
): { file: string; type: string } | null {
  if (!isImageFile(relative)) return null;
  const full = resolveInside(root, relative, allowed);
  if (!full || !fs.existsSync(full)) return null;
  const ext = path.extname(full).toLowerCase();
  return { file: full, type: ext === '.gif' ? 'image/gif' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/bmp' };
}

export function searchMemory(
  root: string,
  query: string,
  limit = 50,
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const file of listFiles(root, '', allowed)) {
    const content = readMemoryFile(root, file.path, allowed);
    if (!content) continue;
    content.split('\n').forEach((text, index) => {
      if (hits.length < limit && text.toLowerCase().includes(needle)) {
        hits.push({ path: file.path, line: index + 1, text: text.trim() });
      }
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

function normalize(text: string): string {
  return text.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Deletes a whole file — when there is nothing to clean line by line or the file is no longer needed.
 * We do not remove the directory: the panel deletes a file, not a memory shelf, otherwise one slip
 * would take out all records at once.
 */
export function removeFile(
  root: string,
  relative: string,
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): { ok: boolean; message: string } {
  const full = resolveInside(root, relative, allowed);
  if (!full) return { ok: false, message: 'такой файл трогать нельзя' };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return { ok: false, message: 'файла нет' };
  }
  if (!stat.isFile()) return { ok: false, message: 'это не файл, а каталог' };

  fs.rmSync(full);
  return { ok: true, message: `удалил файл ${relative}` };
}

/** Removes a line from a file — the very "forget this". */
export function removeLine(
  root: string,
  relative: string,
  lineText: string,
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): { ok: boolean; message: string } {
  const full = resolveInside(root, relative, allowed);
  if (!full) return { ok: false, message: 'такой файл трогать нельзя' };
  if (!fs.existsSync(full)) return { ok: false, message: 'файла нет' };

  const content = fs.readFileSync(full, 'utf8');
  const lines = content.split('\n');
  const target = normalize(lineText);
  const index = lines.findIndex((line) => normalize(line) === target);
  if (index === -1) return { ok: false, message: 'такой строки в файле нет' };

  lines.splice(index, 1);
  fs.writeFileSync(full, lines.join('\n'));
  return { ok: true, message: `убрал строку ${index + 1}` };
}

/**
 * Removes several records at once — what is marked with checkboxes in the panel.
 *
 * Line numbers are taken from the same file that is on disk right now, so they are
 * all checked at once: one missed line (the agent changed the file between
 * opening the panel and pressing "delete") cancels the whole batch. That is more honest than
 * deleting half and leaving the person to figure out what exactly disappeared.
 */
export function removeLines(
  root: string,
  relative: string,
  lineNumbers: number[],
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): { ok: boolean; message: string; removed?: number } {
  const full = resolveInside(root, relative, allowed);
  if (!full) return { ok: false, message: 'такой файл трогать нельзя' };
  if (!fs.existsSync(full)) return { ok: false, message: 'файла нет' };

  const wanted = new Set<number>();
  for (const value of lineNumbers) {
    if (!Number.isInteger(value) || value < 1) return { ok: false, message: 'номер строки непонятный' };
    wanted.add(value);
  }
  if (wanted.size === 0) return { ok: false, message: 'ничего не выбрано' };

  const lines = fs.readFileSync(full, 'utf8').split('\n');
  for (const line of wanted) {
    if (line > lines.length) return { ok: false, message: `строки ${line} в файле уже нет` };
  }

  const kept = lines.filter((_, index) => !wanted.has(index + 1));
  fs.writeFileSync(full, kept.join('\n'));
  return { ok: true, message: `убрал записей: ${wanted.size}`, removed: wanted.size };
}

/** How many files are in the section: the panel shows this as a number next to the section. */
export function countFiles(root: string, allowed: ReadonlySet<string> = MEMORY_EXTENSIONS): number {
  return listFiles(root, '', allowed).length;
}
