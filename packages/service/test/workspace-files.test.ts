// Файлы рабочей папки для правой панели чата: дерево, предпросмотр и отдача файла.
//
// Главное, что здесь проверяется, — безопасность. Панель смотрит только в один
// workspace: `..`, абсолютный путь и символическая ссылка наружу не должны
// показать ни чужую папку, ни весь хост.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { ensureWorkspaces } from '../src/workspaces.ts';
import {
  FilesError,
  handleWorkspaceFilesApi,
  isImageName,
  listWorkspaceEntries,
  previewWorkspaceFile,
  rawWorkspaceFile,
  removeWorkspaceEntry,
  typeLabelOf,
  workspaceTarget,
} from '../src/control/files.ts';
import { makeConfig, probe } from './fixtures.ts';

const config = makeConfig();
const user = probe();
const paths = userPaths(config, user);
const root = path.join(paths.workspaces, 'talk');

function write(relative: string, content: string | Buffer): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

ensureWorkspaces(config, user);
write('AGENTS.md', '# Разговор\n');
write('projects/AGENTS.md', '# Проект\n\nВложенные инструкции.\n');
write('projects/plan.txt', 'план на неделю');
write('projects/contacts.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
write('.git/HEAD', 'ref: refs/heads/main');
write('node_modules/x/index.js', 'module.exports = 1');

test('дерево: файлы раньше папок, типы подписаны, служебный мусор скрыт', () => {
  const list = listWorkspaceEntries(root);
  const names = list.entries.map((entry) => entry.name);

  assert.ok(names.includes('AGENTS.md'));
  assert.ok(names.includes('projects'));
  assert.ok(!names.includes('.git'), 'служебный git не показываем');
  assert.ok(!names.includes('node_modules'), 'зависимости не показываем');
  assert.ok(names.indexOf('AGENTS.md') < names.indexOf('projects'), 'файлы стоят над папками');

  const file = list.entries.find((entry) => entry.name === 'AGENTS.md');
  assert.equal(file?.dir, false);
  assert.equal(file?.type, 'MARKDOWN');
  assert.equal(file?.path, 'AGENTS.md');
  assert.equal(file?.removable, false, 'корневой AGENTS.md удалить нельзя');
  assert.equal(list.entries.find((entry) => entry.name === 'projects')?.type, '', 'у папки типа нет');

  const nested = listWorkspaceEntries(root, 'projects');
  assert.deepEqual(
    nested.entries.map((entry) => entry.path),
    ['projects/AGENTS.md', 'projects/contacts.svg', 'projects/plan.txt'],
    'во вложенной папке путь считается от корня workspace',
  );
  assert.equal(nested.entries.find((entry) => entry.name === 'contacts.svg')?.image, true);
  assert.equal(
    nested.entries.find((entry) => entry.name === 'AGENTS.md')?.removable,
    true,
    'вложенный AGENTS.md — обычный файл проекта',
  );
});

test('подписи типов и картинки узнаются по расширению', () => {
  assert.equal(typeLabelOf('AGENTS.md'), 'MARKDOWN');
  assert.equal(typeLabelOf('plan.txt'), 'TEXT');
  assert.equal(typeLabelOf('contacts.svg'), 'SVG');
  assert.equal(typeLabelOf('data.json'), 'JSON');
  assert.equal(typeLabelOf('README'), 'FILE');
  assert.equal(isImageName('a.PNG'), true);
  assert.equal(isImageName('a.md'), false);
});

test('путь не выходит за workspace: .. и абсолютные адреса отсекаются', () => {
  assert.throws(() => listWorkspaceEntries(root, '..'), FilesError);
  assert.throws(() => listWorkspaceEntries(root, '../private'), FilesError);
  assert.throws(() => listWorkspaceEntries(root, '/etc'), FilesError);
  assert.throws(() => previewWorkspaceFile(root, 'talk', '../private/AGENTS.md'), FilesError);
  assert.equal(rawWorkspaceFile(root, '../private/AGENTS.md'), null);
});

test('символическая ссылка наружу не раскрывается', () => {
  const link = path.join(root, 'escape');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outside-'));
  if (!fs.existsSync(link)) fs.symlinkSync(outside, link);

  // Сама ссылка в дереве не появляется, а пройти через неё нельзя.
  assert.ok(!listWorkspaceEntries(root).entries.some((entry) => entry.name === 'escape'));
  assert.throws(() => listWorkspaceEntries(root, 'escape'), FilesError);
  assert.equal(rawWorkspaceFile(root, 'escape/passwd'), null);
});

test('markdown и текст — строкой, картинка — адресом', () => {
  const md = previewWorkspaceFile(root, 'talk', 'projects/AGENTS.md');
  assert.equal(md.kind, 'markdown');
  assert.match(md.text ?? '', /Вложенные инструкции/);
  assert.equal(md.file.type, 'MARKDOWN');
  assert.match(md.download, /download=1/);

  const text = previewWorkspaceFile(root, 'talk', 'projects/plan.txt');
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'план на неделю');

  const image = previewWorkspaceFile(root, 'talk', 'projects/contacts.svg');
  assert.equal(image.kind, 'image');
  assert.match(image.url ?? '', /workspace=talk/);
  assert.match(image.url ?? '', /path=projects%2Fcontacts\.svg/);
  assert.match(image.download, /download=1/);
});

