// Skills: the panel writes SKILL.md, and pi reads it.
//
// The test holds exactly this seam, not the panel internals: the directory layout,
// the frontmatter format and the path checks. A skill that pi won't see or will read
// incorrectly is a skill Icarus doesn't have, even if it looks intact in the panel.
// That's why "saved and verified" here means "saved and fed to pi's own skill
// loader" (loadSkillsFromDir from @earendil-works/pi-coding-agent).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import {
  listSkills,
  readSkill,
  removeSkill,
  searchSkills,
  skillLabel,
  writeSkill,
} from '../src/control/skills.ts';

/** Empty skills directory: the test fills it later. */
function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-skills-'));
}

/** What pi sees in the directory: names of loaded skills and its own diagnostics. */
function piSees(root: string) {
  const result = loadSkillsFromDir({ dir: root, source: 'user' });
  return { names: result.skills.map((skill) => skill.name), skills: result.skills, diagnostics: result.diagnostics };
}

function seed(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test('a saved skill is seen by pi itself: name, description and path', () => {
  const root = tempRoot();
  const result = writeSkill(root, {
    name: 'pirate-mode',
    description: 'Use when the user asks to speak like a pirate.',
    body: '# Как рычать\n\n1. Говори «йо-хо-хо».',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.id, 'pirate-mode/SKILL.md', 'скилл лёг каноническим каталогом');

  const seen = piSees(root);
  assert.deepEqual(seen.names, ['pirate-mode']);
  assert.equal(seen.skills[0].description, 'Use when the user asks to speak like a pirate.');
  assert.match(seen.skills[0].filePath, /pirate-mode\/SKILL\.md$/);
  assert.deepEqual(seen.diagnostics, [], 'pi не должен ругаться на наш файл');
});

test('a description with a colon, quotes and a dash reaches pi verbatim', () => {
  const root = tempRoot();
  const description = 'Use when: «пират» — то есть всегда, если речь о "морском" стиле';
  writeSkill(root, { name: 'pirate-mode', description, body: 'Рычи.' });

  const [skill] = piSees(root).skills;
  assert.equal(skill.description, description, 'YAML не должен переписать описание своими правилами');
});

test('the panel does not save without a description or with a name that breaks the rules', () => {
  const root = tempRoot();
  assert.equal(writeSkill(root, { name: 'pirate-mode', description: '   ', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'Pirate Mode', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: '-pirate', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'pirate--mode', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'a'.repeat(65), description: 'ок', body: 'x' }).ok, false);
  assert.deepEqual(listSkills(root), [], 'после отказов каталог остаётся пустым');
});

test('the panel does not lose foreign frontmatter but rewrites its own', () => {
  const root = tempRoot();
  seed(root, {
    'notes/SKILL.md': [
      '---',
      'name: notes',
      'description: старое описание',
      'license: MIT',
      'metadata:',
      '  author: человек',
      '---',
      '',
      'старое тело',
      '',
    ].join('\n'),
  });

  const result = writeSkill(root, {
    id: 'notes/SKILL.md',
    name: 'notes',
    description: 'новое описание',
    body: 'новое тело',
  });
  assert.equal(result.ok, true);

  const content = fs.readFileSync(path.join(root, 'notes/SKILL.md'), 'utf8');
  assert.match(content, /license: MIT/, 'чужие ключи остаются на месте');
  assert.match(content, /author: человек/);
  assert.doesNotMatch(content, /старое описание/);

  const seen = piSees(root);
  assert.equal(seen.skills[0].description, 'новое описание');
  assert.match(readSkill(root, 'notes/SKILL.md')?.body ?? '', /новое тело/);
});

test('renaming moves the whole directory — together with the bundle files', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  seed(root, { 'pirate-mode/scripts/run.sh': '#!/bin/sh\necho йо-хо-хо\n' });

  const result = writeSkill(root, {
    id: 'pirate-mode/SKILL.md',
    name: 'sea-wolf',
    description: 'ок',
    body: 'тело',
  });
  assert.equal(result.ok && result.id, 'sea-wolf/SKILL.md');
  assert.equal(fs.existsSync(path.join(root, 'pirate-mode')), false, 'старый каталог уехал целиком');
  assert.equal(fs.existsSync(path.join(root, 'sea-wolf/scripts/run.sh')), true, 'бандл переехал вместе с ним');

  const [summary] = listSkills(root);
  assert.equal(summary.name, 'sea-wolf');
  assert.equal(summary.files, 2, 'в бандле SKILL.md и скрипт');
  assert.deepEqual(piSees(root).names, ['sea-wolf']);
});

test('a skill on a shelf is renamed on its own shelf, not moved to the root', () => {
  const root = tempRoot();
  seed(root, { 'sea/pirate-mode/SKILL.md': '---\nname: pirate-mode\ndescription: ок\n---\n\nтело\n' });

  const result = writeSkill(root, {
    id: 'sea/pirate-mode/SKILL.md',
    name: 'sea-wolf',
    description: 'ок',
    body: 'тело',
  });
  assert.equal(result.ok && result.id, 'sea/sea-wolf/SKILL.md', 'полка осталась на месте');
  assert.deepEqual(piSees(root).names, ['sea-wolf']);
});

test('the panel does not let anything outside the skills directory', () => {
  const root = tempRoot();
  seed(root, { 'outside.md': '---\ndescription: чужое\n---\n' });
  const evil = path.join(root, '..', 'evil.md');
  fs.writeFileSync(evil, '# не скилл\n');

  assert.equal(readSkill(root, '../evil.md'), null);
  assert.equal(readSkill(root, '/etc/passwd.md'), null);
  assert.equal(readSkill(root, '.git/config'), null, 'в служебный каталог репозитория не лезем');
  assert.equal(writeSkill(root, { id: '../evil.md', name: 'evil', description: 'ок', body: 'x' }).ok, false);
  assert.equal(removeSkill(root, '../evil.md').ok, false);
  assert.equal(fs.existsSync(evil), true, 'чужой файл на месте');

  // A skill name is also a directory name, so slashes and dots in it are cut off
  // by the name check, not only by the path check.
  assert.equal(writeSkill(root, { name: '../evil', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'sub/evil', description: 'ок', body: 'x' }).ok, false);
});

test('the name is taken — the panel refuses instead of overwriting a foreign skill', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'первое', body: 'x' });
  const second = writeSkill(root, { name: 'pirate-mode', description: 'второе', body: 'y' });
  assert.equal(second.ok, false);
  assert.match(second.ok ? '' : second.message, /уже есть/);
  assert.equal(listSkills(root)[0].description, 'первое', 'первый скилл не тронут');
});

