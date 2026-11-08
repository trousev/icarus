// Глобальная библиотека артефактов.
//
// Артефакт — это папка `<dataDir>/artifacts/<slug>/`, одна на всю семью. Она
// монтируется в контейнер каждого человека как `/artifacts`, поэтому модель
// видит библиотеку целиком, а не только свою рабочую папку.
//
// Внутри папки:
//
//   index.html | index.md | index.png|jpg|svg — то, что видит человек;
//   index.ai.md                                — короткое описание для ИИ;
//   .artifact.json                             — публичная ссылка (publicId);
//   .folder-acl.json                          — владелец и права.
//
// Права — матрица «субъект × уровень»:
//
//   me     — владелец артефакта;
//   family — все остальные;
//   read ⊂ write ⊂ admin.
//
// Владелец всегда может управлять своим артефактом (иначе можно было бы
// заблокировать себя), но уровень me управляет тем, что ему позволяет агент.
// Файл `.folder-acl.json` намеренно общий для любого каталога, а не только
// артефактов: тот же формат читает generic folder-guard в расширениях.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from './config.ts';
import { listWorkspaces } from './workspaces.ts';

/** Имя глобального каталога внутри dataDir. */
export const ARTIFACTS_DIR = 'artifacts';

/** Скрытая метка артефакта: publicId и даты. Человеку она не видна. */
export const META_FILE = '.artifact.json';

/** Права папки. Один и тот же формат у артефактов и будущих общих каталогов. */
export const ACL_FILE = '.folder-acl.json';

export type ArtifactType = 'html' | 'markdown' | 'image';
export type AccessLevel = 'read' | 'write' | 'admin';

export type FolderAcl = {
  /** Уровень владельца. */
  me: AccessLevel;
  /** Уровень всех остальных. */
  family: AccessLevel;
};

export type ArtifactAcl = {
  version: number;
  owner: string;
  acl: FolderAcl;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_ACL: FolderAcl = { me: 'admin', family: 'read' };

export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  html: 'HTML-страница',
  markdown: 'Markdown-документ',
  image: 'Изображение',
};

const INDEX_FILES: ReadonlyArray<{ file: string; type: ArtifactType }> = [
  { file: 'index.html', type: 'html' },
  { file: 'index.htm', type: 'html' },
  { file: 'index.md', type: 'markdown' },
  { file: 'index.png', type: 'image' },
  { file: 'index.jpg', type: 'image' },
  { file: 'index.jpeg', type: 'image' },
  { file: 'index.svg', type: 'image' },
  { file: 'index.webp', type: 'image' },
  { file: 'index.gif', type: 'image' },
];

export const AI_FILE = 'index.ai.md';

export type Artifact = {
  name: string;
  title: string;
  type: ArtifactType;
  typeLabel: string;
  entry: string;
  size: number;
  updatedAt: string;
  summary: string;
  ai: boolean;
  files: string[];
  /** Чей артефакт. У мигрированных старых папок это автор рабочей папки. */
  owner: string;
  acl: FolderAcl;
  /** Что может текущий смотрящий. */
  access: AccessLevel;
  canRead: boolean;
  canWrite: boolean;
  /** Управление правами, удалением и публичной ссылкой. */
  canManage: boolean;
  publicId?: string;
  urls: ArtifactUrls;
};

export type ArtifactUrls = {
  /** Ссылка в панели (за SSO). */
  panel: string;
  /** Файл без панели: index как есть; у markdown это исходник. */
  raw: string;
  /** Публичная ссылка с панелью; её открывает любой, у кого она есть. */
  public?: string;
  /** Публичная ссылка без панели. */
  bare?: string;
};

export class ArtifactError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.name = 'ArtifactError';
    this.status = status;
  }
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;
const NAME_LIMIT = 128;
const DOC_LIMIT = 256 * 1024;
const FILE_LIMIT = 400;
const LEVELS: Record<AccessLevel, number> = { read: 1, write: 2, admin: 3 };

export function isAccessLevel(value: unknown): value is AccessLevel {
  return value === 'read' || value === 'write' || value === 'admin';
}

export function levelRank(level: AccessLevel): number {
  return LEVELS[level];
}

