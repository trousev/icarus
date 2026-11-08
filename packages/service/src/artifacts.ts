// Артефакты: готовые вещи для человека, которые агент складывает в рабочую папку.
//
// Артефакт — это всегда папка `<workspace>/artifacts/<slug>/` с одним index-файлом:
//
//   index.html        — HTML-страница;
//   index.md          — markdown-документ;
//   index.png|jpg|…   — изображение;
//
// и всегда `index.ai.md` — описание для ИИ. Оно нужно, чтобы модель не разбирала
// HTML и не «читала» картинки глазами: что внутри, о чём, что менять — коротко
// и текстом. Остальные файлы (стили, картинки, шрифты) лежат рядом и принадлежат
// артефакту: HTML ссылается на них относительными путями.
//
// Публичная ссылка — это не путь в панели и не секрет инсталляции. У артефакта
// есть случайный publicId, записанный в скрытом `.artifact.json`; только с ним
// маршрут `/a/<человек>/<workspace>/<артефакт>/<id>/…` открывается без SSO.
// Ссылку можно отозвать, удалив publicId, — старый адрес сразу перестанет работать.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findUser, userPaths, type IcarusConfig } from './config.ts';
import { findWorkspace, listWorkspaces, type Workspace } from './workspaces.ts';

/** Имя каталога артефактов внутри workspace: одно на всех, его видит и агент. */
export const ARTIFACTS_DIR = 'artifacts';

/** Скрытая метка артефакта: publicId и служебные даты. Человеку она не видна. */
export const META_FILE = '.artifact.json';

export type ArtifactType = 'html' | 'markdown' | 'image';

/** Подписи типов — те же, что в дизайне панели; их не придумывает браузер. */
export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  html: 'HTML-страница',
  markdown: 'Markdown-документ',
  image: 'Изображение',
};

/**
 * Порядок важен: если в папке случайно оказалось два index-файла, артефакт всё
 * равно откроется предсказуемо. Проверка структуры (`artifact_check`) при этом
 * честно скажет, что файлов больше одного.
 */
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

/** Описание для ИИ: обязательный спутник любого артефакта. */
export const AI_FILE = 'index.ai.md';

export type ArtifactMeta = {
  version?: number;
  publicId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Artifact = {
  /** Имя папки: оно же id в API и последний сегмент пути. */
  name: string;
  title: string;
  type: ArtifactType;
  typeLabel: string;
  /** Имя index-файла, который видит человек. */
  entry: string;
  /** Размер index-файла: в списке показываем именно его, а не весь бандл. */
  size: number;
  updatedAt: string;
  summary: string;
  /** Есть ли `index.ai.md`: без него артефакт считается неполным. */
  ai: boolean;
  /** Файлы бандла, относительные пути. Скрытая метка сюда не попадает. */
  files: string[];
  publicId?: string;
  /** Ссылки, которые человек копирует и открывает. */
  urls: ArtifactUrls;
};

export type ArtifactUrls = {
  /** Обычная ссылка в панели (за SSO). */
  panel: string;
  /** Файл без панели: index как есть; у markdown это исходник, а не рендер. */
  raw: string;
  /** Публичная ссылка с панелью; её открывает любой, у кого она есть. */
  public?: string;
  /** Публичная ссылка без панели. */
  bare?: string;
};

export class ArtifactError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'ArtifactError';
    this.status = status;
  }
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;
const NAME_LIMIT = 128;
const DOC_LIMIT = 256 * 1024;
const FILE_LIMIT = 400;

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

/** Каталог артефактов конкретного workspace. */
export function artifactsRoot(config: IcarusConfig, userId: string, workspace: string): string {
  const user = findUser(config, userId);
  if (!user) throw new ArtifactError(`пользователь ${userId} не заведён`, 404);
  const ws = findWorkspace(config, user, workspace);
  if (!ws) throw new ArtifactError(`workspace «${workspace}» не найден`, 404);
  return path.join(userPaths(config, user).workspaces, ws.slug, ARTIFACTS_DIR);
}

