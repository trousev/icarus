// File sidebar in chat: working folder tree, search and file preview.
//
// The panel looks only into the person's current workspace — the same directory
// where pi works (`/workspaces/<slug>`). Service data (`/workspaces/.icarus`) and
// other people's workspaces don't get here: the workspace name from the request is
// checked against the registry, and a relative path cannot escape the root.
// Symlinks are not resolved — otherwise a workspace file could expose the whole host.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_WORKSPACE, findUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { errorBody } from '../http/sse.ts';
import { log } from '../log.ts';
import { findWorkspace } from '../workspaces.ts';
import { displayPath } from './workspaces.ts';

const BASE = '/panel/api/workspace-files';

/** How many entries we return per request: the tree is paged lazily, folder by folder. */
const MAX_ENTRIES = 500;
/** Directory scan ceiling: we don't sort a huge folder in full. */
const SCAN_LIMIT = 2000;
/** How much text we show in the preview. Anything more — download only. */
const PREVIEW_BYTES = 256 * 1024;
/** This chunk is enough to tell whether it's text or a binary file. */
const SNIFF_BYTES = 8192;

/**
 * Search across the workspace. The panel sends it on every keystroke, so the
 * request has ceilings: a single search must not roam over gigabytes and hang the panel.
 */
export const SEARCH_MIN_QUERY = 2;
const SEARCH_MAX_QUERY = 200;
const SEARCH_MAX_HITS = 50;
/** How many lines we show from a single file: the rest is just noise. */
const SEARCH_HITS_PER_FILE = 3;
const SEARCH_MAX_FILES = 4000;
const SEARCH_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Maximum nesting depth: protection against matryoshka folders. */
const SEARCH_MAX_DEPTH = 16;
/** Line chunks before and after the match: context is visible, but not the whole minified file. */
const SEARCH_BEFORE = 60;
const SEARCH_AFTER = 120;

/** Service clutter that only gets in the way in the file tree. */
const SKIPPED = new Set(['.git', 'node_modules', '.DS_Store']);

const TYPE_LABELS: Record<string, string> = {
  '.md': 'MARKDOWN',
  '.markdown': 'MARKDOWN',
  '.mdx': 'MARKDOWN',
  '.txt': 'TEXT',
  '.log': 'LOG',
  '.json': 'JSON',
  '.jsonl': 'JSONL',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.ini': 'INI',
  '.csv': 'CSV',
  '.tsv': 'TSV',
  '.xml': 'XML',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.js': 'JS',
  '.mjs': 'JS',
  '.cjs': 'JS',
  '.ts': 'TS',
  '.tsx': 'TSX',
  '.jsx': 'JSX',
  '.py': 'PYTHON',
  '.sh': 'SHELL',
  '.bash': 'SHELL',
  '.sql': 'SQL',
  '.svg': 'SVG',
  '.png': 'PNG',
  '.jpg': 'JPG',
  '.jpeg': 'JPG',
  '.gif': 'GIF',
  '.webp': 'WEBP',
  '.avif': 'AVIF',
  '.bmp': 'BMP',
  '.ico': 'ICO',
  '.pdf': 'PDF',
  '.zip': 'ZIP',
  '.tar': 'TAR',
  '.gz': 'GZ',
};

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);

export type WorkspaceFileEntry = {
  name: string;
  /** Path inside the workspace, always with `/`. */
  path: string;
  dir: boolean;
  size: number;
  mtime: string;
  /** Label for the right edge of the row: MARKDOWN, PNG… Empty for folders. */
  type: string;
  image: boolean;
  /** Whether it can be removed from the panel. The root AGENTS.md — no: it's the workspace map. */
  removable: boolean;
};

export type WorkspaceFileList = {
  path: string;
  entries: WorkspaceFileEntry[];
  /** The folder has more files than rendered: the list is truncated. */
  truncated: boolean;
};

export type WorkspaceFilePreview = {
  file: WorkspaceFileEntry;
  kind: 'markdown' | 'text' | 'image' | 'binary';
  /** Text for markdown and plain text. */
  text?: string;
  /** The text didn't fit in full: the beginning is shown. */
  truncated?: boolean;
  /** Image URL: loaded by a separate request, not as a JSON string. */
  url?: string;
  /** Download link — every file has one. */
  download: string;
};

export type WorkspaceFileTarget = {
  workspace: { slug: string; name: string; path: string };
  root: string;
};

