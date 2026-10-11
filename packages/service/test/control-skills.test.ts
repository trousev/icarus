// Скиллы: панель пишет SKILL.md, а читает его pi.
//
// Тест держит именно этот стык, а не внутренности панели: раскладку каталога,
// формат frontmatter и проверки путей. Скилл, который pi не увидит или прочитает
// не так, — это скилл, которого у Икара нет, даже если в панели он выглядит целым.
// Поэтому «сохранили и проверили» здесь значит «сохранили и скормили pi его же
// загрузчику скиллов» (loadSkillsFromDir из @earendil-works/pi-coding-agent).
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

/** Пустой каталог скиллов: дальше его наполняет тест. */
function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-skills-'));
}

/** Что видит pi в каталоге: имена загруженных скиллов и его же диагностика. */
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

test('сохранённый скилл видит сам pi: имя, описание и путь', () => {
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

test('описание с двоеточием, кавычками и тире доезжает до pi дословно', () => {
  const root = tempRoot();
  const description = 'Use when: «пират» — то есть всегда, если речь о "морском" стиле';
  writeSkill(root, { name: 'pirate-mode', description, body: 'Рычи.' });

  const [skill] = piSees(root).skills;
  assert.equal(skill.description, description, 'YAML не должен переписать описание своими правилами');
});

test('без описания и с именем не по правилам панель не сохраняет', () => {
  const root = tempRoot();
  assert.equal(writeSkill(root, { name: 'pirate-mode', description: '   ', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'Pirate Mode', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: '-pirate', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'pirate--mode', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'a'.repeat(65), description: 'ок', body: 'x' }).ok, false);
  assert.deepEqual(listSkills(root), [], 'после отказов каталог остаётся пустым');
});

test('чужой frontmatter панель не теряет, а своё переписывает', () => {
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

test('переименование переезжает каталогом — вместе с файлами бандла', () => {
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

test('скилл с полки переименовывается на своей полке, а не переезжает в корень', () => {
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

test('за пределы каталога скиллов панель не выпускает', () => {
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

  // Имя скилла — это ещё и имя каталога, поэтому слэши и точки в нём отсекает
  // проверка имени, а не только проверка пути.
  assert.equal(writeSkill(root, { name: '../evil', description: 'ок', body: 'x' }).ok, false);
  assert.equal(writeSkill(root, { name: 'sub/evil', description: 'ок', body: 'x' }).ok, false);
});

test('имя занято — панель отказывает, а не переписывает чужой скилл', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'pirate-mode', description: 'первое', body: 'x' });
  const second = writeSkill(root, { name: 'pirate-mode', description: 'второе', body: 'y' });
  assert.equal(second.ok, false);
  assert.match(second.ok ? '' : second.message, /уже есть/);
  assert.equal(listSkills(root)[0].description, 'первое', 'первый скилл не тронут');
});

test('удаление сносит скилл с бандлом, но не каталог скиллов', () => {
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

test('плоский .md в корне панель тоже правит: pi берёт и такие скиллы', () => {
  const root = tempRoot();
  seed(root, { 'sea-wolf.md': '---\nname: loose-note\ndescription: плоский скилл\n---\n\nтело\n' });

  const [summary] = listSkills(root);
  assert.equal(summary.id, 'sea-wolf.md');
  assert.equal(summary.name, 'loose-note', 'имя берётся из frontmatter: у плоского файла каталога нет');

  const result = writeSkill(root, { id: 'sea-wolf.md', name: 'loose-note', description: 'новое', body: 'тело' });
  assert.equal(result.ok, true);
  assert.deepEqual(piSees(root).skills.map((skill) => skill.description), ['новое']);
});

test('скилл без описания в списке виден, но помечен: pi его пропустит', () => {
  const root = tempRoot();
  seed(root, { 'half-done.md': '---\nname: half-done\n---\n\nбез описания\n' });

  const [summary] = listSkills(root);
  assert.equal(summary.name, 'half-done');
  assert.match(String(summary.problem), /описани/i);
  assert.deepEqual(piSees(root).names, [], 'pi такой файл скиллом не считает');
});

test('скрытый от модели скилл pi видит, но в каталог промпта не кладёт', () => {
  const root = tempRoot();
  writeSkill(root, { name: 'secret-handshake', description: 'ок', body: 'x', hidden: true });

  const [skill] = piSees(root).skills;
  assert.equal(skill.disableModelInvocation, true, 'disable-model-invocation доехал до pi');
  assert.equal(listSkills(root)[0].hidden, true);
});

test('поиск ищет по файлу скилла и возвращает сам скилл, а не путь', () => {
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

test('подпись скилла для коммита — имя, а не путь файла', () => {
  assert.equal(skillLabel('pirate-mode/SKILL.md'), 'pirate-mode');
  assert.equal(skillLabel('sea-wolf.md'), 'sea-wolf');
  assert.equal(skillLabel('SKILL.md'), 'SKILL.md', 'у корневого файла имени нет — остаётся имя файла');
});
