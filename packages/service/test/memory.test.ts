// Разбор разговора в память: чистые функции — разбор ответа модели и раскладка по полкам.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyExtraction,
  buildExtractionPrompt,
  formatTranscript,
  isAllowedTarget,
  isDuplicate,
  isEvidenceOf,
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
  const raw = 'Вот результат:\n```json\n{"journal":"говорили о кофе","notes":[{"file":"preferences.md","append":"- Кофе без сахара","evidence":"я без сахара"}]}\n```\nГотово.';
  const parsed = parseExtraction(raw);
  assert.ok(parsed);
  assert.equal(parsed?.journal, 'говорили о кофе');
  assert.deepEqual(parsed?.notes, [
    { file: 'preferences.md', append: '- Кофе без сахара', evidence: 'я без сахара' },
  ]);
});

test('запись без цитаты из слов человека отбрасывается', () => {
  // Та самая беда: модель пересказала совет Икара, не сверившись со словами человека.
  const raw = '{"notes":[{"file":"preferences.md","append":"- Заваривает сенчу при 70 °C"}]}';
  assert.equal(parseExtraction(raw), null, 'нет evidence — нет записи');

  const withGap = '{"notes":[{"file":"preferences.md","append":"- Заваривает сенчу при 70 °C","evidence":"   "}]}';
  assert.equal(parseExtraction(withGap), null, 'пустая цитата не считается');
});

test('цитата обязана быть дословно из реплики пользователя', () => {
  const transcript = [
    { role: 'assistant' as const, text: 'Сенчу заваривают при 70–75 °C.' },
    { role: 'user' as const, text: 'спасибо, попробую' },
  ];
  assert.equal(isEvidenceOf('Сенчу заваривают при 70–75 °C.', transcript), false, 'слова Икара не источник');
  assert.equal(isEvidenceOf('спасибо, попробую', transcript), true);
  assert.equal(isEvidenceOf('сенчу заваривают при 70', transcript), false);
});

test('реплики Икара помечены как контекст, а не как источник', () => {
  const formatted = formatTranscript([
    { role: 'user', text: 'пью сенчу' },
    { role: 'assistant', text: 'заваривай при 70 °C' },
  ]);
  assert.match(formatted, /ЧЕЛОВЕК: пью сенчу/);
  assert.match(formatted, /ИКАР \(контекст, не источник\): заваривай при 70 °C/);
});

test('факт из слов человека пишется вместе с цитатой', () => {
  const root = tempMemory();
  const result = applyExtraction(
    root,
    {
      notes: [
        { file: 'preferences.md', append: '- Пьёт сенчу', evidence: 'пью сенчу каждый день' },
      ],
    },
    new Date('2026-09-18T10:00:00Z'),
    [
      { role: 'user', text: 'пью сенчу каждый день' },
      { role: 'assistant', text: 'заваривай при 70 °C' },
    ],
  );
  assert.deepEqual(result.changed, ['preferences.md']);
  assert.match(fs.readFileSync(path.join(root, 'preferences.md'), 'utf8'), /- Пьёт сенчу \(его слова: «пью сенчу каждый день»\)/);
});

test('запись на основе слов Икара не доходит до полки', () => {
  const root = tempMemory();
  const result = applyExtraction(
    root,
    {
      notes: [
        // совет Икара про 70 °C, выданный за факт о человеке
        { file: 'preferences.md', append: '- Заваривает сенчу при 70 °C', evidence: 'заваривай при 70 °C' },
      ],
    },
    new Date('2026-09-18T10:00:00Z'),
    [
      { role: 'user', text: 'как заваривать сенчу?' },
      { role: 'assistant', text: 'заваривай при 70 °C' },
    ],
  );
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.rejected, ['preferences.md']);
  assert.equal(fs.existsSync(path.join(root, 'preferences.md')), false, 'файл не должен появиться');
});

test('короткое «да» в ответ на вопрос Икара подтверждает сказанное человеком', () => {
  const root = tempMemory();
  const entries = [
    { role: 'user' as const, text: 'пью сенчу' },
    { role: 'assistant' as const, text: 'то есть зелёный чай?' },
    { role: 'user' as const, text: 'да, именно так' },
  ];
  const result = applyExtraction(
    root,
    {
      notes: [
        { file: 'preferences.md', append: '- Пьёт сенчу', evidence: 'пью сенчу' },
        { file: 'preferences.md', append: '- Подтвердил: это зелёный чай', evidence: 'да, именно так' },
      ],
    },
    new Date('2026-09-18T10:00:00Z'),
    entries,
  );
  // «да» — не пустая реплика: оно подтверждает сказанное человеком выше, и запись с такой
  // цитатой проходит. Совет Икара в подтверждение не годится — его в репликах человека нет.
  assert.deepEqual(result.changed, ['preferences.md', 'preferences.md']);
  assert.deepEqual(result.rejected, []);
  const saved = fs.readFileSync(path.join(root, 'preferences.md'), 'utf8');
  assert.match(saved, /- Пьёт сенчу \(его слова: «пью сенчу»\)/);
  assert.match(saved, /- Подтвердил: это зелёный чай \(его слова: «да, именно так»\)/);
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
  // Пояс задаём явно: дата в промпте локальная, и тест не должен зависеть от пояса машины.
  const prompt = buildExtractionPrompt('Пользователь: привет', new Date('2026-09-18T00:00:00Z'), '', 'UTC');
  assert.match(prompt, /Пользователь: привет/);
  assert.match(prompt, /2026-09-18/);
  assert.match(prompt, /"notes"/);
});

test('промпт разбора запрещает брать факты из слов Икара', () => {
  const prompt = buildExtractionPrompt(
    [
      { role: 'user', text: 'как заваривать сенчу?' },
      { role: 'assistant', text: 'заваривай при 70 °C' },
    ],
    new Date('2026-09-18T00:00:00Z'),
    '',
    'UTC',
  );
  assert.match(prompt, /Память строится ТОЛЬКО из слов человека/);
  assert.match(prompt, /ИКАР \(контекст, не источник\): заваривай при 70 °C/);
  assert.match(prompt, /"evidence"/);
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
