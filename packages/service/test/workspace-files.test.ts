// Working folder files for the chat's right panel: tree, preview and file serving.
//
// The main thing checked here is security. The panel looks into only one
// workspace: `..`, an absolute path and a symlink pointing outside must not
// expose either a foreign folder or the whole host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { ensureWorkspaces } from '../src/workspaces.ts';
import {
  FilesError,
  SEARCH_MIN_QUERY,
  handleWorkspaceFilesApi,
  isImageName,
  listWorkspaceEntries,
  previewWorkspaceFile,
  rawWorkspaceFile,
  removeWorkspaceEntry,
  searchWorkspaceFiles,
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

test('tree: files before folders, types are labeled, service junk is hidden', () => {
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

test('type labels and images are recognized by extension', () => {
  assert.equal(typeLabelOf('AGENTS.md'), 'MARKDOWN');
  assert.equal(typeLabelOf('plan.txt'), 'TEXT');
  assert.equal(typeLabelOf('contacts.svg'), 'SVG');
  assert.equal(typeLabelOf('data.json'), 'JSON');
  assert.equal(typeLabelOf('README'), 'FILE');
  assert.equal(isImageName('a.PNG'), true);
  assert.equal(isImageName('a.md'), false);
});

test('a path does not escape the workspace: .. and absolute addresses are cut off', () => {
  assert.throws(() => listWorkspaceEntries(root, '..'), FilesError);
  assert.throws(() => listWorkspaceEntries(root, '../private'), FilesError);
  assert.throws(() => listWorkspaceEntries(root, '/etc'), FilesError);
  assert.throws(() => previewWorkspaceFile(root, 'talk', '../private/AGENTS.md'), FilesError);
  assert.equal(rawWorkspaceFile(root, '../private/AGENTS.md'), null);
});

test('a symlink pointing outside is not exposed', () => {
  const link = path.join(root, 'escape');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outside-'));
  if (!fs.existsSync(link)) fs.symlinkSync(outside, link);

  // The link itself does not appear in the tree, and one cannot pass through it.
  assert.ok(!listWorkspaceEntries(root).entries.some((entry) => entry.name === 'escape'));
  assert.throws(() => listWorkspaceEntries(root, 'escape'), FilesError);
  assert.equal(rawWorkspaceFile(root, 'escape/passwd'), null);
});

test('markdown and text as a string, an image as an address', () => {
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

test('a binary file is honestly called binary, large text is truncated', () => {
  write('blob.bin', Buffer.from([0, 1, 2, 3, 4]));
  assert.equal(previewWorkspaceFile(root, 'talk', 'blob.bin').kind, 'binary');

  write('big.txt', 'a'.repeat(256 * 1024 + 5));
  const big = previewWorkspaceFile(root, 'talk', 'big.txt');
  assert.equal(big.kind, 'text');
  assert.equal(big.truncated, true);
  assert.equal((big.text ?? '').length, 256 * 1024, 'показано ровно 256 КБ');
});

test('file serving: an image goes as an image, the rest as a file', () => {
  const image = rawWorkspaceFile(root, 'projects/contacts.svg');
  assert.equal(image?.type, 'image/svg+xml');
  assert.equal(image?.name, 'contacts.svg');
  assert.equal(rawWorkspaceFile(root, 'projects/plan.txt')?.type, 'application/octet-stream');
  assert.equal(rawWorkspaceFile(root, 'projects/missing.txt'), null);
});

test('the workspace is taken from the registry, and an unknown slug does not open', () => {
  assert.equal(workspaceTarget(config, user, 'nope'), null);
  const target = workspaceTarget(config, user, 'talk');
  assert.equal(target?.workspace.name, 'Разговор');
  assert.equal(target?.workspace.slug, 'talk');
  assert.ok((target?.workspace.path ?? '').endsWith('workspaces/talk'), 'в шапке видно папку на диске');
});

/** A collector for the response: JSON routes are fine with status, headers and body. */
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

test('the API responds with the tree and preview, a foreign workspace is 404', async () => {
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

test('the API does not allow writing: the panel only views files', async () => {
  const res = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'POST' } as never,
    res as never,
    new URL('http://panel/panel/api/workspace-files?workspace=talk'),
    { config, userId: user.id },
  );
  assert.equal(res.status, 405);
});

test('deletion: a file is deleted, an empty folder right away, a non-empty one only with force', () => {
  write('trash/file.txt', 'мусор');
  write('trash/nested/deep.txt', 'тоже мусор');
  fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });

  removeWorkspaceEntry(root, 'trash/file.txt');
  assert.equal(fs.existsSync(path.join(root, 'trash/file.txt')), false, 'файл удалён');

  // The server does not touch a non-empty folder without confirmation.
  assert.throws(
    () => removeWorkspaceEntry(root, 'trash'),
    (error: unknown) => error instanceof FilesError && error.status === 409,
    'непустая папка требует force',
  );
  assert.ok(fs.existsSync(path.join(root, 'trash/nested/deep.txt')), 'содержимое на месте');

  // An empty folder is deleted by the same request, without confirmation.
  removeWorkspaceEntry(root, 'empty-dir');
  assert.equal(fs.existsSync(path.join(root, 'empty-dir')), false, 'пустая папка удалена');

  const removed = removeWorkspaceEntry(root, 'trash', true);
  assert.equal(removed.dir, true);
  assert.equal(removed.recursive, true);
  assert.equal(fs.existsSync(path.join(root, 'trash')), false, 'непустая папка удалена с содержимым');
});

test('deletion does not escape the workspace and does not touch the root', () => {
  assert.throws(() => removeWorkspaceEntry(root, ''), FilesError, 'корень workspace не удаляем');
  assert.throws(() => removeWorkspaceEntry(root, '.'), FilesError);
  assert.throws(() => removeWorkspaceEntry(root, '../private/AGENTS.md'), FilesError);
  assert.throws(() => removeWorkspaceEntry(root, '/etc/passwd'), FilesError);
});

test('a symlink cannot be deleted: there is a foreign file behind it', () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outside-')), 'keep.txt');
  fs.writeFileSync(outside, 'не трогать');
  const link = path.join(root, 'escape-file');
  if (!fs.existsSync(link)) fs.symlinkSync(outside, link);

  assert.throws(() => removeWorkspaceEntry(root, 'escape-file'), FilesError);
  assert.ok(fs.existsSync(outside), 'файл за ссылкой цел');
});

test('the API deletes a file and folders: an empty one right away, a non-empty one after force', async () => {
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

test('recursive folder deletion does not follow symlinks', () => {
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

test('the root AGENTS.md is not deleted, a nested one can be', () => {
  assert.throws(
    () => removeWorkspaceEntry(root, 'AGENTS.md'),
    (error: unknown) => error instanceof FilesError && error.status === 403,
    'корневой AGENTS.md защищён',
  );
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')), 'инструкции workspace на месте');

  removeWorkspaceEntry(root, 'projects/AGENTS.md');
  assert.equal(fs.existsSync(path.join(root, 'projects/AGENTS.md')), false, 'вложенный AGENTS.md удаляется');
});

test('search: finds text in nested files and the file name, skips junk', () => {
  write('search/code.ts', 'const secret = "needle";\n// и ещё needle в комментарии\n');
  write('search/notes.md', 'Одна строка\nЗдесь тоже Needle — регистр не важен.\n');
  write('search/needle-file.txt', 'ничего интересного');
  // A binary file: needles lie in it, but it is not shown as text.
  write('search/blob.bin', Buffer.from([0, 1, 2, ...Buffer.from('needle inside binary')]));
  write('.git/needle.txt', 'needle');
  write('node_modules/needle/index.js', 'needle');

  const result = searchWorkspaceFiles(root, 'needle');
  assert.equal(result.query, 'needle');
  assert.ok(result.scanned > 0, 'поиск действительно обошёл файлы');

  const marks = result.hits.map((hit) => hit.file.path + ':' + hit.line);
  assert.ok(marks.includes('search/code.ts:1'), 'строка в коде найдена');
  assert.ok(marks.includes('search/code.ts:2'), 'комментарий тоже ищется');
  assert.ok(marks.includes('search/notes.md:2'), 'регистр не мешает');
  assert.ok(marks.includes('search/needle-file.txt:0'), 'имя файла — тоже совпадение');
  assert.ok(!marks.some((mark) => mark.startsWith('.git/')), 'служебный git не сканируется');
  assert.ok(!marks.some((mark) => mark.startsWith('node_modules/')), 'зависимости не сканируются');
  assert.ok(
    !marks.some((mark) => mark.startsWith('search/blob.bin')),
    'содержимое двоичного файла не читается',
  );

  const hit = result.hits.find((item) => item.file.path === 'search/code.ts' && item.line === 1);
  assert.ok(hit?.match, 'панель знает, что подсветить в куске');
  assert.equal(hit?.text.slice(hit.match.start, hit.match.start + hit.match.length), 'needle');
  assert.equal(hit?.file.type, 'TS');
});

test('search: a symlink pointing outside does not open foreign files', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle в чужой папке');
  const link = path.join(root, 'search/outside');
  if (!fs.existsSync(link)) fs.symlinkSync(outside, link);

  const result = searchWorkspaceFiles(root, 'needle');
  assert.ok(
    !result.hits.some((hit) => hit.file.path.includes('outside')),
    'через ссылку поиск не выходит за workspace',
  );
});

test('search requires at least two characters and does not accept an infinite query', () => {
  assert.equal(SEARCH_MIN_QUERY, 2);
  assert.throws(
    () => searchWorkspaceFiles(root, 'n'),
    (error: unknown) => error instanceof FilesError && error.status === 400,
  );
  assert.throws(() => searchWorkspaceFiles(root, '   '), FilesError);
  assert.throws(() => searchWorkspaceFiles(root, 'x'.repeat(201)), FilesError);
});

test('search: a large file is checked by name only, its content is not read', () => {
  write('search/needle-huge.txt', 'x'.repeat(1024 * 1024 + 10));
  const result = searchWorkspaceFiles(root, 'needle');
  const huge = result.hits.filter((hit) => hit.file.path === 'search/needle-huge.txt');
  assert.deepEqual(huge.map((hit) => hit.line), [0], 'у огромного файла остаётся только совпадение по имени');
});

test('the API searches the workspace and returns the line, snippet and match position', async () => {
  const res = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'GET' } as never,
    res as never,
    new URL('http://panel/panel/api/workspace-files/search?workspace=talk&q=needle'),
    { config, userId: user.id },
  );
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.text) as {
    query: string;
    scanned: number;
    hits: { file: { path: string }; line: number; text: string; match: { start: number; length: number } }[];
  };
  assert.equal(payload.query, 'needle');
  assert.ok(payload.scanned > 0);
  assert.ok(payload.hits.some((hit) => hit.file.path === 'search/code.ts' && hit.line === 1));

  const short = fakeResponse();
  await handleWorkspaceFilesApi(
    { method: 'GET' } as never,
    short as never,
    new URL('http://panel/panel/api/workspace-files/search?workspace=talk&q=n'),
    { config, userId: user.id },
  );
  assert.equal(short.status, 400, 'один символ — не запрос');
});

test('search honestly says it hit the ceiling', () => {
  for (let index = 0; index < 60; index += 1) write('many/f' + index + '.txt', 'needle');
  const result = searchWorkspaceFiles(root, 'needle');
  assert.equal(result.hits.length, 50, 'больше потолка не отдаём');
  assert.equal(result.truncated, true, 'и не делаем вид, что это всё');
});
