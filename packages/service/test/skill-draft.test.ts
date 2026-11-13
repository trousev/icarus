// "Write it for me": from a person's idea the model assembles a skill, and the panel a draft.
//
// The model is not called here: the test holds what we can hold — the task, parsing
// the response and the fact that the draft reaches disk as a live skill that pi sees. The model's
// responses in the tests are deliberately sloppy: a backtick fence, chatter around the JSON,
// capital letters in the name, a taken name, Cyrillic — it regularly produces all of this.
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

/** The model's response as a single JSON string: this is how it answers when all is well. */
function answer(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

test("the model's task carries the person's idea and requires three fields", () => {
  const prompt = skillDraftPrompt('разбирать голосовые сообщения в текст');
  assert.match(prompt, /разбирать голосовые сообщения в текст/);
  assert.match(prompt, /"name"/);
  assert.match(prompt, /"description"/);
  assert.match(prompt, /"body"/);
  assert.match(prompt, /латинск/i, 'сказано, каким должно быть имя');
  assert.match(prompt, /какой момент его звать/i, 'сказано, чем описание отличается от инструкции');
});

test('a response in a backtick fence with chatter around it is parsed', () => {
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

test('field synonyms are accepted: instructions instead of body', () => {
  const result = parseSkillDraft(
    answer({ title: 'voice-notes', when_to_use: 'Когда пришло голосовое.', instructions: 'Шаг один.' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.name, 'voice-notes');
  assert.equal(result.ok && result.draft.description, 'Когда пришло голосовое.');
  assert.equal(result.ok && result.draft.body, 'Шаг один.');
});

test('a whole SKILL.md in the response is cleaned down to the instructions', () => {
  const file = '```markdown\n---\nname: voice-notes\ndescription: Разбирает голосовые.\n---\n\n# Как\n\n1. Расшифруй.\n```';
  const result = parseSkillDraft(file);
  assert.equal(result.ok, true);
  const body = result.ok ? result.draft.body : '';
  assert.match(body, /# Как/);
  assert.doesNotMatch(body, /^---/, 'frontmatter в теле не остаётся: его пишет панель');
  assert.doesNotMatch(body, /```/, 'забор из бэктиков тоже не остаётся');
});

test('the name is normalized: case, spaces, underscores, diacritics', () => {
  const result = parseSkillDraft(answer({ name: '  Voice_Notes Café!! ', description: 'ок', body: 'тело' }));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.name, 'voice-notes-cafe');
  assert.equal(result.ok ? result.draft.note : '', undefined, 'привели молча: человек видит имя в поле');
});

test('a Cyrillic name does not lose the instructions: the name is empty, with a note', () => {
  const result = parseSkillDraft(answer({ name: 'разбор-голосовых', description: 'Разбирает.', body: 'Шаги.' }));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.name, '', 'имя человек допишет сам');
  assert.match(result.ok ? String(result.draft.note) : '', /не латиницей/);
  assert.equal(result.ok && result.draft.body, 'Шаги.', 'ради имени инструкцию не выбрасываем');
});

test('a taken name gets a number rather than overwriting someone else\'s skill', () => {
  const taken = new Set(['voice-notes', 'voice-notes-2']);
  const result = parseSkillDraft(answer({ name: 'voice-notes', description: 'ок', body: 'тело' }), taken);
  assert.equal(result.ok && result.draft.name, 'voice-notes-3');
  assert.match(result.ok ? String(result.draft.note) : '', /занято/);

  assert.equal(uniqueSkillName('свежее', new Set()), 'свежее', 'свободное имя не трогаем');
});

test('an overlong description is trimmed at the end of a sentence', () => {
  const sentence = 'Этот скилл разбирает голосовые сообщения и складывает расшифровку в журнал. ';
  const result = parseSkillDraft(answer({ name: 'voice-notes', description: sentence.repeat(20), body: 'тело' }));
  assert.equal(result.ok, true);
  const description = result.ok ? result.draft.description : '';
  assert.ok(description.length <= 1024, `описание длиннее лимита: ${description.length}`);
  assert.match(description, /журнал\.$/, 'обрезали по концу фразы, а не посреди слова');
  assert.match(result.ok ? String(result.draft.note) : '', /длинновато/);
});

test('no JSON, no description and no instructions is a failure, not an empty draft', () => {
  const noJson = parseSkillDraft('Извини, не могу помочь.');
  assert.equal(noJson.ok, false);
  assert.match(noJson.ok ? '' : noJson.message, /JSON/);

  const noDescription = parseSkillDraft(answer({ name: 'x', body: 'тело' }));
  assert.equal(noDescription.ok, false);

  const noBody = parseSkillDraft(answer({ name: 'x', description: 'ок' }));
  assert.equal(noBody.ok, false);
  assert.match(noBody.ok ? '' : noBody.message, /инструкцию/);
});

test('the one-shot skill question runs without tools, session and skills', () => {
  // The model that writes a skill must not be able to do anything: it answers with text, and
  // that is it. Otherwise "write it for me" would turn into an agent with hands at the push of a button.
  const args = oneShotArgs({ provider: 'deepinfra', id: 'strong-model' }, 'идея', SKILL_DRAFT_SYSTEM);
  assert.ok(args.includes('--no-tools'), 'без тулов');
  assert.ok(args.includes('--no-session'), 'без сессии');
  assert.ok(args.includes('--no-skills'), 'без скиллов');
  assert.ok(args.includes('--no-extensions'), 'без расширений');
  assert.equal(args[args.indexOf('--system-prompt') + 1], SKILL_DRAFT_SYSTEM, 'роль — наша, а не «отвечай ровно»');
  assert.ok(args.includes('deepinfra/strong-model'), 'модель выбирает вызывающий');
});

test('the draft is saved as an ordinary skill, and pi sees it', () => {
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

test('slugify: from anything to a name that follows the rules', () => {
  assert.equal(slugifySkillName('Pirate Mode!'), 'pirate-mode');
  assert.equal(slugifySkillName('  --Морской--  '), '', 'кириллица остаётся без латиницы');
  assert.equal(slugifySkillName('a'.repeat(80)).length, 64, 'длина ограничена');
  assert.equal(slugifySkillName('хвост-'.repeat(20)), '', 'дефисы по краям не остаются');
  assert.doesNotMatch(slugifySkillName('Уже Латиница ok'), /[^a-z0-9-]/, 'только строчная латиница, цифры и дефис');
});
