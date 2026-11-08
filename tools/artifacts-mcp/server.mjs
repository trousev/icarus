#!/usr/bin/env node
// Артефакты: MCP-сервер, который объясняет агенту, куда класть готовые вещи,
// откуда их брать и как показать человеку.
//
// Артефакты — глобальная библиотека `/artifacts`, общая для всех людей. Доступ
// к папкам решают права `.folder-acl.json`: у каждого артефакта есть владелец,
// а уровни read ⊂ write ⊂ admin задаются отдельно для «меня» и «семьи».
// Файловые инструменты pi блокирует generic folder-guard, поэтому читать и
// писать здесь можно только то, что разрешено.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'artifacts', version: '2.0.0' };
const ARTIFACTS = path.resolve(process.env.ICARUS_ARTIFACTS_DIR ?? '/artifacts');
const USER_ID = (process.env.ICARUS_USER_ID ?? '').trim();
const PUBLIC_BASE = (process.env.ICARUS_URL ?? '').replace(/\/+$/, '');

const META_FILE = '.artifact.json';
const ACL_FILE = '.folder-acl.json';
const AI_FILE = 'index.ai.md';
const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;
const LEVELS = { read: 1, write: 2, admin: 3 };
const isLevel = (value) => value === 'read' || value === 'write' || value === 'admin';
const DEFAULT_ACL = { me: 'admin', family: 'read' };

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

const INSTRUCTIONS = `Артефакты — ОБЩАЯ библиотека в /artifacts, а не в рабочей папке. Один артефакт — папка /artifacts/<slug>/: внутри index.html, index.md или index.png/jpg/svg, обязательный index.ai.md и ассеты рядом. slug — короткое латинское имя в нижнем регистре через дефис: plan-na-chetverg, otchet-atlas.

Создание:
1. artifact_new(name) — заводит папку и права. Без него писать в /artifacts нельзя: folder-guard блокирует файлы.
2. Напиши index.ai.md (H1, о чём артефакт, что внутри, что можно менять) и index-файл обычными write.
3. artifact_check — проверь структуру.
4. artifact_link — дай человеку ВНУТРЕННЮЮ ссылку в панели. Публичную создавай только по прямой просьбе: «публичная», «поделиться», «без входа» — artifact_link с public: true. Публичная требует прав admin.

Права у папки: owner и acl { me, family }, уровни read < write < admin (write умеет читать, admin — ещё права/удаление/публичную ссылку). Владелец всегда управляет своим артефактом; family по умолчанию read. Не обещай изменить права, если ты не владелец и не admin: это делает панель.

Читать чужие артефакты можно в пределах прав; HTML не парсь — artifact_read отдаёт index.ai.md и список файлов. Если инструмент заблокирован правами — это не ошибка сети, а запрет: честно скажи человеку, что доступа нет.`;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(message) {
  process.stderr.write(`[artifacts] ${message}\n`);
}

function requireUser() {
  if (!USER_ID) throw new Error('не задан ICARUS_USER_ID: непонятно, чьи права проверять');
  return USER_ID;
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

function realDirOrNull(dir) {
  try {
    const stats = fs.lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
    return dir;
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

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, file);
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
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
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
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
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
      if (files.length >= 400) return files.slice(0, 400);
      continue;
    }
    if (entry.isFile()) files.push(relative);
  }
  return files;
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

function readAcl(dir) {
  const text = readSmall(path.join(dir, ACL_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.owner !== 'string' || parsed.owner.trim() === '') return null;
    if (!parsed.acl || typeof parsed.acl !== 'object') return null;
    if (!isLevel(parsed.acl.me) || !isLevel(parsed.acl.family)) return null;
    return { owner: parsed.owner, acl: { me: parsed.acl.me, family: parsed.acl.family } };
  } catch {
    return null;
  }
}

function writeAcl(dir, owner, acl) {
  const now = new Date().toISOString();
  writeJsonAtomic(path.join(dir, ACL_FILE), {
    version: 1,
    owner,
    acl: { me: acl.me, family: acl.family },
    createdAt: now,
    updatedAt: now,
  });
}

function readMeta(dir) {
  const text = readSmall(path.join(dir, META_FILE));
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.publicId === 'string' && PUBLIC_ID.test(parsed.publicId)
      ? { publicId: parsed.publicId }
      : {};
  } catch {
    return {};
  }
}

function writeMeta(dir, publicId) {
  const now = new Date().toISOString();
  writeJsonAtomic(path.join(dir, META_FILE), { version: 1, publicId, createdAt: now, updatedAt: now });
}

function allows(level, required) {
  return LEVELS[level] >= LEVELS[required];
}

function accessFor(owner, acl, viewer) {
  return viewer === owner ? acl.me : acl.family;
}

