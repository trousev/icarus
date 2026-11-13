// Control panel: path protection, search, forgetting and git rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, readImageFile, readMemoryFile, removeFile, removeLine, resolveInside, searchMemory } from '../src/control/memory.ts';
import { commitAll, ensureRepo, log, revert, show } from '../src/control/git.ts';

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-panel-'));
  fs.mkdirSync(path.join(root, 'people'), { recursive: true });
  fs.writeFileSync(path.join(root, 'preferences.md'), '# Предпочтения\n- Кофе без сахара\n- Не будить до 09:00\n');
  fs.writeFileSync(path.join(root, 'people/barsik.md'), '- Кот, рыжий\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'не markdown');
  return root;
}

test('does not let out of the memory directory', () => {
  const root = tempRoot();
  assert.ok(resolveInside(root, 'preferences.md'));
  assert.ok(resolveInside(root, 'people/barsik.md'));
  assert.equal(resolveInside(root, '../../etc/passwd.md'), null);
  assert.equal(resolveInside(root, '/etc/passwd.md'), null);
  assert.equal(resolveInside(root, 'notes.txt'), null, 'только markdown');
  assert.equal(resolveInside(root, 'people/../../secret.md'), null);
});

test('files are listed recursively, service ones are skipped', () => {
  const root = tempRoot();
  const files = listFiles(root).map((file) => file.path);
  assert.deepEqual(files.sort(), ['people/barsik.md', 'preferences.md']);
});

test('reading a file and searching by lines', () => {
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

test('forgetting removes exactly one line', () => {
  const root = tempRoot();
  const result = removeLine(root, 'preferences.md', '- Не будить до 09:00');
  assert.equal(result.ok, true);

  const content = String(readMemoryFile(root, 'preferences.md'));
  assert.doesNotMatch(content, /Не будить/);
  assert.match(content, /Кофе без сахара/, 'остальное не тронуто');

  assert.equal(removeLine(root, 'preferences.md', '- Такой строки нет').ok, false);
  assert.equal(removeLine(root, '../../etc/passwd.md', 'что-нибудь').ok, false);
});

test('a file is removed entirely, but not outside memory and not a directory', () => {
  const root = tempRoot();
  // A directory with a memory «extension» is still not deleted: we remove a file, not a shelf.
  fs.mkdirSync(path.join(root, 'archive.md'), { recursive: true });

  assert.equal(removeFile(root, '../../etc/passwd.md').ok, false, 'за пределы памяти нельзя');
  assert.equal(removeFile(root, 'notes.txt').ok, false, 'не markdown не трогаем');
  assert.equal(removeFile(root, 'archive.md').ok, false, 'каталог целиком не удаляем');

  assert.equal(removeFile(root, 'people/barsik.md').ok, true);
  assert.equal(fs.existsSync(path.join(root, 'people/barsik.md')), false, 'файла больше нет');
  assert.equal(removeFile(root, 'people/barsik.md').ok, false, 'дважды один файл не удалить');
  assert.ok(fs.existsSync(path.join(root, 'preferences.md')), 'соседние файлы целы');
});

test('git: history, diff and rollback', async () => {
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

test('rollback by a garbage hash is not performed', async () => {
  const root = tempRoot();
  await ensureRepo(root);
  assert.equal((await revert(root, 'не-хеш')).ok, false);
});

test('the set of allowed extensions is set from outside and is not blurred', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-rules-'));
  // Its own set — like the section that opens more than just .md.
  const allowed = new Set(['.jsonl', '.mw', '.gif']);
  fs.writeFileSync(path.join(root, 'osc.jsonl'), '{"code":"dsolve(...):"}\n');
  fs.writeFileSync(path.join(root, '0123456789abcdef.gif'), 'GIF89a');
  fs.writeFileSync(path.join(root, 'worksheet.mw'), '<worksheet/>');
  // An alien set is not mixed into this section.
  fs.writeFileSync(path.join(root, 'identity.md'), '- Кто-то\n');

  assert.deepEqual(
    listFiles(root, '', allowed).map((file) => file.path).sort(),
    ['0123456789abcdef.gif', 'osc.jsonl', 'worksheet.mw'],
  );
  assert.match(String(readMemoryFile(root, 'osc.jsonl', allowed)), /dsolve/);

  const image = readImageFile(root, '0123456789abcdef.gif', allowed);
  assert.ok(image);
  assert.equal(image.type, 'image/gif');
  // Not an image and not an allowed extension — we do not serve it.
  assert.equal(readImageFile(root, 'osc.jsonl', allowed), null);
  assert.equal(readImageFile(root, '../../etc/passwd.gif', allowed), null);
  assert.equal(readMemoryFile(root, 'identity.md', allowed), null);

  // «Forget a line» in an alien file is not allowed: it does not pass by extensions.
  assert.equal(removeLine(root, 'osc.jsonl', '- Любая строка').ok, false);
  // But for ordinary memory it is still possible.
  assert.equal(removeLine(root, 'identity.md', '- Кто-то').ok, true);
});
