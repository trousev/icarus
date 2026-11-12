// Общие скиллы: снимок у всех, у получателя — выключен по умолчанию.
//
// Тест держит главное обещание шаринга: у владельца скилл остаётся личным, у
// остальных появляется в списке выключенным, включается только самим человеком и
// едет в settings.json путём, а не копией в личный каталог. Заодно проверяем, что
// правка автора доезжает до снимка и что переименование не теряет включённость.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import { userPaths } from '../src/config.ts';
import { prepareUser } from '../src/workspace.ts';
import { writeSkill } from '../src/control/skills.ts';
import {
  enabledSharedPaths,
  isShared,
  listVisible,
  readShared,
  readVisible,
  renameShare,
  setShared,
  setSharedEnabled,
  storePaths,
  syncShared,
} from '../src/skills/registry.ts';
import { makeConfig, probe } from './fixtures.ts';

const DRAFT = { name: 'pirate-mode', description: 'говорить как пират', body: '# Йо-хо-хо' };

function setup() {
  const config = makeConfig({ users: [probe('anna'), probe('boris')] });
  const anna = probe('anna');
  const boris = probe('boris');
  prepareUser(config, anna);
  prepareUser(config, boris);
  const root = userPaths(config, anna).skills;
  const saved = writeSkill(root, DRAFT);
  assert.equal(saved.ok, true);
  return { config, anna, boris, root };
}

