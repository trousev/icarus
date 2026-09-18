// Разбор разговора в память: чистые функции — разбор ответа модели и раскладка по полкам.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyExtraction,
  buildExtractionPrompt,
  isAllowedTarget,
  isDuplicate,
  memoryIndex,
  parseExtraction,
} from '../../extensions/memory-extractor.ts';
import { buildMemoryCore } from '../../extensions/lib/memory-core.ts';

function tempMemory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-memory-'));
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  return dir;
}

test('писать можно только в известные полки', () => {
  assert.equal(isAllowedTarget('identity.md'), true);
  assert.equal(isAllowedTarget('preferences.md'), true);
  assert.equal(isAllowedTarget('people/маша.md'), true);
  assert.equal(isAllowedTarget('projects/икар.md'), true);
  assert.equal(isAllowedTarget('journal/2026-09.md'), false, 'журнал ведёт код, а не модель');
  assert.equal(isAllowedTarget('../../etc/passwd'), false);
  assert.equal(isAllowedTarget('/etc/passwd'), false);
  assert.equal(isAllowedTarget('shared-memory/общее.md'), false, 'в семейную память только по просьбе');
  assert.equal(isAllowedTarget('notes.txt'), false);
});

test('JSON достаётся из ответа с пояснениями и ```', () => {
  const raw = 'Вот результат:\n```json\n{"journal":"говорили о кофе","notes":[{"file":"preferences.md","append":"- Кофе без сахара"}]}\n```\nГотово.';
  const parsed = parseExtraction(raw);
  assert.ok(parsed);
  assert.equal(parsed?.journal, 'говорили о кофе');
  assert.deepEqual(parsed?.notes, [{ file: 'preferences.md', append: '- Кофе без сахара' }]);
});

test('мусор и пустые записи отбрасываются', () => {
  assert.equal(parseExtraction('никакого json тут нет'), null);
  assert.equal(parseExtraction('{"notes":[]}'), null);
  const parsed = parseExtraction('{"notes":[{"file":"identity.md"},{"append":"без файла"},{"file":"identity.md","append":"   "}]}');
  assert.equal(parsed, null);
});

test('факты раскладываются по полкам, дубликаты не плодятся', () => {
  const root = tempMemory();
  const extraction = {
    journal: 'обсуждали переезд и кофе',
    notes: [
      { file: 'preferences.md', append: '- Кофе без сахара' },
      { file: 'people/маша.md', append: '- Сестра, живёт в Порту' },
      { file: 'shared-memory/общее.md', append: '- не должно попасть' },
    ],
  };

  const first = applyExtraction(root, extraction, new Date('2026-09-18T10:00:00Z'));
  assert.deepEqual(first.changed.sort(), ['journal/2026-09.md', 'people/маша.md', 'preferences.md']);
  assert.deepEqual(first.rejected, ['shared-memory/общее.md']);

  assert.match(fs.readFileSync(path.join(root, 'preferences.md'), 'utf8'), /- Кофе без сахара/);
  assert.match(fs.readFileSync(path.join(root, 'journal/2026-09.md'), 'utf8'), /- 18\.09 — обсуждали переезд и кофе/);

  // второй прогон с тем же фактом ничего не меняет
  const second = applyExtraction(root, extraction, new Date('2026-09-18T11:00:00Z'));
  assert.deepEqual(second.changed, []);
  assert.ok(second.skipped.length >= 3, 'всё должно опознаться как уже известное');
});

test('дописывание не ломает существующий файл без перевода строки в конце', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Старое');
  applyExtraction(root, { notes: [{ file: 'preferences.md', append: '- Новое' }] });
  assert.equal(fs.readFileSync(path.join(root, 'preferences.md'), 'utf8'), '- Старое\n- Новое\n');
});

test('промпт разбора содержит разговор и сегодняшнюю дату', () => {
  const prompt = buildExtractionPrompt('Пользователь: привет', new Date('2026-09-18T00:00:00Z'));
  assert.match(prompt, /Пользователь: привет/);
  assert.match(prompt, /2026-09-18/);
  assert.match(prompt, /"notes"/);
});

test('похожие формулировки не превращаются в дубли', () => {
  const existing = ['- Не будить раньше 09:00.', '- Кот Барсик: рыжий, толстый'];

  assert.equal(isDuplicate(existing, '- Не будить раньше 9 утра'), true, 'перефраз того же запрета');
  assert.equal(isDuplicate(existing, '- Кот Барсик рыжий и толстый'), true, 'перефраз факта про кота');
  assert.equal(isDuplicate(existing, '- Любит чёрный чай с бергамотом'), false, 'новый факт не режется');
});

test('индекс памяти содержит пути и уже записанные факты', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Кофе без сахара\n');
  fs.writeFileSync(path.join(root, 'people/barsik.md'), '- Кот, рыжий\n');
  fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(root, 'journal/2026-09.md'), '- 18.09 — что-то было\n');

  const index = memoryIndex(root);
  assert.match(index, /preferences\.md/);
  assert.match(index, /people\/barsik\.md/);
  assert.match(index, /Кофе без сахара/);
  assert.doesNotMatch(index, /что-то было/, 'журнал в индекс не тащим');
});

test('разбор получает индекс и не должен повторяться', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Не будить до 09:00\n');
  const prompt = buildExtractionPrompt('Разговор', new Date('2026-09-18T00:00:00Z'), memoryIndex(root));
  assert.match(prompt, /уже записано/);
  assert.match(prompt, /Не будить до 09:00/);
});

test('дедупликация работает и при раскладке', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Не будить раньше 09:00.\n');
  const result = applyExtraction(root, { notes: [{ file: 'preferences.md', append: '- Не будить раньше 9 утра' }] });
  assert.deepEqual(result.changed, [], 'перефраз не должен дописываться');
  assert.equal(fs.readFileSync(path.join(root, 'preferences.md'), 'utf8').split('\n').filter(Boolean).length, 1);
});

test('ядро памяти собирается из полок и пусто, если памяти нет', () => {
  const root = tempMemory();
  assert.equal(buildMemoryCore(root), '', 'на пустой памяти ядро не выдумывается');

  fs.writeFileSync(path.join(root, 'identity.md'), '# Кто это\n- Зовут Саня');
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Кофе без сахара');
  fs.writeFileSync(path.join(root, 'people/маша.md'), '- Сестра');

  const core = buildMemoryCore(root);
  assert.match(core, /Зовут Саня/);
  assert.match(core, /Кофе без сахара/);
  assert.match(core, /маша/);
});

test('ядро памяти не разрастается бесконечно', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), 'x'.repeat(5000));
  const core = buildMemoryCore(root);
  assert.ok(core.length < 2500, `ядро должно обрезаться, получилось ${core.length}`);
});
