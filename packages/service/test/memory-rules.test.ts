// Memory rules: the durable separate from the temporary, relative time — into a date.
// The extraction mechanics are tested by memory.test.ts; here — only the instruction texts
// the model sees: a "recently had surgery" that leaked into identity.md reads half a year
// later as today's news, and this is fixed by wording, not code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionPrompt } from '../../extensions/memory-extractor.ts';
import { renderAgentsMd } from '../src/workspace.ts';
import { makeConfig } from './fixtures.ts';

const TODAY = new Date('2026-09-18T00:00:00Z');

function promptRules(): string {
  return buildExtractionPrompt('недавно была операция на глазу', TODAY);
}

test('the prompt steers temporary states into projects/, not identity', () => {
  const prompt = promptRules();
  const rubric = prompt.slice(prompt.indexOf('Куда писать'));
  assert.match(rubric, /projects\/<тема>\.md/, 'projects/ должен быть назван полкой для длящегося');
  assert.match(rubric, /длящееся/);
  assert.match(rubric, /(здоровь|операци)/, 'пример из временной жизни, а не абстракция');
  assert.match(rubric, /[Пп]о состоянию на \d{2}\.\d{2}\.\d{4}/, 'строка состояния обязана быть датированной');
  assert.match(prompt, /а не в identity\.md/, 'identity прямо закрыта для временного');
});

test('the prompt requires converting relative time into an absolute date', () => {
  const prompt = promptRules();
  for (const phrase of ['недавно', 'на прошлой неделе', 'полгода назад', 'только что']) {
    assert.ok(prompt.includes(phrase), `нет правила про «${phrase}»`);
  }
  // Two forms: a state snapshot and the start of an ongoing thing. A line break in the rule doesn't matter.
  assert.match(prompt, /по состоянию\s+на \d{2}\.\d{2}\.\d{4}/);
  assert.match(prompt, /с \d{2}\.\d{2}\.\d{4}/);
  // The reference date is taken from today's number, not invented.
  assert.match(prompt, /Сегодня 2026-09-18/);
});

test('the extraction example shows a temporary state on the projects/ shelf', () => {
  const prompt = promptRules();
  const example = prompt.slice(prompt.indexOf('{"journal"'));
  assert.match(example, /"file": "projects\//);
  assert.match(example, /[Пп]о состоянию на/);
});

test('AGENTS.md separates the durable and the ongoing', () => {
  const md = renderAgentsMd(makeConfig());
  const section = md.slice(md.indexOf('Как устроена память'));
  assert.match(section, /identity\.md/);
  assert.match(section, /устойчив/i, 'identity должна быть названа полкой устойчивого');
  assert.match(section, /projects\//);
  assert.match(section, /по состоянию на \d{2}\.\d{2}\.\d{4}/, 'проекты датируются строкой состояния');
  assert.match(section, /journal\/YYYY-MM\.md/);
  assert.match(section, /по датам/, 'журнал — события по датам');
});