export type RawWorkspaceFile = { file: string; name: string; type: string; size: number };

/** A single search hit: file, line and a text chunk around the find. */
export type WorkspaceSearchHit = {
  file: WorkspaceFileEntry;
  /** Line with the match, 1-based. 0 — only the file name matched. */
  line: number;
  /** A line chunk around the match; empty if only the name matched. */
  text: string;
  /** Where the match sits in `text`: the panel highlights exactly it. */
  match: { start: number; length: number } | null;
};

export type WorkspaceSearchResult = {
  query: string;
  hits: WorkspaceSearchHit[];
  /** How many files we managed to look at: the number shows the search walked the folder. */
  scanned: number;
  /** We hit the ceiling: there may be more matches than shown. */
  truncated: boolean;
};

/** What exactly was removed: the panel uses this data to drop the row from the tree. */
export type RemovedWorkspaceEntry = {
  path: string;
  name: string;
  dir: boolean;
  /** The folder was non-empty and was removed along with its contents. */
  recursive: boolean;
};

export class FilesError extends Error {
  status: 400 | 403 | 404 | 409;

  constructor(message: string, status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = 'FilesError';
    this.status = status;
  }
}

/** File type label for the panel: an extension like `MARKDOWN` or `PNG`. */
export function typeLabelOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (TYPE_LABELS[ext]) return TYPE_LABELS[ext];
  if (!ext || ext === '.') return 'FILE';
  return ext.slice(1).toUpperCase().slice(0, 8);
}

export function isImageName(name: string): boolean {
  return IMAGE_TYPES[path.extname(name).toLowerCase()] !== undefined;
}

/**
 * The workspace from the request and its root on disk. An unknown slug is not a path
 * error but a missing folder: let the caller respond 404.
 */
export function workspaceTarget(
  config: IcarusConfig,
  user: UserConfig,
  slug: string | undefined,
): WorkspaceFileTarget | null {
  const workspace = findWorkspace(config, user, slug || DEFAULT_WORKSPACE);
  if (!workspace) return null;
  const root = path.join(userPaths(config, user).workspaces, workspace.slug);
  return {
    workspace: { slug: workspace.slug, name: workspace.name, path: displayPath(root) },
    root,
  };
}

/** Path inside the root. `..`, absolute paths and NUL are rejected before touching the disk. */
function resolveIn(root: string, relative: string): string | null {
  if (relative.includes('\u0000')) return null;
  const full = path.resolve(root, relative);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** The real path does not escape the root even through symlinks. */
function realInside(root: string, full: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(full);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * The root AGENTS.md is the workspace map: pi reads it before every turn, and
 * the panel must not leave the workspace without instructions. Nested AGENTS.md
 * (e.g. `projects/AGENTS.md`) are ordinary project files and can be deleted.
 */
export function isProtectedWorkspacePath(relative: string): boolean {
  return toPosix(relative) === 'AGENTS.md';
}

function entryOf(file: string, relative: string, dir: boolean, stats: fs.Stats): WorkspaceFileEntry {
  const name = path.basename(file);
  const normalized = toPosix(relative);
  return {
    name,
    path: normalized,
    dir,
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    type: dir ? '' : typeLabelOf(name),
    image: dir ? false : isImageName(name),
    removable: !isProtectedWorkspacePath(normalized),
  };
}

/** Contents of a single folder. Files come before folders — that way the root immediately
 *  shows AGENTS.md and other working files, as in the panel mockup. */
export function listWorkspaceEntries(root: string, relative = ''): WorkspaceFileList {
  const dir = resolveIn(root, relative);
  if (!dir || !realInside(root, dir)) throw new FilesError('путь ведёт за пределы workspace', 400);

  let info: fs.Stats;
  try {
    info = fs.lstatSync(dir);
  } catch {
    throw new FilesError('папка не найдена', 404);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new FilesError('это не папка', 400);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new FilesError('не удалось прочитать папку', 404);
  }

  const collected: WorkspaceFileEntry[] = [];
  for (const dirent of dirents) {
    if (SKIPPED.has(dirent.name) || dirent.isSymbolicLink()) continue;
    if (!dirent.isDirectory() && !dirent.isFile()) continue;
    const file = path.join(dir, dirent.name);
    const nested = relative ? path.join(relative, dirent.name) : dirent.name;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      continue;
    }
    collected.push(entryOf(file, nested, dirent.isDirectory(), stats));
    // We don't sort a folder with tens of thousands of files in full: the panel
    // only shows the first MAX_ENTRIES anyway.
    if (collected.length >= SCAN_LIMIT) break;
  }

  collected.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? 1 : -1;
    return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
  });

  return {
    path: toPosix(relative),
    entries: collected.slice(0, MAX_ENTRIES),
    truncated: collected.length > MAX_ENTRIES,
  };
}

