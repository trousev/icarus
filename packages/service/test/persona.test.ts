// Персона — единственное место, где карта окружения и путь к вложениям собираются в
// текст промпта. Путь там склеивается строкой, поэтому забытая подстановка не падает
// ни типом, ни линтером: модель просто получает «${ICARUS}/incoming/…» и ищет файл,
// которого нет. Тест читает готовый промпт и ловит ровно это.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-persona-'));
// Переменные читаются на загрузке модуля, поэтому выставляем их до import().
process.env.ICARUS_HOME = ROOT;
process.env.ICARUS_MEMORY_DIR = path.join(ROOT, 'memory');
process.env.ICARUS_CHANNEL = 'web';

fs.mkdirSync(path.join(ROOT, 'memory'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'icarus.md'), '# Персона\n\nты Икар\n');
fs.writeFileSync(path.join(ROOT, 'AGENTS.md'), '# Где ты находишься\n\nслужебное лежит в .icarus\n');

const { default: persona } = await import('../../extensions/persona.ts');

type BeforeStart = (event: unknown) => Promise<{ systemPrompt: string }>;

function handler(): BeforeStart {
  let captured: BeforeStart | undefined;
  const pi = {
    on: (name: string, fn: BeforeStart) => {
      if (name === 'before_agent_start') captured = fn;
    },
  };
  // Расширение пользуется только `on`; остальное для этого теста не нужно.
  persona(pi as never);
  assert.ok(captured, 'персона подписалась на before_agent_start');
  return captured;
}

async function prompt(): Promise<string> {
  return (await handler()({ systemPromptOptions: { contextFiles: [] } })).systemPrompt;
}

test('карта окружения приезжает в промпт из служебного каталога', async () => {
  const text = await prompt();
  assert.match(text, /ты Икар/, 'персона прочитана');
  assert.match(text, /# Контекст: .*\/AGENTS\.md/, 'карта окружения подставлена');
  assert.match(text, /служебное лежит в \.icarus/, 'содержимое карты доехало');
});

test('путь к вложениям подставляется, а не остаётся шаблоном', async () => {
  const text = await prompt();
  assert.ok(
    text.includes(`${ROOT}/incoming/файл.jpg`),
    'путь в markdown-картинке собран из настоящего корня, а не из литерала',
  );
  assert.doesNotMatch(text, /\$\{ICARUS\}/, 'незаполненный шаблон в промпте — модель пойдёт мимо');
  assert.doesNotMatch(text, /\bundefined\b/);
});

test('режим артефакта: промпт про конкретную папку, а не про workspace', async () => {
  process.env.ICARUS_ARTIFACT = 'plan';
  process.env.ICARUS_ARTIFACT_TITLE = 'План на четверг';
  process.env.ICARUS_ARTIFACT_ENTRY = 'index.md';
  process.env.ICARUS_ARTIFACT_TYPE = 'markdown';
  try {
    const text = await prompt();
    assert.match(text, /# Правка артефакта/);
    assert.match(text, /План на четверг/);
    assert.match(text, /\/artifacts\/plan/);
    assert.match(text, /`index\.md`/);
    assert.match(text, /заменено этим режимом/, 'границы persona не спорят с папкой артефакта');
    assert.match(text, /История версий ведётся системой/);
    assert.match(text, /\.folder-acl\.json/);
    assert.doesNotMatch(text, /# Твой workspace/, 'в артефактном режиме workspace не упоминается');
  } finally {
    delete process.env.ICARUS_ARTIFACT;
    delete process.env.ICARUS_ARTIFACT_TITLE;
    delete process.env.ICARUS_ARTIFACT_ENTRY;
    delete process.env.ICARUS_ARTIFACT_TYPE;
  }
});

test('режим HTML-артефакта: в промпте есть контракт адресов элементов', async () => {
  process.env.ICARUS_ARTIFACT = 'report';
  process.env.ICARUS_ARTIFACT_TITLE = 'Отчёт по «Атласу»';
  process.env.ICARUS_ARTIFACT_ENTRY = 'index.html';
  process.env.ICARUS_ARTIFACT_TYPE = 'html';
  try {
    const text = await prompt();
    assert.match(text, /data-icarus-ref/, 'модель знает, что это за атрибут');
    assert.match(text, /ссылк[аи] находит элемент/, 'и зачем его сохранять');
    assert.match(text, /правкой именно этого блока/, 'ссылка из чата — про конкретный блок');
  } finally {
    delete process.env.ICARUS_ARTIFACT;
    delete process.env.ICARUS_ARTIFACT_TITLE;
    delete process.env.ICARUS_ARTIFACT_ENTRY;
    delete process.env.ICARUS_ARTIFACT_TYPE;
  }
});
