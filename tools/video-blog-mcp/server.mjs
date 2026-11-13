#!/usr/bin/env node
// video-blog: an MCP server that turns a video into a blog post.
//
// Why a server instead of a script. A script does the same thing, but only
// someone who remembers the path and flags can use it. Here the same chain is declared as tools:
// the person says "make a post from this video", the model calls video_to_blog, and
// where to put files, where to get the key and how to cut long audio is the server's concern.
//
// Chain: yt-dlp (audio + metadata) → DeepInfra Whisper (transcript) → DeepInfra
// DeepSeek (rewrite the transcript into a post). The key is the same one Icarus itself
// runs on (DEEPINFRA_API_KEY), nothing separate needs to be set up.
//
// External binaries arrive in the person's container lazily: yt-dlp — a static one from
// GitHub releases, ffmpeg — only when the audio is over the upload limit and needs
// cutting. They live in VIDEO_BLOG_HOME (by default <ICARUS_HOME>/tools/video-blog),
// i.e. in the mounted service directory: recreating the container doesn't wipe them,
// and nothing needs to be baked into the image.
//
// The server deliberately has no HTTP mode: it always runs where the keys and
// working folders are — inside the agent container. There is nothing to expose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'video-blog', version: '1.0.0' };

const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEFAULT_ASR_MODEL = 'openai/whisper-large-v3-turbo';
const DEFAULT_LLM_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash';
/** Price of whisper-large-v3-turbo on DeepInfra: $0.0002 per minute of audio. */
const ASR_USD_PER_MINUTE = 0.0002;

/** Default single-upload limit: larger — we cut with ffmpeg instead of sending one piece. */
const DEFAULT_MAX_UPLOAD_MB = 24;
/** Default chunk length when splitting, seconds. Whisper works in 30 s windows, but with margin. */
const DEFAULT_SPLIT_SECONDS = 900;
/** From this transcript size map-reduce kicks in, to avoid exceeding the context. */
const CHARS_PER_CHUNK = 45_000;
/** Duration ceiling: protection against "let's do the whole podcast season". */
const DEFAULT_MAX_MINUTES = 240;

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const FFMPEG_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz';
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

const INSTRUCTIONS = `Видео в блог-пост: скачать звук, расшифровать, переписать в пост.

Инструменты:
- video_to_blog — главный: ссылка на видео на входе, готовый Markdown-пост на выходе. Качает звук, расшифровывает и переписывает. Стоит денег (около $0.002 за пятиминутное видео) и пишет файлы в рабочую папку.
- video_transcribe — только расшифровка, без переписывания: «что там говорят».
- blog_from_transcript — наоборот: готовый транскрипт (текстом или файлом) превратить в пост. Годится для подкастов, у которых транскрипт уже есть.
- blog_status — что готово к работе: есть ли ключ, скачаны ли yt-dlp и ffmpeg, куда лягут файлы. С install: true сервер заранее скачает бинарники.

Что помнить:
- Инструменты пишут файлы в рабочую папку и тратят копейки на API. Это нормальная работа, а не заказ: отдельного подтверждения не нужно.
- Пост — это пересказ, а не цитата. Если человек собирается что-то процитировать, пусть смотрит .transcript.txt рядом: там слова говорящего, а не редактура.
- Длинный текст лучше не тянуть в разговор: include_text: false вернёт пути и сводку, а файл модель прочитает обычным чтением, когда он понадобится.
- Ошибка «нет ключа», «yt-dlp не отвечает», «нет речи в аудио» — это не поломка Икара, а состояние: скажи человеку, чего не хватает, и не повторяй вызов наугад.`;

// --- configuration -----------------------------------------------------------

function envText(name) {
  return (process.env[name] ?? '').trim();
}

