// Выключенный скилл: он есть в панели и под git, но pi его не видит.
//
// Проверяем именно стык с pi: «выключен» — это не галочка в нашем JSON, а файл,
// которого нет в каталоге, который читает pi. Поэтому тест снова кормит результат
// загрузчику pi и смотрит, что имя пропало и вернулось.
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

test('выключение убирает скилл из каталога pi и возвращает его обратно', () => {
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

test('панель видит выключенный скилл с тем же id и статусом', () => {
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

test('бандл переезжает вместе с выключенным скиллом', () => {
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

test('переименование выключенного скилла не включает его обратно', () => {
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

test('переименование корневого SKILL.md не уносит весь каталог скиллов', () => {
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

test('включение занятого имени отказывает, а не затирает соседа', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'ок', body: 'тело' });
  setSkillEnabled(root, 'pirate-mode/SKILL.md', false);
  // В корне появился другой скилл с тем же путём: включать поверх него нельзя.
  fs.mkdirSync(path.join(root, 'pirate-mode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pirate-mode', 'SKILL.md'), '---\nname: pirate-mode\ndescription: чужой\n---\n');

  const result = setSkillEnabled(root, 'pirate-mode/SKILL.md', true);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /занято/);
});
