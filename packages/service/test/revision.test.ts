// Service code fingerprint: compose uses it to tell that the sources in the bind-mount changed,
// and recreates the container. Without it the deploy is green but old code from node memory runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceRevision } from '../src/docker/revision.ts';

const ENTRIES = ['packages/service/src', 'packages/extensions', 'package.json'];

/** Lays out files in a temporary "repository" and returns its root. */
function sandbox(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-rev-'));
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test('the fingerprint is deterministic: same code — same fingerprint', () => {
  const files = { 'packages/service/src/index.ts': 'код', 'package.json': '{}' };
  const first = sourceRevision(sandbox(files), ENTRIES);
  const second = sourceRevision(sandbox(files), ENTRIES);

  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, second);
});

test('editing a byte in the code changes the fingerprint', () => {
  const before = sourceRevision(sandbox({ 'packages/service/src/index.ts': 'const a = 1;' }), ENTRIES);
  const after = sourceRevision(sandbox({ 'packages/service/src/index.ts': 'const a = 2;' }), ENTRIES);

  assert.notEqual(before, after, 'смена кода должна пересоздавать контейнер');
});

test('a new file and deleting a file change the fingerprint', () => {
  const root = sandbox({ 'packages/service/src/index.ts': 'код' });
  const base = sourceRevision(root, ENTRIES);

  write(root, { 'packages/service/src/new.ts': 'ещё код' });
  const added = sourceRevision(root, ENTRIES);
  assert.notEqual(added, base);

  fs.rmSync(path.join(root, 'packages/service/src/new.ts'));
  assert.equal(sourceRevision(root, ENTRIES), base, 'вернули файл — вернулся отпечаток');
});

test('extensions are part of the fingerprint: editing them also recreates the service', () => {
  const base = sourceRevision(sandbox({ 'packages/extensions/control-panel.ts': 'версия 1' }), ENTRIES);
  const changed = sourceRevision(sandbox({ 'packages/extensions/control-panel.ts': 'версия 2' }), ENTRIES);

  assert.notEqual(base, changed, 'расширения копируются людям при старте сервиса — их смена важна');
});

test('node_modules and hidden directories do not affect the fingerprint', () => {
  const root = sandbox({ 'packages/service/src/index.ts': 'код' });
  const base = sourceRevision(root, ENTRIES);

  write(root, {
    'packages/service/src/node_modules/left-pad/index.js': 'мусор',
    'packages/service/src/.cache/мусор': 'мусор',
  });
  assert.equal(sourceRevision(root, ENTRIES), base);
});

test('missing paths do not break the fingerprint, and the lockfile is in the default set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-rev-'));
  assert.match(sourceRevision(root, ENTRIES), /^[0-9a-f]{16}$/, 'пустой репозиторий — не ошибка');

  const withLock = sandbox({ 'pnpm-lock.yaml': 'lockfile' });
  assert.notEqual(
    sourceRevision(withLock),
    sourceRevision(sandbox({})),
    'смена зависимостей тоже должна пересоздавать сервис',
  );
});
