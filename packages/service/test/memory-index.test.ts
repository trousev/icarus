// Индекс памяти для разбора: файлы показываются целиком, но весь блок обязан
// оставаться в бюджете символов. Раньше индекс молча обрезал каждый файл на восьми
// строках — на identity.md в 20+ фактов разбор не видел поздние и плодил дубли.
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

test('видны все факты файла, а не только первые восемь', () => {
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

test('короткие факты показываются целым файлом, а не первыми восемью', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('факт', 50));

  const index = memoryIndex(root);
  assert.equal(
    index.split('\n').filter((line) => /факт №/.test(line)).length,
    50,
    'бюджет позволяет — файл показываем целиком',
  );
});

test('индекс помещается в бюджет символов', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('очень длинный факт про человека', 120));
  for (let i = 0; i < 10; i += 1) {
    fs.writeFileSync(path.join(root, 'projects', `тема-${i}.md`), bullets(`проект ${i}`, 40));
  }

  const index = memoryIndex(root);
  assert.ok(index.length <= INDEX_BUDGET, `индекс разросся: ${index.length} символов`);
});

test('хвост обрезанного файла помечен, а не молчит', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('длинный факт номер', 200));

  const index = memoryIndex(root);
  assert.match(index, /ещё \d+ пункт/, 'обрезка должна быть видна словами');
  assert.ok(index.length <= INDEX_BUDGET, `индекс разросся: ${index.length} символов`);
});

test('журнал в индекс не тащим, а люди и темы — да', () => {
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

test('явные лимиты по-прежнему работают', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), bullets('факт', 10));
  fs.writeFileSync(path.join(root, 'preferences.md'), bullets('вкус', 2));

  const limited = memoryIndex(root, 25, 3);
  assert.equal(limited.split('\n').filter((line) => /факт №/.test(line)).length, 3);

  const oneFile = memoryIndex(root, 1);
  assert.match(oneFile, /факт №1/);
  assert.doesNotMatch(oneFile, /preferences\.md/, 'maxFiles остаётся ограничителем');
});

test('на пустой памяти индекс пуст', () => {
  assert.equal(memoryIndex(tempMemory()), '');
});
