// The family memory in the core: the person's own shelf is not the only thing Icarus must know
// from the first second — the family identity has to be there too. The rules are narrow and
// these tests hold them: exactly one file from `shared-memory`, inside the same block, with its
// own cap, and a missing shared store is not an error but simply an absent section.
//
// The shared root is passed explicitly: the core must not read a live `.icarus/shared-memory`
// while a test checks what fits into the prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMemoryCore, memoryPrompt } from '../../extensions/lib/memory-core.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A person's shelf and a family shelf, both under their own temporary roots. */
function shelves(options: { personal?: Record<string, string>; shared?: Record<string, string> } = {}) {
  const root = tempDir('icarus-core-');
  const shared = tempDir('icarus-shared-');
  for (const [rel, content] of Object.entries(options.personal ?? {})) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  for (const [rel, content] of Object.entries(options.shared ?? {})) {
    const file = path.join(shared, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, shared };
}

test('the family identity gets into the core after the personal shelves', () => {
  const { root, shared } = shelves({
    personal: { 'identity.md': '- Зовут Саня\n', 'preferences.md': '- Кофе без сахара\n' },
    shared: { 'identity.md': '# Семья\n- Дори — бассет-хаунд, наша собака\n' },
  });

  const core = buildMemoryCore(root, shared);
  assert.match(core, /## Кто это[\s\S]*## Предпочтения[\s\S]*## Семья/);
  assert.match(core, /- Дори — бассет-хаунд, наша собака/);
});

test('only identity.md comes from the family shelf, the rest stays behind links', () => {
  const { root, shared } = shelves({
    personal: { 'identity.md': '- Зовут Саня\n' },
    shared: {
      'identity.md': '# Семья\n- Подробности о собаке — в projects/дори.md\n',
      'projects/дори.md': '# Дори\n- Не любит, когда её будят в семь утра\n',
      'masters.md': '# Мастера\n- Сантехник Патрик, +353 87 000 0000\n',
    },
  });

  const core = buildMemoryCore(root, shared);
  assert.match(core, /проекты\/дори|projects\/дори/, 'ссылка из файла остаётся на месте');
  assert.doesNotMatch(core, /будят в семь утра/, 'содержимое проекта В ядро не поехало');
  assert.doesNotMatch(core, /Сантехник Патрик/, 'список мастеров — тоже ссылка, а не содержимое');
});

test('a huge family file is capped with its own limit, not the personal one', () => {
  const { root, shared } = shelves({
    personal: { 'identity.md': '- Зовут Саня\n' },
    shared: { 'identity.md': `# Семья\n- ${'очень длинная семейная мысль. '.repeat(200)}` },
  });

  const core = buildMemoryCore(root, shared);
  const section = core.slice(core.indexOf('## Семья'));
  assert.ok(section.length < 1000, `семейная секция должна уложиться в кап: ${section.length}`);
  assert.match(section, /файл целиком по пути/, 'обрезка говорит, где читать целиком');
});

test('a huge family file does not squeeze out the personal facts', () => {
  const { root, shared } = shelves({
    personal: { 'identity.md': '- Зовут Саня\n- Живёт в Дублине\n' },
    shared: { 'identity.md': `# Семья\n- ${'длинно. '.repeat(400)}` },
  });

  const core = buildMemoryCore(root, shared);
  assert.match(core, /- Зовут Саня/);
  assert.match(core, /- Живёт в Дублине/);
});

test('the section sits inside the memory block, the wrapper knows about the family path', () => {
  const { root, shared } = shelves({
    personal: { 'identity.md': '- Зовут Саня\n' },
    shared: { 'identity.md': '# Семья\n- Женат на Вите\n' },
  });

  const block = memoryPrompt(buildMemoryCore(root, shared));
  assert.match(block, /^# Ядро памяти/);
  assert.match(block, /## Семья/);
  assert.ok(block.indexOf('## Семья') < block.lastIndexOf('Память отвечает, а не начинает'),
    'правило «память отвечает, а не начинает» закрывает и семейную часть');
  assert.match(block, /shared-memory/);
});

test('no shared store — no section, and no trace of it in the prompt', () => {
  const { root } = shelves({ personal: { 'identity.md': '- Зовут Саня\n' } });
  const missing = path.join(tempDir('icarus-gone-'), 'shared-memory');

  const core = buildMemoryCore(root, missing);
  assert.match(core, /- Зовут Саня/);
  assert.doesNotMatch(core, /## Семья/);
  assert.doesNotMatch(core, /undefined/);
  assert.equal(core, buildMemoryCore(root, missing), 'отсутствие файла не делает ядро нестабильным');
});

test('an empty family file is the same as no file', () => {
  const { root, shared } = shelves({
    personal: { 'identity.md': '- Зовут Саня\n' },
    shared: { 'identity.md': '\n\n' },
  });

  const core = buildMemoryCore(root, shared);
  assert.doesNotMatch(core, /## Семья/);
});

test('the description of a family file is metadata, not a fact about the family', () => {
  const { root, shared } = shelves({
    personal: { 'identity.md': '- Зовут Саня\n' },
    shared: { 'identity.md': '---\ndescription: кто в семье и что у них общее\n---\n- Женат на Вите\n' },
  });

  const core = buildMemoryCore(root, shared);
  assert.match(core, /- Женат на Вите/);
  assert.doesNotMatch(core, /кто в семье и что у них общее/);
});

test('the core has a ceiling: fat memory files cannot eat the whole prompt', () => {
  const { root, shared } = shelves({
    personal: {
      'identity.md': `# Кто это\n${'- факт о человеке. '.repeat(200)}`,
      'preferences.md': `# Предпочтения\n${'- вкус. '.repeat(200)}`,
    },
    shared: { 'identity.md': `# Семья\n${'- семейный факт. '.repeat(200)}` },
  });

  const block = memoryPrompt(buildMemoryCore(root, shared));
  assert.ok(block.length < 6000, `блок памяти разросся: ${block.length} знаков`);
});
