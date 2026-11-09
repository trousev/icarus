// Сайд-панель файлов в чате: дерево рабочей папки и предпросмотр одного файла.
//
// Панель смотрит только в текущий workspace человека — тот же каталог, в котором
// работает pi (`/workspaces/<slug>`). Служебное (`/workspaces/.icarus`) и чужие
// workspace'ы сюда не попадают: имя workspace'а из запроса сверяется с реестром,
// а относительный путь не может вывести за корень. Символические ссылки не
// раскрываются — иначе файл воркспейса мог бы показать весь хост.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_WORKSPACE, findUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { errorBody } from '../http/sse.ts';
import { log } from '../log.ts';
import { findWorkspace } from '../workspaces.ts';
import { displayPath } from './workspaces.ts';

const BASE = '/panel/api/workspace-files';

/** Сколько строк отдаём за один заход: дерево листается лениво, по папкам. */
const MAX_ENTRIES = 500;
/** Потолок разбора каталога: огромную папку не сортируем целиком. */
const SCAN_LIMIT = 2000;
/** Сколько текста показываем в предпросмотре. Больше — только скачать. */
const PREVIEW_BYTES = 256 * 1024;
/** По этому куску понятно, текст это или двоичный файл. */
const SNIFF_BYTES = 8192;

/** Служебный мусор, который в дереве файлов только мешает. */
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
  /** Путь внутри workspace, всегда через `/`. */
  path: string;
  dir: boolean;
  size: number;
  mtime: string;
  /** Подпись для правого края строки: MARKDOWN, PNG… У папок пусто. */
  type: string;
  image: boolean;
  /** Можно ли удалить из панели. Корневой AGENTS.md — нет: это карта workspace'а. */
  removable: boolean;
};

export type WorkspaceFileList = {
  path: string;
  entries: WorkspaceFileEntry[];
  /** В папке больше файлов, чем отрисовано: список обрезан. */
  truncated: boolean;
};

export type WorkspaceFilePreview = {
  file: WorkspaceFileEntry;
  kind: 'markdown' | 'text' | 'image' | 'binary';
  /** Текст для markdown и обычного текста. */
  text?: string;
  /** Текст не влез целиком: показано начало. */
  truncated?: boolean;
  /** Адрес картинки: грузится отдельным запросом, а не строкой JSON. */
  url?: string;
  /** Ссылка на скачивание — есть у любого файла. */
  download: string;
};

export type WorkspaceFileTarget = {
  workspace: { slug: string; name: string; path: string };
  root: string;
};

export type RawWorkspaceFile = { file: string; name: string; type: string; size: number };

/** Что именно удалили: панель по этим данным убирает строку из дерева. */
export type RemovedWorkspaceEntry = {
  path: string;
  name: string;
  dir: boolean;
  /** Папка была не пуста и удалена вместе с содержимым. */
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

/** Подпись типа файла для панели: расширение вроде `MARKDOWN` или `PNG`. */
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
 * Workspace из запроса и его корень на диске. Незнакомый slug — не ошибка пути,
 * а отсутствие папки: пусть вызывающий ответит 404.
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

/** Путь внутри корня. `..`, абсолютные пути и NUL отсекаются до похода на диск. */
function resolveIn(root: string, relative: string): string | null {
  if (relative.includes('\u0000')) return null;
  const full = path.resolve(root, relative);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** Настоящий путь не выходит за корень даже через символические ссылки. */
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
 * Корневой AGENTS.md — карта workspace'а: pi читает его перед каждым ходом, и
 * панель не должна оставлять workspace без инструкций. Вложенные AGENTS.md
 * (например, `projects/AGENTS.md`) — обычные файлы проекта, их удалять можно.
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

/** Содержимое одной папки. Файлы идут перед папками — так корень сразу показывает
 *  AGENTS.md и другие рабочие файлы, как в макете панели. */
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
    // Папку с десятком тысяч файлов не сортируем целиком: панель всё равно
    // показывает только первые MAX_ENTRIES.
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
 * Один вход в дерево: путь внутри workspace и его stat. Корень workspace'а
 * сюда не пускаем — панель показывает и удаляет содержимое, а не саму папку.
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
 * Удаляет файл или папку. Непустую папку без явного `force` не трогаем: клиент
 * сначала спрашивает подтверждение, и только потом повторяет запрос. Пустая
 * папка удаляется сразу — предупреждать в ней не о чем.
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
 * Предпросмотр файла: markdown и текст — строкой, картинки — адресом, всё
 * остальное честно называется двоичным. Большой текст отдаём началом, а не
 * ошибкой: человек чаще хочет заглянуть, чем скачать целиком.
 */
export function previewWorkspaceFile(root: string, slug: string, relative: string): WorkspaceFilePreview {
  const { full, entry } = fileEntry(root, relative);
  const download = rawUrl(slug, entry.path, true);
  if (entry.image) {
    return { file: entry, kind: 'image', url: rawUrl(slug, entry.path), download };
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(full, 'r');
    const buffer = Buffer.allocUnsafe(PREVIEW_BYTES + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(read, PREVIEW_BYTES));
    const head = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));
    // NUL в начале файла — достаточный признак двоичного: так выглядят архивы,
    // картинки неизвестного формата и всё, что не стоит показывать текстом.
    if (head.includes(0)) return { file: entry, kind: 'binary', download };
    const text = bytes.toString('utf8');
    const kind = MARKDOWN_EXT.has(path.extname(entry.name).toLowerCase()) ? 'markdown' : 'text';
    return { file: entry, kind, text, truncated: read > PREVIEW_BYTES, download };
  } catch {
    throw new FilesError('не удалось прочитать файл', 404);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Файл для отдачи браузеру: картинки — как есть, остальное — на скачивание. */
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

/** Имя для `content-disposition`: ASCII-запасной вариант и честный UTF-8. */
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
        // Тот же человек только что видел файл в дереве: ему можно закэшировать
        // картинку ненадолго. Общий кэш панели тут ни при чём.
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
        // SVG — это документ: открытый напрямую, он мог бы исполнить скрипт в
        // origin панели. Sandbox оставляет картинке только картинку.
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
