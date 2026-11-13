// Control panel, memory section: git history — what makes rollback honest.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Commit = { hash: string; date: string; subject: string };

/**
 * A commit in the history of a single file: who touched it, when, and how much.
 * added/removed are lines for this file, not for the whole commit: in the panel,
 * next to a memory entry, what matters is what happened to it, not the whole repo.
 */
export type FileCommit = {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  added: number;
  removed: number;
};

function git(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

export async function ensureRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, '.git'))) return;
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'icarus@localhost']);
  await git(dir, ['config', 'user.name', 'Icarus']);
}

export async function log(dir: string, limit = 50): Promise<Commit[]> {
  const result = await git(dir, [
    'log',
    `-${limit}`,
    '--date=iso-strict',
    '--pretty=format:%H%x1f%ad%x1f%s',
  ]);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, date, subject] = line.split('\u001f');
      return { hash, date, subject };
    });
}

export async function show(dir: string, commit: string): Promise<{ stat: string; patch: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { stat: '', patch: '' };
  const stat = await git(dir, ['show', '--stat', '--oneline', commit]);
  const patch = await git(dir, ['show', '--unified=2', '--no-color', commit]);
  return { stat: stat.stdout, patch: patch.stdout.slice(0, 20_000) };
}

/** Revert a parsing commit. We don't rewrite history: we make a reverse commit. */
export async function revert(dir: string, commit: string): Promise<{ ok: boolean; message: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { ok: false, message: 'не похоже на хеш коммита' };
  const result = await git(dir, ['revert', '--no-edit', commit]);
  if (result.code !== 0) {
    await git(dir, ['revert', '--abort']);
    return { ok: false, message: result.stderr.trim() || 'откат не удался' };
  }
  return { ok: true, message: `откатил ${commit.slice(0, 8)}` };
}

/**
 * Commit history and line counts per commit: with a path — for one file, without a
 * path — for the whole repository (that's how the skills section lives: a skill is a
 * directory, not a file).
 *
 * The `--numstat` format prints «+N\t−M\tпуть» between a commit line and the next
 * commit, so we parse it in blocks. We take the hash and date in the same format as
 * log() so dates in the panel read the same, and we pin the TZ: otherwise the day on
 * the boundary between author and server would differ.
 */
export async function fileHistory(dir: string, relative: string, limit = 30): Promise<FileCommit[]> {
  if (relative.includes('\u0000') || relative.startsWith('-')) return [];
  const args = [
    'log',
    `-${limit}`,
    '--no-color',
    '--numstat',
    '--date=short',
    '--pretty=format:@@%H%x1f%h%x1f%an%x1f%ad%x1f%s',
  ];
  if (relative) args.push('--', relative);
  const result = await git(dir, args);
  if (result.code !== 0) return [];

  const commits: FileCommit[] = [];
  let current: FileCommit | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('@@')) {
      const [hash, short, author, date, subject] = line.slice(2).split('\u001f');
      current = { hash, short, author, date, subject, added: 0, removed: 0 };
      commits.push(current);
      continue;
    }
    const stat = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!stat || !current) continue;
    // git prints "-" instead of a number for a binary file: lines aren't counted there.
    current.added += stat[1] === '-' ? 0 : Number(stat[1]);
    current.removed += stat[2] === '-' ? 0 : Number(stat[2]);
  }
  return commits;
}

/**
 * Which commit added or changed each line of the file: the "entry date" for the panel.
 *
 * We take dates not from the memory text (there a date exists only on state lines),
 * but from history: memory is a git repository, and an entry's age honestly lives in
 * the commit. We return by line index (0-based), not by number: that way the caller
 * doesn't need to remember the off-by-one shift.
 */
export async function blameLines(dir: string, relative: string): Promise<(string | null)[]> {
  if (!relative || relative.includes('\u0000') || relative.startsWith('-')) return [];
  const result = await git(dir, ['blame', '--line-porcelain', '--date=short', '--', relative]);
  if (result.code !== 0) return [];

  const dates: (string | null)[] = [];
  // In porcelain, the line for a file line is the one starting with a tab. The date
  // comes before it, in the block header: we remember it and hand it out per line.
  let stamp: number | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('author-time ')) {
      const value = Number(line.slice('author-time '.length).trim());
      stamp = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith('\t')) {
      // An uncommitted line (all-zero hash) arrives without author-time — no date.
      dates.push(stamp === null ? null : dayOf(stamp));
      stamp = null;
    }
  }
  return dates;
}

/** Day in UTC: in the panel a date is "when the entry appeared", without hours or minutes. */
function dayOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await ensureRepo(dir);
  await git(dir, ['add', '-A']);
  const result = await git(dir, ['commit', '-q', '-m', message]);
  return result.code === 0;
}

/**
 * Whether there is anything uncommitted in this place: edits or new files.
 *
 * Needed before deletion: the person could have put bundle files there by hand and
 * not committed them, and `commitAll` won't see them — an untracked file won't appear
 * in history, and reverting the deletion won't bring it back. So before deleting we
 * ask and record.
 */
export async function hasChanges(dir: string, relative: string): Promise<boolean> {
  if (!relative || relative.includes('\u0000')) return false;
  const result = await git(dir, ['status', '--porcelain', '--', relative]);
  return result.code === 0 && result.stdout.trim() !== '';
}
