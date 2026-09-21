// Панель памяти: чтение файлов, поиск, точечное забывание и удаление файла целиком.
// Всё, что приходит из браузера, проверяется на выход за пределы каталога памяти.
//
// Каталогов два, и они разной природы. Память — markdown, который агент правит
// руками и который панель умеет чистить построчно. Математика — рабочие файлы
// Maple (журналы сессий, графики, воркшиты): их создаёт сам Maple, и панель
// показывает их только для чтения, иначе «забудь строку» полезла бы в журнал,
// из которого сессия восстанавливается, и сломала бы расчёт.
import fs from 'node:fs';
import path from 'node:path';

export type MemoryFile = { path: string; size: number; modified: string; ext: string };
export type SearchHit = { path: string; line: number; text: string };

/** Расширения памяти: её правит агент, и в панели у неё есть «забыть строку». */
const MEMORY_EXTENSIONS = new Set(['.md']);

/** Расширения математики: журналы Maple, воркшиты, скрипты, графики. */
const MAPLE_EXTENSIONS = new Set(['.jsonl', '.mw', '.mpl', '.txt', '.gif', '.jpg', '.jpeg', '.bmp']);

/** Форматы, которые браузер покажет картинкой, а не текстом. */
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpg', '.jpeg', '.bmp']);

export const memoryExtensions = MEMORY_EXTENSIONS;
export const mapleExtensions = MAPLE_EXTENSIONS;

/** Считается ли файл картинкой: панель рисует его через <img>, а не как текст. */
export function isImageFile(relative: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

/** Все расширения, которые панель вообще готова отдать. */
export function knownExtension(relative: string): boolean {
  const ext = path.extname(relative).toLowerCase();
  return MEMORY_EXTENSIONS.has(ext) || MAPLE_EXTENSIONS.has(ext);
}

/**
 * Приводит путь к безопасному виду внутри root или возвращает null.
 * allowed — какие расширения пускать: их два набора (память и математика), и
 * смешивать их нельзя, иначе «/file?path=journal.jsonl» открывал бы журнал Maple
 * как память — с кнопками, которых там быть не должно.
 */
export function resolveInside(
  root: string,
  relative: string,
  allowed: ReadonlySet<string> = MEMORY_EXTENSIONS,
): string | null {
  if (!relative || relative.includes('\u0000')) return null;
  // Абсолютный путь отбрасываем до любых манипуляций: иначе «/etc/passwd.md»
  // превратился бы в относительный «etc/passwd.md» и тихо уехал внутрь памяти.
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

/** Картинку читаем байтами: как текст график не отдать. */
export function readImageFile(
  root: string,
  relative: string,
  allowed: ReadonlySet<string> = MAPLE_EXTENSIONS,
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
 * Удаляет файл целиком — когда чистить построчно нечего или файл больше не нужен.
 * Каталог не сносим: панель удаляет файл, а не полку памяти, иначе одним промахом
 * уехали бы все записи разом.
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

/** Убирает строку из файла — то самое «забудь это». */
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
