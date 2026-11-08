// MCP артефактов: глобальная библиотека, ACL и инструменты.
//
// Сервер запускается отдельным процессом, как его запускает pi: проверяем
// настоящий stdio-хендшейк, права и ответы на tools/call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER = path.resolve(import.meta.dirname, '../../../tools/artifacts-mcp/server.mjs');

type Rpc = {
  child: ChildProcessWithoutNullStreams;
  call: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
};

function workspace(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-mcp-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function acl(owner: string, me = 'admin', family = 'read'): string {
  return JSON.stringify({ version: 1, owner, acl: { me, family }, createdAt: '', updatedAt: '' });
}

async function start(cwd: string): Promise<Rpc> {
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
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    }
  });
  const call = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      const request = { jsonrpc: '2.0', id, ...message };
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  return {
    child,
    call,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill(), 1000).unref();
      }),
  };
}

async function withServer(
  files: Record<string, string | Buffer>,
  run: (rpc: Rpc, root: string) => Promise<void>,
): Promise<void> {
  const root = workspace(files);
  const rpc = await start(root);
  try {
    await run(rpc, root);
  } finally {
    await rpc.stop();
  }
}

function resultText(message: Record<string, unknown>): string {
  const result = message.result as { content?: Array<{ text?: string }> };
  return (result.content ?? []).map((item) => item.text ?? '').join('\n');
}

test('хендшейк: глобальная библиотека, ACL, пять инструментов', async () => {
  await withServer({}, async (rpc) => {
    const init = await rpc.call({ method: 'initialize', params: {} });
    const info = init.result as { instructions: string; serverInfo: { name: string } };
    assert.equal(info.serverInfo.name, 'artifacts');
    assert.match(info.instructions, /\/artifacts/);
    assert.match(info.instructions, /artifact_new/);
    assert.match(info.instructions, /index\.ai\.md/);
    assert.match(info.instructions, /public: true/);

    const list = await rpc.call({ method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'artifact_check',
      'artifact_link',
      'artifact_list',
      'artifact_new',
      'artifact_read',
    ]);
  });
});

test('artifact_list показывает владельца, уровень и тип', async () => {
  await withServer(
    {
      'artifacts/plan/.folder-acl.json': acl('probe'),
      'artifacts/plan/index.md': '# План на четверг\n',
      'artifacts/plan/index.ai.md': '# План на четверг\n\nРасписание дня.\n',
      'artifacts/site/.folder-acl.json': acl('probe2', 'admin', 'write'),
      'artifacts/site/index.html': '<title>Сайт</title>',
      'artifacts/site/index.ai.md': '# Сайт\n\nЛендинг.\n',
    },
    async (rpc) => {
      const answer = await rpc.call({ method: 'tools/call', params: { name: 'artifact_list', arguments: {} } });
      const text = resultText(answer);
      assert.match(text, /План на четверг/);
      assert.match(text, /Markdown-документ/);
      assert.match(text, /владелец: probe; твой уровень: admin/);
      assert.match(text, /Сайт/);
      assert.match(text, /владелец: probe2; твой уровень: write/);
      assert.match(text, /публичной ссылки нет/);
    },
  );
});

test('artifact_read отдаёт index.ai.md и права', async () => {
  await withServer(
    {
      'artifacts/site/.folder-acl.json': acl('probe'),
      'artifacts/site/index.html': '<h1>Сырой HTML</h1>',
      'artifacts/site/index.ai.md': '# Сайт\n\nЧто внутри: лендинг.\n',
    },
    async (rpc) => {
      const answer = await rpc.call({
        method: 'tools/call',
        params: { name: 'artifact_read', arguments: { name: 'site' } },
      });
      const text = resultText(answer);
      assert.match(text, /Что внутри: лендинг/);
      assert.match(text, /владелец: probe/);
      assert.doesNotMatch(text, /<h1>Сырой HTML<\/h1>/);
    },
  );
});

