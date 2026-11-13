// Artifact conversation: pi must work in the artifact folder, not in the workspace.
//
// We check two joints: PiSession gives docker exec the working directory
// `/artifacts/<slug>` and the mode label in the environment, while the registry
// does not let anyone into someone else's artifact without write permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ACL, artifactsRoot, writeAcl } from '../src/artifacts.ts';
import type { FolderAcl } from '../src/artifacts.ts';
import type { IcarusConfig } from '../src/config.ts';
import { PiSession } from '../src/sessions/pi-session.ts';
import type { Spawner } from '../src/sessions/rpc-client.ts';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { artifactForConversation } from '../src/sessions/chats.ts';
import { makeConfig, probe } from './fixtures.ts';

function artifact(config: IcarusConfig, slug: string, acl: FolderAcl = DEFAULT_ACL): void {
  const dir = path.join(artifactsRoot(config), slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.md'), '# План\n');
  fs.writeFileSync(path.join(dir, 'index.ai.md'), '# План\n\nРасписание.\n');
  writeAcl(dir, 'probe', acl);
}

const STUB = 'process.stdin.resume();';

/** pi stub: remembers with which directory and environment it was called. */
function capturingSpawner(calls: Array<{ workdir?: string; env?: Record<string, string> }>): Spawner {
  return (_container, _args, env, workdir) => {
    calls.push({ workdir, env });
    return spawn(process.execPath, ['-e', STUB], { stdio: ['pipe', 'pipe', 'pipe'] });
  };
}

test('an artifact session starts pi in /artifacts/<slug> and passes the mode into the prompt', () => {
  const config = makeConfig();
  const calls: Array<{ workdir?: string; env?: Record<string, string> }> = [];
  const session = new PiSession(
    config,
    probe(),
    'web-artifact-1',
    config.models[0]!,
    'stub',
    0,
    capturingSpawner(calls),
    'talk',
    { slug: 'plan', title: 'План на четверг', entry: 'index.md', type: 'markdown' },
  );
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.workdir, '/artifacts/plan');
    assert.equal(calls[0]!.env?.ICARUS_ARTIFACT, 'plan');
    assert.equal(calls[0]!.env?.ICARUS_ARTIFACT_TITLE, 'План на четверг');
    assert.equal(calls[0]!.env?.ICARUS_ARTIFACT_ENTRY, 'index.md');
    assert.equal(calls[0]!.env?.ICARUS_ARTIFACT_TYPE, 'markdown');
    assert.equal(calls[0]!.env?.ICARUS_WORKSPACE, 'talk');
  } finally {
    session.dispose();
  }
});

test('a regular session still works in the workspace', () => {
  const config = makeConfig();
  const calls: Array<{ workdir?: string; env?: Record<string, string> }> = [];
  const session = new PiSession(config, probe(), 'web-talk-1', config.models[0]!, 'stub', 0, capturingSpawner(calls), 'talk');
  try {
    assert.equal(calls[0]!.workdir, '/workspaces/talk');
    assert.equal(calls[0]!.env?.ICARUS_ARTIFACT, undefined);
  } finally {
    session.dispose();
  }
});

test('the registry passes the artifact into the session and remembers it in the conversation', async () => {
  const config = makeConfig();
  artifact(config, 'plan');
  const seen: Array<unknown[]> = [];
  const fake = {
    key: 'probe:web-artifact-2',
    user: probe(),
    container: 'stub',
    generation: 0,
    busy: false,
    alive: true,
    lastUsed: Date.now(),
    turns: 0,
    compacting: null as Promise<void> | null,
    workspace: 'talk',
    artifact: { slug: 'plan', title: 'План', entry: 'index.md', type: 'markdown' },
    onEvent: () => () => {},
    dispose(): void {},
    async compact(): Promise<{ status: 'nothing' }> {
      return { status: 'nothing' };
    },
  };
  const registry = new SessionRegistry(config, {
    ensureContainer: async () => 'stub',
    createSession: (...args: unknown[]) => {
      seen.push(args);
      return fake as never;
    },
  });
  try {
    await registry.acquire(probe(), 'web-artifact-2', 'talk', 'plan');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]![7], { slug: 'plan', title: 'План', entry: 'index.md', type: 'markdown' });
    assert.equal(artifactForConversation(config, probe(), 'web-artifact-2'), 'plan');
  } finally {
    registry.dispose();
  }
});

test('without write permission an artifact chat does not start', async () => {
  const config = makeConfig();
  artifact(config, 'viewonly', { me: 'read', family: 'read' });
  const registry = new SessionRegistry(config, {
    ensureContainer: async () => 'stub',
    createSession: () => {
      throw new Error('сессия не должна была создаться');
    },
  });
  try {
    await assert.rejects(
      () => registry.acquire(probe(), 'web-artifact-3', 'talk', 'viewonly'),
      /нет права менять артефакт/,
    );
  } finally {
    registry.dispose();
  }
});
