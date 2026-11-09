// Персона в Telegram: агент должен знать, что markdown-ссылка на файл станет
// настоящим вложением, — иначе он будет отдавать человеку мёртвый путь текстом.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-persona-tg-'));
// Переменные читаются на загрузке модуля, поэтому выставляем их до import().
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

test('в Telegram агент знает, что ссылка на файл станет вложением', async () => {
  const text = await prompt();
  assert.match(text, /# Telegram/);
  assert.match(text, /markdown-ссылку/);
  assert.match(text, /придёт фотографией/, 'картинка уходит фотографией');
  assert.match(text, /файлом/, 'остальное — файлом');
  assert.match(text, /Отдельного инструмента нет/);
  assert.doesNotMatch(text, /# Веб-чат/, 'чужие правила канала в Telegram не едут');
});
