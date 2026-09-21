// Синхронизация скиллов: раскладка в каталог pi, манифест и повторные проходы.
//
// Проверяем то, что легко сломать незаметно: frontmatter SKILL.md, идемпотентность
// (второй проход не должен ничего переписывать — иначе сессии pi перезапускались бы
// на каждом опросе), удаление скилла, который убрали в LibreChat, и неприкосновенность
// чужих файлов в каталоге.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  materializeSkills,
  needsFetch,
  readManifest,
  renderSkillMd,
  skillFiles,
  syncSkillDirectory,
  SKILLS_MANIFEST,
  type SkillsSource,
} from '../src/skills/sync.ts';
import type { SkillDetail, SkillFileContent, SkillSummary } from '../src/skills/librechat.ts';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-skills-'));
}

function skill(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    id: '6ab15c19d5c6deea90e8ade0',
    name: 'pirate-mode',
    description: 'Use when the user asks to speak like a pirate.',
    version: 1,
    fileCount: 0,
    updatedAt: '2026-09-21T16:32:25.426Z',
    body: '# Pirate mode\n\nАрр!\n',
    ...overrides,
  };
}

function entry(detail: SkillDetail, extra: SkillFileContent[] = []) {
  return { summary: detail, files: skillFiles(detail, extra) };
}

/**
 * Клиент-заглушка: считает запросы, чтобы проверять, что неизменившиеся скиллы
 * не перечитываются.
 */
function fakeClient(skills: SkillDetail[]): SkillsSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listSkills(): Promise<SkillSummary[]> {
      calls.push('list');
      return skills;
    },
    async getSkill(id: string): Promise<SkillDetail> {
      calls.push(`get:${id}`);
      const found = skills.find((item) => item.id === id);
      if (!found) throw new Error(`нет скилла ${id}`);
      return found;
    },
    async listFiles(id: string): Promise<SkillFileContent[]> {
      calls.push(`files:${id}`);
      return [];
    },
    async getFile(id: string, relativePath: string): Promise<SkillFileContent> {
      calls.push(`file:${id}:${relativePath}`);
      return { relativePath, filename: relativePath, mimeType: 'text/plain', bytes: 0, isBinary: false };
    },
  };
}

test('SKILL.md: frontmatter с именем и описанием, тело ниже', () => {
  const text = renderSkillMd(skill());
  assert.ok(text.startsWith('---\n'));
  assert.match(text, /name: pirate-mode/);
  assert.match(text, /description: Use when the user asks to speak like a pirate\./);
  assert.match(text, /# Pirate mode/);
});

test('SKILL.md: чужие ключи frontmatter сохраняются, disable-model-invocation переносится', () => {
  const text = renderSkillMd(
    skill({ disableModelInvocation: true, frontmatter: { 'always-apply': true, 'allowed-tools': ['execute_code'] } }),
  );
  assert.match(text, /always-apply: true/);
  assert.match(text, /disable-model-invocation: true/);
  assert.match(text, /allowed-tools:/);
});

test('файлы скилла: SKILL.md и текст, бинарные пропускаются', () => {
  const files = skillFiles(skill(), [
    {
      relativePath: 'references/tone.md',
      filename: 'tone.md',
      mimeType: 'text/markdown',
      bytes: 3,
      content: 'раз',
      isBinary: false,
    },
    { relativePath: 'assets/logo.png', filename: 'logo.png', mimeType: 'image/png', bytes: 10, isBinary: true },
  ]);
  assert.deepEqual([...files.keys()].sort(), ['SKILL.md', 'references/tone.md']);
});

test('скилл кладётся вместе с манифестом, проход считается изменённым', () => {
  const root = tempRoot();
  const first = materializeSkills(root, [entry(skill())], [skill()]);
  assert.equal(first.changed, true);
  assert.deepEqual(first.written, ['pirate-mode']);
  assert.match(fs.readFileSync(path.join(root, 'pirate-mode', 'SKILL.md'), 'utf8'), /Арр!/);
  assert.ok(fs.existsSync(path.join(root, SKILLS_MANIFEST)));
});

test('повторный проход с тем же набором ничего не переписывает', () => {
  const root = tempRoot();
  materializeSkills(root, [entry(skill())], [skill()]);
  const second = materializeSkills(root, [entry(skill())], [skill()]);
  assert.equal(second.changed, false);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.removed, []);
});

test('новая версия скилла переписывается', () => {
  const root = tempRoot();
  materializeSkills(root, [entry(skill())], [skill()]);
  const updated = skill({ version: 2, body: '# Pirate mode\n\nАрр, версия два!\n' });
  const second = materializeSkills(root, [entry(updated)], [updated]);
  assert.equal(second.changed, true);
  assert.deepEqual(second.written, ['pirate-mode']);
  assert.match(fs.readFileSync(path.join(root, 'pirate-mode', 'SKILL.md'), 'utf8'), /версия два/);
});

test('скилл, удалённый в LibreChat, убирается с диска', () => {
  const root = tempRoot();
  materializeSkills(root, [entry(skill())], [skill()]);
  const second = materializeSkills(root, [], []);
  assert.deepEqual(second.removed, ['pirate-mode']);
  assert.equal(fs.existsSync(path.join(root, 'pirate-mode')), false);
});

test('чужие файлы в каталоге не трогаются', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'manual-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manual-skill', 'SKILL.md'), 'руками положено');
  materializeSkills(root, [entry(skill())], [skill()]);
  materializeSkills(root, [], []);
  assert.equal(fs.readFileSync(path.join(root, 'manual-skill', 'SKILL.md'), 'utf8'), 'руками положено');
});