test('двоичный файл честно называется двоичным, большой текст — обрезается', () => {
  write('blob.bin', Buffer.from([0, 1, 2, 3, 4]));
  assert.equal(previewWorkspaceFile(root, 'talk', 'blob.bin').kind, 'binary');

  write('big.txt', 'a'.repeat(256 * 1024 + 5));
  const big = previewWorkspaceFile(root, 'talk', 'big.txt');
  assert.equal(big.kind, 'text');
  assert.equal(big.truncated, true);
  assert.equal((big.text ?? '').length, 256 * 1024, 'показано ровно 256 КБ');
});

test('отдача файла: картинка идёт как картинка, остальное — файлом', () => {
  const image = rawWorkspaceFile(root, 'projects/contacts.svg');
  assert.equal(image?.type, 'image/svg+xml');
  assert.equal(image?.name, 'contacts.svg');
  assert.equal(rawWorkspaceFile(root, 'projects/plan.txt')?.type, 'application/octet-stream');
  assert.equal(rawWorkspaceFile(root, 'projects/missing.txt'), null);
});

test('workspace берётся из реестра, а незнакомый slug не открывается', () => {
  assert.equal(workspaceTarget(config, user, 'nope'), null);
  const target = workspaceTarget(config, user, 'talk');
  assert.equal(target?.workspace.name, 'Разговор');
  assert.equal(target?.workspace.slug, 'talk');
  assert.ok((target?.workspace.path ?? '').endsWith('workspaces/talk'), 'в шапке видно папку на диске');
});

/** Копилка для ответа: JSON-маршрутам хватает status, заголовков и тела. */
function fakeResponse() {
  const chunks: Buffer[] = [];
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body?: string | Buffer) {
      if (body) chunks.push(Buffer.from(body));
    },
    get text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
  return res;
}

test('API отвечает деревом и предпросмотром, чужой workspace — 404', async () => {
  const list = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'GET' } as never,
    list as never,
    new URL('http://panel/panel/api/workspace-files?workspace=talk&path=projects'),
    { config, userId: user.id },
  );
  assert.equal(list.status, 200);
  const payload = JSON.parse(list.text) as { workspace: { name: string }; entries: { name: string }[] };
  assert.equal(payload.workspace.name, 'Разговор');
  assert.ok(payload.entries.some((entry) => entry.name === 'AGENTS.md'));

  const read = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'GET' } as never,
    read as never,
    new URL('http://panel/panel/api/workspace-files/read?workspace=talk&path=projects/AGENTS.md'),
    { config, userId: user.id },
  );
  assert.equal(read.status, 200);
  const preview = JSON.parse(read.text) as { kind: string; text: string };
  assert.equal(preview.kind, 'markdown');
  assert.match(preview.text, /Вложенные инструкции/);

  const missing = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'GET' } as never,
    missing as never,
    new URL('http://panel/panel/api/workspace-files?workspace=nope'),
    { config, userId: user.id },
  );
  assert.equal(missing.status, 404, 'незнакомый workspace не читается');
});

test('API не разрешает запись: панель только смотрит файлы', async () => {
  const res = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'POST' } as never,
    res as never,
    new URL('http://panel/panel/api/workspace-files?workspace=talk'),
    { config, userId: user.id },
  );
  assert.equal(res.status, 405);
});

