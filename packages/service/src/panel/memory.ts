// Панель памяти: чтение файлов, поиск, точечное забывание.
// Всё, что приходит из браузера, проверяется на выход за пределы каталога памяти.
import fs from 'node:fs';
import path from 'node:path';

export type MemoryFile = { path: string; size: number; modified: string };
export type SearchHit = { path: string; line: number; text: string };

/** Приводит путь к безопасному виду внутри root или возвращает null. */
export function resolveInside(root: string, relative: string): string | null {
  if (!relative || relative.includes('\u0000')) return null;
  // Абсолютный путь отбрасываем до любых манипуляций: иначе «/etc/passwd.md»
  // превратился бы в относительный «etc/passwd.md» и тихо уехал внутрь памяти.
  if (path.isAbsolute(relative)) return null;
  const normalized = path.normalize(relative);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  if (!normalized.endsWith('.md')) return null;
  const full = path.resolve(root, normalized);
  const rootWithSep = path.resolve(root) + path.sep;
  return full.startsWith(rootWithSep) ? full : null;
}

export function listFiles(root: string, prefix = ''): MemoryFile[] {
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
      files.push(...listFiles(root, relative));
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const stat = fs.statSync(path.join(root, relative));
    files.push({ path: relative, size: stat.size, modified: stat.mtime.toISOString() });
  }
  return files;
}

export function readMemoryFile(root: string, relative: string): string | null {
  const full = resolveInside(root, relative);
  if (!full || !fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

export function searchMemory(root: string, query: string, limit = 50): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const file of listFiles(root)) {
    const content = readMemoryFile(root, file.path);
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

/** Убирает строку из файла — то самое «забудь это». */
export function removeLine(root: string, relative: string, lineText: string): { ok: boolean; message: string } {
  const full = resolveInside(root, relative);
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