/** Путь из нескольких сегментов, каждый из которых не должен вывести за корень. */
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

function readTextIfSmall(file: string): string | null {
  const stats = statOrNull(file);
  if (!stats || !stats.isFile() || stats.size > DOC_LIMIT) return null;
  try {
    // Симлинк на файл вне артефакта читать не будем: описание и index должны
    // лежать в самой папке, иначе публичная ссылка могла бы показать чужое.
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** YAML-frontmatter в начале index.ai.md — метаданные, а не заголовок и не описание. */
function stripFrontmatter(text: string): string {
  const source = text.replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return source;
  return source.slice(end + 4).replace(/^\s*\n/, '');
}

/** Заголовок для человека: сначала H1 из описания для ИИ, потом сам index. */
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

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Короткое описание из `index.ai.md`: первый абзац после заголовков. */
export function summaryOf(ai: string | null): string {
  if (!ai) return '';
  const text = stripFrontmatter(ai);
  const paragraphs = text.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '---' && !line.startsWith('#') && !line.startsWith('```'));
    if (lines.length === 0) continue;
    const text = stripMarkdown(lines.join(' '));
    if (text !== '') return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  }
  return '';
}

function readableDate(date: Date): string {
  return date.toISOString();
}

/** Что лежит в папке: только имена, без содержимого и без скрытых файлов. */
export function listFiles(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (hidden(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
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

export function readMeta(dir: string): ArtifactMeta | null {
  const file = path.join(dir, META_FILE);
  const text = readTextIfSmall(file);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const meta = parsed as ArtifactMeta;
    return {
      ...(typeof meta.publicId === 'string' && PUBLIC_ID.test(meta.publicId) ? { publicId: meta.publicId } : {}),
      ...(typeof meta.createdAt === 'string' ? { createdAt: meta.createdAt } : {}),
      ...(typeof meta.updatedAt === 'string' ? { updatedAt: meta.updatedAt } : {}),
    };
  } catch {
    return null;
  }
}

function writeMeta(dir: string, meta: ArtifactMeta): void {
  const file = path.join(dir, META_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  // 0644, а не 0600: файл пишет то агент в контейнере, то сервис на хосте, и
  // publicId — не секрет. Иначе панель могла бы не прочитать метку, созданную
  // агентом под другим uid.
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, ...meta }, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/**
 * Ссылки артефакта. `config.url` — внешний адрес панели; локальный запуск тоже
 * годится, поэтому абсолютный адрес всегда собирается от него, а не от запроса:
 * иначе ссылка, скопированная в панели, вела бы на внутренний порт контейнера.
 */
export function artifactUrls(
  config: IcarusConfig,
  userId: string,
  workspace: string,
  artifact: string,
  entry: string,
  publicId?: string,
): ArtifactUrls {
  const base = config.url.replace(/\/+$/, '');
  const user = encodeURIComponent(userId);
  const ws = encodeURIComponent(workspace);
  const slug = encodeURIComponent(artifact);
  const entryPath = entry.split('/').map(encodeURIComponent).join('/');
  const panel = `${base}/panel/artifacts?${new URLSearchParams({ workspace, artifact }).toString()}`;
  const raw = `${base}/panel/artifacts/raw/${ws}/${slug}/${entryPath}`;
  if (!publicId || !PUBLIC_ID.test(publicId)) return { panel, raw };
  const pub = `${base}/a/${user}/${ws}/${slug}/${publicId}/`;
  return { panel, raw, public: pub, bare: `${pub}?bare=1` };
}

/** Артефакт по папке: null — папка есть, но index-файла в ней нет. */
export function inspectArtifact(
  config: IcarusConfig,
  userId: string,
  workspace: string,
  slug: string,
): Artifact | null {
  if (!isArtifactName(slug)) return null;
  const root = artifactsRoot(config, userId, workspace);
  const dir = safeJoin(root, slug);
  if (!dir) return null;
  // Папка-симлинк увела бы артефакт за пределы workspace: такие не открываем.
  let link: fs.Stats;
  try {
    link = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (link.isSymbolicLink()) return null;
  const stats = statOrNull(dir);
  if (!stats?.isDirectory()) return null;
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
    ...(meta?.publicId === undefined ? {} : { publicId: meta.publicId }),
    urls: artifactUrls(config, userId, workspace, slug, found.file, meta?.publicId),
  };
}

/** Все артефакты workspace, свежие сверху. Битые папки молча пропускаем. */
export function listArtifacts(config: IcarusConfig, userId: string, workspace: string): Artifact[] {
  const root = artifactsRoot(config, userId, workspace);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const artifacts: Artifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || hidden(entry.name)) continue;
    const artifact = inspectArtifact(config, userId, workspace, entry.name);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'ru'));
}