test('artifact_new создаёт папку и ACL, после чего разрешена запись', async () => {
  await withServer({}, async (rpc, root) => {
    const answer = await rpc.call({
      method: 'tools/call',
      params: { name: 'artifact_new', arguments: { name: 'plan' } },
    });
    const text = resultText(answer);
    assert.match(text, /\/artifacts\/plan\//);
    const dir = path.join(root, 'artifacts', 'plan');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.folder-acl.json'), 'utf8')) as {
      owner: string;
      acl: { me: string; family: string };
    };
    assert.equal(saved.owner, 'probe');
    assert.deepEqual(saved.acl, { me: 'admin', family: 'none' });
    assert.match(text, /family=none/);

    fs.writeFileSync(path.join(dir, 'index.md'), '# План\n');
    fs.writeFileSync(path.join(dir, 'index.ai.md'), '# План\n');
    const check = resultText(
      await rpc.call({ method: 'tools/call', params: { name: 'artifact_check', arguments: { name: 'plan' } } }),
    );
    assert.match(check, /✓/);
  });
});

test('artifact_link: по умолчанию внутренняя, public: true — только admin', async () => {
  await withServer(
    {
      'artifacts/plan/.folder-acl.json': acl('probe2', 'admin', 'read'),
      'artifacts/plan/index.md': '# План\n',
      'artifacts/plan/index.ai.md': '# План\n',
    },
    async (rpc) => {
      const inner = resultText(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_link', arguments: { name: 'plan' } } }),
      );
      assert.match(inner, /panel\/artifacts\?artifact=plan/);
      assert.doesNotMatch(inner, /\/a\/plan\//);

      const denied = await rpc.call({
        method: 'tools/call',
        params: { name: 'artifact_link', arguments: { name: 'plan', public: true } },
      });
      assert.equal((denied.result as { isError?: boolean }).isError, true);
      assert.match(resultText(denied), /владелец или admin/);
    },
  );
});

test('artifact_link с public: true у владельца создаёт publicId', async () => {
  await withServer(
    {
      'artifacts/plan/.folder-acl.json': acl('probe'),
      'artifacts/plan/index.md': '# План\n',
      'artifacts/plan/index.ai.md': '# План\n',
    },
    async (rpc, root) => {
      const answer = resultText(
        await rpc.call({
          method: 'tools/call',
          params: { name: 'artifact_link', arguments: { name: 'plan', public: true } },
        }),
      );
      assert.match(answer, /https:\/\/icarus\.example\/a\/plan\/[A-Za-z0-9_-]{16,}\//);
      assert.match(answer, /\?bare=1/);
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/plan/.artifact.json'), 'utf8')) as {
        publicId: string;
      };
      assert.match(meta.publicId, /^[A-Za-z0-9_-]{16,}$/);
    },
  );
});

test('artifact_check честно говорит, чего не хватает', async () => {
  await withServer(
    {
      'artifacts/broken/index.html': '<h1>Без прав и описания</h1>',
    },
    async (rpc) => {
      const text = resultText(
        await rpc.call({ method: 'tools/call', params: { name: 'artifact_check', arguments: {} } }),
      );
      assert.match(text, /✗ \/artifacts\/broken\/.*\.folder-acl\.json/);
      assert.match(text, /index\.ai\.md/);
    },
  );
});

test('ошибка инструмента — это isError, а не падение сервера', async () => {
  await withServer({}, async (rpc) => {
    const unknown = await rpc.call({ method: 'tools/call', params: { name: 'artifact_delete', arguments: {} } });
    assert.equal((unknown.result as { isError?: boolean }).isError, true);
    const missing = await rpc.call({ method: 'tools/call', params: { name: 'artifact_read', arguments: { name: 'nope' } } });
    assert.equal((missing.result as { isError?: boolean }).isError, true);
    assert.match(resultText(missing), /artifact_list/);
  });
});
