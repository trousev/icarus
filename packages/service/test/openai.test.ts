// Идентичность, вложения и конфиг — то, что легко сломать незаметно.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, extractLatestUserMessage, resolveIdentity } from '../src/http/openai.ts';
import { userVolumes } from '../src/docker/compose.ts';
import { expandValue, loadConfig, userPaths, type IcarusConfig } from '../src/config.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('заголовки клиента задают пользователя и разговор', () => {
  const req = {
    headers: { 'x-icarus-user-id': 'probe', 'x-icarus-conversation-id': 'conv-1' },
  } as any;
  const identity = resolveIdentity(req, { user: 'другой' }, []);
  assert.equal(identity.userId, 'probe');
  assert.equal(identity.conversationId, 'conv-1');
});

test('без заголовков остаётся фолбэк на тело и хеш истории', () => {
  const req = { headers: {} } as any;
  const identity = resolveIdentity(req, { user: 'from-body' }, [{ role: 'user', content: 'привет' }]);
  assert.equal(identity.userId, 'from-body');
  assert.equal(identity.conversationId.length, 32);
  const same = resolveIdentity({ headers: {} } as any, {}, [{ role: 'user', content: 'привет' }]);
  assert.equal(same.conversationId, identity.conversationId, 'хеш должен быть детерминированным');
});

test('вложение раскодируется в файл, а не теряется', () => {
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

test('упоминание вложений попадает в реплику', () => {
  const prompt = buildPrompt('что тут?', ['/workspaces/.icarus/incoming/a.png']);
  assert.match(prompt, /что тут\?/);
  assert.match(prompt, /\/workspaces\/\.icarus\/incoming\/a\.png/);
});

test('подстановка ~ и переменных окружения', () => {
  assert.ok(expandValue('~/icarus', { HOME: '/home/x' } as any).startsWith('/home'));
  assert.equal(expandValue('env:MY_KEY', { MY_KEY: 'secret' } as any), 'secret');
  assert.equal(expandValue('${MY_KEY}', { MY_KEY: 'secret' } as any), 'secret');
  assert.equal(expandValue('просто строка', {} as any), 'просто строка');
});

test('контейнер монтирует память, сессии и репозитории', () => {
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
  // Код сервера артефактов нужен контейнеру всегда, даже без Maple; остальной
  // каталог tools (стенды и логи) в контейнер не едет.
  assert.match(joined, /\/tools\/artifacts-mcp:\/opt\/icarus\/tools\/artifacts-mcp:ro/);
  // OPDS-сервер — рецепт из каталога: без маунта команда из рецепта не найдёт файл.
  assert.match(joined, /\/tools\/opds-mcp:\/opt\/icarus\/tools\/opds-mcp:ro/);
  assert.doesNotMatch(joined, /\/tools:\/opt\/icarus\/tools:ro/);
});

test('пути пользователя выводятся из dataDir', () => {
  const config = { dataDir: '/data' } as unknown as IcarusConfig;
  const paths = userPaths(config, { id: 'probe' });
  assert.equal(paths.workspaces, '/data/users/probe/workspaces');
  assert.equal(paths.memory, '/data/users/probe/workspaces/.icarus/memory');
  assert.equal(paths.agentsMd, '/data/users/probe/workspaces/.icarus/AGENTS.md');
  assert.equal(paths.sharedMemory, '/data/shared');
});

test('конфиг без apiKey не принимается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-cfg-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, 'dataDir: /tmp\nmodels:\n  - provider: deepinfra\n    id: deepseek-ai/DeepSeek-V4.1-Flash\nusers:\n  - a\n');
  assert.throws(() => loadConfig(file, {} as any), /apiKey/);
});
