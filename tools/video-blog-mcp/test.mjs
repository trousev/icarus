#!/usr/bin/env node
// Быстрый самотест video-blog: без сети, без ключа и без настоящего yt-dlp.
//
//   node tools/video-blog-mcp/test.mjs
//
// Заглушками подменяется всё внешнее: yt-dlp и ffmpeg — скрипты во временном
// каталоге, DeepInfra — локальный HTTP-сервер. Так проверяются разбор ответов,
// защита от плейлиста и лимитов, нарезка длинного аудио и то, что пост и
// транскрипт действительно ложатся на диск.
//
// Полный сценарий через настоящий stdio-протокол живёт в
// packages/service/test/video-blog-mcp.test.ts и гоняется через ./script/test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatch, humanSize, humanTime, slugify, TOOLS } from './server.mjs';

const NL = '\n';

// --- стенд -------------------------------------------------------------------

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Заглушка yt-dlp: `-J` отдаёт метаданные, обычный вызов кладёт «аудио». */
function fakeYtdlp(dir) {
  const file = path.join(dir, 'fake-yt-dlp');
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args.includes('--version')) {",
    "  process.stdout.write('9.9.9-fake');",
    '  process.exit(0);',
    '}',
    "if (args.includes('-J')) {",
    "  if (process.env.FAKE_YTDLP_FAIL === '1') {",
    "    process.stderr.write('ERROR: Video unavailable');",
    '    process.exit(1);',
    '  }',
    "  process.stdout.write(process.env.FAKE_YTDLP_INFO ?? '{}');",
    '  process.exit(0);',
    '}',
    "const index = args.indexOf('-o');",
    "const target = args[index + 1].replace('%(ext)s', 'm4a');",
    'fs.writeFileSync(target, Buffer.alloc(Number(process.env.FAKE_AUDIO_BYTES ?? 4096), 7));',
  ];
  fs.writeFileSync(file, `${lines.join(NL)}${NL}`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Заглушка ffmpeg: версия по запросу и две части вместо настоящей нарезки. */
function fakeFfmpeg(dir) {
  const file = path.join(dir, 'fake-ffmpeg');
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    "if (args.includes('-version')) {",
    "  process.stdout.write('ffmpeg version 9.9-fake Copyright');",
    '  process.exit(0);',
    '}',
    'const folder = path.dirname(args[args.length - 1]);',
    "for (const name of ['part_000.mp3', 'part_001.mp3']) {",
    "  fs.writeFileSync(path.join(folder, name), 'part');",
    '}',
  ];
  fs.writeFileSync(file, `${lines.join(NL)}${NL}`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Заглушка DeepInfra: два маршрута, которых хватает цепочке. */
async function fakeDeepInfra({ text = 'Привет, это расшифровка.', segments = 2 } = {}) {
  const calls = { transcriptions: 0, chats: 0 };
  const server = http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: 'no key' });
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url?.endsWith('/audio/transcriptions')) {
        calls.transcriptions += 1;
        return json(200, {
          text,
          language: 'ru',
          duration: 60,
          segments: Array.from({ length: segments }, (_, index) => ({
            start: index * 30,
            end: index * 30 + 30,
            text: `Кусок ${index + 1}`,
          })),
        });
      }
      if (req.url?.endsWith('/chat/completions')) {
        calls.chats += 1;
        return json(200, {
          choices: [{ message: { role: 'assistant', content: '# Заголовок\n\nАбзац поста.' } }],
          usage: { estimated_cost: 0.0007 },
        });
      }
      return json(404, { error: 'нет маршрута' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function setup({ info = {}, audioBytes = 4096, api = {} } = {}) {
  const root = tempDir('video-blog');
  const home = path.join(root, 'home');
  const out = path.join(root, 'out');
  fs.mkdirSync(home, { recursive: true });
  const deepinfra = await fakeDeepInfra(api);
  const env = {
    VIDEO_BLOG_HOME: home,
    VIDEO_BLOG_YTDLP: fakeYtdlp(root),
    VIDEO_BLOG_FFMPEG: fakeFfmpeg(root),
    VIDEO_BLOG_BASE_URL: deepinfra.url,
    VIDEO_BLOG_API_KEY: 'test-key',
    VIDEO_BLOG_MAX_UPLOAD_MB: '24',
    FAKE_AUDIO_BYTES: String(audioBytes),
    FAKE_YTDLP_INFO: JSON.stringify({
      title: 'Как читать видео',
      uploader: 'Test Channel',
      upload_date: '20261101',
      duration: 600,
      description: 'Описание ролика',
      webpage_url: 'https://example.invalid/watch?v=1',
      ...info,
    }),
  };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  return {
    home,
    out,
    deepinfra,
    async restore() {
      // Сервер-заглушку закрываем обязательно: иначе тестовый прогон висит на живом сокете.
      await deepinfra.close();
      for (const key of Object.keys(env)) delete process.env[key];
      for (const key of ['FAKE_YTDLP_FAIL', 'VIDEO_BLOG_MAX_MINUTES', 'VIDEO_BLOG_API_KEY']) delete process.env[key];
      Object.assign(process.env, previous);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function call(name, args = {}) {
  const response = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = response.result.content.map((item) => item.text).join('\n');
  return { text, isError: response.result.isError === true };
}

function findFile(dir, suffix) {
  const name = fs.readdirSync(dir).find((entry) => entry.endsWith(suffix));
  return name === undefined ? null : path.join(dir, name);
}

// --- тесты -------------------------------------------------------------------

test('инструменты: четыре, у каждого схема и запрет лишних полей', () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    ['blog_status', 'video_transcribe', 'video_to_blog', 'blog_from_transcript'],
  );
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 60, `${tool.name}: описание объясняет, когда звать`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: лишние поля запрещены`);
  }
});

test('мелочи: slug, размер и время', () => {
  assert.equal(slugify('Why Are People Starting to Sound Like ChatGPT?'), 'why-are-people-starting-to-sound-like-chatgpt');
  assert.equal(slugify('Как читать видео: часть 2'), 'как-читать-видео-часть-2');
  assert.equal(slugify('!!!'), 'blog-post');
  assert.equal(slugify('x'.repeat(200)).length, 60);
  assert.equal(humanTime(3725), '1:02:05');
  assert.equal(humanTime(312), '5:12');
  assert.equal(humanSize(0), '0 Б');
  assert.equal(humanSize(1024 * 1024 * 3), '3 МБ');
  assert.equal(humanSize(1536), '1.5 КБ');
});

test('status: без ключа говорит об этом прямо, а не падает', async () => {
  const stand = await setup();
  try {
    process.env.VIDEO_BLOG_API_KEY = '';
    process.env.DEEPINFRA_API_KEY = '';
    const { text, isError } = await call('blog_status');
    assert.equal(isError, false);
    assert.match(text, /Ключ DeepInfra: НЕТ/);
    assert.match(text, /yt-dlp: 9\.9\.9-fake/);
    assert.match(text, /ffmpeg: 9\.9-fake/);
  } finally {
    await stand.restore();
  }
});

test('video_to_blog: ссылка на входе — пост и транскрипт на выходе', async () => {
  const stand = await setup();
  try {
    const { text, isError } = await call('video_to_blog', { url: 'https://example.invalid/watch?v=1', out: stand.out });
    assert.equal(isError, false, text);
    assert.match(text, /Блог-пост готов/);
    assert.match(text, /Как читать видео — Test Channel/);
    assert.match(text, /Стоимость: расшифровка \$0\.0002 \+ модель \$0\.0007 = \$0\.0009/);

    const post = findFile(stand.out, '.md');
    const transcript = findFile(stand.out, '.transcript.txt');
    const meta = findFile(stand.out, '.meta.json');
    assert.ok(post !== null && transcript !== null && meta !== null, 'пост, транскрипт и метаданные на месте');
    assert.match(path.basename(post), /^2026-/, 'имя файла начинается с даты');

    const markdown = fs.readFileSync(post, 'utf8');
    assert.match(markdown, /^# Заголовок/);
    assert.match(markdown, /Источник: \[Как читать видео\]/);

    // Таймкоды склеены по частям: у второй сегмент стартует не с нуля.
    const body = fs.readFileSync(transcript, 'utf8');
    assert.match(body, /^\[0:00\] Кусок 1/m);
    assert.match(body, /^\[0:30\] Кусок 2/m);

    const parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
    assert.equal(parsed.duration, 60);
    assert.equal(parsed.language, 'ru');
    assert.equal(parsed.uploader, 'Test Channel');
    assert.equal(parsed.llm_cost_usd, 0.0007);
    assert.equal(stand.deepinfra.calls.transcriptions, 1);
    assert.equal(stand.deepinfra.calls.chats, 1);
  } finally {
    await stand.restore();
  }
});

test('длинное аудио режется, куски расшифровываются по очереди', async () => {
  const stand = await setup({ audioBytes: 8192 });
  try {
    process.env.VIDEO_BLOG_MAX_UPLOAD_MB = '0.001';
    const { text, isError } = await call('video_transcribe', {
      url: 'https://example.invalid/watch?v=1',
      out: stand.out,
      include_text: false,
    });
    assert.equal(isError, false, text);
    assert.equal(stand.deepinfra.calls.transcriptions, 2, 'две части — два запроса к Whisper');
    assert.match(text, /Длительность: 2:00/);
    assert.doesNotMatch(text, /Кусок 1/, 'include_text: false не тянет текст в разговор');

    const body = fs.readFileSync(findFile(stand.out, '.transcript.txt'), 'utf8');
    assert.match(body, /^\[0:00\] Кусок 1/m);
    assert.match(body, /^\[1:00\] Кусок 1/m, 'вторая часть сдвинута на 60 секунд');
  } finally {
    await stand.restore();
  }
});

test('пустая расшифровка — это ошибка, а не пустой файл', async () => {
  const stand = await setup({ api: { text: '' } });
  try {
    const { text, isError } = await call('video_transcribe', { url: 'https://example.invalid/watch?v=1', out: stand.out });
    assert.equal(isError, true);
    assert.match(text, /нет речи/);
    assert.equal(fs.existsSync(stand.out), false, 'на диск ничего не легло');
  } finally {
    await stand.restore();
  }
});

test('плейлист и превышение лимита отсекаются до скачивания', async () => {
  const playlist = await setup({ info: { _type: 'playlist', entries: [{ id: 'a' }] } });
  try {
    const { text, isError } = await call('video_to_blog', { url: 'https://example.invalid/playlist', out: playlist.out });
    assert.equal(isError, true);
    assert.match(text, /плейлист/);
  } finally {
    await playlist.restore();
  }

  const long = await setup({ info: { duration: 100000 } });
  try {
    process.env.VIDEO_BLOG_MAX_MINUTES = '2';
    const { text, isError } = await call('video_to_blog', { url: 'https://example.invalid/watch?v=1', out: long.out });
    assert.equal(isError, true);
    assert.match(text, /больше лимита 2 мин/);
    assert.match(text, /VIDEO_BLOG_MAX_MINUTES/);
  } finally {
    await long.restore();
  }
});

test('ссылка и файл вместе — отказ; yt-dlp не ответил — внятная причина', async () => {
  const stand = await setup();
  try {
    const both = await call('video_to_blog', { url: 'https://example.invalid/1', file: '/tmp/a.mp3', out: stand.out });
    assert.equal(both.isError, true);
    assert.match(both.text, /ровно одно из двух/);
    const none = await call('video_transcribe', { out: stand.out });
    assert.equal(none.isError, true);
    assert.match(none.text, /ровно одно из двух/);

    process.env.FAKE_YTDLP_FAIL = '1';
    const broken = await call('video_to_blog', { url: 'https://example.invalid/1', out: stand.out });
    assert.equal(broken.isError, true);
    assert.match(broken.text, /yt-dlp не смог прочитать видео/);
    assert.match(broken.text, /Video unavailable/);
  } finally {
    await stand.restore();
  }
});

test('blog_from_transcript: текст на входе, пост на выходе, расшифровка не запускается', async () => {
  const stand = await setup();
  try {
    const { text, isError } = await call('blog_from_transcript', {
      transcript: 'Это длинный транскрипт подкаста про видеопосты.',
      title: 'Подкаст про видео',
      out: stand.out,
      out_lang: 'ru',
    });
    assert.equal(isError, false, text);
    assert.match(text, /Пост собран из готового транскрипта/);
    assert.match(text, /# Заголовок/, 'include_text по умолчанию отдаёт сам пост');
    assert.equal(stand.deepinfra.calls.transcriptions, 0);
    assert.equal(stand.deepinfra.calls.chats, 1);
    assert.ok(findFile(stand.out, '.md') !== null);

    const empty = await call('blog_from_transcript', { out: stand.out });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /ровно одно из двух/);
  } finally {
    await stand.restore();
  }
});

test('временные каталоги убираются за собой, keep_audio их оставляет', async () => {
  const stand = await setup();
  try {
    await call('video_to_blog', { url: 'https://example.invalid/watch?v=1', out: stand.out, include_text: false });
    assert.deepEqual(fs.readdirSync(path.join(stand.home, 'work')), [], 'рабочие каталоги удалены');

    await call('video_transcribe', { url: 'https://example.invalid/watch?v=1', out: stand.out, keep_audio: true });
    assert.equal(fs.readdirSync(path.join(stand.home, 'work')).length, 1, 'keep_audio: true оставил аудио');
  } finally {
    await stand.restore();
  }
});
