// История версий артефакта: маленький git-репозиторий в каждой папке.
//
// Человек про git не знает и не должен: панель показывает «История версий» и
// кнопку «Вернуть». Коммиты делает императивный слой — расширение pi после
// каждого write/edit и этот модуль при инициализации/откате. ИИ к истории
// отношения не имеет: он просто пишет файлы, а система фиксирует снимки.
//
// Служебные файлы артефакта в историю не попадают: `.folder-acl.json` — это
// права, `.artifact.json` — публичная ссылка. Иначе откат содержимого менял бы
// доступ к артефакту. Исключения лежат в `.git/info/exclude`, а не в видимом
// `.gitignore`: пользователь не должен видеть даже намёка на git.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureArtifactsRoot, readAcl } from './artifacts.ts';
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

function gitDirOk(dir: string): boolean {
  try {
    const stats = fs.lstatSync(path.join(dir, '.git'));
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Служебные файлы не версионируются: их нельзя откатывать вместе с контентом. */
function ensureExclude(dir: string): void {
  const info = path.join(dir, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  const file = path.join(info, 'exclude');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // файла ещё нет — начнём с пустого
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

/** Завести репозиторий, если его ещё нет. Идемпотентно. */
export async function ensureArtifactRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (!gitDirOk(dir)) {
    // Битый или чужой `.git` не трогаем: лучше ошибка, чем молча перезаписать.
    if (fs.existsSync(path.join(dir, '.git'))) {
      throw new Error(`в ${dir} уже есть .git, но это не каталог`);
    }
    const init = await git(dir, ['init', '-q']);
    if (init.code !== 0) throw new Error(init.stderr.trim() || 'git init не удался');
    await git(dir, ['config', 'user.name', 'Icarus']);
    await git(dir, ['config', 'user.email', 'icarus@localhost']);
    // Глобальный commit.gpgsign иначе потребует ключ, которого в контейнере нет.
    await git(dir, ['config', 'commit.gpgsign', 'false']);
  }
  ensureExclude(dir);
}

/**
 * Зафиксировать изменения. false — коммитить нечего. Ошибки git не глотаем:
 * вызывающий решает, показать их человеку или записать в лог.
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

/** Версии от новых к старым. Пустой репозиторий — пустая история. */
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
 * Вернуть содержимое к версии `commit`.
 *
 * Не переписываем историю: `read-tree` ставит в индекс и рабочую папку ровно то
 * дерево, а затем обычный коммит «restore» фиксирует возврат. Так старые версии
 * остаются доступными, а человек видит понятное «вернул к такой-то».
 */
export async function restoreArtifact(
  dir: string,
  commit: string,
): Promise<{ ok: true; changed: boolean; subject: string }> {
  if (!HASH.test(commit)) throw new Error('не похоже на версию артефакта');
  await ensureArtifactRepo(dir);

  const exists = await git(dir, ['cat-file', '-e', `${commit}^{commit}`]);
  if (exists.code !== 0) throw new Error('такой версии нет');

  // Незакоммиченное перед откатом тоже сохраняем: это честнее, чем потерять.
  await commitArtifact(dir, 'artifact: before restore');

  const reset = await git(dir, ['read-tree', '-u', '--reset', commit]);
  if (reset.code !== 0) throw new Error(reset.stderr.trim() || 'не удалось вернуть версию');

  const changed = await commitArtifact(dir, `artifact: restore ${commit.slice(0, 8)}`);
  return { ok: true, changed, subject: `artifact: restore ${commit.slice(0, 8)}` };
}

/**
 * Поднять историю у всех существующих артефактов. Старые папки получили
 * initial-коммит при миграции; новые заводятся при первом write через pi.
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
