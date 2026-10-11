// «Напиши за меня»: из идеи человека модель собирает скилл, а панель — черновик.
//
// Модель тут не вызывается: тест держит то, что мы можем держать, — задание, разбор
// ответа и то, что черновик доходит до диска живым скиллом, который видит pi. Ответы
// модели в тестах нарочно неряшливые: забор из бэктиков, болтовня вокруг JSON,
// заглавные буквы в имени, занятое имя, кириллица — всё это она выдаёт регулярно.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import {
  parseSkillDraft,
  skillDraftPrompt,
  SKILL_DRAFT_SYSTEM,
  slugifySkillName,
  uniqueSkillName,
} from '../src/control/skill-draft.ts';
import { oneShotArgs } from '../src/sessions/one-shot.ts';
import { listSkills, writeSkill } from '../src/control/skills.ts';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-draft-'));
}

/** Ответ модели одной строкой JSON: так она отвечает, когда всё хорошо. */
function answer(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

test('задание модели несёт идею человека и требует три поля', () => {
  const prompt = skillDraftPrompt('разбирать голосовые сообщения в текст');
  assert.match(prompt, /разбирать голосовые сообщения в текст/);
  assert.match(prompt, /"name"/);
  assert.match(prompt, /"description"/);
  assert.match(prompt, /"body"/);
  assert.match(prompt, /латинск/i, 'сказано, каким должно быть имя');
  assert.match(prompt, /какой момент его звать/i, 'сказано, чем описание отличается от инструкции');
});

test('ответ в заборе из бэктиков и с болтовнёй вокруг разбирается', () => {
  const messy = [
    'Конечно! Вот скилл:',
    '```json',
    answer({ name: 'voice-notes', description: 'Разбирает голосовые.', body: '# Как\n\n1. Расшифруй.' }),
    '```',
    'Надеюсь, подойдёт.',
  ].join('\n');

  const result = parseSkillDraft(messy);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.name, 'voice-notes');
  assert.match(result.ok ? result.draft.body : '', /Расшифруй/);
  assert.equal(result.ok ? result.draft.note : 'нет', undefined, 'чинить было нечего — пометки нет');
});

