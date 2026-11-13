// MCP «видео в блог-пост» в общем наборе: сервер живёт в tools/video-blog-mcp,
// здесь — короткая интеграция через настоящий stdio, чтобы CI видел главное:
// ссылка на входе даёт пост и транскрипт на диске, а внешний мир (yt-dlp,
// DeepInfra) подменён заглушками.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SERVER = path.resolve(import.meta.dirname, '../../../tools/video-blog-mcp/server.mjs');

const INFO = {
  title: 'Как читать видео',
  uploader: 'Test Channel',
  upload_date: '20261101',
  duration: 600,
  description: 'Описание ролика',
  webpage_url: 'https://example.invalid/watch?v=1',
};

/** Заглушка yt-dlp: `-J` отдаёт метаданные, обычный вызов кладёт файл «аудио». */
function fakeYtdlp(dir: string): string {
  const file = path.join(dir, 'fake-yt-dlp');
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args.includes('--version')) { process.stdout.write('9.9.9-fake'); process.exit(0); }",
    "if (args.includes('-J')) { process.stdout.write(process.env.FAKE_YTDLP_INFO ?? '{}'); process.exit(0); }",
    'const index = args.indexOf("-o");',
    'fs.writeFileSync(args[index + 1].replace("%(ext)s", "m4a"), Buffer.alloc(4096, 7));',
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

type FakeApi = { url: string; calls: () => number; close: () => Promise<void> };

/** Ровно те два маршрута, которых хватает цепочке: расшифровка и редактор. */
async function fakeDeepInfra(): Promise<FakeApi> {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    state.calls += 1;
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/audio/transcriptions')) {
        return json({
          text: 'Привет, это расшифровка.',
          language: 'ru',
          duration: 600,
          segments: [{ start: 0, end: 30, text: 'Кусок 1' }],
        });
      }
      json({
        choices: [{ message: { role: 'assistant', content: '# Заголовок\n\nАбзац поста.' } }],
        usage: { estimated_cost: 0.0007 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => state.calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Rpc = {
  call: (message: Record<string, unknown>) => Promise<Record<string, any>>;
  tool: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  stop: () => Promise<void>;
};

async function start(env: Record<string, string>): Promise<Rpc> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let id = 0;
  const pending = new Map<number, (value: Record<string, any>) => void>();
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
  child.stderr.on('data', () => {
    // диагностика сервера тесту не нужна
  });
  const call = (message: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...message })}\n`);
    });
  return {
    call,
    tool: async (name, args = {}) => {
      const message = await call({ method: 'tools/call', params: { name, arguments: args } });
      return {
        text: ((message.result?.content ?? []) as Array<{ text?: string }>).map((item) => item.text ?? '').join('\n'),
        isError: message.result?.isError === true,
      };
    },
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill(), 1000).unref();
      }),
  };
}

test('MCP видео-в-блог: ссылка на входе, пост и транскрипт на выходе', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-blog-mcp-'));
  const home = path.join(root, 'home');
  const out = path.join(root, 'out');
  fs.mkdirSync(home, { recursive: true });
  const api = await fakeDeepInfra();
  const rpc = await start({
    VIDEO_BLOG_HOME: home,
    VIDEO_BLOG_OUT_DIR: out,
    VIDEO_BLOG_YTDLP: fakeYtdlp(root),
    VIDEO_BLOG_BASE_URL: api.url,
    VIDEO_BLOG_API_KEY: 'test-key',
    FAKE_YTDLP_INFO: JSON.stringify(INFO),
  });
  try {
    const init = await rpc.call({ method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'video-blog');
    assert.match(init.result.instructions, /video_to_blog/);

    const list = await rpc.call({ method: 'tools/list', params: {} });
    assert.deepEqual(
      (list.result.tools as Array<{ name: string }>).map((tool) => tool.name),
      ['blog_status', 'video_transcribe', 'video_to_blog', 'blog_from_transcript'],
    );

    const status = await rpc.tool('blog_status');
    assert.equal(status.isError, false, status.text);
    assert.match(status.text, /Ключ DeepInfra: есть/);

    const result = await rpc.tool('video_to_blog', {
      url: 'https://example.invalid/watch?v=1',
      include_text: false,
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Блог-пост готов/);
    assert.match(result.text, /Как читать видео — Test Channel/);

    const files = fs.readdirSync(out);
    const post = files.find((name) => name.endsWith('.md'));
    assert.ok(post !== undefined, 'пост записан в папку результата');
    assert.match(fs.readFileSync(path.join(out, post), 'utf8'), /Источник: \[Как читать видео\]/);
    assert.ok(files.some((name) => name.endsWith('.transcript.txt')), 'транскрипт лежит рядом');
    assert.ok(files.some((name) => name.endsWith('.meta.json')), 'метаданные лежат рядом');
    assert.equal(api.calls(), 2, 'один запрос к Whisper и один к редактору');

    assert.deepEqual(fs.readdirSync(path.join(home, 'work')), [], 'рабочий каталог убран за собой');
  } finally {
    await rpc.stop();
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP видео-в-блог: без ключа честно говорит, чего не хватает', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-blog-mcp-'));
  const audio = path.join(root, 'audio.m4a');
  fs.writeFileSync(audio, Buffer.alloc(4096, 3));
  const rpc = await start({
    VIDEO_BLOG_HOME: path.join(root, 'home'),
    VIDEO_BLOG_OUT_DIR: path.join(root, 'out'),
    VIDEO_BLOG_API_KEY: '',
    DEEPINFRA_API_KEY: '',
  });
  try {
    const status = await rpc.tool('blog_status');
    assert.match(status.text, /Ключ DeepInfra: НЕТ/);

    // Локальный файл вместо ссылки: ключ проверяется раньше, чем сеть, и без yt-dlp.
    const empty = await rpc.tool('video_transcribe', { file: audio });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /нет ключа/);
  } finally {
    await rpc.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
