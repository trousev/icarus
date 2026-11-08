// Каталог памяти: описания в frontmatter, индекс файлов, обновление описания.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCatalog,
  descriptionOf,
  formatCatalog,
  stripFrontmatter,
  updateDescription,
  withDescription,
} from '../../extensions/lib/memory-catalog.ts';

function tempMemory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-catalog-'));
  fs.mkdirSync(path.join(root, 'people'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
  return root;
}

test('описание читается из frontmatter и из голой строки', () => {
  assert.equal(descriptionOf('---\ndescription: про Arduino\n---\n- факт\n'), 'про Arduino');
  assert.equal(descriptionOf('---\nпро Arduino и диоды\n---\n- факт\n'), 'про Arduino и диоды');
  assert.equal(descriptionOf('- просто факт\n'), '');
});

test('frontmatter вырезается из тела, но описание остаётся в файле', () => {
  const text = '---\ndescription: про Arduino\n---\n- диод мигает\n';
  assert.equal(stripFrontmatter(text), '- диод мигает\n');
  assert.equal(descriptionOf(text), 'про Arduino');
});

test('withDescription добавляет блок и не теряет остальные ключи', () => {
  const added = withDescription('- факт\n', 'про Arduino');
  assert.match(added, /^---\ndescription: про Arduino\n---\n\n- факт\n$/);

  const replaced = withDescription('---\ntags: memory\ndescription: старое\n---\n- факт\n', 'новое');
  assert.match(replaced, /tags: memory/);
  assert.match(replaced, /description: новое/);
  assert.doesNotMatch(replaced, /description: старое/);
});

test('описание всегда одна строка и не разрастается', () => {
  const added = withDescription('- факт\n', '  про\nArduino   и диоды  '.repeat(30));
  const line = added.split('\n')[1] ?? '';
  assert.doesNotMatch(line, /\n/);
  assert.ok(line.length <= 230, `описание не обрезалось: ${line.length}`);
});

test('каталог: порядок, описания, пустые файлы не мешают', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '---\ndescription: кто он\n---\n- Зовут Саня\n');
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Чай без сахара\n');
  fs.writeFileSync(path.join(root, 'people/vita.md'), '---\ndescription: жена Виталия\n---\n- Работает в Mastercard\n');
  fs.writeFileSync(path.join(root, 'projects/arduino.md'), '---\nпро Arduino и диоды\n---\n- Мигает диод\n');
  fs.writeFileSync(path.join(root, 'projects/empty.md'), '');
  fs.writeFileSync(path.join(root, 'journal/2026-11.md'), '- 07.11 — разговор\n');

  const files = buildCatalog(root);
  assert.deepEqual(files.map((file) => file.rel), [
    'identity.md',
    'preferences.md',
    'people/vita.md',
    'projects/arduino.md',
    'journal/2026-11.md',
  ]);
  assert.equal(files[0]?.description, 'кто он');
  assert.equal(files[1]?.description, 'вкусы, привычки, табу', 'у предпочтений есть разумный дефолт');
  assert.equal(files[3]?.description, 'про Arduino и диоды');
  assert.equal(files[4]?.description, 'журнал за 11.2026');

  const text = formatCatalog(files);
  assert.match(text, /projects\/arduino\.md/);
  assert.match(text, /про Arduino и диоды/);
  assert.match(text, /read/, 'модели сказано, чем читать');
});

test('update_description пишет описание и не выходит за память', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'projects/arduino.md'), '- Мигает диод\n');

  const result = updateDescription('projects/arduino.md', 'про Arduino и диоды', root);
  assert.equal(result.ok, true);
  const text = fs.readFileSync(path.join(root, 'projects/arduino.md'), 'utf8');
  assert.match(text, /description: про Arduino и диоды/);
  assert.match(text, /- Мигает диод/, 'тело файла не потерялось');

  assert.equal(updateDescription('../outside.md', 'нет', root).ok, false, 'наружу нельзя');
  assert.equal(updateDescription('/etc/passwd.md', 'нет', root).ok, false, 'абсолютный путь нельзя');
  assert.equal(updateDescription('projects/note.txt', 'нет', root).ok, false, 'только .md');
  assert.equal(updateDescription('projects/missing.md', 'нет', root).ok, false, 'нет файла — нет записи');
  assert.equal(updateDescription('projects/arduino.md', '   ', root).ok, false, 'пустое описание не пишем');
});
