// Самотест MCP артефактов: настоящий stdio-хендшейк на временной папке.
//
//   node tools/artifacts-mcp/test.mjs
//
// Модель, сеть и докер не нужны: сервер запускается как отдельный процесс, как его
// запускает pi, и отвечает на initialize, tools/list и tools/call.
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

async function start(cwd) {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: {
      ...process.env,
      ICARUS_URL: 'https://icarus.example',
      ICARUS_USER_ID: 'probe',
      ICARUS_WORKSPACE: 'talk',
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

test('initialize отдаёт инструкции и четыре инструмента', async () => {
  await withServer({}, async (rpc) => {
    const init = await rpc.call({ method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'artifacts');
    assert.match(init.result.instructions, /index\.ai\.md/);
    assert.match(init.result.instructions, /artifact_link/);

    const list = await rpc.call({ method: 'tools/list', params: {} });
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name).sort(),
      ['artifact_check', 'artifact_link', 'artifact_list', 'artifact_read'],
    );
  });
});

test('список, чтение и описание для ИИ', async () => {
  await withServer(
    {
      'artifacts/plan/index.md': '# План на четверг\n\n1. Стендап.\n',
      'artifacts/plan/index.ai.md': '# План на четверг\n\nРасписание дня.\n',
      'artifacts/site/index.html': '<h1>Сырой HTML</h1>',
      'artifacts/site/index.ai.md': '# Сайт\n\nЛендинг.\n',
    },
    async (rpc) => {
      const list = text(await rpc.call({ method: 'tools/call', params: { name: 'artifact_list', arguments: {} } }));
      assert.match(list, /План на четверг/);
      assert.match(list, /Markdown-документ/);
      assert.match(list, /HTML-страница/);

      const read = text(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_read', arguments: { name: 'site' } } }),
      );
      assert.match(read, /Лендинг/);
      assert.doesNotMatch(read, /<h1>Сырой HTML<\/h1>/);
    },
  );
});

test('artifact_link по умолчанию — внутренняя ссылка, без публикации', async () => {
  await withServer(
    { 'artifacts/plan/index.md': '# План\n', 'artifacts/plan/index.ai.md': '# План\n' },
    async (rpc, root) => {
      const answer = text(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_link', arguments: { name: 'plan' } } }),
      );
      assert.match(answer, /panel\/artifacts\?workspace=talk&artifact=plan/);
      assert.doesNotMatch(answer, /\/a\/probe\/talk\/plan\//);
      assert.equal(fs.existsSync(path.join(root, 'artifacts/plan/.artifact.json')), false);
    },
  );
});

test('artifact_link с public: true создаёт publicId и ссылки', async () => {
  await withServer(
    { 'artifacts/plan/index.md': '# План\n', 'artifacts/plan/index.ai.md': '# План\n' },
    async (rpc, root) => {
      const answer = text(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_link', arguments: { name: 'plan', public: true } } }),
      );
      assert.match(answer, /https:\/\/icarus\.example\/a\/probe\/talk\/plan\/[A-Za-z0-9_-]{16,}\//);
      assert.match(answer, /\?bare=1/);
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/plan/.artifact.json'), 'utf8'));
      assert.match(meta.publicId, /^[A-Za-z0-9_-]{16,}$/);
    },
  );
});

test('artifact_check видит неполный артефакт', async () => {
  await withServer(
    {
      'artifacts/full/index.md': '# Полный\n',
      'artifacts/full/index.ai.md': '# Полный\n',
      'artifacts/broken/index.html': '<h1>Без описания</h1>',
    },
    async (rpc) => {
      const answer = text(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_check', arguments: {} } }),
      );
      assert.match(answer, /✓ artifacts\/full\//);
      assert.match(answer, /✗ artifacts\/broken\/.*index\.ai\.md/);
    },
  );
});

test('ошибка инструмента — это isError, а не падение сервера', async () => {
  await withServer({}, async (rpc) => {
    const answer = await rpc.call({
      method: 'tools/call',
      params: { name: 'artifact_read', arguments: { name: 'nope' } },
    });
    assert.equal(answer.result.isError, true);
    assert.match(text(answer), /artifact_list/);
  });
});
