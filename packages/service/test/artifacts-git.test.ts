// Artifact version history: a small git repository per folder.
//
// We check not "git in general" but the promise to the person: any change can
// be reverted, and rights and the public link do not change on rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  artifactHistory,
  artifactVersion,
  artifactVersionFile,
  commitArtifact,
  ensureArtifactRepo,
  ensureArtifactRepos,
  restoreArtifact,
} from '../src/artifacts-git.ts';
import { DEFAULT_ACL, artifactsRoot, writeAcl } from '../src/artifacts.ts';
import { makeConfig, probe } from './fixtures.ts';

function artifact(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-git-test-'));
  fs.writeFileSync(path.join(dir, 'index.md'), '# Первая версия\n');
  fs.writeFileSync(path.join(dir, 'index.ai.md'), '# Первая версия\n');
  fs.writeFileSync(path.join(dir, '.folder-acl.json'), JSON.stringify({ owner: 'probe', acl: DEFAULT_ACL }));
  fs.writeFileSync(path.join(dir, '.artifact.json'), JSON.stringify({ publicId: 'abcdefghijklmnopqrstuvwx' }));
  return dir;
}

test('snapshot, change and return to the first version', async () => {
  const dir = artifact();
  await ensureArtifactRepo(dir);
  assert.equal(await commitArtifact(dir, 'artifact: initial version'), true);
  assert.equal(await commitArtifact(dir, 'artifact: initial version'), false, 'без изменений коммита нет');

  const initial = (await artifactHistory(dir))[0]!;
  assert.equal(initial.subject, 'artifact: initial version');

  fs.writeFileSync(path.join(dir, 'index.md'), '# Вторая версия\n');
  fs.writeFileSync(path.join(dir, 'second.md'), 'лишний файл\n');
  assert.equal(await commitArtifact(dir, 'artifact: write index.md'), true);

  const before = await artifactHistory(dir);
  assert.equal(before.length, 2);
  assert.equal(before[0]!.subject, 'artifact: write index.md');

  const result = await restoreArtifact(dir, initial.hash);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'index.md'), 'utf8'), '# Первая версия\n');
  assert.equal(fs.existsSync(path.join(dir, 'second.md')), false, 'файл, добавленный позже, убран');
  assert.equal(await commitArtifact(dir, 'artifact: initial version'), false, 'рабочая папка чистая');
});

test('service files are not versioned: rollback does not change rights and the link', async () => {
  const dir = artifact();
  await ensureArtifactRepo(dir);
  await commitArtifact(dir, 'artifact: initial version');
  const list = await new Promise<string>((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      execFile('git', ['-C', dir, 'ls-files'], (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    });
  });
  assert.doesNotMatch(list, /folder-acl/);
  assert.doesNotMatch(list, /artifact\.json/);

  fs.writeFileSync(path.join(dir, '.folder-acl.json'), JSON.stringify({ owner: 'probe', acl: { me: 'read', family: 'read' } }));
  fs.writeFileSync(path.join(dir, 'index.md'), '# Другая\n');
  await commitArtifact(dir, 'artifact: write index.md');
  const history = await artifactHistory(dir);
  const initial = history.find((commit) => commit.subject === 'artifact: initial version')!;
  await restoreArtifact(dir, initial.hash);

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.folder-acl.json'), 'utf8')).acl.me, 'read');
  assert.equal(fs.existsSync(path.join(dir, '.artifact.json')), true);
});

test('nonexistent version and garbage hash are not rolled back', async () => {
  const dir = artifact();
  await ensureArtifactRepo(dir);
  await commitArtifact(dir, 'artifact: initial version');
  await assert.rejects(() => restoreArtifact(dir, 'deadbeef'), /такой версии нет/);
  await assert.rejects(() => restoreArtifact(dir, 'не-хеш'), /не похоже/);
});

test('initialization of all artifacts: initial commit for existing ones', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const dir = path.join(artifactsRoot(config), 'plan');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.md'), '# План\n');
  fs.writeFileSync(path.join(dir, 'index.ai.md'), '# План\n');
  writeAcl(dir, 'probe', DEFAULT_ACL);

  const initialized = await ensureArtifactRepos(config);
  assert.equal(initialized, 1);
  const history = await artifactHistory(dir);
  assert.equal(history[0]!.subject, 'artifact: initial version');
  assert.equal(await ensureArtifactRepos(config), 0, 'повторный запуск не плодит коммиты');
});


test('version preview reads content and assets without changing files', async () => {
  const dir = artifact();
  await ensureArtifactRepo(dir);
  await commitArtifact(dir, 'artifact: initial version');
  const initial = (await artifactHistory(dir))[0]!;
  fs.writeFileSync(path.join(dir, 'index.md'), '# Вторая версия\n');
  await commitArtifact(dir, 'artifact: write index.md');

  const config = makeConfig({ url: 'https://icarus.example' });
  const version = await artifactVersion(config, dir, initial.hash);
  assert.equal(version.artifact.title, 'Первая версия');
  assert.equal(version.artifact.type, 'markdown');
  assert.equal(version.artifact.entry, 'index.md');
  assert.match(version.content ?? '', /Первая версия/);
  assert.match(version.aiContent ?? '', /Первая версия/);
  assert.match(version.artifact.urls.raw, new RegExp(`/panel/artifacts/version/[^/]+/${initial.hash}/index.md$`));
  assert.equal(version.artifact.files.some((file) => file.startsWith('.')), false);
  assert.equal(version.commit.hash, initial.hash);

  const text = await artifactVersionFile(dir, initial.hash, 'index.md');
  assert.equal(text.type, 'text/markdown; charset=utf-8');
  assert.match(text.content.toString('utf8'), /Первая версия/);
  assert.equal(fs.readFileSync(path.join(dir, 'index.md'), 'utf8'), '# Вторая версия\n', 'просмотр не меняет файл');

  await assert.rejects(() => artifactVersionFile(dir, initial.hash, '../secret'), /недоступен/);
  await assert.rejects(() => artifactVersionFile(dir, initial.hash, '.git/config'), /недоступен/);
  await assert.rejects(() => artifactVersionFile(dir, initial.hash, 'index.ai.md'), /недоступен/);
});
