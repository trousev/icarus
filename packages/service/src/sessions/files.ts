// Файлы сессий pi: где лежит история разговора и как достать из неё начало.
//
// Имя файла — `<когда создан>_<id сессии>.jsonl`, id сессии считается из
// человека и разговора (см. identity.ts). Обратно из имени разговор не
// восстановить, поэтому chats.json хранит conversationId рядом с записью.
import fs from 'node:fs';
import path from 'node:path';

export type FileSession = {
  sessionId: string;
  file: string;
  mtimeMs: number;
  size: number;
};

/** id сессии из имени файла: `<время>_<uuid>.jsonl` или `<uuid>.jsonl`. */
export function sessionIdFromFileName(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null;
  const base = name.slice(0, -'.jsonl'.length);
  const at = base.lastIndexOf('_');
  const id = at === -1 ? base : base.slice(at + 1);
  return id || null;
}

/**
 * Все файлы сессий по одному на разговор. Если у одного id несколько файлов
 * (старый ещё не убран в archive/), оставляем самый свежий.
 */
export function discoverSessionFiles(dir: string): FileSession[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = new Map<string, FileSession>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sessionId = sessionIdFromFileName(entry.name);
    if (!sessionId) continue;
    const file = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const previous = found.get(sessionId);
    if (!previous || stat.mtimeMs > previous.mtimeMs) {
      found.set(sessionId, { sessionId, file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return [...found.values()];
}

/** Самый свежий файл с таким id: после /clear в каталоге лежит уже новый. */
export function sessionFileForId(dir: string, sessionId: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const matches = names.filter((name) => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`));
  if (matches.length === 0) return null;
  return matches
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .at(-1) ?? null;
}

/** Текст из content сообщения pi: строка или массив блоков `{type:"text"}`. */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === 'object')
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('\n');
}

/**
 * Первая реплика человека из начала файла. Читаем только голову: для заголовка
 * хватает первого сообщения, а файл сессии бывает большим. Приписку о файлах
 * срезаем — в заголовке она выглядит как «Пользователь приложил файлы…».
 */
export function readFirstUserText(file: string, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    if (read <= 0) return '';
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: { type?: string; message?: Record<string, unknown> };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const text = textOfContent(entry.message.content);
      const cut = text.indexOf('\n\n[Пользователь приложил файлы');
      const clean = (cut === -1 ? text : text.slice(0, cut)).trim();
      if (clean) return clean;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Когда создан разговор, по имени файла: `2026-09-23T18-54-52-308Z_…`. */
export function createdAtFromFileName(name: string): string | null {
  const at = name.indexOf('_');
  const stamp = at === -1 ? name : name.slice(0, at);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}