function envNumber(name, fallback) {
  const value = Number(envText(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Settings are read on every call, not once at startup: that way tests
 * bring up the server with a different environment without restarting the module.
 */
function config() {
  const home =
    envText('VIDEO_BLOG_HOME') || path.join(envText('ICARUS_HOME') || os.homedir(), 'tools', 'video-blog');
  return {
    baseUrl: (envText('VIDEO_BLOG_BASE_URL') || envText('DEEPINFRA_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: envText('VIDEO_BLOG_API_KEY') || envText('DEEPINFRA_API_KEY'),
    asrModel: envText('VIDEO_BLOG_ASR_MODEL') || DEFAULT_ASR_MODEL,
    llmModel: envText('VIDEO_BLOG_LLM_MODEL') || DEFAULT_LLM_MODEL,
    home,
    binDir: path.join(home, 'bin'),
    workRoot: path.join(home, 'work'),
    maxMinutes: envNumber('VIDEO_BLOG_MAX_MINUTES', DEFAULT_MAX_MINUTES),
    maxUploadBytes: Math.floor(envNumber('VIDEO_BLOG_MAX_UPLOAD_MB', DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024),
    splitSeconds: Math.round(envNumber('VIDEO_BLOG_SPLIT_SECONDS', DEFAULT_SPLIT_SECONDS)),
  };
}

function log(message) {
  process.stderr.write(`[video-blog] ${message}\n`);
}

// --- common ------------------------------------------------------------------

class ToolError extends Error {}

function fail(message) {
  throw new ToolError(message);
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${rounded} ${units[unit]}`;
}

function humanTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function slugify(text, maxLength = 60) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    // Cyrillic in a file name is not an error, but hieroglyphs and emoji in a path get in the way,
    // so we keep letters, digits and the hyphen, and collapse the rest.
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return slug === '' ? 'blog-post' : slug;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** The process's entire stdout/stderr: the chain is short, streaming parsing isn't needed. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // yt-dlp writes progress to stderr: without this the error tail gets swamped by progress.
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function tail(text, limit = 600) {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

// --- external binaries -------------------------------------------------------

async function isExecutable(file) {
  try {
    await fs.promises.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function downloadTo(url, target, { gunzip = false } = {}) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || response.body === null) {
      fail(`не скачался ${url}: HTTP ${response.status}`);
    }
    const source = Readable.fromWeb(response.body);
    const sink = fs.createWriteStream(tmp);
    await pipeline(source, ...(gunzip ? [createGunzip()] : []), sink);
    await fs.promises.chmod(tmp, 0o755);
    await fs.promises.rename(tmp, target);
    return target;
  } catch (caught) {
    await fs.promises.rm(tmp, { force: true });
    if (caught instanceof ToolError) throw caught;
    fail(`не скачался ${url}: ${String(caught?.message ?? caught)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Path to the binary. Order: environment variable (tests and special builds) →
 * already downloaded in the cache → download. We download only what's actually needed:
 * ffmpeg is called only when the audio doesn't fit the upload limit.
 */
async function ensureBinary(kind) {
  const override = kind === 'yt-dlp' ? envText('VIDEO_BLOG_YTDLP') : envText('VIDEO_BLOG_FFMPEG');
  if (override !== '') return override;
  const target = path.join(config().binDir, kind);
  if (await isExecutable(target)) return target;
  const source = kind === 'yt-dlp' ? YTDLP_URL : FFMPEG_URL;
  log(`скачиваю ${kind} → ${target}`);
  await downloadTo(source, target, { gunzip: kind === 'ffmpeg' });
  log(`${kind} готов: ${humanSize((await fs.promises.stat(target)).size)}`);
  return target;
}

async function binaryVersion(kind) {
  const override = kind === 'yt-dlp' ? envText('VIDEO_BLOG_YTDLP') : envText('VIDEO_BLOG_FFMPEG');
  const cached = path.join(config().binDir, kind);
  if (override === '' && !(await isExecutable(cached))) return null;
  const command = override !== '' ? override : cached;
  try {
    const args = kind === 'yt-dlp' ? ['--version'] : ['-hide_banner', '-version'];
    const result = await run(command, args);
    if (result.code !== 0) return null;
    const first = result.stdout.split('\n').find((line) => line.trim() !== '') ?? '';
    return { path: command, version: kind === 'yt-dlp' ? first.trim() : (first.split(' ')[2] ?? '').trim() };
  } catch {
    return null;
  }
}

// --- yt-dlp ------------------------------------------------------------------

async function ytdlpFetch(url, extraArgs = [], timeoutMs = 60_000) {
  const binary = await ensureBinary('yt-dlp');
  const result = await run(
    binary,
    ['--js-runtimes', 'node', '--no-playlist', '--no-warnings', ...extraArgs, url],
    { timeout: timeoutMs },
  );
  return result;
}

async function probe(url) {
  const result = await ytdlpFetch(url, ['-J'], 120_000);
  if (result.code !== 0) {
    fail(`yt-dlp не смог прочитать видео: ${tail(result.stderr, 400) || 'пустой ответ'}`);
  }
  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    fail('yt-dlp вернул не JSON: похоже, ссылка не на видео или сайт отдал страницу-заглушку');
  }
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    fail('это плейлист или поиск, а не один ролик: дай ссылку на конкретное видео');
  }
  return {
    title: info.title ?? 'Без названия',
    uploader: info.uploader ?? info.channel ?? '',
    date: info.upload_date ?? '',
    duration: Number(info.duration) || 0,
    description: (info.description ?? '').trim(),
    url: info.webpage_url ?? url,
  };
}

async function downloadAudio(url, directory) {
  await fs.promises.mkdir(directory, { recursive: true });
  // We take the raw audio stream (m4a/opus) and don't run it through ffmpeg: Whisper
  // accepts both webm and m4a, and an extra re-encode is both time and an extra
  // binary in the dependencies. ffmpeg is needed only for splitting a long file.
  const result = await ytdlpFetch(
    url,
    ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '-o', path.join(directory, 'audio.%(ext)s')],
    30 * 60_000,
  );
  const files = (await fs.promises.readdir(directory))
    .filter((name) => name.startsWith('audio.') && !name.endsWith('.part'))
    .map((name) => path.join(directory, name));
  if (files.length === 0) {
    fail(`звук не скачался: ${tail(result.stderr, 400) || 'yt-dlp не оставил файла'}`);
  }
  const stats = await Promise.all(files.map(async (file) => ({ file, size: (await fs.promises.stat(file)).size })));
  const best = stats.sort((a, b) => b.size - a.size)[0];
  log(`аудио: ${path.basename(best.file)} (${humanSize(best.size)})`);
  return best.file;
}

// --- transcription -----------------------------------------------------------

async function splitAudio(file, directory) {
  const { maxUploadBytes, splitSeconds } = config();
  const ffmpeg = await ensureBinary('ffmpeg');
  const partsDir = path.join(directory, 'parts');
  await fs.promises.mkdir(partsDir, { recursive: true });
  log(`аудио больше ${humanSize(maxUploadBytes)} — режу на части по ${splitSeconds} с`);
  const result = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vn', '-ac', '1', '-b:a', '64k', '-c:a', 'libmp3lame',
    '-f', 'segment', '-segment_time', String(splitSeconds),
    path.join(partsDir, 'part_%03d.mp3'),
  ]);
  if (result.code !== 0) fail(`ffmpeg не смог разрезать аудио: ${tail(result.stderr, 400)}`);
  const parts = (await fs.promises.readdir(partsDir)).filter((n) => n.endsWith('.mp3')).sort();
  if (parts.length === 0) fail('ffmpeg отработал, но частей не осталось');
  return parts.map((name) => path.join(partsDir, name));
}

async function transcribeFile(file, { language, prompt }) {
  const { apiKey, baseUrl, asrModel } = config();
  if (apiKey === '') fail('нет ключа: задай DEEPINFRA_API_KEY (или VIDEO_BLOG_API_KEY) в окружении сервера');

  const body = new FormData();
  body.set('model', asrModel);
  body.set('response_format', 'verbose_json');
  body.set('chunk_level', 'segment');
  if (language) body.set('language', language);
  if (prompt) body.set('initial_prompt', String(prompt).slice(0, 900));
  const bytes = await fs.promises.readFile(file);
  body.set('file', new Blob([bytes]), path.basename(file));

  let response;
  try {
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body,
    });
  } catch (caught) {
    fail(`запрос к ${baseUrl} не ушёл: ${String(caught?.message ?? caught)}`);
  }
  const raw = await response.text();
  if (!response.ok) fail(`расшифровка не удалась (HTTP ${response.status}): ${tail(raw, 400)}`);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(`расшифровка вернула не JSON: ${tail(raw, 200)}`);
  }
  return {
    text: String(data.text ?? '').trim(),
    language: data.language ?? null,
    duration: Number(data.duration) || 0,
    segments: Array.isArray(data.segments)
      ? data.segments.map((segment) => ({
          start: Number(segment.start) || 0,
          end: Number(segment.end) || 0,
          text: String(segment.text ?? '').trim(),
        }))
      : [],
  };
}