function rawUrl(slug: string, relative: string, download = false): string {
  const query = new URLSearchParams({ workspace: slug, path: relative });
  if (download) query.set('download', '1');
  return `${BASE}/raw?${query.toString()}`;
}

/**
 * A single tree entry: the path inside the workspace and its stat. We don't let the
 * workspace root in here — the panel shows and deletes contents, not the folder itself.
 */
function resolveEntry(
  root: string,
  relative: string,
): { full: string; stats: fs.Stats; entry: WorkspaceFileEntry } {
  const full = resolveIn(root, relative);
  const base = path.resolve(root);
  if (!full || full === base || !relative.trim() || !realInside(root, full)) {
    throw new FilesError('путь ведёт за пределы workspace', 400);
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(full);
  } catch {
    throw new FilesError('файл не найден', 404);
  }
  if (stats.isSymbolicLink()) throw new FilesError('символические ссылки не показываются', 400);
  if (!stats.isFile() && !stats.isDirectory()) throw new FilesError('это не файл и не папка', 400);
  return { full, stats, entry: entryOf(full, relative, stats.isDirectory(), stats) };
}

function fileEntry(root: string, relative: string): { full: string; entry: WorkspaceFileEntry } {
  const resolved = resolveEntry(root, relative);
  if (!resolved.stats.isFile()) throw new FilesError('это не файл', 400);
  return { full: resolved.full, entry: resolved.entry };
}

/**
 * Removes a file or folder. We don't touch a non-empty folder without an explicit
 * `force`: the client first asks for confirmation and only then repeats the request.
 * An empty folder is deleted at once — there is nothing to warn about.
 */
