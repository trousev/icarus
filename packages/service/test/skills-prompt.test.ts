// Каталог скиллов в системном промпте: его собирает персона сама (она заменяет
// промпт pi целиком), поэтому формат и фильтры проверяем тестом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSkillsBlock, skillFileReadTool, type SkillEntry } from '../../extensions/lib/skills-core.ts';

const skill: SkillEntry = {
  name: 'pirate-mode',
  description: 'Use when the user asks to speak like a pirate.',
  filePath: '/home/node/.pi/agent/skills/pirate-mode/SKILL.md',
};

test('каталог попадает в промпт, если есть чем читать файл скилла', () => {
  const block = formatSkillsBlock([skill], ['read', 'bash', 'edit']);
  assert.match(block, /<available_skills>/);
  assert.match(block, /<name>pirate-mode<\/name>/);
  assert.match(block, /<description>Use when the user asks to speak like a pirate\.<\/description>/);
  assert.match(block, /<location>\/home\/node\/\.pi\/agent\/skills\/pirate-mode\/SKILL\.md<\/location>/);
  assert.match(block, /Use the read tool to load a skill's file/);
});

test('без read и bash каталога нет: файл скилла нечем открыть', () => {
  assert.equal(skillFileReadTool(['edit', 'write']), null);
  assert.equal(formatSkillsBlock([skill], ['edit', 'write']), '');
});

test('bash вместо read — подсказка про bash', () => {
  const block = formatSkillsBlock([skill], ['bash']);
  assert.match(block, /Use bash to load a skill's file/);
});

test('скилл, скрытый от модели, в каталог не едет', () => {
  const block = formatSkillsBlock([{ ...skill, disableModelInvocation: true }], ['read']);
  assert.equal(block, '');
});

test('пустой набор скиллов не добавляет блок', () => {
  assert.equal(formatSkillsBlock([], ['read']), '');
});

test('XML-спецсимволы в описании экранируются', () => {
  const block = formatSkillsBlock([{ ...skill, description: 'a < b & c' }], ['read']);
  assert.match(block, /<description>a &lt; b &amp; c<\/description>/);
});
