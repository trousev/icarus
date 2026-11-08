#!/usr/bin/env node
// Артефакты: MCP-сервер, который объясняет агенту, куда класть готовые вещи,
// откуда их брать и как показать человеку.
//
// Отдельного «создателя артефактов» нет намеренно: pi уже умеет писать файлы, а
// структура простая. Сервер нужен для трёх вещей, которых файловые инструменты
// не знают: где именно лежат артефакты в текущем workspace, как прочитать
// index.ai.md вместо разбора HTML и как получить публичную ссылку.
//
// Артефакт — папка `artifacts/<slug>/`:
//   index.html | index.md | index.png|jpg|svg — то, что видит человек;
//   index.ai.md — описание для ИИ;
//   остальные файлы — ассеты, на которые ссылается index.
//
// Публичная ссылка — случайный publicId в `.artifact.json`, а не имя папки.
// `artifact_link` создаёт его в момент, когда ссылку действительно просят.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'artifacts', version: '1.0.0' };
const META_FILE = '.artifact.json';
const AI_FILE = 'index.ai.md';
const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;

const INDEX_FILES = [
  { file: 'index.html', type: 'html' },
  { file: 'index.htm', type: 'html' },
  { file: 'index.md', type: 'markdown' },
  { file: 'index.png', type: 'image' },
  { file: 'index.jpg', type: 'image' },
  { file: 'index.jpeg', type: 'image' },
  { file: 'index.svg', type: 'image' },
  { file: 'index.webp', type: 'image' },
  { file: 'index.gif', type: 'image' },
];

const TYPE_LABELS = {
  html: 'HTML-страница',
  markdown: 'Markdown-документ',
  image: 'Изображение',
};

const WORKSPACE = process.cwd();
const ARTIFACTS = path.join(WORKSPACE, 'artifacts');
const PUBLIC_BASE = (process.env.ICARUS_URL ?? '').replace(/\/+$/, '');
const USER_ID = (process.env.ICARUS_USER_ID ?? '').trim();
const WORKSPACE_ID = (process.env.ICARUS_WORKSPACE ?? path.basename(WORKSPACE)).trim();

const INSTRUCTIONS = `Артефакт — это готовая вещь для человека: страница, документ или картинка. Он живёт в папке artifacts/<slug>/ текущей рабочей папки. Специального инструмента создания нет: создавай папку и файлы обычными файловыми инструментами. slug — короткое латинское имя в нижнем регистре через дефис: plan-na-chetverg, otchet-atlas.

Внутри папки ровно один index-файл, который видит человек:
- index.html — HTML-страница;
- index.md — markdown-документ;
- index.png, index.jpg или index.svg — изображение.
И всегда index.ai.md — короткое описание для ИИ: заголовок H1, о чём артефакт, что внутри, что можно менять. Его пиши для каждого артефакта: по нему модель понимает содержимое, не разбирая HTML и не глядя на картинку.

Остальные файлы (style.css, картинки, шрифты) лежат рядом с index; ссылки внутри HTML — относительные, без внешних CDN, если без них страница ломается. Секреты, токены и чужие персональные данные в артефакт не клади.

Порядок работы:
1. Посмотри, что уже есть: artifact_list.
2. Создай папку artifacts/<slug>/ и файлы: сначала index.ai.md, потом index.
3. Проверь структуру: artifact_check.
4. Дай человеку ссылку В ПАНЕЛИ: artifact_link без public — это обычная ссылка. Публичную ссылку (любой, у кого есть адрес) создавай только по прямой просьбе: «публичная», «поделиться», «открыть без входа» — тогда artifact_link с public: true. Не выдавай публичную вместо обычной.
5. Если артефакт уже существует — не плоди второй, а правь его; перед правкой прочитай artifact_read.

Как читать: artifact_list, затем artifact_read — он отдаёт index.ai.md и список файлов. HTML не парсь.`;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(message) {
  process.stderr.write(`[artifacts] ${message}\n`);
}

