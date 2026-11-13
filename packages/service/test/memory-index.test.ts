// Memory index for extraction: files are shown in full, but the whole block must
// stay within the character budget. Previously the index silently truncated each file to eight
// lines — with identity.md of 20+ facts, extraction never saw the later ones and bred duplicates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INDEX_BUDGET, memoryIndex } from '../../extensions/memory-extractor.ts';

function tempMemory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-index-'));
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  return dir;
}

function bullets(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_, i) => `- ${prefix} №${i + 1}`).join('\n')}\n`;
}

test('all facts of a file are visible, not just the first eight', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('факт', 25));

  const index = memoryIndex(root);
  assert.match(index, /факт №1\b/);
  assert.match(index, /факт №25\b/, 'поздние факты тоже должны попадать в индекс');
  assert.equal(
    index.split('\n').filter((line) => /факт №/.test(line)).length,
    25,
    'ничего не теряется, пока файл влезает в бюджет',
  );
});

test('short facts are shown as the whole file, not just the first eight', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('факт', 50));

  const index = memoryIndex(root);
  assert.equal(
    index.split('\n').filter((line) => /факт №/.test(line)).length,
    50,
    'бюджет позволяет — файл показываем целиком',
  );
});

test('the index fits within the character budget', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('очень длинный факт про человека', 120));
  for (let i = 0; i < 10; i += 1) {
    fs.writeFileSync(path.join(root, 'projects', `тема-${i}.md`), bullets(`проект ${i}`, 40));
  }

  const index = memoryIndex(root);
  assert.ok(index.length <= INDEX_BUDGET, `индекс разросся: ${index.length} символов`);
});

test('the tail of a truncated file is marked rather than silent', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('длинный факт номер', 200));

  const index = memoryIndex(root);
  assert.match(index, /ещё \d+ пункт/, 'обрезка должна быть видна словами');
  assert.ok(index.length <= INDEX_BUDGET, `индекс разросся: ${index.length} символов`);
});

test('we do not pull the journal into the index, but people and topics — yes', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'journal/2026-09.md'), '- 18.09 — секретное событие\n');
  fs.writeFileSync(path.join(root, 'people/маша.md'), '- Сестра, живёт в Порту\n');
  fs.writeFileSync(path.join(root, 'projects/дом.md'), '- Строит дом\n');

  const index = memoryIndex(root);
  assert.doesNotMatch(index, /секретное событие/);
  assert.match(index, /people\/маша\.md/);
  assert.match(index, /projects\/дом\.md/);
  assert.match(index, /Сестра, живёт в Порту/);
});

test('the names of all files are visible, even when the facts did not fit the budget', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('очень длинный факт про человека', 300));
  fs.writeFileSync(path.join(root, 'projects/домашняя_сеть.md'), bullets('роутер', 3));
  fs.writeFileSync(path.join(root, 'projects/щенок.md'), bullets('щенок', 3));

  const index = memoryIndex(root);
  assert.match(
    index,
    /^Файлы памяти \(пиши в существующий, близнецов не заводи\): identity\.md, projects\/домашняя_сеть\.md, projects\/щенок\.md/,
    'список имён идёт первым и не режется бюджетом',
  );
  assert.ok(index.length <= INDEX_BUDGET, `индекс разросся: ${index.length} символов`);
});

test('explicit limits still work', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('факт', 10));
  fs.writeFileSync(path.join(root, 'preferences.md'), bullets('вкус', 2));

  const limited = memoryIndex(root, 25, 3);
  assert.equal(limited.split('\n').filter((line) => /факт №/.test(line)).length, 3);

  const oneFile = memoryIndex(root, 1);
  assert.match(oneFile, /факт №1/);
  // maxFiles limits the fact blocks, not the list of names: names are the cheapest,
  // and extraction uses them to understand which topics are already taken.
  assert.doesNotMatch(oneFile, /вкус №1/, 'maxFiles остаётся ограничителем блоков');
  assert.match(oneFile, /Файлы памяти .*preferences\.md/, 'но имя файла видно всегда');
});

test('on empty memory the index is empty', () => {
  assert.equal(memoryIndex(tempMemory()), '');
});