test('удаление: файл удаляется, пустая папка — сразу, непустая — только с force', () => {
  write('trash/file.txt', 'мусор');
  write('trash/nested/deep.txt', 'тоже мусор');
  fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });

  removeWorkspaceEntry(root, 'trash/file.txt');
  assert.equal(fs.existsSync(path.join(root, 'trash/file.txt')), false, 'файл удалён');

  // Непустую папку без подтверждения сервер не трогает.
  assert.throws(
    () => removeWorkspaceEntry(root, 'trash'),
    (error: unknown) => error instanceof FilesError && error.status === 409,
    'непустая папка требует force',
  );
  assert.ok(fs.existsSync(path.join(root, 'trash/nested/deep.txt')), 'содержимое на месте');

  // Пустая папка удаляется тем же запросом, без подтверждения.
  removeWorkspaceEntry(root, 'empty-dir');
  assert.equal(fs.existsSync(path.join(root, 'empty-dir')), false, 'пустая папка удалена');

  const removed = removeWorkspaceEntry(root, 'trash', true);
  assert.equal(removed.dir, true);
  assert.equal(removed.recursive, true);
  assert.equal(fs.existsSync(path.join(root, 'trash')), false, 'непустая папка удалена с содержимым');
});

test('удаление не выходит за workspace и не трогает корень', () => {
  assert.throws(() => removeWorkspaceEntry(root, ''), FilesError, 'корень workspace не удаляем');
  assert.throws(() => removeWorkspaceEntry(root, '.'), FilesError);
  assert.throws(() => removeWorkspaceEntry(root, '../private/AGENTS.md'), FilesError);
  assert.throws(() => removeWorkspaceEntry(root, '/etc/passwd'), FilesError);
});

test('символическую ссылку удалять нельзя: за ней чужой файл', () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outside-')), 'keep.txt');
  fs.writeFileSync(outside, 'не трогать');
  const link = path.join(root, 'escape-file');
  if (!fs.existsSync(link)) fs.symlinkSync(outside, link);

  assert.throws(() => removeWorkspaceEntry(root, 'escape-file'), FilesError);
  assert.ok(fs.existsSync(outside), 'файл за ссылкой цел');
});

test('API удаляет файл и папки: пустую сразу, непустую — после force', async () => {
  write('api-delete.txt', 'удалить');
  write('api-dir/inside.txt', 'внутри');

  const file = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'DELETE' } as never,
    file as never,
    new URL('http://panel/panel/api/workspace-files?workspace=talk&path=api-delete.txt'),
    { config, userId: user.id },
  );
  assert.equal(file.status, 200);
  assert.equal(fs.existsSync(path.join(root, 'api-delete.txt')), false);

  const guarded = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'DELETE' } as never,
    guarded as never,
    new URL('http://panel/panel/api/workspace-files?workspace=talk&path=AGENTS.md'),
    { config, userId: user.id },
  );
  assert.equal(guarded.status, 403, 'корневой AGENTS.md не удаляется и через API');
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));

  const denied = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'DELETE' } as never,
    denied as never,
    new URL('http://panel/panel/api/workspace-files?workspace=talk&path=api-dir'),
    { config, userId: user.id },
  );
  assert.equal(denied.status, 409, 'непустая папка без force не удаляется');
  assert.ok(fs.existsSync(path.join(root, 'api-dir/inside.txt')));

  const forced = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'DELETE' } as never,
    forced as never,
    new URL('http://panel/panel/api/workspace-files?workspace=talk&path=api-dir&force=1'),
    { config, userId: user.id },
  );
  assert.equal(forced.status, 200);
  assert.equal(fs.existsSync(path.join(root, 'api-dir')), false, 'с force папка удаляется целиком');
});

test('рекурсивное удаление папки не идёт по символическим ссылкам', () => {
  write('bag/inner.txt', 'своё');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outside-'));
  const keep = path.join(outsideDir, 'keep.txt');
  fs.writeFileSync(keep, 'чужое');
  fs.symlinkSync(outsideDir, path.join(root, 'bag/outside'));

  const removed = removeWorkspaceEntry(root, 'bag', true);
  assert.equal(removed.recursive, true);
  assert.equal(fs.existsSync(path.join(root, 'bag')), false, 'папка удалена');
  assert.ok(fs.existsSync(keep), 'файл за ссылкой цел');
});

test('корневой AGENTS.md не удаляется, вложенный — можно', () => {
  assert.throws(
    () => removeWorkspaceEntry(root, 'AGENTS.md'),
    (error: unknown) => error instanceof FilesError && error.status === 403,
    'корневой AGENTS.md защищён',
  );
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')), 'инструкции workspace на месте');

  removeWorkspaceEntry(root, 'projects/AGENTS.md');
  assert.equal(fs.existsSync(path.join(root, 'projects/AGENTS.md')), false, 'вложенный AGENTS.md удаляется');
});