/** Сколько артефактов у человека во всех workspace'ах: число у раздела в панели. */
export function countArtifacts(config: IcarusConfig, userId: string): number {
  const user = findUser(config, userId);
  if (!user) return 0;
  let total = 0;
  try {
    for (const workspace of listWorkspaces(config, user)) {
      const root = path.join(userPaths(config, user).workspaces, workspace.slug, ARTIFACTS_DIR);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || hidden(entry.name)) continue;
        if (inspectArtifact(config, userId, workspace.slug, entry.name)) total += 1;
      }
    }
  } catch {
    // Сломанный каталог не должен ронять счётчики всей панели.
  }
  return total;
}

/** Куда ведут ссылки в списке: workspace'ы человека, даже пустые. */
export function artifactWorkspaces(config: IcarusConfig, userId: string): Workspace[] {
  const user = findUser(config, userId);
  if (!user) return [];
  return listWorkspaces(config, user);
}

/** Описание для ИИ (содержимое `index.ai.md`) и сам index-файл. */
export function readArtifact(
  config: IcarusConfig,
  userId: string,
  workspace: string,
  slug: string,
): { artifact: Artifact; ai: string | null; content: string | null; dir: string } {
  const artifact = inspectArtifact(config, userId, workspace, slug);
  if (!artifact) throw new ArtifactError('артефакт не найден или в папке нет index-файла', 404);
  const root = artifactsRoot(config, userId, workspace);
  const dir = safeJoin(root, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  return {
    artifact,
    ai: readTextIfSmall(path.join(dir, AI_FILE)),
    content: artifact.type === 'markdown' ? readTextIfSmall(path.join(dir, artifact.entry)) : null,
    dir,
  };
}

/**
 * Публичный id. Раньше ссылки не было — она появляется в тот момент, когда её
 * просят (кнопка в панели или `artifact_link` в MCP). Тогда у артефакта, который
 * человек никому не показывал, публичного адреса просто не существует.
 */
export function ensurePublicId(
  config: IcarusConfig,
  userId: string,
  workspace: string,
  slug: string,
): { artifact: Artifact; publicId: string } {
  const artifact = inspectArtifact(config, userId, workspace, slug);
  if (!artifact) throw new ArtifactError('артефакт не найден или в папке нет index-файла', 404);
  const root = artifactsRoot(config, userId, workspace);
  const dir = safeJoin(root, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  const meta = readMeta(dir);
  if (meta?.publicId) return { artifact, publicId: meta.publicId };

  const now = new Date().toISOString();
  const publicId = crypto.randomBytes(18).toString('base64url');
  writeMeta(dir, { publicId, createdAt: meta?.createdAt ?? now, updatedAt: now });
  const next = inspectArtifact(config, userId, workspace, slug);
  return { artifact: next ?? artifact, publicId };
}

/** Отозвать ссылку: старый адрес перестаёт открываться сразу же. */
export function clearPublicId(config: IcarusConfig, userId: string, workspace: string, slug: string): Artifact {
  const artifact = inspectArtifact(config, userId, workspace, slug);
  if (!artifact) throw new ArtifactError('артефакт не найден', 404);
  const dir = safeJoin(artifactsRoot(config, userId, workspace), slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
  const file = path.join(dir, META_FILE);
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    throw new ArtifactError(`не удалось отозвать ссылку: ${error instanceof Error ? error.message : String(error)}`, 409);
  }
  return inspectArtifact(config, userId, workspace, slug) ?? artifact;
}

/**
 * Удаление артефакта — не `rm -rf`: папка уезжает в `artifacts/.trash/`, откуда
 * её ещё можно достать руками. Человек нажал «удалить», но это не значит, что
 * он хотел потерять работу навсегда.
 */
export function trashArtifact(config: IcarusConfig, userId: string, workspace: string, slug: string): string {
  const artifact = inspectArtifact(config, userId, workspace, slug);
  if (!artifact) throw new ArtifactError('артефакт не найден', 404);
  const root = artifactsRoot(config, userId, workspace);
  const dir = safeJoin(root, slug);
  if (!dir) throw new ArtifactError('артефакт не найден', 404);
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

/** MIME по расширению: только то, что артефакт действительно может содержать. */
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

/** Файл артефакта по относительному пути: null — если путь выводит из папки. */
export function artifactFile(
  config: IcarusConfig,
  userId: string,
  workspace: string,
  slug: string,
  relative: string,
): { file: string; type: string } | null {
  if (!isArtifactName(slug)) return null;
  const artifact = inspectArtifact(config, userId, workspace, slug);
  if (!artifact) return null;
  const dir = safeJoin(artifactsRoot(config, userId, workspace), slug);
  if (!dir) return null;
  const clean = relative.replace(/^\/+/, '');
  if (clean === '' || clean.includes('\u0000')) return null;
  // Скрытые файлы и описание для ИИ наружу не отдаём: `index.ai.md` — заметки
  // для модели, а не часть артефакта, которую видит человек. Панель читает его
  // через API, где уже проверено, что это его артефакт.
  const segments = clean.split('/');
  if (segments.some((segment) => segment.startsWith('.') || segment === AI_FILE)) return null;
  const file = safeJoin(dir, clean);
  if (!file) return null;
  const stats = statOrNull(file);
  if (!stats?.isFile()) return null;
  // Симлинк внутри папки мог бы увести за её пределы: отдаём только настоящие файлы.
  try {
    const real = fs.realpathSync(file);
    const realDir = fs.realpathSync(dir);
    if (real !== realDir && !real.startsWith(realDir + path.sep)) return null;
  } catch {
    return null;
  }
  return { file, type: mimeOf(file) };
}

/**
 * Публичный артефакт по сегментам `/a/<человек>/<workspace>/<артефакт>/<id>/…`.
 * Проверяем и наличие человека, и совпадение id с меткой: без второго чужой
 * артефакт открывался бы по угадываемому имени папки.
 */
export function publicArtifact(
  config: IcarusConfig,
  userId: string,
  workspace: string,
  slug: string,
  publicId: string,
): { artifact: Artifact; dir: string } | null {
  if (!isArtifactName(slug) || !PUBLIC_ID.test(publicId)) return null;
  const user = findUser(config, userId);
  if (!user || !findWorkspace(config, user, workspace)) return null;
  const artifact = inspectArtifact(config, userId, workspace, slug);
  if (!artifact || artifact.publicId !== publicId) return null;
  const dir = safeJoin(artifactsRoot(config, userId, workspace), slug);
  if (!dir) return null;
  return { artifact, dir };
}

/** Относительный путь для подписи внизу панели: как его видит человек. */
export function displayPath(workspace: string, slug: string, entry: string): string {
  // Человеку показываем привычный вид с ~, а не путь внутри dataDir с его id:
  // в панели и в подсказке агента это одно и то же место.
  return `~/icarus/workspaces/${workspace}/${ARTIFACTS_DIR}/${slug}/${entry}`;
}