function urlsOf(slug, entry, publicId) {
  const name = encodeURIComponent(slug);
  const panel = PUBLIC_BASE
    ? `${PUBLIC_BASE}/panel/artifacts?artifact=${name}`
    : `/panel/artifacts?artifact=${name}`;
  const raw = PUBLIC_BASE
    ? `${PUBLIC_BASE}/panel/artifacts/raw/${name}/${entry.split('/').map(encodeURIComponent).join('/')}`
    : `/panel/artifacts/raw/${name}/${entry.split('/').map(encodeURIComponent).join('/')}`;
  if (!PUBLIC_BASE || !publicId) return { panel, raw };
  const pub = `${PUBLIC_BASE}/a/${name}/${publicId}/`;
  return { panel, raw, public: pub, bare: `${pub}?bare=1` };
}

function inspect(slug, viewer = USER_ID) {
  if (!validName(slug)) return null;
  const dir = safeJoin(ARTIFACTS, slug);
  if (!dir) return null;
  if (!realDirOrNull(dir)) return null;
  const aclFile = readAcl(dir);
  if (!aclFile) return null;
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
  const access = accessFor(aclFile.owner, aclFile.acl, viewer);
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
    owner: aclFile.owner,
    acl: aclFile.acl,
    access,
    canRead: allows(access, 'read'),
    canWrite: allows(access, 'write'),
    canManage: viewer === aclFile.owner || allows(access, 'admin'),
    publicId: meta.publicId,
    urls: urlsOf(slug, entry.file, meta.publicId),
  };
}

function listAll(viewer = USER_ID) {
  let entries;
  try {
    entries = fs.readdirSync(ARTIFACTS, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const artifact = inspect(entry.name, viewer);
    if (artifact?.canRead) items.push(artifact);
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'ru'));
}

function artifactDir(slug) {
  if (!validName(slug)) return null;
  return safeJoin(ARTIFACTS, slug);
}