/** Что даёт уровень: следующий включает предыдущий. */
export function allows(level: AccessLevel, required: AccessLevel): boolean {
  return levelRank(level) >= levelRank(required);
}

/** Уровень смотрящего по матрице «владелец → me, остальные → family». */
export function accessFor(owner: string, acl: FolderAcl, viewer: string): AccessLevel {
  return viewer === owner ? acl.me : acl.family;
}

/** Имя папки-артефакта: без слешей, без выхода из каталога, без скрытых имён. */
export function isArtifactName(value: string): boolean {
  for (const char of value) if (char.charCodeAt(0) < 32) return false;
  return (
    value.length > 0 &&
    value.length <= NAME_LIMIT &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('.') &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

/** Глобальный каталог артефактов: один на инсталляцию. */
export function artifactsRoot(config: IcarusConfig): string {
  return path.join(config.dataDir, ARTIFACTS_DIR);
}

export function ensureArtifactsRoot(config: IcarusConfig): string {
  const root = artifactsRoot(config);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeJoin(root: string, ...segments: string[]): string | null {
  const full = path.resolve(root, ...segments);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function hidden(name: string): boolean {
  return name.startsWith('.');
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function realDirOrNull(dir: string): string | null {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
  return dir;
}

function readTextIfSmall(file: string): string | null {
  const stats = statOrNull(file);
  if (!stats || !stats.isFile() || stats.size > DOC_LIMIT) return null;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, file);
}

/** YAML-frontmatter в начале index.ai.md — метаданные, а не заголовок и не описание. */
function stripFrontmatter(text: string): string {
  const source = text.replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return source;
  return source.slice(end + 4).replace(/^\s*\n/, '');
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleOf(slug: string, ai: string | null, document: string | null): string {
  if (ai) {
    const text = stripFrontmatter(ai);
    const heading = /^\s*#\s+(.+?)\s*$/m.exec(text)?.[1];
    if (heading) return stripMarkdown(heading);
    const first = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && line !== '---' && !line.startsWith('#'));
    if (first) return stripMarkdown(first).slice(0, 90);
  }
  if (document) {
    const text = stripFrontmatter(document);
    const heading = /^\s*#\s+(.+?)\s*$/m.exec(text)?.[1];
    if (heading) return stripMarkdown(heading).slice(0, 90);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
    if (title) return stripMarkdown(title.replace(/\s+/g, ' ').trim()).slice(0, 90);
  }
  const human = slug.replace(/[-_]+/g, ' ').trim();
  return human === '' ? slug : human.charAt(0).toUpperCase() + human.slice(1);
}

export function summaryOf(ai: string | null): string {
  if (!ai) return '';
  const text = stripFrontmatter(ai);
  for (const paragraph of text.split(/\n\s*\n/)) {
    const lines = paragraph
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '---' && !line.startsWith('#') && !line.startsWith('```'));
    if (lines.length === 0) continue;
    const summary = stripMarkdown(lines.join(' '));
    if (summary !== '') return summary.length > 180 ? `${summary.slice(0, 177)}…` : summary;
  }
  return '';
}

function readableDate(date: Date): string {
  return date.toISOString();
}

export function listFiles(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (hidden(entry.name) || entry.isSymbolicLink()) continue;
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), `${relative}/`));
      if (files.length >= FILE_LIMIT) return files.slice(0, FILE_LIMIT);
      continue;
    }
    if (entry.isFile()) files.push(relative);
  }
  return files;
}

export function detectEntry(dir: string): { file: string; type: ArtifactType } | null {
  let names: Set<string>;
  try {
    names = new Set(fs.readdirSync(dir));
  } catch {
    return null;
  }
  for (const candidate of INDEX_FILES) {
    if (names.has(candidate.file)) return candidate;
  }
  return null;
}

