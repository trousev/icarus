// A disabled skill: it is present in the panel and under git, but pi does not see it.
//
// We check exactly the junction with pi: "disabled" is not a checkbox in our JSON, but a file
// that is absent from the directory pi reads. That is why the test feeds the result into the pi
// loader again and watches the name disappear and come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import {
  SKILLS_DISABLED_DIR,
  listSkills,
  readSkill,
  setSkillEnabled,
  writeSkill,
} from '../src/control/skills.ts';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-skills-off-'));
}

function piSees(root: string): string[] {
  return loadSkillsFromDir({ dir: root, source: 'user' }).skills.map((skill) => skill.name);
}

test('disabling removes the skill from the pi directory and brings it back', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  assert.deepEqual(piSees(root), ['pirate-mode']);

  const off = setSkillEnabled(root, 'pirate-mode/SKILL.md', false);
  assert.equal(off.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'pirate-mode')), false, 'из корня каталог уехал');
  assert.equal(
    fs.existsSync(path.join(root, SKILLS_DISABLED_DIR, 'pirate-mode', 'SKILL.md')),
    true,
    'и лежит в служебном каталоге',
  );
  assert.deepEqual(piSees(root), [], 'pi выключенный скилл не видит');

  const on = setSkillEnabled(root, 'pirate-mode/SKILL.md', true);
  assert.equal(on.ok, true);
  assert.deepEqual(piSees(root), ['pirate-mode'], 'включение вернуло скилл pi');
});

test('the panel sees a disabled skill with the same id and status', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  setSkillEnabled(root, 'pirate-mode/SKILL.md', false);

  const [skill] = listSkills(root);
  assert.equal(skill.id, 'pirate-mode/SKILL.md', 'служебный префикс не протекает в id');
  assert.equal(skill.enabled, false);
  assert.equal(skill.files, 1, 'бандл считается относительно самого скилла');

  const detail = readSkill(root, 'pirate-mode/SKILL.md');
  assert.match(detail?.body ?? '', /тело/);
  assert.equal(detail?.enabled, false);
  assert.deepEqual(detail?.bundle.map((file) => file.path), ['pirate-mode/SKILL.md']);
});

test('the bundle moves along with the disabled skill', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  fs.mkdirSync(path.join(root, 'pirate-mode', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pirate-mode', 'scripts', 'run.sh'), '#!/bin/sh\n');

  setSkillEnabled(root, 'pirate-mode/SKILL.md', false);
  assert.equal(
    fs.existsSync(path.join(root, SKILLS_DISABLED_DIR, 'pirate-mode', 'scripts', 'run.sh')),
    true,
    'скрипт рядом со скиллом уехал вместе с ним',
  );

  const [skill] = listSkills(root);
  assert.equal(skill.enabled, false);
  assert.equal(skill.files, 2);
});

test('renaming a disabled skill does not enable it back', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  setSkillEnabled(root, 'pirate-mode/SKILL.md', false);

  const renamed = writeSkill(root, {
    id: 'pirate-mode/SKILL.md',
    name: 'sea-wolf',
    description: 'ок',
    body: 'тело',
  });
  assert.equal(renamed.ok && renamed.id, 'sea-wolf/SKILL.md');
  assert.equal(fs.existsSync(path.join(root, 'sea-wolf')), false, 'включённым он не стал');
  assert.equal(fs.existsSync(path.join(root, SKILLS_DISABLED_DIR, 'sea-wolf', 'SKILL.md')), true);
  assert.deepEqual(piSees(root), []);
});

test('renaming the root SKILL.md does not carry away the whole skills directory', () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, 'SKILL.md'),
    '---\nname: root-note\ndescription: корневой скилл\n---\n\nтело\n',
  );
  writeSkill(root, { name: 'sailor-talk', description: 'ок', body: 'тело' });

  const renamed = writeSkill(root, {
    id: 'SKILL.md',
    name: 'root-note',
    description: 'корневой скилл',
    body: 'тело',
  });
  assert.equal(renamed.ok, true);
  assert.equal(fs.existsSync(root), true, 'сам каталог скиллов остался на месте');
  assert.equal(fs.existsSync(path.join(root, 'root-note', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'sailor-talk', 'SKILL.md')), true, 'сосед не уехал');
});

test('enabling an occupied name refuses instead of overwriting a neighbour', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  setSkillEnabled(root, 'pirate-mode/SKILL.md', false);
  // Another skill with the same path appeared at the root: we must not enable over it.
  fs.mkdirSync(path.join(root, 'pirate-mode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pirate-mode', 'SKILL.md'), '---\nname: pirate-mode\ndescription: чужой\n---\n');

  const result = setSkillEnabled(root, 'pirate-mode/SKILL.md', true);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /занято/);
});
