// pi auto-commits: the extension, not the model, records artifact changes.
//
// We exercise the real tool_call/tool_result/turn_end hooks with a fake pi: before
// a write an "as it was" snapshot appears, after it a commit, and turn_end picks up
// changes that did not come through write/edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactHistory } from '../src/artifacts-git.ts';

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

async function loadExtension(root: string, viewer = 'probe') {
  process.env.ICARUS_ARTIFACTS_DIR = root;
  process.env.ICARUS_USER_ID = viewer;
  const module = await import(`../../extensions/artifact-git.ts?test=${Date.now()}-${Math.random()}`);
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  module.default(pi as never);
  return handlers;
}

function seed(root: string, slug = 'plan'): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.md'), '# Как было\n');
  fs.writeFileSync(path.join(dir, 'index.ai.md'), '# Как было\n');
  fs.writeFileSync(
    path.join(dir, '.folder-acl.json'),
    JSON.stringify({ version: 1, owner: 'probe', acl: { me: 'admin', family: 'read' } }),
  );
  return dir;
}

test('write: snapshot before, commit after; turn_end picks up the rest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-git-ext-'));
  const dir = seed(root);
  const handlers = await loadExtension(root);
  const ctx = { signal: undefined };

  const file = path.join(dir, 'index.md');
  await handlers.get('tool_call')!({ toolName: 'write', input: { path: file } }, ctx);
  fs.writeFileSync(file, '# После\n');
  await handlers.get('tool_result')!({ toolName: 'write', input: { path: file }, isError: false }, ctx);

  let history = await artifactHistory(dir);
  assert.deepEqual(history.map((item) => item.subject), ['artifact: write index.md', 'artifact: snapshot before change']);
  assert.equal(fs.readFileSync(file, 'utf8'), '# После\n');

  // As if MCP or bash put the file there: turn_end must record it.
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'добор\n');
  await handlers.get('turn_end')!({}, ctx);
  history = await artifactHistory(dir);
  assert.equal(history[0]!.subject, 'artifact: update');
  assert.equal(fs.readFileSync(path.join(dir, 'extra.txt'), 'utf8'), 'добор\n');
});

test('a tool error does not create a commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-git-ext-'));
  const dir = seed(root);
  const handlers = await loadExtension(root);
  await handlers.get('tool_call')!({ toolName: 'write', input: { path: path.join(dir, 'index.md') } }, { signal: undefined });
  const before = (await artifactHistory(dir)).length;
  await handlers.get('tool_result')!(
    { toolName: 'write', input: { path: path.join(dir, 'index.md') }, isError: true },
    { signal: undefined },
  );
  assert.equal((await artifactHistory(dir)).length, before, 'снимок до записи остаётся, нового коммита нет');
});

test('artifact_new initializes .git in a new folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-git-ext-'));
  const dir = seed(root, 'new-one');
  const handlers = await loadExtension(root);
  await handlers.get('tool_result')!(
    { toolName: 'mcp_artifacts_artifact_new', input: { name: 'new-one' }, isError: false },
    { signal: undefined },
  );
  assert.equal(fs.existsSync(path.join(dir, '.git')), true);
});

test('an alien family read does not commit and does not touch .git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-git-ext-'));
  const dir = seed(root);
  fs.writeFileSync(
    path.join(dir, '.folder-acl.json'),
    JSON.stringify({ version: 1, owner: 'probe', acl: { me: 'admin', family: 'read' } }),
  );
  const handlers = await loadExtension(root, 'probe2');
  fs.writeFileSync(path.join(dir, 'index.md'), '# Чужая правка\n');
  await handlers.get('turn_end')!({}, { signal: undefined });
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'index.md'), 'utf8'), '# Чужая правка\n');
});
