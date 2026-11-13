// Age of a fact at read time: the memory core marks items with the month from the memory's
// git history (`- [2026-03] text`). We check on a temporary git repository: the month is taken
// from the line's author, the text does not change, and without git the memory is read as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotateAges, buildMemoryCore, clearMemoryAges } from '../../extensions/lib/memory-core.ts';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** We skip git tests only where git really is absent. */
function ageTest(name: string, fn: () => void): void {
  test(name, { skip: hasGit ? false : 'git недоступен' }, fn);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ages-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'icarus@localhost']);
  git(dir, ['config', 'user.name', 'Icarus']);
  return dir;
}

/** A commit with the given author and committer date — this is how blame returns the needed month. */
function commitAt(root: string, iso: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

ageTest('the core marks items with the month from git history', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '# Кто это\n- Зовут Саня\n- Работает в банке\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- \[2026-03\] Зовут Саня/);
  assert.match(core, /- \[2026-03\] Работает в банке/);
  assert.doesNotMatch(core, /\[2026-03\] Кто это/, 'заголовки не пункты — метки у них нет');
});

ageTest('the text of an item does not change during annotation', () => {
  const root = tempRepo();
  const original = '- Пьёт сенчу (его слова: «пью сенчу»)\n';
  fs.writeFileSync(path.join(root, 'identity.md'), original);
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  const line = buildMemoryCore(root)
    .split('\n')
    .find((row) => row.includes('сенчу'));
  assert.equal(line, '- [2026-03] Пьёт сенчу (его слова: «пью сенчу»)');
  // Remove the mark — get the original text of the line down to the character.
  assert.equal(line?.replace(/^(\s*[-*]\s+)\[\d{4}-\d{2}\] /, '$1'), original.trim());
});

ageTest('the month is taken per line, its own for each', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n- Работает в банке\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n- Работает в банке, в IT\n');
  commitAt(root, '2026-06-01T12:00:00+00:00', 'memory: июнь');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- \[2026-03\] Зовут Саня/);
  assert.match(core, /- \[2026-06\] Работает в банке, в IT/);
});

ageTest('people and projects also get a mark when they are read', () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, 'people'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'people/маша.md'), '- Сестра, живёт в Порту\n');
  fs.writeFileSync(path.join(root, 'projects/дом.md'), '- Строит дом\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  // They are not in the core — they are read by index. The mark is still computed from git history.
  const people = annotateAges(path.join(root, 'people/маша.md'), fs.readFileSync(path.join(root, 'people/маша.md'), 'utf8'));
  const projects = annotateAges(path.join(root, 'projects/дом.md'), fs.readFileSync(path.join(root, 'projects/дом.md'), 'utf8'));
  assert.match(people, /- \[2026-03\] Сестра, живёт в Порту/);
  assert.match(projects, /- \[2026-03\] Строит дом/);
});

ageTest('an uncommitted line stays without a mark, the neighbouring ones — with a mark', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  fs.appendFileSync(path.join(root, 'identity.md'), '- Любит собак\n');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- \[2026-03\] Зовут Саня/);
  assert.match(core, /^- Любит собак$/m, 'у незакоммиченной строки даты нет');
});

ageTest('memory changes — the marks update, the prompt is rebuilt', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();
  assert.match(buildMemoryCore(root), /\[2026-03\] Зовут Саня/);

  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n- Любит собак\n');
  commitAt(root, '2026-06-01T12:00:00+00:00', 'memory: июнь');
  const updated = buildMemoryCore(root);
  assert.match(updated, /- \[2026-06\] Любит собак/, 'новый факт получил свой месяц');
});

ageTest('while the memory has not changed, the core returns the same thing', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  assert.equal(buildMemoryCore(root), buildMemoryCore(root), 'метка не должна «плыть» между ходами');
});

test('without a git repository the text is read without a mark', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-nogit-'));
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- Зовут Саня/, 'факт на месте');
  assert.doesNotMatch(core, /\[\d{4}-\d{2}\]/, 'метку выдумывать не из чего');
});

test('annotation does not touch headings and non-list lines', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '# Кто это\nЗовут Саня\n- Работает в банке\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  const annotated = annotateAges(path.join(root, 'identity.md'), '# Кто это\nЗовут Саня\n- Работает в банке\n');
  assert.equal(annotated, '# Кто это\nЗовут Саня\n- [2026-03] Работает в банке\n');
});
