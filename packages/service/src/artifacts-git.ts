// Artifact version history: a small git repository in each folder.
//
// The human doesn't know about git and shouldn't: the panel shows "Version history" and
// a "Restore" button. Commits are made by the imperative layer — the pi extension after
// each write/edit and this module on init/restore. The AI has nothing to do with the
// history: it just writes files, and the system records snapshots.
//
// Artifact service files don't make it into history: `.folder-acl.json` holds
// permissions, `.artifact.json` holds the public link. Otherwise restoring content would
// change access to the artifact. The exclusions live in `.git/info/exclude`, not in the
// visible `.gitignore`: the user shouldn't see even a hint of git.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_FILE,
  ARTIFACT_TYPE_LABELS,
  ensureArtifactsRoot,
  entryForFiles,
  mimeOf,
  readAcl,
  summaryOf,
  titleOf,
  type ArtifactType,
} from './artifacts.ts';
import type { IcarusConfig } from './config.ts';
import { log } from './log.ts';

const GIT_TIMEOUT = 20_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const IGNORED = ['.folder-acl.json', '.artifact.json'];
const HASH = /^[0-9a-f]{7,40}$/i;

export type ArtifactCommit = {
  hash: string;
  short: string;
  date: string;
  subject: string;
};

/** Artifact version for preview: everything the panel needs, without modifying files. */
export type ArtifactVersion = {
  artifact: {
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
    urls: { raw: string };
  };
  content: string | null;
  aiContent: string | null;
  commit: ArtifactCommit;
};

type GitResult = { code: number; stdout: string; stderr: string };

function git(dir: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { timeout: GIT_TIMEOUT, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? Number((error as { code?: number }).code)
            : 1
          : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** Binary read: `git show` for images and other version files. */
function gitBuffer(dir: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { timeout: GIT_TIMEOUT, maxBuffer: MAX_BUFFER, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? Number((error as { code?: number }).code)
            : 1
          : 0;
        const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
        resolve({ code, stdout: buffer, stderr: String(stderr ?? '') });
      },
    );
  });
}

function gitDirOk(dir: string): boolean {
  try {
    const stats = fs.lstatSync(path.join(dir, '.git'));
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Service files are not versioned: they can't be restored along with the content. */
function ensureExclude(dir: string): void {
  const info = path.join(dir, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  const file = path.join(info, 'exclude');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // the file doesn't exist yet — start from empty
  }
  const lines = new Set(current.split('\n').map((line) => line.trim()));
  const missing = IGNORED.filter((name) => !lines.has(name));
  if (missing.length === 0) return;
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  fs.writeFileSync(file, `${prefix}${missing.join('\n')}\n`);
}

function commitMessage(message: string): string {
  const clean = message.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || 'artifact: update').slice(0, 200);
}

/** Create the repository if it doesn't exist yet. Idempotent. */
export async function ensureArtifactRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (!gitDirOk(dir)) {
    // We don't touch a broken or foreign `.git`: an error is better than silently overwriting.
    if (fs.existsSync(path.join(dir, '.git'))) {
      throw new Error(`в ${dir} уже есть .git, но это не каталог`);
    }
    const init = await git(dir, ['init', '-q']);
    if (init.code !== 0) throw new Error(init.stderr.trim() || 'git init не удался');
    await git(dir, ['config', 'user.name', 'Icarus']);
    await git(dir, ['config', 'user.email', 'icarus@localhost']);
    // The global commit.gpgsign would otherwise require a key that isn't in the container.
    await git(dir, ['config', 'commit.gpgsign', 'false']);
  }
  ensureExclude(dir);
}

/**
 * Record the changes. false — nothing to commit. We don't swallow git errors:
 * the caller decides whether to show them to the human or write them to the log.
 */
export async function commitArtifact(dir: string, message: string): Promise<boolean> {
  await ensureArtifactRepo(dir);
  const add = await git(dir, ['add', '-A']);
  if (add.code !== 0) throw new Error(add.stderr.trim() || 'git add не удался');

  const staged = await git(dir, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return false;
  if (staged.code !== 1) throw new Error(staged.stderr.trim() || 'git diff не удался');

  const commit = await git(dir, ['commit', '-q', '-m', commitMessage(message)]);
  if (commit.code !== 0) throw new Error(commit.stderr.trim() || 'git commit не удался');
  return true;
}

/** Versions from new to old. An empty repository means an empty history. */
export async function artifactHistory(dir: string, limit = 40): Promise<ArtifactCommit[]> {
  if (!gitDirOk(dir)) return [];
  const result = await git(dir, [
    'log',
    `-${Math.max(1, Math.min(100, limit))}`,
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%ad%x1f%s',
  ]);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, date, subject] = line.split('\u001f');
      return { hash: hash ?? '', short: short ?? '', date: date ?? '', subject: subject ?? '' };
    })
    .filter((commit) => HASH.test(commit.hash));
}

/**
 * Restore the content to version `commit`.
 *
 * We don't rewrite history: `read-tree` puts exactly that tree into the index and the
 * working folder, and then a regular "restore" commit records the rollback. This way old
 * versions stay available, and the human sees a clear "restored to such-and-such".
 */