function validName(name) {
  if (typeof name !== 'string') return false;
  for (const char of name) if (char.charCodeAt(0) < 32) return false;
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

function safeJoin(root, ...segments) {
  const full = path.resolve(root, ...segments);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readSmall(file, limit = 256 * 1024) {
  const stats = statOrNull(file);
  if (!stats?.isFile() || stats.size > limit) return null;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function stripMarkdown(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFrontmatter(text) {
  const source = String(text).replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return source;
  return source.slice(end + 4).replace(/^\s*\n/, '');
}

function titleOf(slug, ai, document) {
  if (ai) {
    const text = stripFrontmatter(ai);
    const heading = /^\s*#\s+(.+?)\s*$/m.exec(text)?.[1];
    if (heading) return stripMarkdown(heading);
    const first = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && line !== '---' && !line.startsWith('#'));
    if (first) return stripMarkdown(first).slice(0, 90);
  }
  if (document) {
    const text = stripFrontmatter(document);
    const heading = /^\s*#\s+(.+?)\s*$/m.exec(text)?.[1];
    if (heading) return stripMarkdown(heading).slice(0, 90);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(document)?.[1];
    if (title) return stripMarkdown(title.replace(/\s+/g, ' ').trim()).slice(0, 90);
  }
  const human = slug.replace(/[-_]+/g, ' ').trim();
  return human === '' ? slug : human.charAt(0).toUpperCase() + human.slice(1);
}

function summaryOf(ai) {
  if (!ai) return '';
  for (const paragraph of stripFrontmatter(ai).split(/\n\s*\n/)) {
    const lines = paragraph
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '---' && !line.startsWith('#') && !line.startsWith('```'));
    if (lines.length === 0) continue;
    const text = stripMarkdown(lines.join(' '));
    if (text) return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  }
  return '';
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} Кб`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Мб`;
}

function detectEntry(dir) {
  let names;
  try {
    names = new Set(fs.readdirSync(dir));
  } catch {
    return null;
  }
  return INDEX_FILES.find((candidate) => names.has(candidate.file)) ?? null;
}

function readMeta(dir) {
  const text = readSmall(path.join(dir, META_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.publicId !== 'string' || !PUBLIC_ID.test(parsed.publicId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeMeta(dir, meta) {
  const file = path.join(dir, META_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  // 0644: publicId — не секрет, а читать метку может и сервис на хосте (другой uid).
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, ...meta }, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function urlsOf(slug, entry, publicId) {
  const user = encodeURIComponent(USER_ID);
  const workspace = encodeURIComponent(WORKSPACE_ID);
  const artifact = encodeURIComponent(slug);
  const entryPath = String(entry).split('/').map(encodeURIComponent).join('/');
  const relativePanel = `/panel/artifacts?${new URLSearchParams({ workspace: WORKSPACE_ID, artifact: slug }).toString()}`;
  const panel = PUBLIC_BASE ? `${PUBLIC_BASE}${relativePanel}` : relativePanel;
  if (!PUBLIC_BASE || !USER_ID || !publicId) {
    return { panel, raw: panel };
  }
  const pub = `${PUBLIC_BASE}/a/${user}/${workspace}/${artifact}/${publicId}/`;
  return { panel, raw: `${PUBLIC_BASE}/panel/artifacts/raw/${workspace}/${artifact}/${entryPath}`, public: pub, bare: `${pub}?bare=1` };
}

function listFiles(dir, prefix = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), `${relative}/`));
      continue;
    }
    if (entry.isFile()) files.push(relative);
    if (files.length >= 400) return files.slice(0, 400);
  }
  return files;
}

function inspect(slug) {
  if (!validName(slug)) return null;
  const dir = safeJoin(ARTIFACTS, slug);
  if (!dir?.startsWith(ARTIFACTS + path.sep)) return null;
  let link;
  try {
    link = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (link.isSymbolicLink()) return null;
  const stats = statOrNull(dir);
  if (!stats?.isDirectory()) return null;
  const entry = detectEntry(dir);
  if (!entry) return null;
  const entryPath = path.join(dir, entry.file);
  const entryStats = statOrNull(entryPath);
  if (!entryStats?.isFile()) return null;
  try {
    if (fs.lstatSync(entryPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const ai = readSmall(path.join(dir, AI_FILE));
  const document =
    ai === null && (entry.type === 'html' || entry.type === 'markdown')
      ? readSmall(path.join(dir, entry.file))
      : null;
  const meta = readMeta(dir);
  return {
    name: slug,
    dir,
    title: titleOf(slug, ai, document),
    summary: summaryOf(ai),
    type: entry.type,
    typeLabel: TYPE_LABELS[entry.type],
    entry: entry.file,
    size: entryStats.size,
    updatedAt: entryStats.mtime.toISOString(),
    ai: ai !== null,
    aiContent: ai,
    files: listFiles(dir),
    publicId: meta?.publicId,
    urls: urlsOf(slug, entry.file, meta?.publicId),
  };
}

function listAll() {
  let entries;
  try {
    entries = fs.readdirSync(ARTIFACTS, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const artifact = inspect(entry.name);
    if (artifact) items.push(artifact);
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'ru'));
}

function ensurePublicId(slug) {
  if (!PUBLIC_BASE || !USER_ID) {
    throw new Error('публичная ссылка недоступна: серверу не передали ICARUS_URL или ICARUS_USER_ID');
  }
  const artifact = inspect(slug);
  if (!artifact) throw new Error(`артефакт «${slug}» не найден: в папке artifacts/${slug} нет index.html, index.md или index.png`);
  if (artifact.publicId) return { artifact, publicId: artifact.publicId };
  const publicId = crypto.randomBytes(18).toString('base64url');
  const now = new Date().toISOString();
  writeMeta(artifact.dir, { publicId, createdAt: now, updatedAt: now });
  const next = inspect(slug) ?? artifact;
  return { artifact: next, publicId };
}

function problemsOf(slug) {
  const dir = safeJoin(ARTIFACTS, slug);
  if (!dir || !validName(slug)) return ['имя папки не годится'];
  const stats = statOrNull(dir);
  if (!stats?.isDirectory()) return ['папки нет'];
  const indexes = INDEX_FILES.filter((candidate) => statOrNull(path.join(dir, candidate.file))?.isFile());
  const problems = [];
  if (indexes.length === 0) problems.push('нет index.html, index.md или index.png/jpg/svg');
  if (indexes.length > 1) problems.push(`index-файлов больше одного: ${indexes.map((item) => item.file).join(', ')}`);
  const ai = readSmall(path.join(dir, AI_FILE));
  if (ai === null) problems.push(`нет ${AI_FILE} — описания для ИИ`);
  else if (ai.trim() === '') problems.push(`${AI_FILE} пустой`);
  return problems;
}

function listText(items, query) {
  const filtered = items.filter((item) => {
    if (!query) return true;
    const needle = query.toLowerCase();
    return (
      item.title.toLowerCase().includes(needle) ||
      item.name.toLowerCase().includes(needle) ||
      item.summary.toLowerCase().includes(needle) ||
      (item.aiContent ?? '').toLowerCase().includes(needle)
    );
  });
  if (filtered.length === 0) {
    return items.length === 0
      ? 'Артефактов пока нет. Создай папку artifacts/<slug>/ с index.ai.md и index-файлом.'
      : `По запросу «${query}» ничего не нашлось. Всего артефактов: ${items.length}.`;
  }
  const lines = [`Артефакты (${filtered.length}${query ? ` из ${items.length}` : ''}):`];
  for (const item of filtered) {
    lines.push('');
    lines.push(`## ${item.title}`);
    lines.push(
      `- папка: artifacts/${item.name}/; тип: ${item.typeLabel}; размер: ${humanSize(item.size)}; обновлён: ${item.updatedAt.slice(0, 16).replace('T', ' ')}`,
    );
    lines.push(`- описание для ИИ: ${item.ai ? `${AI_FILE} есть` : `${AI_FILE} НЕТ — добавь его`}`);
    if (item.summary) lines.push(`- коротко: ${item.summary}`);
    lines.push(`- файлы: ${item.files.join(', ')}`);
    lines.push(`- ссылка в панели: ${item.urls.panel}`);
    if (item.urls.public) lines.push(`- публичная ссылка: ${item.urls.public}`);
    else lines.push('- публичной ссылки нет (по умолчанию не создаётся; только по просьбе — artifact_link с public: true)');
  }
  return lines.join('\n');
}

function readText(slug) {
  const artifact = inspect(slug);
  if (!artifact) {
    throw new Error(
      `артефакт «${slug}» не найден или в его папке нет index-файла. Список: artifact_list.`,
    );
  }
  const lines = [
    `# ${artifact.title}`,
    '',
    `- папка: artifacts/${artifact.name}/`,
    `- тип: ${artifact.typeLabel} (${artifact.entry})`,
    `- размер: ${humanSize(artifact.size)}`,
    `- обновлён: ${artifact.updatedAt}`,
    `- файлы: ${artifact.files.join(', ')}`,
    `- ссылка в панели: ${artifact.urls.panel}`,
    ...(artifact.urls.public ? [`- публичная ссылка: ${artifact.urls.public}`, `- без панели: ${artifact.urls.bare}`] : []),
    '',
    artifact.ai
      ? `## ${AI_FILE}\n\n${artifact.aiContent}`
      : `## ${AI_FILE} отсутствует\n\nАртефакт неполный: добавь описание для ИИ — заголовок H1, о чём он, что внутри, что можно менять.`,
  ];
  if (artifact.type === 'markdown') {
    const content = readSmall(path.join(artifact.dir, artifact.entry));
    if (content !== null) {
      lines.push('', `## ${artifact.entry}`, '', content);
    }
  }
  return { text: lines.join('\n'), artifact };
}

function linkText(slug, makePublic = false) {
  const artifact = inspect(slug);
  if (!artifact) {
    throw new Error(`артефакт «${slug}» не найден: в папке artifacts/${slug} нет index.html, index.md или index.png`);
  }
  if (!makePublic) {
    return [
      `Ссылка на «${artifact.title}» в панели:`,
      '',
      artifact.urls.panel,
      '',
      'Это обычная внутренняя ссылка: человек должен быть в панели. Публичную ссылку создавай только по прямой просьбе — artifact_link с public: true.',
    ].join('\n');
  }
  const { artifact: linked } = ensurePublicId(slug);
  return [
    `Публичная ссылка на «${linked.title}»:`,
    '',
    `- в панели: ${linked.urls.public}`,
    `- без панели: ${linked.urls.bare}`,
    `- ссылка на панель (только для вошедших): ${linked.urls.panel}`,
    '',
    'Отдай человеку публичную ссылку. `?bare=1` — тот же артефакт без панели.',
  ].join('\n');
}

function checkText(slug) {
  const items = slug ? [slug] : listAll().map((item) => item.name);
  if (items.length === 0) {
    return 'Артефактов нет. Создай папку artifacts/<slug>/ с index.ai.md и index.html, index.md или index.png.';
  }
  const lines = [];
  let bad = 0;
  for (const name of items) {
    const problems = problemsOf(name);
    if (problems.length === 0) {
      lines.push(`✓ artifacts/${name}/ — в порядке`);
    } else {
      bad += 1;
      lines.push(`✗ artifacts/${name}/ — ${problems.join('; ')}`);
    }
  }
  lines.push('', bad === 0 ? 'Все артефакты полные.' : `Неполных артефактов: ${bad}.`);
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'artifact_list',
    description:
      'Список артефактов в текущей рабочей папке: название, тип, размер, описание для ИИ, ссылки. Вызывай перед созданием, чтобы не плодить дубликаты, и чтобы показать человеку, что уже есть.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Необязательный поиск по названию, описанию и тексту index.ai.md.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_read',
    description:
      'Прочитать артефакт так, как его понимает ИИ: index.ai.md, список файлов и ссылки. Для markdown — ещё и сам текст. HTML и картинки не парси: всё нужное уже в index.ai.md.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя папки артефакта в artifacts/.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_link',
    description:
      'Ссылка на артефакт. По умолчанию возвращает внутреннюю ссылку в панели — её и давай человеку. Публичная ссылка (любой, у кого есть адрес) создаётся только при public: true и только по прямой просьбе.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя папки артефакта в artifacts/.' },
        public: { type: 'boolean', description: 'Создать публичную ссылку. Только по прямой просьбе человека.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_check',
    description:
      'Проверить структуру артефактов: есть ли index-файл, нет ли второго, на месте ли index.ai.md. Без name проверяет все.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя папки артефакта; без него проверяются все.' } },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  artifact_list: (args) => listText(listAll(), typeof args.query === 'string' ? args.query.trim() : ''),
  artifact_read: (args) => readText(String(args.name ?? '')).text,
  artifact_link: (args) => linkText(String(args.name ?? ''), args.public === true),
  artifact_check: (args) => checkText(typeof args.name === 'string' ? args.name : ''),
};

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
        result: { content: [{ type: 'text', text: `неизвестный инструмент: ${name}` }], isError: true },
      };
    }
    try {
      const text = await handler(args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: String(error?.message ?? error) }],
          isError: true,
        },
      };
    }
  }
  if (id === undefined || id === null) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
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
      if (!line) continue;
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

// Запускаемся только как самостоятельный сервер: тесты импортируют helpers.
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) serveStdio();

export {
  ARTIFACTS,
  INSTRUCTIONS,
  TOOLS,
  checkText,
  inspect,
  linkText,
  listAll,
  listText,
  problemsOf,
  readText,
  urlsOf,
  validName,
};