function listText(items, query) {
  if (!USER_ID) return 'Не задан ICARUS_USER_ID: права проверить нечем.';
  const filtered = items.filter((item) => {
    if (!query) return true;
    const needle = query.toLowerCase();
    return (
      item.title.toLowerCase().includes(needle) ||
      item.name.toLowerCase().includes(needle) ||
      item.owner.toLowerCase().includes(needle) ||
      item.summary.toLowerCase().includes(needle) ||
      (item.aiContent ?? '').toLowerCase().includes(needle)
    );
  });
  if (filtered.length === 0) {
    return items.length === 0
      ? 'Доступных артефактов нет. Создай новый через artifact_new(name).'
      : `По запросу «${query}» ничего не нашлось. Доступно артефактов: ${items.length}.`;
  }
  const lines = [`Артефакты (${filtered.length}${query ? ` из ${items.length}` : ''}):`];
  for (const item of filtered) {
    lines.push('');
    lines.push(`## ${item.title}`);
    lines.push(
      `- папка: /artifacts/${item.name}/; тип: ${item.typeLabel}; размер: ${humanSize(item.size)}; обновлён: ${item.updatedAt.slice(0, 16).replace('T', ' ')}`,
    );
    lines.push(`- владелец: ${item.owner}; твой уровень: ${item.access}`);
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
  if (!artifact) throw new Error(`артефакт «${slug}» не найден или у тебя нет прав читать его. Список: artifact_list.`);
  if (!artifact.canRead) throw new Error(`нет права читать «${slug}»: владелец ${artifact.owner}, твой уровень ${artifact.access}.`);
  const lines = [
    `# ${artifact.title}`,
    '',
    `- папка: /artifacts/${artifact.name}/`,
    `- владелец: ${artifact.owner}; твой уровень: ${artifact.access}`,
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
    if (content !== null) lines.push('', `## ${artifact.entry}`, '', content);
  }
  return lines.join('\n');
}

function linkText(slug, makePublic) {
  requireUser();
  const artifact = inspect(slug);
  if (!artifact) throw new Error(`артефакт «${slug}» не найден или у тебя нет прав читать его.`);
  if (!makePublic) {
    return [
      `Ссылка на «${artifact.title}» в панели:`,
      '',
      artifact.urls.panel,
      '',
      'Это обычная внутренняя ссылка. Публичную создавай только по прямой просьбе — artifact_link с public: true (нужен уровень admin).',
    ].join('\n');
  }
  if (!artifact.canManage) {
    throw new Error(`публичную ссылку делает владелец или admin артефакта; твой уровень — ${artifact.access}.`);
  }
  if (!PUBLIC_BASE) throw new Error('публичная ссылка недоступна: серверу не передали ICARUS_URL');
  let publicId = artifact.publicId;
  if (!publicId) {
    publicId = crypto.randomBytes(18).toString('base64url');
    writeMeta(artifact.dir, publicId);
  }
  const urls = urlsOf(slug, artifact.entry, publicId);
  return [
    `Публичная ссылка на «${artifact.title}»:`,
    '',
    `- в панели: ${urls.public}`,
    `- без панели: ${urls.bare}`,
    `- ссылка на панель (только для вошедших): ${urls.panel}`,
    '',
    'Отдай человеку публичную ссылку. `?bare=1` — тот же артефакт без панели.',
  ].join('\n');
}

function newText(slug) {
  requireUser();
  if (!validName(slug)) throw new Error('имя артефакта: латиница, цифры, дефис; без слэшей и скрытых имён');
  const dir = artifactDir(slug);
  if (!dir) throw new Error('имя артефакта не годится');
  if (fs.existsSync(dir)) throw new Error(`артефакт «${slug}» уже существует: правь его, а не создавай второй.`);
  fs.mkdirSync(dir, { recursive: true });
  writeAcl(dir, USER_ID, DEFAULT_ACL);
  return [
    `Артефакт /artifacts/${slug}/ создан, права: me=admin, family=read.`,
    '',
    'Теперь напиши обычными write:',
    `- /artifacts/${slug}/index.ai.md — H1, о чём артефакт, что внутри, что можно менять;`,
    `- /artifacts/${slug}/index.md | index.html | index.png|jpg|svg — то, что увидит человек.`,
    '',
    'Потом artifact_check и artifact_link (внутренняя ссылка). Публичную — только по просьбе.',
  ].join('\n');
}

function problemsOf(slug) {
  const dir = artifactDir(slug);
  if (!dir) return ['имя папки не годится'];
  if (!realDirOrNull(dir)) return ['папки нет'];
  const problems = [];
  if (!readAcl(dir)) problems.push(`нет ${ACL_FILE} — создай артефакт через artifact_new`);
  const indexes = INDEX_FILES.filter((candidate) => statOrNull(path.join(dir, candidate.file))?.isFile());
  if (indexes.length === 0) problems.push('нет index.html, index.md или index.png/jpg/svg');
  if (indexes.length > 1) problems.push(`index-файлов больше одного: ${indexes.map((item) => item.file).join(', ')}`);
  const ai = readSmall(path.join(dir, AI_FILE));
  if (ai === null) problems.push(`нет ${AI_FILE} — описания для ИИ`);
  else if (ai.trim() === '') problems.push(`${AI_FILE} пустой`);
  return problems;
}

function checkText(slug) {
  let names;
  if (slug) names = [slug];
  else {
    try {
      names = fs.readdirSync(ARTIFACTS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      names = [];
    }
  }
  if (names.length === 0) return 'Артефактов нет. Создай новый через artifact_new(name).';
  const lines = [];
  let bad = 0;
  for (const name of names) {
    const problems = problemsOf(name);
    if (problems.length === 0) lines.push(`✓ /artifacts/${name}/ — в порядке`);
    else {
      bad += 1;
      lines.push(`✗ /artifacts/${name}/ — ${problems.join('; ')}`);
    }
  }
  lines.push('', bad === 0 ? 'Все артефакты полные.' : `Неполных артефактов: ${bad}.`);
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'artifact_new',
    description:
      'Создать артефакт: папку /artifacts/<slug>/ и права (me=admin, family=read). Без него писать в /artifacts нельзя. После — обычными write положи index.ai.md и index-файл.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя папки: латиница в нижнем регистре через дефис.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_list',
    description:
      'Доступные артефакты: название, тип, размер, владелец, твой уровень, описание для ИИ и ссылки. Вызывай перед созданием и чтобы показать человеку, что уже есть.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поиск по названию, владельцу, описанию и тексту index.ai.md.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_read',
    description:
      'Прочитать артефакт так, как его понимает ИИ: index.ai.md, владелец/уровень, список файлов и ссылки. HTML и картинки не парси.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя папки артефакта.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_link',
    description:
      'Ссылка на артефакт. По умолчанию внутренняя, в панели — её и давай человеку. Публичная (любой, у кого есть адрес) — только при public: true и только по прямой просьбе; нужен уровень admin.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя папки артефакта.' },
        public: { type: 'boolean', description: 'Создать публичную ссылку. Только по прямой просьбе человека.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_check',
    description:
      'Проверить структуру: есть ли .folder-acl.json, index-файл, index.ai.md. Без name проверяет все.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя папки; без него проверяются все.' } },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  artifact_new: (args) => newText(String(args.name ?? '')),
  artifact_list: (args) => {
    requireUser();
    return listText(listAll(), typeof args.query === 'string' ? args.query.trim() : '');
  },
  artifact_read: (args) => {
    requireUser();
    return readText(String(args.name ?? ''));
  },
  artifact_link: (args) => linkText(String(args.name ?? ''), args.public === true),
  artifact_check: (args) => {
    requireUser();
    return checkText(typeof args.name === 'string' ? args.name : '');
  },
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
        result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true },
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
  newText,
  problemsOf,
  readText,
  urlsOf,
  validName,
};
