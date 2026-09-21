// Правила памяти: устойчивое отдельно от временного, относительное время — в дату.
// Механику разбора проверяет memory.test.ts; здесь — только тексты инструкций, которые
// видит модель: уехавший в identity.md «недавно была операция» через полгода читается
// как сегодняшняя новость, и лечится это формулировкой, а не кодом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionPrompt } from '../../extensions/memory-extractor.ts';
import { renderAgentsMd } from '../src/workspace.ts';
import { makeConfig } from './fixtures.ts';

const TODAY = new Date('2026-09-18T00:00:00Z');

function promptRules(): string {
  return buildExtractionPrompt('недавно была операция на глазу', TODAY);
}

test('промпт уводит временные состояния в projects/, а не в identity', () => {
  const prompt = promptRules();
  const rubric = prompt.slice(prompt.indexOf('Куда писать'));
  assert.match(rubric, /projects\/<тема>\.md/, 'projects/ должен быть назван полкой для длящегося');
  assert.match(rubric, /длящееся/);
  assert.match(rubric, /(здоровь|операци)/, 'пример из временной жизни, а не абстракция');
  assert.match(rubric, /[Пп]о состоянию на \d{2}\.\d{2}\.\d{4}/, 'строка состояния обязана быть датированной');
  assert.match(prompt, /а не в identity\.md/, 'identity прямо закрыта для временного');
});

test('промпт требует переводить относительное время в абсолютную дату', () => {
  const prompt = promptRules();
  for (const phrase of ['недавно', 'на прошлой неделе', 'полгода назад', 'только что']) {
    assert.ok(prompt.includes(phrase), `нет правила про «${phrase}»`);
  }
  // Две формы: снимок состояния и начало длящегося. Перенос строки в правиле не мешает.
  assert.match(prompt, /по состоянию\s+на \d{2}\.\d{2}\.\d{4}/);
  assert.match(prompt, /с \d{2}\.\d{2}\.\d{4}/);
  // Дата отсчёта берётся из сегодняшнего числа, а не выдумывается.
  assert.match(prompt, /Сегодня 2026-09-18/);
});

test('пример разбора показывает временное состояние на полке projects/', () => {
  const prompt = promptRules();
  const example = prompt.slice(prompt.indexOf('{"journal"'));
  assert.match(example, /"file": "projects\//);
  assert.match(example, /[Пп]о состоянию на/);
});

test('AGENTS.md разделяет устойчивое и длящееся', () => {
  const md = renderAgentsMd(makeConfig());
  const section = md.slice(md.indexOf('Как устроена память'));
  assert.match(section, /identity\.md/);
  assert.match(section, /устойчив/i, 'identity должна быть названа полкой устойчивого');
  assert.match(section, /projects\//);
  assert.match(section, /по состоянию на \d{2}\.\d{2}\.\d{4}/, 'проекты датируются строкой состояния');
  assert.match(section, /journal\/YYYY-MM\.md/);
  assert.match(section, /по датам/, 'журнал — события по датам');
});