/** Права папки: null — файла нет или он битый. */
export function readAcl(dir: string): ArtifactAcl | null {
  const text = readTextIfSmall(path.join(dir, ACL_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const raw = parsed as { owner?: unknown; acl?: unknown; createdAt?: unknown; updatedAt?: unknown };
    if (typeof raw.owner !== 'string' || raw.owner.trim() === '') return null;
    if (!raw.acl || typeof raw.acl !== 'object' || Array.isArray(raw.acl)) return null;
    const acl = raw.acl as { me?: unknown; family?: unknown };
    if (!isAccessLevel(acl.me) || !isAccessLevel(acl.family)) return null;
    return {
      version: 1,
      owner: raw.owner,
      acl: { me: acl.me, family: acl.family },
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function writeAcl(dir: string, owner: string, acl: FolderAcl, created?: string): ArtifactAcl {
  const now = new Date().toISOString();
  const next: ArtifactAcl = {
    version: 1,
    owner,
    acl: { me: acl.me, family: acl.family },
    createdAt: created ?? now,
    updatedAt: now,
  };
  writeJsonAtomic(path.join(dir, ACL_FILE), next);
  return next;
}

export function readMeta(dir: string): { publicId?: string } | null {
  const text = readTextIfSmall(path.join(dir, META_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const meta = parsed as { publicId?: unknown };
    return typeof meta.publicId === 'string' && PUBLIC_ID.test(meta.publicId)
      ? { publicId: meta.publicId }
      : {};
  } catch {
    return null;
  }
}

export function writeMeta(dir: string, publicId: string): void {
  const now = new Date().toISOString();
  writeJsonAtomic(path.join(dir, META_FILE), { version: 1, publicId, createdAt: now, updatedAt: now });
}

export function artifactUrls(
  config: IcarusConfig,
  slug: string,
  entry: string,
  publicId?: string,
): ArtifactUrls {
  const base = config.url.replace(/\/+$/, '');
  const name = encodeURIComponent(slug);
  const entryPath = entry.split('/').map(encodeURIComponent).join('/');
  const panel = `${base}/panel/artifacts?artifact=${name}`;
  const raw = `${base}/panel/artifacts/raw/${name}/${entryPath}`;
  if (!publicId || !PUBLIC_ID.test(publicId)) return { panel, raw };
  const pub = `${base}/a/${name}/${publicId}/`;
  return { panel, raw, public: pub, bare: `${pub}?bare=1` };
}

export function artifactDir(config: IcarusConfig, slug: string): string | null {
  if (!isArtifactName(slug)) return null;
  const dir = safeJoin(ensureArtifactsRoot(config), slug);
  return dir ? realDirOrNull(dir) : null;
}

/**
 * Артефакт глазами смотрящего. null — папки нет, index-файла нет или нет ACL:
 * без прав артефакт не существует для чужих инструментов и панели.
 */
export function inspectArtifact(config: IcarusConfig, slug: string, viewer: string): Artifact | null {
  const dir = artifactDir(config, slug);
  if (!dir) return null;
  const aclFile = readAcl(dir);
  if (!aclFile) return null;
  const found = detectEntry(dir);
  if (!found) return null;
  const entryPath = path.join(dir, found.file);
  const entryStats = statOrNull(entryPath);
  if (!entryStats?.isFile()) return null;
  try {
    if (fs.lstatSync(entryPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }

  const ai = readTextIfSmall(path.join(dir, AI_FILE));
  const document =
    found.type === 'html' || found.type === 'markdown'
      ? readTextIfSmall(path.join(dir, found.file))
      : null;
  const meta = readMeta(dir);
  const access = accessFor(aclFile.owner, aclFile.acl, viewer);
  const ownerViewer = viewer === aclFile.owner;
  return {
    name: slug,
    title: titleOf(slug, ai, document),
    type: found.type,
    typeLabel: ARTIFACT_TYPE_LABELS[found.type],
    entry: found.file,
    size: entryStats.size,
    updatedAt: readableDate(entryStats.mtime),
    summary: summaryOf(ai),
    ai: ai !== null,
    files: listFiles(dir),
    owner: aclFile.owner,
    acl: aclFile.acl,
    access,
    canRead: allows(access, 'read'),
    canWrite: allows(access, 'write'),
    // Владелец управляет своим артефактом всегда: иначе он мог бы выставить
    // себе read и навсегда потерять доступ к настройкам прав.
    canManage: ownerViewer || allows(access, 'admin'),
    ...(meta?.publicId === undefined ? {} : { publicId: meta.publicId }),
    urls: artifactUrls(config, slug, found.file, meta?.publicId),
  };
}

/** Все артефакты, которые этот человек вправе видеть. */
export function listArtifacts(config: IcarusConfig, viewer: string): Artifact[] {
  const root = ensureArtifactsRoot(config);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const artifacts: Artifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || hidden(entry.name)) continue;
    const artifact = inspectArtifact(config, entry.name, viewer);
    if (artifact?.canRead) artifacts.push(artifact);
  }
  return artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'ru'));
}

export function countArtifacts(config: IcarusConfig, viewer: string): number {
  return listArtifacts(config, viewer).length;
}

/** Чтение содержимого: без read — честный 403. */
export function readArtifact(
  config: IcarusConfig,
  viewer: string,
  slug: string,
): { artifact: Artifact; ai: string | null; content: string | null; dir: string } {
  const artifact = inspectArtifact(config, slug, viewer);
  if (!artifact) throw new ArtifactError('артефакт не найден', 404);
  if (!artifact.canRead) throw new ArtifactError('нет права читать этот артефакт', 403);
  const dir = artifactDir(config, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  return {
    artifact,
    ai: readTextIfSmall(path.join(dir, AI_FILE)),
    content: artifact.type === 'markdown' ? readTextIfSmall(path.join(dir, artifact.entry)) : null,
    dir,
  };
}

export function ensurePublicId(
  config: IcarusConfig,
  viewer: string,
  slug: string,
): { artifact: Artifact; publicId: string } {
  const artifact = inspectArtifact(config, slug, viewer);
  if (!artifact) throw new ArtifactError('артефакт не найден', 404);
  if (!artifact.canManage) throw new ArtifactError('публичную ссылку делает владелец или админ артефакта', 403);
  if (artifact.publicId) return { artifact, publicId: artifact.publicId };
  const dir = artifactDir(config, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  const publicId = crypto.randomBytes(18).toString('base64url');
  writeMeta(dir, publicId);
  const next = inspectArtifact(config, slug, viewer);
  return { artifact: next ?? artifact, publicId };
}

export function clearPublicId(config: IcarusConfig, viewer: string, slug: string): Artifact {
  const artifact = inspectArtifact(config, slug, viewer);
  if (!artifact) throw new ArtifactError('артефакт не найден', 404);
  if (!artifact.canManage) throw new ArtifactError('ссылку отзывает владелец или админ артефакта', 403);
  const dir = artifactDir(config, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  try {
    fs.rmSync(path.join(dir, META_FILE), { force: true });
  } catch (error) {
    throw new ArtifactError(`не удалось отозвать ссылку: ${error instanceof Error ? error.message : String(error)}`, 409);
  }
  return inspectArtifact(config, slug, viewer) ?? artifact;
}

/** Менять права может владелец или админ; уровни — только read/write/admin. */
export function setAcl(
  config: IcarusConfig,
  viewer: string,
  slug: string,
  acl: FolderAcl,
): Artifact {
  const artifact = inspectArtifact(config, slug, viewer);
  if (!artifact) throw new ArtifactError('артефакт не найден', 404);
  if (!artifact.canManage) throw new ArtifactError('права меняет владелец или админ артефакта', 403);
  if (!isAccessLevel(acl.me) || !isAccessLevel(acl.family)) {
    throw new ArtifactError('уровень прав — read, write или admin', 400);
  }
  const dir = artifactDir(config, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  writeAcl(dir, artifact.owner, acl, readAcl(dir)?.createdAt);
  const next = inspectArtifact(config, slug, viewer);
  if (!next) throw new ArtifactError('артефакт не найден', 404);
  return next;
}

export function trashArtifact(config: IcarusConfig, viewer: string, slug: string): string {
  const artifact = inspectArtifact(config, slug, viewer);
  if (!artifact) throw new ArtifactError('артефакт не найден', 404);
  if (!artifact.canManage) throw new ArtifactError('удаляет владелец или админ артефакта', 403);
  const dir = artifactDir(config, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  const root = ensureArtifactsRoot(config);
  const trash = path.join(root, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = safeJoin(trash, `${slug}-${stamp}`);
  if (!target) throw new ArtifactError('не удалось подготовить удаление', 400);
  try {
    fs.renameSync(dir, target);
  } catch (error) {
    throw new ArtifactError(`не удалось удалить: ${error instanceof Error ? error.message : String(error)}`, 409);
  }
  return target;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function artifactFileUnchecked(
  config: IcarusConfig,
  slug: string,
  relative: string,
): { file: string; type: string } | null {
  const dir = artifactDir(config, slug);
  if (!dir) return null;
  const clean = relative.replace(/^\/+/, '');
  if (clean === '' || clean.includes('\u0000')) return null;
  const segments = clean.split('/');
  if (segments.some((segment) => segment.startsWith('.') || segment === AI_FILE)) return null;
  const file = safeJoin(dir, clean);
  if (!file) return null;
  const stats = statOrNull(file);
  if (!stats?.isFile()) return null;
  try {
    const real = fs.realpathSync(file);
    const realDir = fs.realpathSync(dir);
    if (real !== realDir && !real.startsWith(realDir + path.sep)) return null;
  } catch {
    return null;
  }
  return { file, type: mimeOf(file) };
}

/** Файл артефакта: требует read и не выпускает за папку. */
export function artifactFile(
  config: IcarusConfig,
  viewer: string,
  slug: string,
  relative: string,
): { file: string; type: string } | null {
  const artifact = inspectArtifact(config, slug, viewer);
  if (!artifact?.canRead) return null;
  return artifactFileUnchecked(config, slug, relative);
}

/** Файл по уже проверенной публичной ссылке: ACL не нужен, publicId уже проверен. */
export function publicArtifactFile(
  config: IcarusConfig,
  slug: string,
  relative: string,
): { file: string; type: string } | null {
  return artifactFileUnchecked(config, slug, relative);
}

/**
 * Публичный артефакт: только по случайному publicId, без ACL и без SSO.
 * Публичная ссылка — осознанное «покажи вот этот», а не доступ по умолчанию.
 */
export function publicArtifact(
  config: IcarusConfig,
  slug: string,
  publicId: string,
): { artifact: Artifact; dir: string } | null {
  if (!isArtifactName(slug) || !PUBLIC_ID.test(publicId)) return null;
  const dir = artifactDir(config, slug);
  if (!dir) return null;
  const acl = readAcl(dir);
  if (!acl) return null;
  const artifact = inspectArtifact(config, slug, acl.owner);
  if (!artifact || artifact.publicId !== publicId) return null;
  return { artifact, dir };
}

/** Как артефакт называется для человека: путь внутри контейнера. */
export function displayPath(slug: string, entry: string): string {
  return `/artifacts/${slug}/${entry}`;
}

/**
 * Переносит старые артефакты из per-user/per-workspace в глобальную библиотеку.
 * Запускается при подготовке человека; после переноса старый каталог пуст.
 */
export function migrateLegacyArtifacts(config: IcarusConfig, user: UserConfig): string[] {
  const root = ensureArtifactsRoot(config);
  const moved: string[] = [];
  let workspaces: ReturnType<typeof listWorkspaces>;
  try {
    workspaces = listWorkspaces(config, user);
  } catch {
    return moved;
  }
  for (const workspace of workspaces) {
    const oldRoot = path.join(userPaths(config, user).workspaces, workspace.slug, ARTIFACTS_DIR);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(oldRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || hidden(entry.name) || !isArtifactName(entry.name)) continue;
      const source = path.join(oldRoot, entry.name);
      if (!realDirOrNull(source)) continue;
      let slug = entry.name;
      let target = safeJoin(root, slug);
      for (let n = 2; target && fs.existsSync(target); n += 1) {
        slug = `${entry.name}-${user.id}${n > 2 ? `-${n}` : ''}`;
        target = safeJoin(root, slug);
      }
      if (!target) continue;
      try {
        fs.renameSync(source, target);
      } catch {
        continue;
      }
      if (!readAcl(target)) writeAcl(target, user.id, DEFAULT_ACL);
      moved.push(slug);
    }
    try {
      fs.rmdirSync(oldRoot);
    } catch {
      // В старой папке осталось что-то чужое или скрытое — не трогаем.
    }
  }
  return moved;
}
