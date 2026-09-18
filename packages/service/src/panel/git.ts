// Панель памяти: git-история — то, что делает откат честным.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Commit = { hash: string; date: string; subject: string };

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

/** Откат коммита разбора. Не переписываем историю: делаем обратный коммит. */
export async function revert(dir: string, commit: string): Promise<{ ok: boolean; message: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { ok: false, message: 'не похоже на хеш коммита' };
  const result = await git(dir, ['revert', '--no-edit', commit]);
  if (result.code !== 0) {
    await git(dir, ['revert', '--abort']);
    return { ok: false, message: result.stderr.trim() || 'откат не удался' };
  }
  return { ok: true, message: `откатил ${commit.slice(0, 8)}` };
}

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await ensureRepo(dir);
  await git(dir, ['add', '-A']);
  const result = await git(dir, ['commit', '-q', '-m', message]);
  return result.code === 0;
}