export function removeWorkspaceEntry(
  root: string,
  relative: string,
  force = false,
): RemovedWorkspaceEntry {
  const { full, stats, entry } = resolveEntry(root, relative);
  if (!entry.removable) {
    throw new FilesError('корневой AGENTS.md удалить нельзя: это инструкции агента в workspace', 403);
  }

  if (stats.isDirectory()) {
    let empty: boolean;
    try {
      empty = fs.readdirSync(full).length === 0;
    } catch {
      throw new FilesError('не удалось прочитать папку', 404);
    }
    if (!empty && !force) throw new FilesError('папка не пуста', 409);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (error) {
      throw new FilesError(`не удалось удалить папку: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
    return { path: entry.path, name: entry.name, dir: true, recursive: !empty };
  }

  try {
    fs.rmSync(full, { force: true });
  } catch (error) {
    throw new FilesError(`не удалось удалить файл: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  return { path: entry.path, name: entry.name, dir: false, recursive: false };
}

/**
 * The beginning of a file as text. Shared by preview and search: both decide from
 * the first bytes whether it's text or a binary file, and neither reads beyond the ceiling.
 */
function readTextHead(
  full: string,
  limit: number,
): { text: string; truncated: boolean; binary: boolean } {
  const fd = fs.openSync(full, 'r');
  try {
    const buffer = Buffer.allocUnsafe(limit + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(read, limit));
    const head = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));
    // A NUL at the start of the file is a sufficient sign of a binary file: that's how
    // archives, images of unknown format and anything not worth showing as text look.
    return { text: bytes.toString('utf8'), truncated: read > limit, binary: head.includes(0) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * File preview: markdown and text as a string, images as a URL, everything else
 * is honestly called binary. Large text is returned as its beginning rather than an
 * error: a person more often wants a peek than a full download.
 */
export function previewWorkspaceFile(root: string, slug: string, relative: string): WorkspaceFilePreview {
  const { full, entry } = fileEntry(root, relative);
  const download = rawUrl(slug, entry.path, true);
  if (entry.image) {
    return { file: entry, kind: 'image', url: rawUrl(slug, entry.path), download };
  }

  let head: { text: string; truncated: boolean; binary: boolean };
  try {
    head = readTextHead(full, PREVIEW_BYTES);
  } catch {
    throw new FilesError('не удалось прочитать файл', 404);
  }
  if (head.binary) return { file: entry, kind: 'binary', download };
  const kind = MARKDOWN_EXT.has(path.extname(entry.name).toLowerCase()) ? 'markdown' : 'text';
  return { file: entry, kind, text: head.text, truncated: head.truncated, download };
}

/** Literal for the regexp: the query is text, not a pattern. */
function queryPattern(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A line chunk around the match with ellipses. The offset is counted inside the
 *  chunk already: the panel highlights exactly the find, not the first letter it hits. */
function lineSnippet(line: string, index: number, length: number): { text: string; start: number } {
  const from = Math.max(0, index - SEARCH_BEFORE);
  const to = Math.min(line.length, index + length + SEARCH_AFTER);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < line.length ? '…' : '';
  return {
    text: prefix + line.slice(from, to) + suffix,
    start: prefix.length + (index - from),
  };
}

/** Matches in the text: no more than `limit` lines, each with a number and a chunk. */
function textHits(
  entry: WorkspaceFileEntry,
  text: string,
  pattern: string,
  limit: number,
): WorkspaceSearchHit[] {
  const probe = new RegExp(pattern, 'i');
  const global = new RegExp(pattern, 'gi');
  const hits: WorkspaceSearchHit[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let number = 0; number < lines.length && hits.length < limit; number += 1) {
    const line = lines[number];
    if (!probe.test(line)) continue;
    global.lastIndex = 0;
    for (let match = global.exec(line); match && hits.length < limit; match = global.exec(line)) {
      const snippet = lineSnippet(line, match.index, match[0].length);
      hits.push({
        file: entry,
        line: number + 1,
        text: snippet.text,
        match: { start: snippet.start, length: match[0].length },
      });
      // An empty match would loop exec; the minimum query length already cuts it
      // off, but the last line of defense is cheap.
      if (!match[0]) break;
    }
  }
  return hits;
}

/**
 * Search across all workspace files: by name and by content. It walks the same way
 * as the tree: service folders and symlinks are skipped, images and binary files are
 * checked by name only — there is nothing to show of their content.
 */
export function searchWorkspaceFiles(root: string, rawQuery: string): WorkspaceSearchResult {
  const query = rawQuery.trim();
  if (query.length < SEARCH_MIN_QUERY) {
    throw new FilesError(`поиск: нужно хотя бы ${SEARCH_MIN_QUERY} символа`, 400);
  }
  if (query.length > SEARCH_MAX_QUERY) throw new FilesError('поиск: слишком длинный запрос', 400);

  const pattern = queryPattern(query);
  const nameProbe = new RegExp(pattern, 'i');
  const hits: WorkspaceSearchHit[] = [];
  let scanned = 0;
  let bytes = 0;
  let truncated = false;

  /** Walk in the same order as the tree: files first, then folders. */
  const walk = (relative: string, depth: number): void => {
    if (hits.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_FILES) {
      truncated = true;
      return;
    }
    if (depth > SEARCH_MAX_DEPTH) return;

    const dir = resolveIn(root, relative);
    if (!dir || !realInside(root, dir)) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
      return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
    });

    for (const dirent of dirents) {
      if (hits.length >= SEARCH_MAX_HITS || scanned >= SEARCH_MAX_FILES) {
        truncated = true;
        return;
      }
      if (SKIPPED.has(dirent.name) || dirent.isSymbolicLink()) continue;
      const full = path.join(dir, dirent.name);
      const nested = relative ? path.join(relative, dirent.name) : dirent.name;
      if (dirent.isDirectory()) {
        walk(nested, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;

      scanned += 1;
      let stats: fs.Stats;
      try {
        stats = fs.statSync(full);
      } catch {
        continue;
      }
      const entry = entryOf(full, nested, false, stats);
      if (nameProbe.test(entry.name)) {
        hits.push({ file: entry, line: 0, text: '', match: null });
        if (hits.length >= SEARCH_MAX_HITS) {
          truncated = true;
          return;
        }
      }
      // We search content only in text: an image and a binary file have none,
      // and a huge file must not eat the whole request budget.
      if (entry.image || entry.size > SEARCH_MAX_BYTES) continue;
      const budget = Math.min(SEARCH_MAX_BYTES, SEARCH_MAX_TOTAL_BYTES - bytes);
      if (budget <= 0) {
        truncated = true;
        return;
      }
      let head: { text: string; truncated: boolean; binary: boolean };
      try {
        head = readTextHead(full, budget);
      } catch {
        continue;
      }
      bytes += Math.min(entry.size, budget);
      if (head.binary) continue;
      const left = Math.min(SEARCH_HITS_PER_FILE, SEARCH_MAX_HITS - hits.length);
      if (left <= 0) {
        truncated = true;
        return;
      }
      hits.push(...textHits(entry, head.text, pattern, left));
    }
  };

  walk('', 0);
  return {
    query,
    hits,
    scanned,
    // Reaching the ceiling doesn't mean there are more matches, but we can't promise
    // «that's all» in that case: let the panel honestly report the ceiling.
    truncated: truncated || hits.length >= SEARCH_MAX_HITS,
  };
}

/** File to hand to the browser: images as-is, the rest for download. */
export function rawWorkspaceFile(root: string, relative: string): RawWorkspaceFile | null {
  try {
    const { full, entry } = fileEntry(root, relative);
    return {
      file: full,
      name: entry.name,
      type: IMAGE_TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
      size: entry.size,
    };
  } catch {
    return null;
  }
}

/** Name for `content-disposition`: an ASCII fallback and honest UTF-8. */
export function downloadHeader(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export async function handleWorkspaceFilesApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { config: IcarusConfig; userId: string },
): Promise<void> {
  const user = findUser(ctx.config, ctx.userId);
  if (!user) {
    json(res, 404, errorBody(`пользователь ${ctx.userId} не заведён`));
    return;
  }

  const target = workspaceTarget(ctx.config, user, url.searchParams.get('workspace') ?? undefined);
  if (!target) {
    json(res, 404, errorBody('workspace не найден'));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    json(res, 405, errorBody('метод не поддерживается'));
    return;
  }

  const rest = url.pathname.slice(BASE.length).replace(/^\/+/, '');
  const relative = url.searchParams.get('path') ?? '';
  try {
    if (req.method === 'DELETE') {
      if (rest) {
        json(res, 405, errorBody('удалять можно только файл или папку, а не подмаршрут'));
        return;
      }
      const removed = removeWorkspaceEntry(target.root, relative, url.searchParams.get('force') === '1');
      log.info('файлы: удалено', {
        user: user.id,
        workspace: target.workspace.slug,
        path: removed.path,
        dir: removed.dir,
        recursive: removed.recursive,
      });
      json(res, 200, { ok: true, ...removed });
      return;
    }

    if (!rest) {
      const list = listWorkspaceEntries(target.root, relative);
      json(res, 200, { workspace: target.workspace, ...list });
      return;
    }

    if (rest === 'search') {
      const result = searchWorkspaceFiles(target.root, url.searchParams.get('q') ?? '');
      log.info('файлы: поиск', {
        user: user.id,
        workspace: target.workspace.slug,
        query: result.query,
        hits: result.hits.length,
        scanned: result.scanned,
      });
      json(res, 200, result);
      return;
    }

    if (rest === 'read') {
      const preview = previewWorkspaceFile(target.root, target.workspace.slug, relative);
      json(res, 200, preview);
      return;
    }

    if (rest === 'raw') {
      const raw = rawWorkspaceFile(target.root, relative);
      if (!raw) {
        json(res, 404, errorBody('файл не найден или недоступен'));
        return;
      }
      const download = url.searchParams.get('download') === '1';
      const inline = !download && raw.type.startsWith('image/');
      res.writeHead(200, {
        'content-type': inline ? raw.type : 'application/octet-stream',
        // The same person just saw the file in the tree: they may cache the image
        // for a short while. The panel's shared cache has nothing to do with this.
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
        // SVG is a document: opened directly, it could execute a script in the
        // panel origin. Sandbox leaves the image nothing but the image.
        ...(inline ? { 'content-security-policy': 'sandbox' } : {}),
        ...(inline ? {} : { 'content-disposition': downloadHeader(raw.name) }),
      });
      fs.createReadStream(raw.file)
        .on('error', (error) => {
          log.warn('файлы: не удалось отдать файл', { user: user.id, path: relative, error: String(error) });
          res.destroy();
        })
        .pipe(res);
      return;
    }

    json(res, 404, errorBody(`неизвестный маршрут файлов: ${url.pathname}`));
  } catch (error) {
    if (error instanceof FilesError) {
      json(res, error.status, errorBody(error.message));
      return;
    }
    log.error('файлы: ошибка API', { user: user.id, workspace: target.workspace.slug, error: String(error) });
    json(res, 500, errorBody('не удалось обработать файлы workspace', 'server_error'));
  }
}