export async function restoreArtifact(
  dir: string,
  commit: string,
): Promise<{ ok: true; changed: boolean; subject: string }> {
  if (!HASH.test(commit)) throw new Error('не похоже на версию артефакта');
  await ensureArtifactRepo(dir);

  const exists = await git(dir, ['cat-file', '-e', `${commit}^{commit}`]);
  if (exists.code !== 0) throw new Error('такой версии нет');

  // We also save the uncommitted work before the rollback: that's fairer than losing it.
  await commitArtifact(dir, 'artifact: before restore');

  const reset = await git(dir, ['read-tree', '-u', '--reset', commit]);
  if (reset.code !== 0) throw new Error(reset.stderr.trim() || 'не удалось вернуть версию');

  const changed = await commitArtifact(dir, `artifact: restore ${commit.slice(0, 8)}`);
  return { ok: true, changed, subject: `artifact: restore ${commit.slice(0, 8)}` };
}

/** Commit metadata for preview: hash, short hash, date and subject. */
async function commitInfo(dir: string, commit: string): Promise<ArtifactCommit | null> {
  const result = await git(dir, [
    'show',
    '-s',
    '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%ad%x1f%s',
    commit,
  ]);
  if (result.code !== 0) return null;
  const [hash, short, date, subject] = result.stdout.trim().split('\u001f');
  if (!hash || !HASH.test(hash)) return null;
  return { hash, short: short ?? hash.slice(0, 7), date: date ?? '', subject: subject ?? '' };
}

async function showText(dir: string, commit: string, file: string): Promise<string | null> {
  const result = await git(dir, ['show', `${commit}:${file}`]);
  return result.code === 0 ? result.stdout : null;
}

async function versionFiles(dir: string, commit: string): Promise<string[]> {
  const result = await git(dir, ['ls-tree', '-r', '--name-only', '--full-tree', commit]);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .filter((name) => !name.split('/').some((part) => part.startsWith('.')));
}

function encodedPath(relative: string): string {
  return relative.split('/').map(encodeURIComponent).join('/');
}

/**
 * Assemble a version for preview. Changes nothing: reads the commit tree via
 * `git show`. That's exactly what allows "click and look" without pressing "Restore".
 */
export async function artifactVersion(
  config: IcarusConfig,
  dir: string,
  commit: string,
): Promise<ArtifactVersion> {
  if (!HASH.test(commit)) throw new Error('не похоже на версию артефакта');
  if (!gitDirOk(dir)) throw new Error('у артефакта ещё нет истории');
  const info = await commitInfo(dir, commit);
  if (!info) throw new Error('такой версии нет');

  const files = await versionFiles(dir, info.hash);
  const entry = entryForFiles(files);
  if (!entry) throw new Error('в этой версии нет index-файла');
  const ai = await showText(dir, info.hash, AI_FILE);
  const document =
    entry.type === 'html' || entry.type === 'markdown'
      ? await showText(dir, info.hash, entry.file)
      : null;
  const sizeResult = await git(dir, ['cat-file', '-s', `${info.hash}:${entry.file}`]);
  const size = sizeResult.code === 0 ? Number(sizeResult.stdout.trim()) : Buffer.byteLength(document ?? '');
  const slug = path.basename(dir);
  const base = config.url.replace(/\/+$/, '');
  const rawRoot = `${base}/panel/artifacts/version/${encodeURIComponent(slug)}/${info.hash}/`;

  return {
    artifact: {
      name: slug,
      title: titleOf(slug, ai, document),
      type: entry.type,
      typeLabel: ARTIFACT_TYPE_LABELS[entry.type],
      entry: entry.file,
      size: Number.isFinite(size) ? size : 0,
      updatedAt: info.date,
      summary: summaryOf(ai),
      ai: ai !== null,
      files: files.filter((file) => file !== AI_FILE),
      urls: { raw: `${rawRoot}${encodedPath(entry.file)}` },
    },
    content: entry.type === 'markdown' ? document : null,
    aiContent: ai,
    commit: info,
  };
}

/** File of a specific version: HTML assets and preview images. */
export async function artifactVersionFile(
  dir: string,
  commit: string,
  relative: string,
): Promise<{ content: Buffer; type: string }> {
  if (!HASH.test(commit)) throw new Error('не похоже на версию артефакта');
  const clean = relative.replace(/^\/+/, '');
  if (clean === '' || clean.includes('\u0000')) throw new Error('файл не указан');
  const parts = clean.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.') || part === AI_FILE)) {
    throw new Error('файл версии недоступен');
  }
  const result = await gitBuffer(dir, ['show', `${commit}:${clean}`]);
  if (result.code !== 0) throw new Error('файл версии не найден');
  return { content: result.stdout, type: mimeOf(clean) };
}

/**
 * Bring up history for all existing artifacts. Old folders got an
 * initial commit during migration; new ones are created on the first write via pi.
 */
export async function ensureArtifactRepos(config: IcarusConfig): Promise<number> {
  const root = ensureArtifactsRoot(config);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let initialized = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    if (!readAcl(dir)) continue;
    try {
      await ensureArtifactRepo(dir);
      if (await commitArtifact(dir, 'artifact: initial version')) initialized += 1;
    } catch (error) {
      log.warn('артефакты: история не завелась', { artifact: entry.name, error: String(error) });
    }
  }
  return initialized;
}