test('негодное для pi имя пропускается и не ломает проход', () => {
  const root = tempRoot();
  const bad = skill({ id: 'bbbb00000000000000000000', name: 'Плохое Имя' });
  const result = materializeSkills(root, [entry(skill()), entry(bad)], [skill(), bad]);
  assert.deepEqual(result.written, ['pirate-mode']);
  assert.deepEqual(result.skipped, ['Плохое Имя']);
  assert.equal(fs.existsSync(path.join(root, 'Плохое Имя')), false);
});

test('неизменившийся скилл не перечитывается: проход — один запрос за списком', async () => {
  const root = tempRoot();
  const first = fakeClient([skill()]);
  const initial = await syncSkillDirectory(root, first);
  assert.equal(initial.changed, true);
  assert.deepEqual(initial.fetched, ['pirate-mode']);

  const second = fakeClient([skill()]);
  const again = await syncSkillDirectory(root, second);
  assert.equal(again.changed, false);
  assert.deepEqual(again.fetched, []);
  assert.deepEqual(second.calls, ['list'], 'кроме списка ни одного запроса');
});

test('правка скилла перечитывается: version или updatedAt сдвинулись', async () => {
  const root = tempRoot();
  await syncSkillDirectory(root, fakeClient([skill()]));

  const byVersion = fakeClient([skill({ version: 2 })]);
  const afterVersion = await syncSkillDirectory(root, byVersion);
  assert.deepEqual(afterVersion.fetched, ['pirate-mode']);
  assert.equal(afterVersion.changed, true);

  const byDate = fakeClient([skill({ version: 2, updatedAt: '2026-09-21T17:00:00.000Z' })]);
  const afterDate = await syncSkillDirectory(root, byDate);
  assert.deepEqual(afterDate.fetched, ['pirate-mode']);
  assert.equal(afterDate.changed, false, 'тело то же — файлы не переписываем');
});

test('скилл, пропавший из списка, убирается и из манифеста', async () => {
  const root = tempRoot();
  await syncSkillDirectory(root, fakeClient([skill()]));
  const gone = await syncSkillDirectory(root, fakeClient([]));
  assert.deepEqual(gone.removed, ['pirate-mode']);
  assert.equal(fs.existsSync(path.join(root, 'pirate-mode')), false);

  const back = fakeClient([skill()]);
  const returned = await syncSkillDirectory(root, back);
  assert.deepEqual(returned.fetched, ['pirate-mode'], 'вернувшийся скилл читается заново');
});

test('пропавший файл скилла перечитывается, даже если version не менялся', async () => {
  const root = tempRoot();
  await syncSkillDirectory(root, fakeClient([skill()]));
  fs.rmSync(path.join(root, 'pirate-mode'), { recursive: true, force: true });

  const client = fakeClient([skill()]);
  const restored = await syncSkillDirectory(root, client);
  assert.deepEqual(restored.fetched, ['pirate-mode']);
  assert.equal(fs.existsSync(path.join(root, 'pirate-mode', 'SKILL.md')), true);
});

test('манифест хранит version и updatedAt для кэша', async () => {
  const root = tempRoot();
  await syncSkillDirectory(root, fakeClient([skill()]));
  const stored = readManifest(root).skills['pirate-mode'];
  assert.ok(stored, 'скилл должен быть в манифесте');
  assert.equal(stored.id, skill().id);
  assert.equal(stored.version, 1);
  assert.equal(stored.updatedAt, skill().updatedAt);
  assert.match(stored.hash, /^1:[0-9a-f]{16}$/);
});

test('старый манифест без version/updatedAt перечитывается один раз', async () => {
  const root = tempRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'pirate-mode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pirate-mode', 'SKILL.md'), 'старое');
  fs.writeFileSync(
    path.join(root, SKILLS_MANIFEST),
    JSON.stringify({ version: 1, digest: 'x', skills: { 'pirate-mode': { id: skill().id, hash: '1:old' } } }),
  );

  const client = fakeClient([skill()]);
  const result = await syncSkillDirectory(root, client);
  assert.deepEqual(result.fetched, ['pirate-mode'], 'манифест без новых полей — повод перечитать');
  assert.match(fs.readFileSync(path.join(root, 'pirate-mode', 'SKILL.md'), 'utf8'), /Арр!/);

  const second = fakeClient([skill()]);
  await syncSkillDirectory(root, second);
  assert.deepEqual(second.calls, ['list']);
});

test('needsFetch: что считается «скилл не менялся»', () => {
  const root = tempRoot();
  const summary = skill();
  assert.equal(needsFetch(root, summary, readManifest(root)), true, 'пустой манифест — читаем');

  materializeSkills(root, [entry(summary)], [summary]);
  const manifest = readManifest(root);
  assert.equal(needsFetch(root, summary, manifest), false, 'всё совпало — не читаем');
  assert.equal(needsFetch(root, skill({ version: 2 }), manifest), true, 'версия сдвинулась');
  assert.equal(needsFetch(root, skill({ updatedAt: '2026-09-22T00:00:00.000Z' }), manifest), true, 'дата сдвинулась');
  assert.equal(needsFetch(root, skill({ id: 'bbbb00000000000000000000' }), manifest), true, 'другой скилл с тем же именем');

  fs.rmSync(path.join(root, 'pirate-mode'), { recursive: true, force: true });
  assert.equal(needsFetch(root, summary, manifest), true, 'файла нет — читаем заново');
});