async function transcribeAll(files, { language, prompt }) {
  const texts = [];
  const segments = [];
  let duration = 0;
  let detected = language ?? null;
  let carry = prompt;
  for (const [index, file] of files.entries()) {
    if (files.length > 1) log(`расшифровка части ${index + 1}/${files.length}`);
    const started = Date.now();
    const part = await transcribeFile(file, { language, prompt: carry });
    log(`часть ${index + 1}: ${humanTime(part.duration)} за ${Math.round((Date.now() - started) / 1000)} с`);
    if (part.text !== '') {
      texts.push(part.text);
      // The tail of the previous part as a hint for the next one: names and terms don't break at the seam.
      carry = part.text.slice(-400);
    }
    detected = part.language ?? detected;
    for (const segment of part.segments) {
      segments.push({ start: segment.start + duration, end: segment.end + duration, text: segment.text });
    }
    duration += part.duration;
  }
  return { text: texts.join('\n\n'), segments, duration, language: detected };
}

// --- rewriting into a post ---------------------------------------------------

const BLOG_SYSTEM = `Ты — опытный редактор. Ты получаешь сырой транскрипт видео и превращаешь его в блог-пост на языке {lang}.

Правила:
- Сохраняй аргументацию и интонацию говорящего; это блог-пост, а не конспект.
- Структура: один заголовок \`#\`, короткий вводный абзац-крючок, дальше разделы \`##\` с осмысленными подзаголовками, в конце — вывод.
- Убирай слова-заполнители, повторы и обрывы. Реплики вида [music] и [laughter] выбрасывай.
- Не придумывай факты, числа и цитаты, которых нет в транскрипте.
- Можно пересказывать и сокращать; яркие примеры, числа и удачные формулировки оставляй как есть.
- Объём — примерно половина транскрипта. Списки уместны только там, где говорящий сам перечисляет.
- Отвечай только Markdown, начиная с \`#\`. Без предисловий и без обёртки из тройных кавычек.`;

