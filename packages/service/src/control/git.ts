// Панель управления, раздел памяти: git-история — то, что делает откат честным.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Commit = { hash: string; date: string; subject: string };

/**
 * Коммит в истории одного файла: кто и когда его тронул и насколько.
 * added/removed — строки по этому файлу, а не по всему коммиту: в панели рядом с
 * записью памяти важно, что случилось именно с ней, а не со всем репозиторием.
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

/**
 * История одного файла: коммит, который его тронул, и строки по нему.
 *
 * Формат `--numstat` печатает «+N\t−M\tпуть» между строкой коммита и следующим
 * коммитом, поэтому разбираем блоками. Хеш и дату берём в одном формате с log(),
 * чтобы даты в панели читались одинаково, а TZ фиксируем: иначе день на границе
 * суток у автора и на сервере разошлись бы.
 */
export async function fileHistory(dir: string, relative: string, limit = 30): Promise<FileCommit[]> {
  if (!relative || relative.includes('\u0000') || relative.startsWith('-')) return [];
  const result = await git(dir, [
    'log',
    `-${limit}`,
    '--no-color',
    '--numstat',
    '--date=short',
    '--pretty=format:@@%H%x1f%h%x1f%an%x1f%ad%x1f%s',
    '--',
    relative,
  ]);
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
    // «-» вместо числа git печатает для бинарного файла: строк там не считают.
    current.added += stat[1] === '-' ? 0 : Number(stat[1]);
    current.removed += stat[2] === '-' ? 0 : Number(stat[2]);
  }
  return commits;
}

/**
 * Что за коммит добавил или изменил каждую строку файла: «дата записи» для панели.
 *
 * Даты берём не из текста памяти (там дата есть только у строк состояния), а из
 * истории: память — git-репозиторий, и возраст записи честно живёт в коммите.
 * Возвращаем по индексу строки (0-based), а не по номеру: так вызывающему коду не
 * нужно помнить про сдвиг на единицу.
 */
export async function blameLines(dir: string, relative: string): Promise<(string | null)[]> {
  if (!relative || relative.includes('\u0000') || relative.startsWith('-')) return [];
  const result = await git(dir, ['blame', '--line-porcelain', '--date=short', '--', relative]);
  if (result.code !== 0) return [];

  const dates: (string | null)[] = [];
  // В porcelain за строку файла отвечает строка, начатая табуляцией. Дата идёт
  // раньше неё, в заголовке блока: запоминаем её и отдаём по факту строки.
  let stamp: number | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('author-time ')) {
      const value = Number(line.slice('author-time '.length).trim());
      stamp = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith('\t')) {
      // Незакоммиченная строка (хеш из нулей) приезжает без author-time — даты нет.
      dates.push(stamp === null ? null : dayOf(stamp));
      stamp = null;
    }
  }
  return dates;
}

/** День в UTC: в панели дата — это «когда запись появилась», без часов и минут. */
function dayOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await ensureRepo(dir);
  await git(dir, ['add', '-A']);
  const result = await git(dir, ['commit', '-q', '-m', message]);
  return result.code === 0;
}
