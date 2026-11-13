// Artifacts core: global folder, ACL, public link and migration.
//
// An artifact is shared with the family, so the test looks at it through the eyes
// of different people: the owner, "family" with none/read/write/admin, and an
// outsider without ACL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACL_FILE,
  DEFAULT_ACL,
  META_FILE,
  accessFor,
  allows,
  artifactFile,
  artifactUrls,
  artifactsRoot,
  inspectArtifact,
  listArtifacts,
  migrateLegacyArtifacts,
  publicArtifact,
  readArtifact,
  setAcl,
  trashArtifact,
  writeAcl,
} from '../src/artifacts.ts';
import { userPaths } from '../src/config.ts';
import { makeConfig, probe } from './fixtures.ts';

const config = (overrides: Partial<ReturnType<typeof makeConfig>> = {}) => makeConfig({ users: [probe('probe'), probe('probe2')], ...overrides });
const root = (box: ReturnType<typeof makeConfig>) => artifactsRoot(box);
const dirOf = (box: ReturnType<typeof makeConfig>, slug: string) => path.join(root(box), slug);

function seed(dir: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function artifact(box: ReturnType<typeof makeConfig>, slug: string, files: Record<string, string | Buffer>, acl = DEFAULT_ACL, owner = 'probe'): string {
  const dir = dirOf(box, slug);
  seed(dir, files);
  writeAcl(dir, owner, acl);
  return dir;
}

test('artifacts are a global folder with an index file; the type is determined by it', () => {
  const box = config();
  artifact(box, 'plan', {
    'index.md': '# План на четверг\n\n1. Стендап\n',
    'index.ai.md': '# План на четверг\n\nРасписание дня: стендап, демо, ревью.\n',
  });
  artifact(box, 'report', {
    'index.html': '<title>Отчёт</title><h1>Атлас</h1>',
    'index.ai.md': '# Отчёт по «Атласу»\n\nГотовность 87%.\n',
  });
  artifact(box, 'gift', {
    'index.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'index.ai.md': '# Идеи подарка\n\nТри идеи для Анны.\n',
  });
  // A folder without ACL or index is not an artifact.
  seed(dirOf(box, 'draft'), { 'index.md': '# без прав', 'index.ai.md': '# без прав' });
  seed(dirOf(box, 'empty'), { 'notes.txt': 'черновик' });

  const items = listArtifacts(box, 'probe');
  assert.deepEqual(items.map((item) => item.name).sort(), ['gift', 'plan', 'report']);
  const plan = items.find((item) => item.name === 'plan')!;
  assert.equal(plan.type, 'markdown');
  assert.equal(plan.title, 'План на четверг');
  assert.equal(plan.owner, 'probe');
  assert.equal(plan.access, 'admin');
  assert.equal(plan.canManage, true);
  assert.equal(plan.ai, true);
  assert.match(plan.summary, /Расписание дня/);
  assert.match(plan.urls.panel, /\/panel\/artifacts\?artifact=plan/);
  assert.equal(plan.urls.public, undefined);
  assert.equal(items.find((item) => item.name === 'report')!.type, 'html');
  assert.equal(items.find((item) => item.name === 'gift')!.type, 'image');
});

test('ACL: me for the owner, family for everyone else, levels include each other', () => {
  assert.equal(allows('admin', 'write'), true);
  assert.equal(allows('write', 'read'), true);
  assert.equal(allows('read', 'write'), false);
  assert.equal(accessFor('probe', { me: 'admin', family: 'write' }, 'probe'), 'admin');
  assert.equal(accessFor('probe', { me: 'admin', family: 'write' }, 'probe2'), 'write');

  const box = config();
  artifact(box, 'plan', { 'index.md': '# План', 'index.ai.md': '# План' }, { me: 'admin', family: 'read' });
  const family = inspectArtifact(box, 'plan', 'probe2')!;
  assert.equal(family.access, 'read');
  assert.equal(family.canRead, true);
  assert.equal(family.canWrite, false);
  assert.equal(family.canManage, false);

  const owner = inspectArtifact(box, 'plan', 'probe')!;
  assert.equal(owner.access, 'admin');
  assert.equal(owner.canManage, true);
});

test('none: the artifact does not exist for the family, but stays available to the owner', () => {
  assert.deepEqual(DEFAULT_ACL, { me: 'admin', family: 'none' }, 'по умолчанию артефакт личный');
  assert.equal(allows('none', 'read'), false);
  assert.equal(allows('none', 'write'), false);
  assert.equal(allows('read', 'none'), true, 'read включает none');

  const box = config();
  artifact(box, 'diary', { 'index.md': '# Дневник', 'index.ai.md': '# Дневник' }, { me: 'admin', family: 'none' });
  const owner = inspectArtifact(box, 'diary', 'probe')!;
  assert.equal(owner.access, 'admin');
  assert.equal(owner.canRead, true);
  assert.deepEqual(listArtifacts(box, 'probe').map((item) => item.name), ['diary']);

  const family = inspectArtifact(box, 'diary', 'probe2')!;
  assert.equal(family.access, 'none');
  assert.equal(family.canRead, false);
  assert.equal(family.canWrite, false);
  assert.equal(family.canManage, false);
  assert.deepEqual(listArtifacts(box, 'probe2'), []);
  assert.throws(() => readArtifact(box, 'probe2', 'diary'), /нет права читать/);
  assert.equal(artifactFile(box, 'probe2', 'diary', 'index.md'), null);

  // The owner can open access later, but cannot set none for themselves.
  const shared = setAcl(box, 'probe', 'diary', { me: 'admin', family: 'read' });
  assert.deepEqual(shared.acl, { me: 'admin', family: 'read' });
  assert.equal(inspectArtifact(box, 'diary', 'probe2')!.canRead, true);
  assert.throws(() => setAcl(box, 'probe', 'diary', { me: 'none', family: 'read' }), /владельцу нельзя/);
});

test('family none does not prevent a public link: it is opened deliberately', () => {
  const box = config({ url: 'https://icarus.example' });
  artifact(box, 'secret', { 'index.md': '# Секрет', 'index.ai.md': '# Секрет' }, { me: 'admin', family: 'none' });
  const id = 'abcdefghijklmnopqrstuvwx';
  fs.writeFileSync(path.join(dirOf(box, 'secret'), META_FILE), JSON.stringify({ version: 1, publicId: id }));
  assert.equal(publicArtifact(box, 'secret', id)?.artifact.name, 'secret');
});

test('write grants read and write, but not management; admin grants management', () => {
  const box = config();
  artifact(box, 'plan', { 'index.md': '# План', 'index.ai.md': '# План' }, { me: 'admin', family: 'write' });
  const writer = inspectArtifact(box, 'plan', 'probe2')!;
  assert.equal(writer.canRead, true);
  assert.equal(writer.canWrite, true);
  assert.equal(writer.canManage, false);
  assert.equal(artifactFile(box, 'probe2', 'plan', 'index.md')?.type, 'text/markdown; charset=utf-8');
  assert.throws(() => setAcl(box, 'probe2', 'plan', { me: 'admin', family: 'admin' }), /владелец или админ/);

  artifact(box, 'team', { 'index.md': '# Team', 'index.ai.md': '# Team' }, { me: 'admin', family: 'admin' });
  const admin = inspectArtifact(box, 'team', 'probe2')!;
  assert.equal(admin.canManage, true);
  const changed = setAcl(box, 'probe2', 'team', { me: 'read', family: 'write' });
  assert.deepEqual(changed.acl, { me: 'read', family: 'write' });
});

test('the owner always manages their artifact, even if me=read', () => {
  const box = config();
  artifact(box, 'frozen', { 'index.md': '# Заморожен', 'index.ai.md': '# Заморожен' }, { me: 'read', family: 'read' });
  const owner = inspectArtifact(box, 'frozen', 'probe')!;
  assert.equal(owner.access, 'read');
  assert.equal(owner.canRead, true);
  assert.equal(owner.canManage, true);
  const changed = setAcl(box, 'probe', 'frozen', { me: 'admin', family: 'read' });
  assert.equal(changed.acl.me, 'admin');
});

test('an artifact without ACL does not exist for the panel and tools', () => {
  const box = config();
  seed(path.join(root(box), 'raw'), { 'index.md': '# Без прав', 'index.ai.md': '# Без прав' });
  assert.equal(inspectArtifact(box, 'raw', 'probe'), null);
  assert.deepEqual(listArtifacts(box, 'probe'), []);
  assert.throws(() => readArtifact(box, 'probe', 'raw'), /не найден/);
});

test('a public link is created only by a manager and can be revoked', () => {
  const box = config();
  artifact(box, 'plan', { 'index.md': '# План', 'index.ai.md': '# План' }, { me: 'admin', family: 'read' });
  assert.throws(() => setAcl(box, 'probe2', 'plan', { me: 'admin', family: 'read' }), /владелец или админ/);

  // The service creates the public link via ensurePublicId, not this test:
  // for a public check it is enough to write the metadata.
  const id = 'abcdefghijklmnopqrstuvwx';
  fs.writeFileSync(path.join(dirOf(box, 'plan'), META_FILE), JSON.stringify({ version: 1, publicId: id }));
  const item = inspectArtifact(box, 'plan', 'probe')!;
  assert.equal(item.publicId, id);
  assert.equal(item.urls.public, `http://localhost:8081/a/plan/${id}/`);
  assert.equal(item.urls.bare, `${item.urls.public}?bare=1`);
  assert.equal(publicArtifact(box, 'plan', id)?.artifact.name, 'plan');
  assert.equal(publicArtifact(box, 'plan', 'x'.repeat(24)), null);
});

test('artifact file: a nested asset is served on read, leaving the folder is not', () => {
  const box = config();
  artifact(box, 'site', {
    'index.html': '<link rel="stylesheet" href="css/style.css">',
    'css/style.css': 'body { color: red }',
    'index.ai.md': '# Сайт\n',
    '.artifact.json': '{"version":1,"publicId":"abcdefghijklmnopqrstuvwx"}',
  }, { me: 'admin', family: 'write' });

  const css = artifactFile(box, 'probe2', 'site', 'css/style.css');
  assert.equal(css?.type, 'text/css; charset=utf-8');
  assert.equal(fs.readFileSync(css!.file, 'utf8'), 'body { color: red }');
  assert.equal(artifactFile(box, 'probe2', 'site', '../secret.txt'), null);
  assert.equal(artifactFile(box, 'probe2', 'site', '/etc/passwd'), null);
  assert.equal(artifactFile(box, 'probe2', '../site', 'index.md'), null);
  assert.equal(artifactFile(box, 'probe2', 'site', 'index.ai.md'), null);
  assert.equal(artifactFile(box, 'probe2', 'site', '.artifact.json'), null);
});

test('deletion goes to trash and only by a manager', () => {
  const box = config();
  artifact(box, 'plan', { 'index.md': '# План', 'index.ai.md': '# План' }, { me: 'admin', family: 'write' });
  assert.throws(() => trashArtifact(box, 'probe2', 'plan'), /владелец или админ/);
  const target = trashArtifact(box, 'probe', 'plan');
  assert.match(target, /artifacts\/\.trash\/plan-/);
  assert.equal(fs.existsSync(dirOf(box, 'plan')), false);
  assert.equal(fs.existsSync(path.join(target, 'index.md')), true);
});

test('the counter and links work without a workspace', () => {
  const box = config({ url: 'https://icarus.example' });
  artifact(box, 'a', { 'index.md': '# A', 'index.ai.md': '# A' });
  artifact(box, 'b', { 'index.png': Buffer.from([0x89, 0x50]), 'index.ai.md': '# B' });
  assert.equal(listArtifacts(box, 'probe').length, 2);
  const urls = artifactUrls(box, 'a', 'index.md');
  assert.equal(urls.panel, 'https://icarus.example/panel/artifacts?artifact=a');
  assert.equal(urls.raw, 'https://icarus.example/panel/artifacts/raw/a/index.md');
});

test('YAML frontmatter in index.ai.md does not become the title and description', () => {
  const box = config();
  artifact(box, 'calc', {
    'index.html': '<h1>Калькулятор</h1>',
    'index.ai.md': '---\nname: "Калькулятор"\ntype: HTML-страница\n---\n\n# Калькулятор\n\nПростой калькулятор с процентами.\n',
  });
  const item = inspectArtifact(box, 'calc', 'probe')!;
  assert.equal(item.title, 'Калькулятор');
  assert.match(item.summary, /Простой калькулятор/);
  assert.doesNotMatch(item.summary, /name:/);
});

test('a folder name with a line break or traversal is not considered an artifact', () => {
  const box = config();
  artifact(box, 'ok', { 'index.md': '# Ok', 'index.ai.md': '# Ok' });
  assert.equal(inspectArtifact(box, '..', 'probe'), null);
  assert.equal(inspectArtifact(box, '.hidden', 'probe'), null);
  assert.equal(inspectArtifact(box, 'a/b', 'probe'), null);
  assert.equal(inspectArtifact(box, 'line\nbreak', 'probe'), null);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-outside-'));
  fs.writeFileSync(path.join(outside, 'index.md'), '# Чужое');
  fs.writeFileSync(path.join(outside, 'index.ai.md'), '# Чужое');
  fs.writeFileSync(path.join(outside, ACL_FILE), JSON.stringify({ owner: 'probe', acl: DEFAULT_ACL }));
  fs.symlinkSync(outside, path.join(root(box), 'link'));
  assert.equal(inspectArtifact(box, 'link', 'probe'), null);
});

test('old artifacts from a workspace move to the shared library', () => {
  const box = config();
  const old = path.join(userPaths(box, probe('probe')).workspaces, 'talk', 'artifacts', 'plan');
  seed(old, {
    'index.md': '# План',
    'index.ai.md': '# План',
    '.artifact.json': '{"version":1,"publicId":"abcdefghijklmnopqrstuvwx"}',
  });
  const moved = migrateLegacyArtifacts(box, probe('probe'));
  assert.deepEqual(moved, ['plan']);
  assert.equal(fs.existsSync(old), false);
  const item = inspectArtifact(box, 'plan', 'probe')!;
  assert.equal(item.owner, 'probe');
  assert.deepEqual(item.acl, DEFAULT_ACL);
  assert.equal(item.publicId, 'abcdefghijklmnopqrstuvwx');
});
