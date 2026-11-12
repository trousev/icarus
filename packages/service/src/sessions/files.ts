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

/**
 * Файлы только для перечисленных разговоров: список листается страницами, и
 * stat-ить весь каталог ради тридцати видимых чатов незачем. Имена читаем все
 * (это дешёвый readdir), stat — только совпавшие.
 */
export function sessionFilesFor(dir: string, sessionIds: Set<string>): Map<string, FileSession> {
  const found = new Map<string, FileSession>();
  if (sessionIds.size === 0) return found;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }

  for (const name of names) {
    const sessionId = sessionIdFromFileName(name);
    if (!sessionId || !sessionIds.has(sessionId)) continue;
    const file = path.join(dir, name);
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
  return found;
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
 * Начало разговора: первые реплики человека, первый ответ Икара и сколько
 * реплик уже было. По ним модель придумывает заголовок: одно приветствие темы
 * не даёт, а ответ на него показывает, о чём разговор на самом деле.
 */
export type OpeningExchange = {
  /** До трёх первых реплик человека — с запасом на «привет, помоги с …». */
  users: string[];
  /** Первый ответ Икара: он уточняет тему, которую человек назвал вскользь. */
  assistant: string;
  /** Все реплики человека в прочитанной голове файла: по ним видно, пора ли имя оставить. */
  turns: number;
};

/** Приписку о файлах срезаем: в заголовке она выглядит как «Пользователь приложил файлы…». */
function cleanOpeningText(text: string): string {
  const cut = text.indexOf('\n\n[Пользователь приложил файлы');
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * Разбор головы файла сессии: читаем только начало, а файл бывает большим.
 * Сравнение с `readFirstUserText` — здесь нужен ещё и первый ответ.
 */
export function readOpeningExchange(file: string, maxBytes = 128 * 1024): OpeningExchange {
  const opening: OpeningExchange = { users: [], assistant: '', turns: 0 };
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    if (read <= 0) return opening;
    for (const line of buffer.subarray(0, read).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry: { type?: string; message?: Record<string, unknown> };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (entry.type !== 'message') continue;
      const text = cleanOpeningText(textOfContent(entry.message?.content));
      if (entry.message?.role === 'user') {
        opening.turns += 1;
        if (!text) continue;
        if (opening.users.length < 3) opening.users.push(text);
      } else if (entry.message?.role === 'assistant' && opening.turns > 0 && !opening.assistant) {
        opening.assistant = text;
      }
    }
    return opening;
  } catch {
    return opening;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Первая реплика человека из начала файла. */
export function readFirstUserText(file: string, maxBytes = 64 * 1024): string {
  return readOpeningExchange(file, maxBytes).users[0] ?? '';
}

/** Когда создан разговор, по имени файла: `2026-09-23T18-54-52-308Z_…`. */
export function createdAtFromFileName(name: string): string | null {
  const at = name.indexOf('_');
  const stamp = at === -1 ? name : name.slice(0, at);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}