async function chat(messages, { maxTokens = 8000, temperature = 0.6 } = {}) {
  const { apiKey, baseUrl, llmModel } = config();
  if (apiKey === '') fail('нет ключа: задай DEEPINFRA_API_KEY (или VIDEO_BLOG_API_KEY) в окружении сервера');
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: llmModel, messages, temperature, max_tokens: maxTokens }),
    });
  } catch (caught) {
    fail(`запрос к ${baseUrl} не ушёл: ${String(caught?.message ?? caught)}`);
  }
  const raw = await response.text();
  if (!response.ok) fail(`модель не ответила (HTTP ${response.status}): ${tail(raw, 400)}`);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(`модель вернула не JSON: ${tail(raw, 200)}`);
  }
  const content = String(data.choices?.[0]?.message?.content ?? '').trim();
  if (content === '') fail('модель вернула пустой ответ — попробуй ещё раз или смени модель');
  return { content, usage: data.usage ?? {} };
}

async function writePost(transcript, meta, { outLang, style }) {
  const header = [
    `Источник: ${meta.title ?? ''}`,
    meta.uploader ? `Канал/автор: ${meta.uploader}` : '',
    meta.date ? `Опубликовано: ${meta.date}` : '',
    meta.url ? `Ссылка: ${meta.url}` : '',
    meta.duration ? `Длительность: ${humanTime(meta.duration)}` : '',
    meta.description ? `Исходное описание: ${String(meta.description).slice(0, 600)}` : '',
    style ? `Пожелания к стилю: ${style}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const system = BLOG_SYSTEM.replace('{lang}', outLang);
  const usage = {};

  if (transcript.length <= CHARS_PER_CHUNK) {
    const answer = await chat([
      { role: 'system', content: system },
      { role: 'user', content: `${header}\n\n=== ТРАНСКРИПТ ===\n${transcript}` },
    ]);
    return { post: answer.content, usage: answer.usage };
  }

  log(`транскрипт длинный (${transcript.length} знаков) — иду через map-reduce`);
  const chunks = [];
  for (let index = 0; index < transcript.length; index += CHARS_PER_CHUNK) {
    chunks.push(transcript.slice(index, index + CHARS_PER_CHUNK));
  }
  const digests = [];
  for (const [index, chunk] of chunks.entries()) {
    log(`сжимаю часть ${index + 1}/${chunks.length}`);
    const answer = await chat(
      [
        {
          role: 'system',
          content: `Сожми этот кусок транскрипта на языке ${outLang}, сохранив все факты, числа и примеры. Связный текст, без списков.`,
        },
        { role: 'user', content: chunk },
      ],
      { maxTokens: 2000 },
    );
    digests.push(answer.content);
    for (const [key, value] of Object.entries(answer.usage)) {
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
    }
  }
  const answer = await chat([
    { role: 'system', content: system },
    { role: 'user', content: `${header}\n\n=== СЖАТЫЕ ЧАСТИ ===\n${digests.join('\n\n---\n\n')}` },
  ]);
  for (const [key, value] of Object.entries(answer.usage)) {
    if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
  }
  return { post: answer.content, usage };
}

// --- result files ------------------------------------------------------------

async function resolveOutDir(requested) {
  const candidates = [];
  if (typeof requested === 'string' && requested.trim() !== '') candidates.push(path.resolve(requested));
  if (envText('VIDEO_BLOG_OUT_DIR') !== '') candidates.push(path.resolve(envText('VIDEO_BLOG_OUT_DIR')));
  candidates.push(path.join(process.cwd(), 'video-blog'));
  candidates.push(path.join(config().home, 'out'));
  for (const candidate of candidates) {
    try {
      await fs.promises.mkdir(candidate, { recursive: true });
      return candidate;
    } catch (caught) {
      log(`каталог ${candidate} не годится: ${String(caught?.message ?? caught)}`);
    }
  }
  fail('не нашёл, куда писать результат: передай out с путём внутри рабочей папки');
}

async function writeArtifacts(outDir, stem, { transcript, post, meta }) {
  const files = {};
  if (transcript !== undefined) {
    files.transcript = path.join(outDir, `${stem}.transcript.txt`);
    const body = meta.segments?.length
      ? meta.segments.map((segment) => `[${humanTime(segment.start)}] ${segment.text}`).join('\n')
      : transcript;
    await fs.promises.writeFile(files.transcript, body, 'utf8');
  }
  if (post !== undefined) {
    files.post = path.join(outDir, `${stem}.md`);
    await fs.promises.writeFile(files.post, post, 'utf8');
  }
  files.meta = path.join(outDir, `${stem}.meta.json`);
  await fs.promises.writeFile(files.meta, JSON.stringify(meta, null, 2), 'utf8');
  return files;
}

function stemFor(title) {
  return `${today()}-${slugify(title)}`;
}

function costLine(meta) {
  const asr = (meta.duration ?? 0) / 60 * ASR_USD_PER_MINUTE;
  const llm = Number(meta.llm_cost_usd ?? 0);
  const total = asr + llm;
  return `Стоимость: расшифровка $${asr.toFixed(4)} + модель $${llm.toFixed(4)} = $${total.toFixed(4)}`;
}

// --- tools -------------------------------------------------------------------

async function statusHandler(args = {}) {
  const outDirDefault = path.join(process.cwd(), 'video-blog');
  // We install the binaries before measuring: otherwise the report says "not downloaded" right after installation.
  if (args.install === true) {
    for (const kind of ['yt-dlp', 'ffmpeg']) await ensureBinary(kind);
  }
  const ytdlp = await binaryVersion('yt-dlp');
  const ffmpeg = await binaryVersion('ffmpeg');
  const lines = ['video-blog: состояние.'];
  lines.push(`- Ключ DeepInfra: ${config().apiKey === '' ? 'НЕТ — расшифровка и пост не заработают' : 'есть'}`);
  lines.push(`- Модель расшифровки: ${config().asrModel}`);
  lines.push(`- Модель редактора: ${config().llmModel}`);
  lines.push(`- yt-dlp: ${ytdlp ? `${ytdlp.version} (${ytdlp.path})` : 'не скачан'}`);
  lines.push(`- ffmpeg: ${ffmpeg ? `${ffmpeg.version} (нужен только для нарезки длинного аудио)` : 'не скачан'}`);
  lines.push(`- Кэш бинарников: ${config().binDir}`);
  lines.push(`- Папка по умолчанию: ${outDirDefault}`);
  lines.push(
    `- Лимит длительности: ${config().maxMinutes} мин; лимит одной загрузки: ${humanSize(config().maxUploadBytes)}`,
  );

  if (args.install === true) {
    lines.push('Бинарники на месте.');
  } else if (!ytdlp) {
    lines.push('Первый настоящий вызов скачает yt-dlp сам; blog_status с install: true сделает это заранее.');
  }
  return lines.join('\n');
}

async function prepareSource({ url, file }) {
  const hasUrl = typeof url === 'string' && url.trim() !== '';
  const hasFile = typeof file === 'string' && file.trim() !== '';
  if (hasUrl === hasFile) fail('нужна либо ссылка (url), либо путь к файлу (file) — ровно одно из двух');

  const workDir = await fs.promises.mkdtemp(path.join(config().workRoot, 'run-')).catch(async () => {
    await fs.promises.mkdir(config().workRoot, { recursive: true });
    return fs.promises.mkdtemp(path.join(config().workRoot, 'run-'));
  });

  if (hasFile) {
    const source = path.resolve(file.trim());
    let stat;
    try {
      stat = await fs.promises.stat(source);
    } catch {
      fail(`файл не найден: ${source}`);
    }
    return { audio: source, meta: { title: path.basename(source), url: '', duration: 0, size: stat.size }, workDir };
  }

  const info = await probe(url.trim());
  const limitSeconds = config().maxMinutes * 60;
  if (info.duration > limitSeconds) {
    fail(
      `видео длиной ${humanTime(info.duration)} — больше лимита ${config().maxMinutes} мин. ` +
        'Если это осознанно, подними VIDEO_BLOG_MAX_MINUTES у сервера и позови снова.',
    );
  }
  const audio = await downloadAudio(info.url, workDir);
  const size = (await fs.promises.stat(audio)).size;
  if (size > config().maxUploadBytes * 8 + 1024 * 1024) {
    fail(`звук весит ${humanSize(size)} — это не похоже на один разговор; проверь ссылку`);
  }
  return { audio, meta: { ...info, duration: info.duration }, workDir };
}

async function transcribeSource(source, language) {
  const { audio, meta, workDir } = source;
  const size = (await fs.promises.stat(audio)).size;
  const files = size > config().maxUploadBytes ? await splitAudio(audio, workDir) : [audio];
  const result = await transcribeAll(files, { language, prompt: meta.title });
  if (result.text === '') {
    fail('транскрипт пустой: в этом файле либо нет речи, либо она не распозналась');
  }
  return result;
}

async function videoTranscribeHandler(args = {}) {
  const includeText = args.include_text !== false;
  const source = await prepareSource({ url: args.url, file: args.file });
  const result = await transcribeSource(source, args.lang);
  const outDir = await resolveOutDir(args.out);
  const stem = stemFor(source.meta.title);
  const meta = {
    title: source.meta.title,
    uploader: source.meta.uploader ?? null,
    date: source.meta.date ?? null,
    url: source.meta.url ?? null,
    duration: result.duration || source.meta.duration || 0,
    language: result.language,
    words: result.text.split(/\s+/).filter(Boolean).length,
    asr_cost_usd: Number(((result.duration || source.meta.duration || 0) / 60 * ASR_USD_PER_MINUTE).toFixed(6)),
  };
  const files = await writeArtifacts(outDir, stem, { transcript: result.text, meta: { ...meta, segments: result.segments } });
  await cleanup(source.workDir, args.keep_audio);

  const lines = [
    'Расшифровка готова.',
    `- Видео: ${meta.title}${meta.uploader ? ` — ${meta.uploader}` : ''}`,
    `- Длительность: ${humanTime(meta.duration)}${meta.language ? `, язык: ${meta.language}` : ''}`,
    `- Слов: ${meta.words}`,
    `- Транскрипт: ${files.transcript}`,
    `- Стоимость: $${meta.asr_cost_usd.toFixed(4)}`,
  ];
  if (includeText) lines.push('', '--- ТРАНСКРИПТ ---', result.text);
  else lines.push('', 'Полный текст — в файле; он не вставлен сюда, чтобы не занимать разговор.');
  return lines.join('\n');
}

async function videoToBlogHandler(args = {}) {
  const includeText = args.include_text !== false;
  const source = await prepareSource({ url: args.url, file: args.file });
  const result = await transcribeSource(source, args.lang);
  const outLang = args.out_lang || args.lang || result.language || 'ru';
  const outDir = await resolveOutDir(args.out);
  const stem = stemFor(args.title || source.meta.title);
  const { post, usage } = await writePost(result.text, { ...source.meta, duration: result.duration }, {
    outLang,
    style: args.style,
  });

  let body = post;
  if (!body.startsWith('#')) body = `# ${source.meta.title}\n\n${body}`;
  if (source.meta.url && !body.includes(source.meta.url)) {
    body += `\n\n---\n\n*Источник: [${source.meta.title}](${source.meta.url})${source.meta.uploader ? ` — ${source.meta.uploader}` : ''}.*\n`;
  }

  const meta = {
    title: source.meta.title,
    uploader: source.meta.uploader ?? null,
    date: source.meta.date ?? null,
    url: source.meta.url ?? null,
    duration: result.duration || source.meta.duration || 0,
    language: result.language,
    out_language: outLang,
    style: args.style ?? null,
    transcript_words: result.text.split(/\s+/).filter(Boolean).length,
    asr_cost_usd: Number(((result.duration || source.meta.duration || 0) / 60 * ASR_USD_PER_MINUTE).toFixed(6)),
    llm_cost_usd: Number(usage.estimated_cost ?? 0),
    llm_usage: usage,
  };
  const files = await writeArtifacts(outDir, stem, {
    transcript: result.text,
    post: body,
    meta: { ...meta, segments: result.segments },
  });
  await cleanup(source.workDir, args.keep_audio);

  const lines = [
    'Блог-пост готов.',
    `- Видео: ${meta.title}${meta.uploader ? ` — ${meta.uploader}` : ''}`,
    `- Длительность: ${humanTime(meta.duration)}`,
    `- Пост: ${files.post}`,
    `- Транскрипт: ${files.transcript}`,
    `- Язык поста: ${outLang}`,
    `- ${costLine(meta)}`,
  ];
  if (includeText) lines.push('', '--- ПОСТ ---', body);
  else lines.push('', 'Пост лежит в файле; include_text: true вернул бы его целиком.');
  return lines.join('\n');
}

async function blogFromTranscriptHandler(args = {}) {
  const includeText = args.include_text !== false;
  const inline = typeof args.transcript === 'string' ? args.transcript.trim() : '';
  const fromFile = typeof args.transcript_path === 'string' ? args.transcript_path.trim() : '';
  if ((inline === '') === (fromFile === '')) {
    fail('нужен либо transcript (текстом), либо transcript_path (файл) — ровно одно из двух');
  }
  let transcript = inline;
  let sourcePath = '';
  if (fromFile !== '') {
    sourcePath = path.resolve(fromFile);
    try {
      transcript = (await fs.promises.readFile(sourcePath, 'utf8')).trim();
    } catch {
      fail(`не прочитал транскрипт: ${sourcePath}`);
    }
  }
  if (transcript === '') fail('транскрипт пустой — переписывать нечего');

  const outLang = args.out_lang || 'ru';
  const outDir = await resolveOutDir(args.out);
  const title = args.title || path.basename(sourcePath, path.extname(sourcePath)) || 'Блог-пост';
  const meta = { title, url: args.source_url ?? null, duration: 0, style: args.style ?? null };
  const { post, usage } = await writePost(transcript, meta, { outLang, style: args.style });

  let body = post;
  if (!body.startsWith('#')) body = `# ${title}\n\n${body}`;
  const stem = stemFor(title);
  const files = await writeArtifacts(outDir, stem, { post: body, meta: { ...meta, out_language: outLang, llm_usage: usage } });

  const lines = [
    'Пост собран из готового транскрипта.',
    `- Пост: ${files.post}`,
    `- Язык поста: ${outLang}`,
    `- Стоимость модели: $${Number(usage.estimated_cost ?? 0).toFixed(4)}`,
  ];
  if (includeText) lines.push('', '--- ПОСТ ---', body);
  return lines.join('\n');
}

async function cleanup(workDir, keep) {
  if (keep === true) {
    log(`аудио оставлено: ${workDir}`);
    return;
  }
  await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

// --- protocol ----------------------------------------------------------------

const TOOLS = [
  {
    name: 'blog_status',
    description:
      'Состояние video-blog: есть ли ключ DeepInfra, скачаны ли yt-dlp и ffmpeg, какая папка и модели по умолчанию. С install: true заранее скачивает бинарники (первый вызов ускоряется, идёт ~минуту). Ничего не расшифровывает и не тратит денег.',
    inputSchema: {
      type: 'object',
      properties: {
        install: { type: 'boolean', description: 'скачать yt-dlp и ffmpeg сейчас, а не при первом видео' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'video_transcribe',
    description:
      'Расшифровать видео или локальный аудиофайл в текст. Ссылка (url) или путь (file) — ровно одно. Кладёт транскрипт с таймкодами в рабочую папку и возвращает путь; сам текст возвращает только при include_text: true (для длинных записей лучше false). Стоит около $0.0002 за минуту.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'ссылка на видео (YouTube и всё, что понимает yt-dlp)' },
        file: { type: 'string', description: 'путь к локальному аудио или видео в контейнере' },
        lang: { type: 'string', description: 'язык речи, ISO-639-1 (например en, ru); без него определяется сам' },
        out: { type: 'string', description: 'куда положить файлы; по умолчанию <рабочая папка>/video-blog' },
        include_text: { type: 'boolean', description: 'вернуть и сам текст (по умолчанию да)' },
        keep_audio: { type: 'boolean', description: 'оставить скачанное аудио для отладки' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'video_to_blog',
    description:
      'Главный инструмент: видео на входе — готовый Markdown-блог-пост на выходе. Скачивает звук, расшифровывает его и переписывает в пост с заголовком и разделами. Рядом кладёт транскрипт и метаданные. Тратит около $0.002 на пятиминутное видео.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'ссылка на видео (YouTube и всё, что понимает yt-dlp)' },
        file: { type: 'string', description: 'путь к локальному аудио или видео в контейнере (вместо url)' },
        lang: { type: 'string', description: 'язык речи, ISO-639-1; без него определяется сам' },
        out_lang: { type: 'string', description: 'язык самого поста (по умолчанию — язык речи)' },
        style: { type: 'string', description: 'пожелания к стилю: «критично», «для разработчиков», «коротко» ' },
        title: { type: 'string', description: 'заголовок и имя файла вместо названия видео' },
        out: { type: 'string', description: 'куда положить файлы; по умолчанию <рабочая папка>/video-blog' },
        include_text: { type: 'boolean', description: 'вернуть и сам пост (по умолчанию да)' },
        keep_audio: { type: 'boolean', description: 'оставить скачанное аудио' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'blog_from_transcript',
    description:
      'Собрать пост из уже готового транскрипта — текстом (transcript) или файлом (transcript_path). Расшифровка не запускается, только модель-редактор. Годится для подкастов и записей, у которых текст уже есть.',
    inputSchema: {
      type: 'object',
      properties: {
        transcript: { type: 'string', description: 'текст транскрипта прямо в вызове' },
        transcript_path: { type: 'string', description: 'путь к файлу транскрипта (вместо transcript)' },
        title: { type: 'string', description: 'заголовок поста и имя файла' },
        out_lang: { type: 'string', description: 'язык поста (по умолчанию ru)' },
        style: { type: 'string', description: 'пожелания к стилю' },
        source_url: { type: 'string', description: 'ссылка на источник — попадёт в метаданные' },
        out: { type: 'string', description: 'куда положить файлы' },
        include_text: { type: 'boolean', description: 'вернуть и сам пост (по умолчанию да)' },
      },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  blog_status: (args) => statusHandler(args),
  video_transcribe: (args) => videoTranscribeHandler(args),
  video_to_blog: (args) => videoToBlogHandler(args),
  blog_from_transcript: (args) => blogFromTranscriptHandler(args),
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    };
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = HANDLERS[name];
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `неизвестный инструмент: ${String(name)}` }], isError: true },
      };
    }
    try {
      const text = await handler(args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (caught) {
      const message = caught instanceof ToolError ? caught.message : String(caught?.message ?? caught);
      if (!(caught instanceof ToolError)) log(String(caught?.stack ?? caught));
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } };
    }
  }
  if (id === undefined || id === null) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
}

function serveStdio() {
  let buffer = '';
  let inflight = 0;
  const idle = (maxMs = 10_000) =>
    new Promise((resolve) => {
      const deadline = Date.now() + maxMs;
      const tick = () => (inflight === 0 || Date.now() > deadline ? resolve() : setTimeout(tick, 20));
      tick();
    });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      inflight += 1;
      dispatch(message)
        .then((response) => {
          if (response) send(response);
        })
        .catch((error) => log(String(error?.stack ?? error)))
        .finally(() => {
          inflight -= 1;
        });
    }
  });
  process.stdin.on('end', async () => {
    await idle();
    process.exit(0);
  });
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) serveStdio();

export { INSTRUCTIONS, TOOLS, dispatch, ensureBinary, serveStdio, config, slugify, humanTime, humanSize };
