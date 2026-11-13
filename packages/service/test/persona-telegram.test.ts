// Persona in Telegram: the agent must know that a markdown link to a file becomes
// a real attachment, — otherwise it will give the person a dead path as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-persona-tg-'));
// Variables are read at module load, so we set them before import().
process.env.ICARUS_HOME = ROOT;
process.env.ICARUS_MEMORY_DIR = path.join(ROOT, 'memory');
process.env.ICARUS_CHANNEL = 'telegram';

fs.mkdirSync(path.join(ROOT, 'memory'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'icarus.md'), '# Персона\n\nты Икар\n');
fs.writeFileSync(path.join(ROOT, 'AGENTS.md'), '# Где ты находишься\n\nслужебное лежит в .icarus\n');

const { default: persona } = await import('../../extensions/persona.ts');

type BeforeStart = (event: unknown) => Promise<{ systemPrompt: string }>;

async function prompt(): Promise<string> {
  let captured: BeforeStart | undefined;
  const pi = {
    on: (name: string, fn: BeforeStart) => {
      if (name === 'before_agent_start') captured = fn;
    },
  };
  persona(pi as never);
  assert.ok(captured, 'персона подписалась на before_agent_start');
  return (await captured({ systemPromptOptions: { contextFiles: [] } })).systemPrompt;
}

test('in Telegram the agent knows that a link to a file becomes an attachment', async () => {
  const text = await prompt();
  assert.match(text, /# Telegram/);
  assert.match(text, /markdown-ссылку/);
  assert.match(text, /придёт фотографией/, 'картинка уходит фотографией');
  assert.match(text, /файлом/, 'остальное — файлом');
  assert.match(text, /Отдельного инструмента нет/);
  assert.doesNotMatch(text, /# Веб-чат/, 'чужие правила канала в Telegram не едут');
});
