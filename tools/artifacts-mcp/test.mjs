// Самотест MCP артефактов: глобальная библиотека, ACL и инструменты.
//
//   node tools/artifacts-mcp/test.mjs
//
// Сервер запускается отдельным процессом, как его запускает pi.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-mcp-test-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function acl(owner, me = 'admin', family = 'read') {
  return JSON.stringify({ version: 1, owner, acl: { me, family } });
}

async function start(cwd) {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: {
      ...process.env,
      ICARUS_URL: 'https://icarus.example',
      ICARUS_USER_ID: 'probe',
      ICARUS_ARTIFACTS_DIR: path.join(cwd, 'artifacts'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let id = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  const call = (message) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...message })}\n`);
    });
  return {
    call,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.stdin.end();
        setTimeout(() => child.kill(), 1000).unref();
      }),
  };
}

function text(message) {
  return (message.result.content ?? []).map((item) => item.text ?? '').join('\n');
}

async function withServer(files, run) {
  const root = workspace(files);
  const rpc = await start(root);
  try {
    await run(rpc, root);
  } finally {
    await rpc.stop();
  }
}

test('initialize отдаёт инструкции и пять инструментов', async () => {
  await withServer({}, async (rpc) => {
    const init = await rpc.call({ method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'artifacts');
    assert.match(init.result.instructions, /\/artifacts/);
    assert.match(init.result.instructions, /artifact_new/);
    assert.match(init.result.instructions, /index\.ai\.md/);
    assert.match(init.result.instructions, /public: true/);

    const list = await rpc.call({ method: 'tools/list', params: {} });
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name).sort(),
      ['artifact_check', 'artifact_link', 'artifact_list', 'artifact_new', 'artifact_read'],
    );
  });
});

test('список, чтение и права', async () => {
  await withServer(
    {
      'artifacts/plan/.folder-acl.json': acl('probe'),
      'artifacts/plan/index.md': '# План на четверг\n\n1. Стендап.\n',
      'artifacts/plan/index.ai.md': '# План на четверг\n\nРасписание дня.\n',
      'artifacts/site/.folder-acl.json': acl('probe2', 'admin', 'write'),
      'artifacts/site/index.html': '<h1>Сырой HTML</h1>',
      'artifacts/site/index.ai.md': '# Сайт\n\nЛендинг.\n',
    },
    async (rpc) => {
      const list = text(await rpc.call({ method: 'tools/call', params: { name: 'artifact_list', arguments: {} } }));
      assert.match(list, /План на четверг/);
      assert.match(list, /Markdown-документ/);
      assert.match(list, /владелец: probe; твой уровень: admin/);
      assert.match(list, /HTML-страница/);
      assert.match(list, /владелец: probe2; твой уровень: write/);

      const read = text(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_read', arguments: { name: 'site' } } }),
      );
      assert.match(read, /Лендинг/);
      assert.match(read, /владелец: probe2/);
      assert.doesNotMatch(read, /<h1>Сырой HTML<\/h1>/);
    },
  );
});

test('artifact_new создаёт папку и ACL', async () => {
  await withServer({}, async (rpc, root) => {
    const answer = text(
      await rpc.call({ method: 'tools/call', params: { name: 'artifact_new', arguments: { name: 'plan' } } }),
    );
    assert.match(answer, /\/artifacts\/plan\//);
    const dir = path.join(root, 'artifacts', 'plan');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.folder-acl.json'), 'utf8'));
    assert.equal(saved.owner, 'probe');
    assert.deepEqual(saved.acl, { me: 'admin', family: 'read' });
    fs.writeFileSync(path.join(dir, 'index.md'), '# План\n');
    fs.writeFileSync(path.join(dir, 'index.ai.md'), '# План\n');
    const check = text(
      await rpc.call({ method: 'tools/call', params: { name: 'artifact_check', arguments: { name: 'plan' } } }),
    );
    assert.match(check, /✓/);
  });
});

test('artifact_link по умолчанию — внутренняя ссылка; public: true — у владельца', async () => {
  await withServer(
    {
      'artifacts/plan/.folder-acl.json': acl('probe'),
      'artifacts/plan/index.md': '# План\n',
      'artifacts/plan/index.ai.md': '# План\n',
    },
    async (rpc, root) => {
      const inner = text(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_link', arguments: { name: 'plan' } } }),
      );
      assert.match(inner, /panel\/artifacts\?artifact=plan/);
      assert.doesNotMatch(inner, /\/a\/plan\//);

      const pub = text(
        await rpc.call({
          method: 'tools/call',
          params: { name: 'artifact_link', arguments: { name: 'plan', public: true } },
        }),
      );
      assert.match(pub, /https:\/\/icarus\.example\/a\/plan\/[A-Za-z0-9_-]{16,}\//);
      assert.match(pub, /\?bare=1/);
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/plan/.artifact.json'), 'utf8'));
      assert.match(meta.publicId, /^[A-Za-z0-9_-]{16,}$/);
    },
  );
});

test('artifact_check видит отсутствие прав и описания', async () => {
  await withServer(
    { 'artifacts/broken/index.html': '<h1>Без прав</h1>' },
    async (rpc) => {
      const answer = text(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_check', arguments: {} } }),
      );
      assert.match(answer, /✗ \/artifacts\/broken\/.*\.folder-acl\.json/);
      assert.match(answer, /index\.ai\.md/);
    },
  );
});

test('ошибка инструмента — это isError, а не падение сервера', async () => {
  await withServer({}, async (rpc) => {
    const unknown = await rpc.call({
      method: 'tools/call',
      params: { name: 'artifact_delete', arguments: {} },
    });
    assert.equal(unknown.result.isError, true);
    const missing = await rpc.call({
      method: 'tools/call',
      params: { name: 'artifact_read', arguments: { name: 'nope' } },
    });
    assert.equal(missing.result.isError, true);
    assert.match(text(missing), /artifact_list/);
  });
});