test('синонимы полей принимаются: инструкция вместо body', () => {
  const result = parseSkillDraft(
    answer({ title: 'voice-notes', when_to_use: 'Когда пришло голосовое.', instructions: 'Шаг один.' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.name, 'voice-notes');
  assert.equal(result.ok && result.draft.description, 'Когда пришло голосовое.');
  assert.equal(result.ok && result.draft.body, 'Шаг один.');
});

test('целый SKILL.md в ответе чистится до инструкции', () => {
  const file = '```markdown\n---\nname: voice-notes\ndescription: Разбирает голосовые.\n---\n\n# Как\n\n1. Расшифруй.\n```';
  const result = parseSkillDraft(file);
  assert.equal(result.ok, true);
  const body = result.ok ? result.draft.body : '';
  assert.match(body, /# Как/);
  assert.doesNotMatch(body, /^---/, 'frontmatter в теле не остаётся: его пишет панель');
  assert.doesNotMatch(body, /```/, 'забор из бэктиков тоже не остаётся');
});

test('имя приводится к правилам: регистр, пробелы, подчёркивания, диакритика', () => {
  const result = parseSkillDraft(answer({ name: '  Voice_Notes Café!! ', description: 'ок', body: 'тело' }));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.name, 'voice-notes-cafe');
  assert.equal(result.ok ? result.draft.note : '', undefined, 'привели молча: человек видит имя в поле');
});

test('кириллическое имя не теряет инструкцию: имя пустое, с пометкой', () => {
  const result = parseSkillDraft(answer({ name: 'разбор-голосовых', description: 'Разбирает.', body: 'Шаги.' }));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.name, '', 'имя человек допишет сам');
  assert.match(result.ok ? String(result.draft.note) : '', /не латиницей/);
  assert.equal(result.ok && result.draft.body, 'Шаги.', 'ради имени инструкцию не выбрасываем');
});

test('занятое имя получает номер, а не переписывает чужой скилл', () => {
  const taken = new Set(['voice-notes', 'voice-notes-2']);
  const result = parseSkillDraft(answer({ name: 'voice-notes', description: 'ок', body: 'тело' }), taken);
  assert.equal(result.ok && result.draft.name, 'voice-notes-3');
  assert.match(result.ok ? String(result.draft.note) : '', /занято/);

  assert.equal(uniqueSkillName('свежее', new Set()), 'свежее', 'свободное имя не трогаем');
});

test('слишком длинное описание подрезается по концу фразы', () => {
  const sentence = 'Этот скилл разбирает голосовые сообщения и складывает расшифровку в журнал. ';
  const result = parseSkillDraft(answer({ name: 'voice-notes', description: sentence.repeat(20), body: 'тело' }));
  assert.equal(result.ok, true);
  const description = result.ok ? result.draft.description : '';
  assert.ok(description.length <= 1024, `описание длиннее лимита: ${description.length}`);
  assert.match(description, /журнал\.$/, 'обрезали по концу фразы, а не посреди слова');
  assert.match(result.ok ? String(result.draft.note) : '', /длинновато/);
});

test('без JSON, без описания и без инструкции — отказ, а не пустой черновик', () => {
  const noJson = parseSkillDraft('Извини, не могу помочь.');
  assert.equal(noJson.ok, false);
  assert.match(noJson.ok ? '' : noJson.message, /JSON/);

  const noDescription = parseSkillDraft(answer({ name: 'x', body: 'тело' }));
  assert.equal(noDescription.ok, false);

  const noBody = parseSkillDraft(answer({ name: 'x', description: 'ок' }));
  assert.equal(noBody.ok, false);
  assert.match(noBody.ok ? '' : noBody.message, /инструкцию/);
});

test('разовый вопрос про скилл идёт без тулов, сессии и скиллов', () => {
  // Модель, которая пишет скилл, не должна ничего уметь: она отвечает текстом, и
  // только. Иначе «напиши за меня» превратилось бы в агента с руками по кнопке.
  const args = oneShotArgs({ provider: 'deepinfra', id: 'strong-model' }, 'идея', SKILL_DRAFT_SYSTEM);
  assert.ok(args.includes('--no-tools'), 'без тулов');
  assert.ok(args.includes('--no-session'), 'без сессии');
  assert.ok(args.includes('--no-skills'), 'без скиллов');
  assert.ok(args.includes('--no-extensions'), 'без расширений');
  assert.equal(args[args.indexOf('--system-prompt') + 1], SKILL_DRAFT_SYSTEM, 'роль — наша, а не «отвечай ровно»');
  assert.ok(args.includes('deepinfra/strong-model'), 'модель выбирает вызывающий');
});

test('черновик сохраняется как обычный скилл, и его видит pi', () => {
  const root = tempRoot();
  const result = parseSkillDraft(
    answer({
      name: 'Voice Notes',
      description: 'Use when a voice message arrives and the text should go to the journal.',
      body: '# Как разбирать голосовые\n\n1. Расшифруй.\n2. Положи в journal/YYYY-MM.md.\n',
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const saved = writeSkill(root, { ...result.draft, hidden: false });
  assert.equal(saved.ok, true, 'черновик обязан проходить те же проверки, что и рукописный скилл');

  const seen = loadSkillsFromDir({ dir: root, source: 'user' });
  assert.deepEqual(seen.skills.map((skill) => skill.name), ['voice-notes']);
  assert.deepEqual(seen.diagnostics, [], 'pi не должен ругаться на скилл, написанный моделью');
  assert.deepEqual(listSkills(root).map((skill) => skill.description), [result.draft.description]);
});

test('slugify: из чего угодно — имя по правилам', () => {
  assert.equal(slugifySkillName('Pirate Mode!'), 'pirate-mode');
  assert.equal(slugifySkillName('  --Морской--  '), '', 'кириллица остаётся без латиницы');
  assert.equal(slugifySkillName('a'.repeat(80)).length, 64, 'длина ограничена');
  assert.equal(slugifySkillName('хвост-'.repeat(20)), '', 'дефисы по краям не остаются');
  assert.doesNotMatch(slugifySkillName('Уже Латиница ok'), /[^a-z0-9-]/, 'только строчная латиница, цифры и дефис');
});