test('поделился — у другого появился выключенным, а у автора остался своим', () => {
  const { config } = setup();
  assert.equal(isShared(config, 'anna', 'pirate-mode/SKILL.md'), false);

  setShared(config, 'anna', 'pirate-mode/SKILL.md', true);
  assert.equal(isShared(config, 'anna', 'pirate-mode/SKILL.md'), true);

  const own = listVisible(config, 'anna');
  assert.equal(own.length, 1);
  assert.equal(own[0].ownerIsMe, true);
  assert.equal(own[0].shared, true);

  const other = listVisible(config, 'boris');
  assert.equal(other.length, 1);
  assert.equal(other[0].owner, 'anna');
  assert.equal(other[0].ownerIsMe, false);
  assert.equal(other[0].shared, true);
  assert.equal(other[0].enabled, false, 'у других по умолчанию выключен');
  assert.equal(other[0].canEdit, false);
  assert.equal(other[0].canShare, false);
  assert.equal(other[0].canDelete, false);

  // Снимок лежит в общем каталоге, а не в личном каталоге получателя.
  assert.equal(fs.existsSync(path.join(storePaths(config).shared, 'anna', 'pirate-mode', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(userPaths(config, probe('boris')).skills, 'pirate-mode')), false);

  const detail = readVisible(config, 'boris', 'anna', 'pirate-mode/SKILL.md');
  assert.match(detail?.body ?? '', /Йо-хо-хо/);
  assert.equal(detail?.canEdit, false);
});

test('включение чужого скилла — личный флаг и путь в settings.json', () => {
  const { config, boris } = setup();
  setShared(config, 'anna', 'pirate-mode/SKILL.md', true);

  // Пока получатель не включил, пути в settings.json нет вовсе: выключенный
  // скилл не должен занимать ни промпт, ни контекст.
  prepareUser(config, boris);
  const before = JSON.parse(
    fs.readFileSync(path.join(userPaths(config, boris).piAgent, 'settings.json'), 'utf8'),
  ) as { skills?: string[] };
  assert.equal(before.skills, undefined);

  setSharedEnabled(config, 'boris', 'anna', 'pirate-mode/SKILL.md', true);

  const visible = listVisible(config, 'boris');
  assert.equal(visible[0].enabled, true);

  const root = '/workspaces/.icarus/shared-skills/anna/pirate-mode';
  assert.deepEqual(enabledSharedPaths(config, 'boris'), [root]);

  prepareUser(config, boris);
  const settings = JSON.parse(
    fs.readFileSync(path.join(userPaths(config, boris).piAgent, 'settings.json'), 'utf8'),
  ) as { skills?: string[] };
  assert.deepEqual(settings.skills, [root], 'pi читает снимок как дополнительный путь');

  // И проверяем не строку, а загрузчик pi: путь из settings должен дать скилл.
  const seen = loadSkills({
    cwd: userPaths(config, boris).workspaces,
    agentDir: userPaths(config, boris).piAgent,
    skillPaths: [path.join(storePaths(config).shared, 'anna', 'pirate-mode')],
    includeDefaults: false,
  });
  assert.deepEqual(seen.skills.map((skill) => skill.name), ['pirate-mode']);
});

test('правка автора доезжает до снимка, а переименование сохраняет включённость', () => {
  const { config, root } = setup();
  setShared(config, 'anna', 'pirate-mode/SKILL.md', true);
  setSharedEnabled(config, 'boris', 'anna', 'pirate-mode/SKILL.md', true);

  const changed = writeSkill(root, {
    id: 'pirate-mode/SKILL.md',
    name: 'pirate-mode',
    description: 'говорить как пират',
    body: '# Новое тело',
  });
  assert.equal(changed.ok, true);
  syncShared(config);
  assert.match(readShared(config, 'anna', 'pirate-mode/SKILL.md')?.body ?? '', /Новое тело/);

  const renamed = writeSkill(root, {
    id: 'pirate-mode/SKILL.md',
    name: 'sea-wolf',
    description: 'говорить как пират',
    body: '# Новое тело',
  });
  assert.equal(renamed.ok && renamed.id, 'sea-wolf/SKILL.md');
  assert.equal(renameShare(config, 'anna', 'pirate-mode/SKILL.md', 'sea-wolf/SKILL.md'), true);

  const visible = listVisible(config, 'boris');
  assert.equal(visible[0].id, 'sea-wolf/SKILL.md');
  assert.equal(visible[0].enabled, true, 'переименование не выключило скилл у получателя');
  assert.match(readShared(config, 'anna', 'sea-wolf/SKILL.md')?.body ?? '', /Новое тело/);
  assert.equal(fs.existsSync(path.join(storePaths(config).shared, 'anna', 'pirate-mode')), false);
});

test('снятый шаринг исчезает у всех, а повторный снова приезжает выключенным', () => {
  const { config } = setup();
  setShared(config, 'anna', 'pirate-mode/SKILL.md', true);
  setSharedEnabled(config, 'boris', 'anna', 'pirate-mode/SKILL.md', true);
  assert.equal(listVisible(config, 'boris')[0].enabled, true);

  setShared(config, 'anna', 'pirate-mode/SKILL.md', false);
  assert.deepEqual(listVisible(config, 'boris'), []);
  assert.equal(fs.existsSync(path.join(storePaths(config).shared, 'anna', 'pirate-mode')), false);

  setShared(config, 'anna', 'pirate-mode/SKILL.md', true);
  assert.equal(listVisible(config, 'boris')[0].enabled, false, 'старая включённость не переживает повторный шаринг');
});

test('чужой скилл нельзя включить, если им не поделились', () => {
  const { config } = setup();
  assert.throws(() => setSharedEnabled(config, 'boris', 'anna', 'pirate-mode/SKILL.md', true), /не расшарен/);
  assert.equal(readVisible(config, 'boris', 'anna', 'pirate-mode/SKILL.md'), null);
});

test('битый registry.json с путём наружу не читается', () => {
  const { config } = setup();
  fs.mkdirSync(storePaths(config).dir, { recursive: true });
  fs.writeFileSync(
    storePaths(config).registry,
    JSON.stringify({
      version: 1,
      shares: { 'anna/../../evil': { owner: 'anna', id: '../../evil', name: 'evil' } },
      prefs: {},
    }),
  );
  assert.throws(() => listVisible(config, 'boris'), /записан не целиком/);
});
