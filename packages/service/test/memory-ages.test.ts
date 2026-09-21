// Возраст факта при чтении: ядро памяти помечает пункты месяцем из git-истории
// памяти (`- [2026-03] текст`). Проверяем на временном git-репозитории: месяц берётся
// у автора строки, текст не меняется, а без git память читается как раньше.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotateAges, buildMemoryCore, clearMemoryAges } from '../../extensions/lib/memory-core.ts';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** Тесты про git пропускаем только там, где git действительно нет. */
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

/** Коммит с заданной датой автора и коммиттера — так blame отдаёт нужный месяц. */
function commitAt(root: string, iso: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

ageTest('ядро помечает пункты месяцем из git-истории', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '# Кто это\n- Зовут Саня\n- Работает в банке\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- \[2026-03\] Зовут Саня/);
  assert.match(core, /- \[2026-03\] Работает в банке/);
  assert.doesNotMatch(core, /\[2026-03\] Кто это/, 'заголовки не пункты — метки у них нет');
});

ageTest('текст пункта при аннотации не меняется', () => {
  const root = tempRepo();
  const original = '- Пьёт сенчу (его слова: «пью сенчу»)\n';
  fs.writeFileSync(path.join(root, 'identity.md'), original);
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  const line = buildMemoryCore(root)
    .split('\n')
    .find((row) => row.includes('сенчу'));
  assert.equal(line, '- [2026-03] Пьёт сенчу (его слова: «пью сенчу»)');
  // Снимаем метку — получаем исходный текст строки до символа.
  assert.equal(line?.replace(/^(\s*[-*]\s+)\[\d{4}-\d{2}\] /, '$1'), original.trim());
});

ageTest('месяц берётся у каждой строки своя', () => {
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

ageTest('люди и проекты тоже получают метку', () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, 'people'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'people/маша.md'), '- Сестра, живёт в Порту\n');
  fs.writeFileSync(path.join(root, 'projects/дом.md'), '- Строит дом\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- \[2026-03\] Сестра, живёт в Порту/);
  assert.match(core, /- \[2026-03\] Строит дом/);
});

ageTest('незакоммиченная строка остаётся без метки, соседние — с меткой', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  fs.appendFileSync(path.join(root, 'identity.md'), '- Любит собак\n');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- \[2026-03\] Зовут Саня/);
  assert.match(core, /^- Любит собак$/m, 'у незакоммиченной строки даты нет');
});

ageTest('память меняется — метки обновляются, промпт пересобирается', () => {
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

ageTest('пока память не менялась, ядро отдаёт то же самое', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  assert.equal(buildMemoryCore(root), buildMemoryCore(root), 'метка не должна «плыть» между ходами');
});

test('без git-репозитория текст читается без метки', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-nogit-'));
  fs.writeFileSync(path.join(root, 'identity.md'), '- Зовут Саня\n');
  clearMemoryAges();

  const core = buildMemoryCore(root);
  assert.match(core, /- Зовут Саня/, 'факт на месте');
  assert.doesNotMatch(core, /\[\d{4}-\d{2}\]/, 'метку выдумывать не из чего');
});

test('аннотация не трогает заголовки и строки без списка', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'identity.md'), '# Кто это\nЗовут Саня\n- Работает в банке\n');
  commitAt(root, '2026-03-15T12:00:00+00:00', 'memory: март');
  clearMemoryAges();

  const annotated = annotateAges(path.join(root, 'identity.md'), '# Кто это\nЗовут Саня\n- Работает в банке\n');
  assert.equal(annotated, '# Кто это\nЗовут Саня\n- [2026-03] Работает в банке\n');
});