test('deletion removes the skill with its bundle but not the skills directory', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'x' });
  seed(root, { 'pirate-mode/scripts/run.sh': '#!/bin/sh\n' });
  writeSkill(root, { name: 'sailor-talk', description: 'ок', body: 'x' });

  const result = removeSkill(root, 'pirate-mode/SKILL.md');
  assert.equal(result.ok, true);
  assert.deepEqual(listSkills(root).map((skill) => skill.name), ['sailor-talk']);
  assert.equal(fs.existsSync(path.join(root, 'pirate-mode')), false, 'бандл уехал вместе со скиллом');
  assert.equal(removeSkill(root, 'pirate-mode/SKILL.md').ok, false, 'второй раз удалять нечего');
});

test('the panel also edits a flat .md in the root: pi accepts such skills too', () => {
  const root = tempRoot();
  seed(root, { 'sea-wolf.md': '---\nname: loose-note\ndescription: плоский скилл\n---\n\nтело\n' });

  const [summary] = listSkills(root);
  assert.equal(summary.id, 'sea-wolf.md');
  assert.equal(summary.name, 'loose-note', 'имя берётся из frontmatter: у плоского файла каталога нет');

  const result = writeSkill(root, { id: 'sea-wolf.md', name: 'loose-note', description: 'новое', body: 'тело' });
  assert.equal(result.ok, true);
  assert.deepEqual(piSees(root).skills.map((skill) => skill.description), ['новое']);
});

test('a skill without a description is visible in the list but flagged: pi will skip it', () => {
  const root = tempRoot();
  seed(root, { 'half-done.md': '---\nname: half-done\n---\n\nбез описания\n' });

  const [summary] = listSkills(root);
  assert.equal(summary.name, 'half-done');
  assert.match(String(summary.problem), /описани/i);
  assert.deepEqual(piSees(root).names, [], 'pi такой файл скиллом не считает');
});

test('pi sees a skill hidden from the model but does not put it in the prompt catalog', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'secret-handshake', description: 'ок', body: 'x', hidden: true });

  const [skill] = piSees(root).skills;
  assert.equal(skill.disableModelInvocation, true, 'disable-model-invocation доехал до pi');
  assert.equal(listSkills(root)[0].hidden, true);
});

test('search scans the skill file and returns the skill itself, not the path', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: '# Как рычать\n\nГовори «йо-хо-хо».\n' });
  writeSkill(root, { name: 'sailor-talk', description: 'ок', body: 'Ничего морского.\n' });

  const hits = searchSkills(root, 'йо-хо-хо');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'pirate-mode/SKILL.md');
  assert.equal(hits[0].name, 'pirate-mode');
  assert.match(hits[0].text, /йо-хо-хо/);

  assert.deepEqual(searchSkills(root, 'й'), [], 'слишком короткий запрос не ищем');
});

test('the skill label for a commit is the name, not the file path', () => {
  assert.equal(skillLabel('pirate-mode/SKILL.md'), 'pirate-mode');
  assert.equal(skillLabel('sea-wolf.md'), 'sea-wolf');
  assert.equal(skillLabel('SKILL.md'), 'SKILL.md', 'у корневого файла имени нет — остаётся имя файла');
});
