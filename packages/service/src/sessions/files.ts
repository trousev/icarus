// pi session files: where the conversation history lies and how to get its beginning.
//
// The file name is `<when created>_<session id>.jsonl`, the session id is computed from
// the person and conversation (see identity.ts). The conversation cannot be
// restored back from the name, so chats.json stores conversationId next to the record.
import fs from 'node:fs';
import path from 'node:path';

export type FileSession = {
  sessionId: string;
  file: string;
  mtimeMs: number;
  size: number;
};

/** session id from the file name: `<time>_<uuid>.jsonl` or `<uuid>.jsonl`. */
export function sessionIdFromFileName(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null;
  const base = name.slice(0, -'.jsonl'.length);
  const at = base.lastIndexOf('_');
  const id = at === -1 ? base : base.slice(at + 1);
  return id || null;
}

/**
 * All session files, one per conversation. If one id has several files
 * (the old one not yet moved to archive/), we keep the freshest.
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
 * Files only for the listed conversations: the list is paginated, and there is no
 * reason to stat the whole directory for thirty visible chats. We read all names
 * (this is a cheap readdir), stat — only the matched ones.
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

/** The freshest file with this id: after /clear there is already a new one in the directory. */
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

/** Text from the content of a pi message: a string or an array of `{type:"text"}` blocks. */
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
 * The beginning of a conversation: the first person's lines, Icarus's first answer and how many
 * lines there already were. From them the model invents a title: a greeting alone gives no theme,
 * and the answer to it shows what the conversation is really about.
 */
export type OpeningExchange = {
  /** Up to three first person's lines — with a margin for "hi, help with …". */
  users: string[];
  /** Icarus's first answer: it clarifies the theme the person mentioned in passing. */
  assistant: string;
  /** All person's lines in the read head of the file: from them one can see whether it is time to leave the name. */
  turns: number;
};

/** We cut off the note about files: in the title it looks like "The user attached files…". */
function cleanOpeningText(text: string): string {
  const cut = text.indexOf('\n\n[Пользователь приложил файлы');
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * Parsing the head of a session file: we read only the beginning, and the file can be large.
 * Compared to `readFirstUserText` — here the first answer is also needed.
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

/** The first person's line from the beginning of the file. */
export function readFirstUserText(file: string, maxBytes = 64 * 1024): string {
  return readOpeningExchange(file, maxBytes).users[0] ?? '';
}

/** When the conversation was created, by the file name: `2026-09-23T18-54-52-308Z_…`. */
export function createdAtFromFileName(name: string): string | null {
  const at = name.indexOf('_');
  const stamp = at === -1 ? name : name.slice(0, at);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}
