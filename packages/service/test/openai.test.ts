// Identity, attachments and config — the things that are easy to break unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, extractLatestUserMessage, resolveIdentity } from '../src/http/openai.ts';
import { userVolumes } from '../src/docker/compose.ts';
import { expandValue, loadConfig, userPaths, type IcarusConfig } from '../src/config.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('client headers set the user and the conversation', () => {
  const req = {
    headers: { 'x-icarus-user-id': 'probe', 'x-icarus-conversation-id': 'conv-1' },
  } as any;
  const identity = resolveIdentity(req, { user: 'другой' }, []);
  assert.equal(identity.userId, 'probe');
  assert.equal(identity.conversationId, 'conv-1');
});

test('without headers, the fallback to the body and the history hash remains', () => {
  const req = { headers: {} } as any;
  const identity = resolveIdentity(req, { user: 'from-body' }, [{ role: 'user', content: 'привет' }]);
  assert.equal(identity.userId, 'from-body');
  assert.equal(identity.conversationId.length, 32);
  const same = resolveIdentity({ headers: {} } as any, {}, [{ role: 'user', content: 'привет' }]);
  assert.equal(same.conversationId, identity.conversationId, 'хеш должен быть детерминированным');
});

test('an attachment is decoded into a file instead of being lost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-incoming-'));
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'что на картинке?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    },
  ];
  const { text, files } = extractLatestUserMessage(messages, dir);
  assert.equal(text, 'что на картинке?');
  assert.equal(files.length, 1);
  assert.match(files[0], /^\/workspaces\/\.icarus\/incoming\/.+\.png$/);
  const written = fs.readdirSync(dir);
  assert.equal(written.length, 1);
  assert.ok(fs.statSync(path.join(dir, written[0])).size > 0, 'файл не должен быть пустым');
});

test('mentioning attachments gets into the message', () => {
  const prompt = buildPrompt('что тут?', ['/workspaces/.icarus/incoming/a.png']);
  assert.match(prompt, /что тут\?/);
  assert.match(prompt, /\/workspaces\/\.icarus\/incoming\/a\.png/);
});

test('expansion of ~ and environment variables', () => {
  assert.ok(expandValue('~/icarus', { HOME: '/home/x' } as any).startsWith('/home'));
  assert.equal(expandValue('env:MY_KEY', { MY_KEY: 'secret' } as any), 'secret');
  assert.equal(expandValue('${MY_KEY}', { MY_KEY: 'secret' } as any), 'secret');
  assert.equal(expandValue('просто строка', {} as any), 'просто строка');
});

test('the container mounts memory, sessions and repositories', () => {
  const config = {
    dataDir: '/data',
    docker: { image: 'icarus-user:dev', prefix: 'icarus-user', socket: null },
    models: [{ provider: 'deepinfra', id: 'deepseek-ai/DeepSeek-V4.1-Flash', tier: 'fast' as const }],
  } as unknown as IcarusConfig;
  const joined = userVolumes(config, { id: 'probe' }).join(' ');
  assert.match(joined, /\/data\/users\/probe\/workspaces:\/workspaces/);
  assert.match(joined, /\/data\/artifacts:\/artifacts/, 'глобальная библиотека артефактов — отдельным маунтом');
  assert.match(
    joined,
    /\/data\/skills\/shared:\/workspaces\/\.icarus\/shared-skills:ro/,
    'общие скиллы — только для чтения, чтобы получатель не мог переписать чужой',
  );
  assert.match(joined, /\/data\/users\/probe\/workspaces\/private:\/workspaces\/private:ro/);
  // The artifacts server code is always needed by the container, even without Maple; the rest of the
  // tools directory (stands and logs) does not go into the container.
  assert.match(joined, /\/tools\/artifacts-mcp:\/opt\/icarus\/tools\/artifacts-mcp:ro/);
  // The OPDS server is a recipe from the catalog: without the mount, the command from the recipe would not find the file.
  assert.match(joined, /\/tools\/opds-mcp:\/opt\/icarus\/tools\/opds-mcp:ro/);
  // The cinema room is always mounted: the server may be needed even after the config is built.
  assert.match(joined, /\/tools\/arr-mcp:\/opt\/icarus\/tools\/arr-mcp:ro/);
  // Video to blog post is the same kind of recipe from the catalog: the mount is read-only,
  // because the server downloads the binaries into its own service directory.
  assert.match(joined, /\/tools\/video-blog-mcp:\/opt\/icarus\/tools\/video-blog-mcp:ro/);
  assert.doesNotMatch(joined, /\/tools:\/opt\/icarus\/tools:ro/);
});

test('user paths are derived from dataDir', () => {
  const config = { dataDir: '/data' } as unknown as IcarusConfig;
  const paths = userPaths(config, { id: 'probe' });
  assert.equal(paths.workspaces, '/data/users/probe/workspaces');
  assert.equal(paths.memory, '/data/users/probe/workspaces/.icarus/memory');
  assert.equal(paths.agentsMd, '/data/users/probe/workspaces/.icarus/AGENTS.md');
  assert.equal(paths.sharedMemory, '/data/shared');
});

test('a config without apiKey is not accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-cfg-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, 'dataDir: /tmp\nmodels:\n  - provider: deepinfra\n    id: deepseek-ai/DeepSeek-V4.1-Flash\nusers:\n  - a\n');
  assert.throws(() => loadConfig(file, {} as any), /apiKey/);
});
