// The skills catalog in the system prompt: the persona assembles it itself (it replaces
// the pi prompt entirely), so we check the format and filters with a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSkillsBlock, skillFileReadTool, type SkillEntry } from '../../extensions/lib/skills-core.ts';

const skill: SkillEntry = {
  name: 'pirate-mode',
  description: 'Use when the user asks to speak like a pirate.',
  filePath: '/home/node/.pi/agent/skills/pirate-mode/SKILL.md',
};

test('the catalog gets into the prompt if there is something to read the skill file with', () => {
  const block = formatSkillsBlock([skill], ['read', 'bash', 'edit']);
  assert.match(block, /<available_skills>/);
  assert.match(block, /<name>pirate-mode<\/name>/);
  assert.match(block, /<description>Use when the user asks to speak like a pirate\.<\/description>/);
  assert.match(block, /<location>\/home\/node\/\.pi\/agent\/skills\/pirate-mode\/SKILL\.md<\/location>/);
  assert.match(block, /Use the read tool to load a skill's file/);
});

test('without read and bash there is no catalog: there is nothing to open the skill file with', () => {
  assert.equal(skillFileReadTool(['edit', 'write']), null);
  assert.equal(formatSkillsBlock([skill], ['edit', 'write']), '');
});

test('bash instead of read — the hint is about bash', () => {
  const block = formatSkillsBlock([skill], ['bash']);
  assert.match(block, /Use bash to load a skill's file/);
});

test('a skill hidden from the model does not go into the catalog', () => {
  const block = formatSkillsBlock([{ ...skill, disableModelInvocation: true }], ['read']);
  assert.equal(block, '');
});

test('an empty set of skills adds no block', () => {
  assert.equal(formatSkillsBlock([], ['read']), '');
});

test('XML special characters in the description are escaped', () => {
  const block = formatSkillsBlock([{ ...skill, description: 'a < b & c' }], ['read']);
  assert.match(block, /<description>a &lt; b &amp; c<\/description>/);
});
