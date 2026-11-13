// Generic folder-guard: folder permissions for the agent's file tools.
//
// We check not only artifacts but the layer itself: any root with .folder-acl.json
// behaves the same, and bash on a protected path is closed so read/write cannot be bypassed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FOLDER_ACL_FILE, folderVerdict, readFolderAcl } from '../../extensions/lib/folder-access.ts';
import { guardToolCall } from '../../extensions/folder-guard.ts';

function sandbox(acl: { owner: string; me: string; family: string } | null, files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-guard-'));
  const dir = path.join(root, 'plan');
  fs.mkdirSync(dir, { recursive: true });
  if (acl) {
    fs.writeFileSync(path.join(dir, FOLDER_ACL_FILE), JSON.stringify({
      version: 1,
      owner: acl.owner,
      acl: { me: acl.me, family: acl.family },
    }));
  }
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('readFolderAcl reads the owner and levels; it rejects garbage', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' });
  const acl = readFolderAcl(path.join(root, 'plan'));
  assert.deepEqual(acl?.acl, { me: 'admin', family: 'read' });
  assert.equal(acl?.owner, 'probe');

  const broken = sandbox(null);
  fs.mkdirSync(path.join(broken, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'plan', FOLDER_ACL_FILE), '{"owner":"","acl":{}}');
  assert.equal(readFolderAcl(path.join(broken, 'plan')), null);
});

test('the owner reads and writes, family read only reads', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' }, { 'index.md': '# План' });
  const dir = path.join(root, 'plan');
  const file = path.join(dir, 'index.md');

  const ownerRead = folderVerdict(file, 'probe', 'read', [root]);
  assert.equal(ownerRead.protected, true);
  assert.equal(ownerRead.rootOnly, false);
  if (!ownerRead.protected || ownerRead.rootOnly) return;
  assert.equal(ownerRead.allowed, true);

  const familyWrite = folderVerdict(file, 'probe2', 'write', [root]);
  assert.equal(familyWrite.protected, true);
  if (!familyWrite.protected || familyWrite.rootOnly) return;
  assert.equal(familyWrite.allowed, false);
  assert.match(familyWrite.reason ?? '', /Нет права писать/);

  const familyRead = folderVerdict(file, 'probe2', 'read', [root]);
  if (!familyRead.protected || familyRead.rootOnly) return;
  assert.equal(familyRead.allowed, true);
});

test('family none: neither read nor write, the artifact is private', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'none' }, { 'index.md': '# Секрет' });
  const dir = path.join(root, 'plan');
  const acl = readFolderAcl(dir);
  assert.deepEqual(acl?.acl, { me: 'admin', family: 'none' });

  const read = folderVerdict(path.join(dir, 'index.md'), 'probe2', 'read', [root]);
  assert.equal(read.protected, true);
  if (!read.protected || read.rootOnly) return;
  assert.equal(read.allowed, false);
  assert.equal(read.level, 'none');
  assert.match(read.reason ?? '', /нет доступа/);

  const write = folderVerdict(path.join(dir, 'index.md'), 'probe2', 'write', [root]);
  if (!write.protected || write.rootOnly) return;
  assert.equal(write.allowed, false);

  const owner = folderVerdict(path.join(dir, 'index.md'), 'probe', 'write', [root]);
  if (!owner.protected || owner.rootOnly) return;
  assert.equal(owner.allowed, true);
});

test('a folder without ACL is closed: a new artifact only via artifact_new', () => {
  const root = sandbox(null, { 'index.md': '# Без прав' });
  const verdict = folderVerdict(path.join(root, 'plan', 'index.md'), 'probe', 'read', [root]);
  assert.equal(verdict.protected, true);
  if (!verdict.protected || verdict.rootOnly) return;
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /artifact_new/);
});

test('the root of a protected store is only a list of names', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' });
  const verdict = folderVerdict(root, 'probe', 'read', [root]);
  assert.deepEqual(verdict, { protected: true, rootOnly: true, root });
});

test('a symlink from an allowed folder outward does not bypass permissions', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' }, { 'index.md': '# План' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-guard-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'секрет');
  fs.symlinkSync(outside, path.join(root, 'plan', 'link'));
  const verdict = folderVerdict(path.join(root, 'plan', 'link', 'secret.txt'), 'probe', 'read', [root]);
  assert.equal(verdict.protected, true);
  if (!verdict.protected || verdict.rootOnly) return;
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /Симлинк/);
});

test('a symlink from the workspace into /artifacts also checks the ACL', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' }, { 'index.md': '# План' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-guard-workspace-'));
  fs.symlinkSync(path.join(root, 'plan'), path.join(outside, 'jump'));
  const read = folderVerdict(path.join(outside, 'jump', 'index.md'), 'probe2', 'read', [root]);
  assert.equal(read.protected, true);
  if (!read.protected || read.rootOnly) return;
  assert.equal(read.allowed, true);
  const write = folderVerdict(path.join(outside, 'jump', 'index.md'), 'probe2', 'write', [root]);
  assert.equal(write.protected, true);
  if (!write.protected || write.rootOnly) return;
  assert.equal(write.allowed, false);
});

test('guardToolCall: read/edit allowed by ACL, write blocked', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' }, { 'index.md': '# План' });
  const options = { viewer: 'probe2', roots: [root] };
  assert.equal(guardToolCall('read', { path: path.join(root, 'plan', 'index.md') }, options), undefined);
  assert.match(guardToolCall('write', { path: path.join(root, 'plan', 'index.md') }, { viewer: 'probe2', roots: [root] })?.reason ?? '', /Нет права писать/);
  assert.equal(guardToolCall('write', { path: path.join(root, 'plan', 'index.md') }, { viewer: 'probe', roots: [root] }), undefined);
});

test('guardToolCall: .git and service files of an artifact are closed', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' });
  const options = { viewer: 'probe', roots: [root] };
  assert.match(guardToolCall('read', { path: path.join(root, 'plan', '.git', 'config') }, options)?.reason ?? '', /История версий/);
  assert.match(guardToolCall('write', { path: path.join(root, 'plan', '.git', 'config') }, options)?.reason ?? '', /История версий/);
  assert.match(guardToolCall('write', { path: path.join(root, 'plan', '.folder-acl.json') }, options)?.reason ?? '', /Права и ссылка/);
  assert.match(guardToolCall('write', { path: path.join(root, 'plan', '.artifact.json') }, options)?.reason ?? '', /Права и ссылка/);
  assert.equal(
    guardToolCall('read', { path: '/workspaces/talk/.git/config' }, options),
    undefined,
    'обычный git в workspace страж не трогает',
  );
});

test('guardToolCall: ls of the root is allowed, ls of a folder without ACL is not; bash on /artifacts is closed', () => {
  const root = sandbox({ owner: 'probe', me: 'admin', family: 'read' });
  assert.equal(guardToolCall('ls', { path: root }, { viewer: 'probe2', roots: [root] }), undefined);
  assert.match(guardToolCall('grep', { path: root }, { viewer: 'probe2', roots: [root] })?.reason ?? '', /Уточни артефакт/);
  assert.match(
    guardToolCall('bash', { command: `cat ${path.join(root, 'plan', 'index.md')}` }, { viewer: 'probe', roots: [root] })?.reason ?? '',
    /только через read\/write\/edit/,
  );
  assert.equal(guardToolCall('read', { path: '/workspaces/talk/file.md' }, { viewer: 'probe2', roots: [root] }), undefined);
});
