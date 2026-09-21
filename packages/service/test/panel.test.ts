// Панель памяти: защита путей, поиск, забывание и git-откат.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, mapleExtensions, readImageFile, readMemoryFile, removeLine, resolveInside, searchMemory } from '../src/panel/memory.ts';
import { commitAll, ensureRepo, log, revert, show } from '../src/panel/git.ts';

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-panel-'));
  fs.mkdirSync(path.join(root, 'people'), { recursive: true });
  fs.writeFileSync(path.join(root, 'preferences.md'), '# Предпочтения\n- Кофе без сахара\n- Не будить до 09:00\n');
  fs.writeFileSync(path.join(root, 'people/barsik.md'), '- Кот, рыжий\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'не markdown');
  return root;
}

test('за пределы каталога памяти не выпускает', () => {
  const root = tempRoot();
  assert.ok(resolveInside(root, 'preferences.md'));
  assert.ok(resolveInside(root, 'people/barsik.md'));
  assert.equal(resolveInside(root, '../../etc/passwd.md'), null);
  assert.equal(resolveInside(root, '/etc/passwd.md'), null);
  assert.equal(resolveInside(root, 'notes.txt'), null, 'только markdown');
  assert.equal(resolveInside(root, 'people/../../secret.md'), null);
});

test('файлы перечисляются рекурсивно, служебное пропускается', () => {
  const root = tempRoot();
  const files = listFiles(root).map((file) => file.path);
  assert.deepEqual(files.sort(), ['people/barsik.md', 'preferences.md']);
});

test('чтение файла и поиск по строкам', () => {
  const root = tempRoot();
  assert.match(String(readMemoryFile(root, 'preferences.md')), /Кофе без сахара/);
  assert.equal(readMemoryFile(root, '../../etc/passwd.md'), null);

  const hits = searchMemory(root, 'кофе');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'preferences.md');
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].text, /Кофе без сахара/);

  assert.deepEqual(searchMemory(root, 'к'), [], 'слишком короткий запрос не ищем');
});

test('забывание убирает ровно одну строку', () => {
  const root = tempRoot();
  const result = removeLine(root, 'preferences.md', '- Не будить до 09:00');
  assert.equal(result.ok, true);

  const content = String(readMemoryFile(root, 'preferences.md'));
  assert.doesNotMatch(content, /Не будить/);
  assert.match(content, /Кофе без сахара/, 'остальное не тронуто');

  assert.equal(removeLine(root, 'preferences.md', '- Такой строки нет').ok, false);
  assert.equal(removeLine(root, '../../etc/passwd.md', 'что-нибудь').ok, false);
});

test('git: история, дифф и откат', async () => {
  const root = tempRoot();
  await ensureRepo(root);
  assert.equal(await commitAll(root, 'memory: первый разбор'), true);

  fs.writeFileSync(path.join(root, 'preferences.md'), '# Предпочтения\n- Кофе без сахара\n- Любит тишину\n');
  assert.equal(await commitAll(root, 'memory: второй разбор'), true);

  const commits = await log(root);
  assert.equal(commits.length, 2);
  assert.match(commits[0].subject, /второй разбор/);
  assert.ok(commits[0].hash.length >= 7);

  const diff = await show(root, commits[0].hash);
  assert.match(diff.patch, /Любит тишину/);

  const reverted = await revert(root, commits[0].hash);
  assert.equal(reverted.ok, true);
  const content = String(readMemoryFile(root, 'preferences.md'));
  assert.doesNotMatch(content, /Любит тишину/, 'откат вернул прежнее состояние');
  assert.match(content, /Кофе без сахара/);
});

test('откат по мусорному хешу не делается', async () => {
  const root = tempRoot();
  await ensureRepo(root);
  assert.equal((await revert(root, 'не-хеш')).ok, false);
});

test('математика: журналы и графики читаются своим набором расширений', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-maple-'));
  fs.writeFileSync(path.join(root, 'osc.jsonl'), '{"code":"dsolve(...):"}\n');
  fs.writeFileSync(path.join(root, '0123456789abcdef.gif'), 'GIF89a');
  fs.writeFileSync(path.join(root, 'worksheet.mw'), '<worksheet/>');
  // Память в каталог математики не подмешивается: разделы не пересекаются.
  fs.writeFileSync(path.join(root, 'identity.md'), '- Кто-то\n');

  assert.deepEqual(
    listFiles(root, '', mapleExtensions).map((file) => file.path).sort(),
    ['0123456789abcdef.gif', 'osc.jsonl', 'worksheet.mw'],
  );
  assert.match(String(readMemoryFile(root, 'osc.jsonl', mapleExtensions)), /dsolve/);

  const image = readImageFile(root, '0123456789abcdef.gif', mapleExtensions);
  assert.ok(image);
  assert.equal(image.type, 'image/gif');
  // Не картинка и не разрешённое расширение — не отдаём.
  assert.equal(readImageFile(root, 'osc.jsonl', mapleExtensions), null);
  assert.equal(readImageFile(root, '../../etc/passwd.gif', mapleExtensions), null);
  assert.equal(readMemoryFile(root, 'identity.md', mapleExtensions), null);

  // «Забыть строку» в журнале Maple — нельзя: файл не проходит по расширениям.
  assert.equal(removeLine(root, 'osc.jsonl', '- Любая строка').ok, false);
  // А обычной памяти это по-прежнему можно.
  assert.equal(removeLine(root, 'identity.md', '- Кто-то').ok, true);
});
