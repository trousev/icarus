// Parsing a conversation into memory: pure functions — parsing the model response and filing it onto shelves.
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
import { buildMemoryCore, memoryPrompt } from '../../extensions/lib/memory-core.ts';

function tempMemory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-memory-'));
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  return dir;
}

test('you can write only to known shelves', () => {
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

test('JSON is extracted from a response with explanations and ```', () => {
  const raw = 'Вот результат:\n```json\n{"journal":"говорили о кофе","notes":[{"file":"preferences.md","append":"- Кофе без сахара","evidence":"я без сахара"}]}\n```\nГотово.';
  const parsed = parseExtraction(raw);
  assert.ok(parsed);
  assert.equal(parsed?.journal, 'говорили о кофе');
  assert.deepEqual(parsed?.notes, [
    { file: 'preferences.md', append: '- Кофе без сахара', evidence: 'я без сахара' },
  ]);
});

test('an entry without a quote from the human words is dropped', () => {
  // The very trouble: the model retold Icarus's advice without checking the human words.
  const raw = '{"notes":[{"file":"preferences.md","append":"- Заваривает сенчу при 70 °C"}]}';
  assert.equal(parseExtraction(raw), null, 'нет evidence — нет записи');

  const withGap = '{"notes":[{"file":"preferences.md","append":"- Заваривает сенчу при 70 °C","evidence":"   "}]}';
  assert.equal(parseExtraction(withGap), null, 'пустая цитата не считается');
});

test('the quote must be verbatim from the user message', () => {
  const transcript = [
    { role: 'assistant' as const, text: 'Сенчу заваривают при 70–75 °C.' },
    { role: 'user' as const, text: 'спасибо, попробую' },
  ];
  assert.equal(isEvidenceOf('Сенчу заваривают при 70–75 °C.', transcript), false, 'слова Икара не источник');
  assert.equal(isEvidenceOf('спасибо, попробую', transcript), true);
  assert.equal(isEvidenceOf('сенчу заваривают при 70', transcript), false);
});

test('Icarus messages are marked as context, not as a source', () => {
  const formatted = formatTranscript([
    { role: 'user', text: 'пью сенчу' },
    { role: 'assistant', text: 'заваривай при 70 °C' },
  ]);
  assert.match(formatted, /ЧЕЛОВЕК: пью сенчу/);
  assert.match(formatted, /ИКАР \(контекст, не источник\): заваривай при 70 °C/);
});

test('a fact from the human words is written together with the quote', () => {
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

test('an entry based on Icarus words never reaches the shelf', () => {
  const root = tempMemory();
  const result = applyExtraction(
    root,
    {
      notes: [
        // Icarus's advice about 70 °C passed off as a fact about the human
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

test('a short "yes" in reply to Icarus question confirms what the human said', () => {
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
  // "yes" is not an empty message: it confirms what the human said above, and an
  // entry with such a quote passes. Icarus's advice will not do as confirmation —
  // it is not among the human messages.
  assert.deepEqual(result.changed, ['preferences.md', 'preferences.md']);
  assert.deepEqual(result.rejected, []);
  const saved = fs.readFileSync(path.join(root, 'preferences.md'), 'utf8');
  assert.match(saved, /- Пьёт сенчу \(его слова: «пью сенчу»\)/);
  assert.match(saved, /- Подтвердил: это зелёный чай \(его слова: «да, именно так»\)/);
});

test('garbage and empty entries are dropped', () => {
  assert.equal(parseExtraction('никакого json тут нет'), null);
  assert.equal(parseExtraction('{"notes":[]}'), null);
  const parsed = parseExtraction('{"notes":[{"file":"identity.md"},{"append":"без файла"},{"file":"identity.md","append":"   "}]}');
  assert.equal(parsed, null);
});

test('facts are filed onto shelves, duplicates are not multiplied', () => {
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

  // a second run with the same fact changes nothing
  const second = applyExtraction(root, extraction, new Date('2026-09-18T11:00:00Z'));
  assert.deepEqual(second.changed, []);
  assert.ok(second.skipped.length >= 3, 'всё должно опознаться как уже известное');
});

test('appending does not break an existing file without a trailing newline', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Старое');
  applyExtraction(root, { notes: [{ file: 'preferences.md', append: '- Новое' }] });
  assert.equal(fs.readFileSync(path.join(root, 'preferences.md'), 'utf8'), '- Старое\n- Новое\n');
});

test('the extraction prompt contains the conversation and today date', () => {
  // We set the time zone explicitly: the date in the prompt is local, and the test
  // must not depend on the machine time zone.
  const prompt = buildExtractionPrompt('Пользователь: привет', new Date('2026-09-18T00:00:00Z'), '', 'UTC');
  assert.match(prompt, /Пользователь: привет/);
  assert.match(prompt, /2026-09-18/);
  assert.match(prompt, /"notes"/);
});

test('the extraction prompt forbids taking facts from Icarus words', () => {
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

test('similar wordings do not turn into duplicates', () => {
  const existing = ['- Не будить раньше 09:00.', '- Кот Барсик: рыжий, толстый'];

  assert.equal(isDuplicate(existing, '- Не будить раньше 9 утра'), true, 'перефраз того же запрета');
  assert.equal(isDuplicate(existing, '- Кот Барсик рыжий и толстый'), true, 'перефраз факта про кота');
  assert.equal(isDuplicate(existing, '- Любит чёрный чай с бергамотом'), false, 'новый факт не режется');
});

test('the memory index contains paths and already written facts', () => {
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

test('extraction receives the index and must not repeat itself', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Не будить до 09:00\n');
  const prompt = buildExtractionPrompt('Разговор', new Date('2026-09-18T00:00:00Z'), memoryIndex(root));
  assert.match(prompt, /уже записано/);
  assert.match(prompt, /Не будить до 09:00/);
});

test('deduplication also works during filing', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Не будить раньше 09:00.\n');
  const result = applyExtraction(root, { notes: [{ file: 'preferences.md', append: '- Не будить раньше 9 утра' }] });
  assert.deepEqual(result.changed, [], 'перефраз не должен дописываться');
  assert.equal(fs.readFileSync(path.join(root, 'preferences.md'), 'utf8').split('\n').filter(Boolean).length, 1);
});

test('the core contains only the personal: people and projects are read by topic', () => {
  const root = tempMemory();
  assert.equal(buildMemoryCore(root), '', 'на пустой памяти ядро не выдумывается');

  fs.writeFileSync(path.join(root, 'identity.md'), '# Кто это\n- Зовут Саня');
  fs.writeFileSync(path.join(root, 'preferences.md'), '- Кофе без сахара');
  fs.writeFileSync(path.join(root, 'people/маша.md'), '- Сестра');

  const core = buildMemoryCore(root);
  assert.match(core, /Зовут Саня/);
  assert.match(core, /Кофе без сахара/);
  // People do not enter the core: otherwise memory itself picks the topic of the conversation.
  assert.doesNotMatch(core, /маша/, 'люди — не ядро');
});

test('the memory block directly forbids choosing the topic from memory', () => {
  const block = memoryPrompt('## Кто это\n- Зовут Саня');
  assert.match(block, /Зовут Саня/, 'факты остаются в блоке');
  // A complaint from prod: an on-topic answer ended with "by the way, …" from memory.
  // The rule must sit next to the facts, not only in the persona: the temptation starts here.
  assert.match(block, /Память отвечает, а не начинает/);
  assert.match(block, /не делай её темой, вопросом, шуткой или утешением/);
  assert.match(block, /Для ответа — ищи и используй/, 'искать для ответа разрешено и нужно');
  assert.match(block, /Советуешь, планируешь или вспоминаешь — сначала `memory_index`/);
  assert.match(block, /Люди и проекты лежат в памяти, а не здесь/, 'модель знает, где искать людей и проекты');

  assert.equal(memoryPrompt(''), '', 'на пустой памяти блока нет');
});

test('frontmatter with a description does not enter the core', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), '---\ndescription: кто он\n---\n- Зовут Саня\n');

  const core = buildMemoryCore(root);
  assert.match(core, /Зовут Саня/, 'факт на месте');
  assert.doesNotMatch(core, /description/, 'описание — метаданные индекса, не факт');
  assert.doesNotMatch(core, /^---$/m, 'frontmatter в ядро не едет');
});

test('the memory core does not grow without bound', () => {
  const root = tempMemory();
  fs.writeFileSync(path.join(root, 'identity.md'), 'x'.repeat(5000));
  const core = buildMemoryCore(root);
  assert.ok(core.length < 2500, `ядро должно обрезаться, получилось ${core.length}`);
});
