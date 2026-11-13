// Persona is the only place where the environment map and the attachment path are assembled
// into the prompt text. The path there is concatenated as a string, so a forgotten substitution fails
// neither by type nor by linter: the model simply gets "${ICARUS}/incoming/…" and looks for a file
// that does not exist. The test reads the finished prompt and catches exactly this.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-persona-'));
// The variables are read at module load, so we set them before import().
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
  // The extension only uses `on`; the rest is not needed for this test.
  persona(pi as never);
  assert.ok(captured, 'персона подписалась на before_agent_start');
  return captured;
}

async function prompt(): Promise<string> {
  return (await handler()({ systemPromptOptions: { contextFiles: [] } })).systemPrompt;
}

test('the environment map arrives in the prompt from the service directory', async () => {
  const text = await prompt();
  assert.match(text, /ты Икар/, 'персона прочитана');
  assert.match(text, /# Контекст: .*\/AGENTS\.md/, 'карта окружения подставлена');
  assert.match(text, /служебное лежит в \.icarus/, 'содержимое карты доехало');
});

test('the attachment path is substituted instead of remaining a template', async () => {
  const text = await prompt();
  assert.ok(
    text.includes(`${ROOT}/incoming/файл.jpg`),
    'путь в markdown-картинке собран из настоящего корня, а не из литерала',
  );
  assert.doesNotMatch(text, /\$\{ICARUS\}/, 'незаполненный шаблон в промпте — модель пойдёт мимо');
  assert.doesNotMatch(text, /\bundefined\b/);
  assert.match(text, /ссылка на скачивание/, 'про файлы, а не картинки, веб-чат тоже знает');
});

test('artifact mode: the prompt is about a specific folder, not about the workspace', async () => {
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

test('HTML artifact mode: the prompt contains the element address contract', async () => {
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
