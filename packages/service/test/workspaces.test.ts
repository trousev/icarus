// Workspaces: the person's folders and the "read-only" mode for the private one.
// This checks what the migration was for: service data lies outside the working folders,
// creation/deletion are operations on directories, and a private session gets
// not a single write tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WORKSPACE, PRIVATE_WORKSPACE, userPaths } from '../src/config.ts';
import { piArgsFor } from '../src/sessions/pi-session.ts';
import { prepareUser } from '../src/workspace.ts';
import {
  createWorkspace,
  deleteWorkspace,
  ensureWorkspaces,
  findSelectableWorkspace,
  listWorkspaces,
  selectableWorkspaces,
  slugify,
  WorkspaceError,
} from '../src/workspaces.ts';
import { makeConfig, probe } from './fixtures.ts';

const config = makeConfig();
const user = probe();
const paths = userPaths(config, user);

test('"Conversation" and "Private" always exist, and each has its own folder with AGENTS.md', () => {
  const workspaces = ensureWorkspaces(config, user);
  assert.deepEqual(
    workspaces.map((item) => item.slug),
    [DEFAULT_WORKSPACE, PRIVATE_WORKSPACE],
  );
  for (const workspace of workspaces) {
    const dir = path.join(paths.workspaces, workspace.slug);
    assert.ok(fs.existsSync(dir), `папка ${workspace.slug} создана`);
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')), 'свой AGENTS.md');
  }
});

test('service data lies outside the working folders: /workspaces/.icarus', () => {
  assert.equal(paths.memory, path.join(paths.icarus, 'memory'));
  assert.equal(paths.icarus, path.join(paths.workspaces, '.icarus'));
  assert.equal(paths.agentsMd, path.join(paths.icarus, 'AGENTS.md'));
});

test('a new workspace is a folder with its own AGENTS.md and an entry in the registry', () => {
  const workspace = createWorkspace(config, user, 'Мой смешной проект');
  assert.equal(workspace.slug, 'moy-smeshnoy-proekt');
  assert.ok(fs.existsSync(path.join(paths.workspaces, workspace.slug, 'AGENTS.md')));
  const list = listWorkspaces(config, user);
  assert.equal(list.at(-1)?.slug, workspace.slug);
  assert.equal(list.at(-1)?.name, 'Мой смешной проект');
});

test('identical names get different folders', () => {
  const first = createWorkspace(config, user, 'проект');
  const second = createWorkspace(config, user, 'проект');
  assert.notEqual(first.slug, second.slug);
  assert.equal(second.slug, 'proekt-2');
});

test('Cyrillic turns into a readable slug', () => {
  assert.equal(slugify('Привет, мир!'), 'privet-mir');
  assert.equal(slugify('   '), 'workspace');
  assert.equal(slugify('уже-латиница'), 'uzhe-latinica');
});

test('deletion removes the workspace from the registry, but does not touch the folder on disk', () => {
  const workspace = createWorkspace(config, user, 'временный');
  const dir = path.join(paths.workspaces, workspace.slug);
  assert.ok(fs.existsSync(dir));

  deleteWorkspace(config, user, workspace.slug);

  assert.equal(listWorkspaces(config, user).some((item) => item.slug === workspace.slug), false);
  assert.ok(fs.existsSync(dir), 'данные человека остаются');
});

test('service workspaces cannot be deleted', () => {
  assert.throws(() => deleteWorkspace(config, user, PRIVATE_WORKSPACE), WorkspaceError);
  assert.throws(() => deleteWorkspace(config, user, DEFAULT_WORKSPACE), WorkspaceError);
});

test('an empty name is not accepted', () => {
  assert.throws(() => createWorkspace(config, user, '   '), /название/);
});

test('choosing a workspace for a conversation: the private one is excluded, name and slug are equivalent', () => {
  createWorkspace(config, user, 'Работа');
  const available = selectableWorkspaces(config, user);

  assert.equal(available.some((item) => item.slug === 'rabota'), true);
  assert.equal(available.some((item) => item.kind === 'private'), false, 'приватного в списке нет');

  const bySlug = findSelectableWorkspace(config, user, 'rabota');
  assert.ok(bySlug !== null && bySlug !== 'private');
  assert.equal(bySlug.slug, 'rabota', 'по slug');

  const byName = findSelectableWorkspace(config, user, ' работа ');
  assert.ok(byName !== null && byName !== 'private');
  assert.equal(byName.slug, 'rabota', 'по имени, без регистра');

  assert.equal(findSelectableWorkspace(config, user, PRIVATE_WORKSPACE), 'private', 'запрет, а не опечатка');
  assert.equal(findSelectableWorkspace(config, user, 'Приватный'), 'private');
  assert.equal(findSelectableWorkspace(config, user, 'Луна'), null);
});

test('a private session gets no write tools, a normal one does', () => {
  const model = { provider: 'deepinfra', id: 'm', thinking: 'off' as const, tier: 'fast' as const };

  const normal = piArgsFor(model, 's-1', DEFAULT_WORKSPACE);
  assert.ok(!normal.includes('--exclude-tools'), 'в обычном режиме тулы записи на месте');
  assert.ok(!normal.includes('--no-extensions'));

  const privateArgs = piArgsFor(model, 's-2', PRIVATE_WORKSPACE);
  const exclude = privateArgs.indexOf('--exclude-tools');
  assert.ok(exclude >= 0, 'тулы записи отключены');
  assert.equal(privateArgs[exclude + 1], 'write,edit,bash', 'именно все пишущие');

  // Background memory writers are not loaded at all: otherwise they would write it after the turn.
  assert.ok(privateArgs.includes('--no-extensions'));
  const loaded = privateArgs.flatMap((arg, index) => (arg === '-e' ? [privateArgs[index + 1]] : []));
  assert.ok(loaded.some((file) => file?.endsWith('/persona.ts')), 'персона остаётся');
  assert.ok(loaded.some((file) => file?.endsWith('/memory-index.ts')), 'индекс памяти остаётся');
  assert.ok(!loaded.some((file) => file?.endsWith('/memory-extractor.ts')), 'экстрактор памяти выключен');
  assert.ok(!loaded.some((file) => file?.endsWith('/memory-sweeper.ts')), 'уборщик памяти выключен');
});

test('the old household migrates from the person\'s root into .icarus', () => {
  const fresh = makeConfig();
  const freshPaths = userPaths(fresh, user);
  fs.mkdirSync(path.join(freshPaths.root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(freshPaths.root, 'memory', 'identity.md'), 'кто-то');
  fs.writeFileSync(path.join(freshPaths.root, 'AGENTS.md'), 'старая карта');

  prepareUser(fresh, user);

  assert.equal(fs.readFileSync(path.join(freshPaths.icarus, 'memory', 'identity.md'), 'utf8'), 'кто-то');
  assert.equal(fs.readFileSync(freshPaths.agentsMd, 'utf8').startsWith('# Где ты находишься'), true);
  assert.equal(fs.existsSync(path.join(freshPaths.root, 'memory')), false, 'старое место не осталось');
});
