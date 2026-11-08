// Панель артефактов и публичный просмотр: HTTP-часть.
//
// Артефакты глобальные: один каталог на инсталляцию, один список в панели.
// Права проверяются на каждом действии: read — смотреть, write — менять файлы,
// admin — права, удаление и публичная ссылка. Владелец управляет своим всегда.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AI_FILE,
  ArtifactError,
  artifactFile,
  clearPublicId,
  displayPath,
  ensurePublicId,
  isAccessLevel,
  inspectArtifact,
  listArtifacts,
  publicArtifact,
  publicArtifactFile,
  mimeOf,
  readArtifact,
  setAcl,
  trashArtifact,
  type Artifact,
  type FolderAcl,
} from '../artifacts.ts';
import type { IcarusConfig } from '../config.ts';
import { artifactHistory, restoreArtifact } from '../artifacts-git.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { log } from '../log.ts';
import { publicArtifactPage } from './artifacts-ui.ts';

const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups;';

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function fail(res: ServerResponse, error: unknown, where: string): void {
  if (error instanceof ArtifactError) {
    json(res, error.status, errorBody(error.message, error.status === 404 ? 'not_found' : 'invalid_request_error'));
    return;
  }
  log.warn(`артефакты: ${where}`, { error: String(error) });
  json(res, 500, errorBody('раздел артефактов сломался', 'server_error'));
}

function disposition(relative: string): string {
  const name = (relative.split('/').pop() ?? 'artifact').replace(/[\r\n]/g, '_');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  type: string,
  options: { download?: boolean; cache?: string; sandbox?: boolean } = {},
): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(errorBody('файл не найден', 'not_found')));
    return;
  }
  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(stats.size),
    'x-content-type-options': 'nosniff',
    'cache-control': options.cache ?? 'no-cache',
    ...(options.download ? { 'content-disposition': disposition(file) } : {}),
    ...(options.sandbox ? { 'content-security-policy': SANDBOX } : {}),
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

function decode(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/** Глобальный список, чтение, права, ссылки и удаление. */
export async function handleArtifactsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: IcarusConfig,
  userId: string,
): Promise<void> {
  const route = url.pathname.replace(/^\/panel\/artifacts\/api\/?/, '').split('/')[0] ?? '';

  if (req.method === 'GET' && route === 'list') {
    try {
      const items = listArtifacts(config, userId);
      json(res, 200, { total: items.length, items });
    } catch (error) {
      fail(res, error, 'список не собрался');
    }
    return;
  }

  if (req.method === 'GET' && route === 'read') {
    const artifact = decode(url.searchParams.get('artifact') ?? '');
    try {
      const read = readArtifact(config, userId, artifact);
      json(res, 200, {
        artifact: read.artifact,
        aiContent: read.ai,
        content: read.content,
        path: displayPath(read.artifact.name, read.artifact.entry),
        aiFile: AI_FILE,
      });
    } catch (error) {
      fail(res, error, 'артефакт не прочитался');
    }
    return;
  }

  if (req.method === 'GET' && route === 'history') {
    const name = decode(url.searchParams.get('artifact') ?? '');
    try {
      const read = readArtifact(config, userId, name);
      const history = await artifactHistory(read.dir);
      json(res, 200, {
        artifact: read.artifact,
        history,
        current: history[0]?.hash ?? null,
      });
    } catch (error) {
      fail(res, error, 'история не прочиталась');
    }
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, errorBody('раздел артефактов так не умеет', 'invalid_request_error'));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (error) {
    json(res, 400, errorBody(`не разобрал тело запроса: ${String(error)}`, 'invalid_request_error'));
    return;
  }
  const artifact = typeof body.artifact === 'string' ? body.artifact : '';

  if (route === 'link') {
    try {
      const result = ensurePublicId(config, userId, artifact);
      json(res, 200, { artifact: result.artifact, urls: result.artifact.urls });
    } catch (error) {
      fail(res, error, 'публичная ссылка не сделалась');
    }
    return;
  }

  if (route === 'unpublish') {
    try {
      const next = clearPublicId(config, userId, artifact);
      json(res, 200, { artifact: next, urls: next.urls });
    } catch (error) {
      fail(res, error, 'ссылка не отозвалась');
    }
    return;
  }

  if (route === 'delete') {
    try {
      const target = trashArtifact(config, userId, artifact);
      log.info('артефакты: артефакт убран в корзину', { user: userId, artifact, target });
      json(res, 200, { ok: true, trashed: path.basename(target) });
    } catch (error) {
      fail(res, error, 'артефакт не удалился');
    }
    return;
  }

  if (route === 'restore') {
    const commit = typeof body.commit === 'string' ? body.commit : '';
    try {
      const read = readArtifact(config, userId, artifact);
      if (!read.artifact.canWrite && !read.artifact.canManage) {
        throw new ArtifactError('вернуть версию может тот, кто может менять артефакт', 403);
      }
      await restoreArtifact(read.dir, commit);
      const next = inspectArtifact(config, artifact, userId);
      if (!next) throw new ArtifactError('артефакт не найден', 404);
      json(res, 200, { artifact: next, urls: next.urls });
    } catch (error) {
      if (error instanceof ArtifactError) fail(res, error, 'версия не вернулась');
      else json(res, 400, errorBody(error instanceof Error ? error.message : 'версия не вернулась', 'invalid_request_error'));
    }
    return;
  }

  if (route === 'acl') {
    const raw = body.acl;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      json(res, 400, errorBody('нужен acl: { me, family }', 'invalid_request_error'));
      return;
    }
    const values = raw as { me?: unknown; family?: unknown };
    if (!isAccessLevel(values.me) || !isAccessLevel(values.family)) {
      json(res, 400, errorBody('уровень прав — read, write или admin', 'invalid_request_error'));
      return;
    }
    try {
      const acl: FolderAcl = { me: values.me, family: values.family };
      const next = setAcl(config, userId, artifact, acl);
      json(res, 200, { artifact: next, urls: next.urls });
    } catch (error) {
      fail(res, error, 'права не сохранились');
    }
    return;
  }

  json(res, 404, errorBody(`неизвестный маршрут артефактов: ${route}`));
}

/**
 * Файл артефакта: `/panel/artifacts/raw/<артефакт>/<путь>`. Путь, а не query,
 * чтобы относительные стили и картинки внутри HTML разрешались сами.
 */
export function handleArtifactsRaw(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: IcarusConfig,
  userId: string,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, errorBody('файл артефакта только читают', 'invalid_request_error'));
    return;
  }
  const rest = url.pathname.slice('/panel/artifacts/raw/'.length);
  const parts = rest.split('/');
  const artifact = decode(parts[0]);
  const relative = parts.slice(1).map(decode).join('/');
  if (!artifact || !relative) {
    json(res, 404, errorBody('файл не указан', 'not_found'));
    return;
  }
  const found = artifactFile(config, userId, artifact, relative);
  if (!found) {
    json(res, 404, errorBody('файл не найден или недоступен', 'not_found'));
    return;
  }
  sendFile(req, res, found.file, found.type, {
    download: url.searchParams.get('download') === '1',
    cache: 'no-cache',
    sandbox: /^(text\/html|image\/svg\+xml)/.test(found.type),
  });
}

/**
 * Публичный просмотр: `/a/<артефакт>/<publicId>/…`.
 * Старые ссылки `/a/<человек>/<workspace>/<артефакт>/<id>/…` уводим на новый
 * адрес: так уже отправленные ссылки не умирают, а относительные картинки
 * продолжают считаться от правильного каталога.
 */
export async function handlePublicArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: IcarusConfig,
): Promise<boolean> {
  if (url.pathname !== '/a' && !url.pathname.startsWith('/a/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, errorBody('публичный артефакт только читают', 'invalid_request_error'));
    return true;
  }

  const parts = url.pathname.slice('/a/'.length).split('/');
  let slug = decode(parts[0]);
  let publicId = decode(parts[1]);
  let asset = parts.slice(2).map(decode).join('/');

  // Сначала новая схема: /a/<slug>/<publicId>/<asset…>. Иначе вложенный ассет
  // (css/style.css) выглядел бы как старый адрес с четырьмя сегментами.
  let found = publicArtifact(config, slug, publicId);
  let oldRoute = false;
  if (!found) {
    // Старая схема: /a/<user>/<workspace>/<slug>/<id>/...
    if (parts.length >= 4 && parts[2] && parts[3]) {
      slug = decode(parts[2]);
      publicId = decode(parts[3]);
      asset = parts.slice(4).map(decode).join('/');
      found = publicArtifact(config, slug, publicId);
      oldRoute = found !== null;
    }
    if (!found) {
      json(res, 404, errorBody('артефакт не найден или ссылка отозвана', 'not_found'));
      return true;
    }
  }

  if (oldRoute) {
    const canonical = `/a/${encodeURIComponent(slug)}/${encodeURIComponent(publicId)}/${asset}${url.search}`;
    res.writeHead(301, { location: canonical });
    res.end();
    return true;
  }

  if (!slug || !publicId) {
    json(res, 404, errorBody('публичная ссылка не полная', 'not_found'));
    return true;
  }
  const { artifact } = found;

  if (asset === '' && !url.pathname.endsWith('/')) {
    res.writeHead(302, { location: `${url.pathname}/${url.search}` });
    res.end();
    return true;
  }

  if (asset !== '') {
    const file = publicArtifactFile(config, slug, asset);
    if (!file) {
      json(res, 404, errorBody('файл артефакта не найден', 'not_found'));
      return true;
    }
    sendFile(req, res, file.file, file.type, {
      download: url.searchParams.get('download') === '1',
      cache: 'no-cache',
      sandbox: /^(text\/html|image\/svg\+xml)/.test(file.type),
    });
    return true;
  }

  const bare = url.searchParams.get('bare') === '1';
  if (bare) {
    serveBare(req, res, config, artifact);
    return true;
  }

  const content =
    artifact.type === 'markdown'
      ? (() => {
          try {
            return fs.readFileSync(path.join(found.dir, artifact.entry), 'utf8');
          } catch {
            return null;
          }
        })()
      : null;
  const html = publicArtifactPage(artifact, content);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; frame-src 'self'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
  if (req.method === 'HEAD') res.end();
  else res.end(html);
  return true;
}

/** «Без панели»: HTML и картинка — сами файлы, markdown — отдельная страница. */
function serveBare(
  req: IncomingMessage,
  res: ServerResponse,
  config: IcarusConfig,
  artifact: Artifact,
): void {
  const dir = path.join(config.dataDir, 'artifacts', artifact.name);
  const file = path.join(dir, artifact.entry);
  if (artifact.type !== 'markdown') {
    const type = mimeOf(file);
    sendFile(req, res, file, type, {
      cache: 'no-cache',
      sandbox: /^(text\/html|image\/svg\+xml)/.test(type),
    });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    json(res, 404, errorBody('файл артефакта не найден', 'not_found'));
    return;
  }
  const base = artifact.urls.public ?? '';
  const doc = JSON.stringify({ content, raw: base }).replaceAll('<', '\\u003c');
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeTitle(artifact.title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0f1116; --text:#e6e8ec; --dim:#8b93a1; --line:#262b36; --accent:#7aa2f7; --busy:#e0af68; --raise:#20242e; --panel:#1b1f28; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.7 ui-sans-serif, system-ui, sans-serif; }
  .wrap { max-width:780px; margin:0 auto; padding:44px 28px 64px; }
  .wrap > :first-child { margin-top:0; }
  h1 { font-size:34px; line-height:1.2; margin:0 0 14px; letter-spacing:-.4px; }
  h2 { font-size:24px; margin:34px 0 10px; }
  h3 { font-size:19px; margin:28px 0 8px; }
  h4,h5,h6 { font-size:16px; margin:22px 0 6px; }
  p { margin:0 0 16px; }
  ul,ol { margin:0 0 18px; padding-left:26px; }
  li { margin:0 0 6px; }
  li.task { list-style:none; margin-left:-20px; }
  blockquote { margin:20px 0; padding:14px 18px; border-left:3px solid var(--busy); background:rgba(224,175,104,.09); border-radius:0 8px 8px 0; }
  blockquote p:last-child { margin-bottom:0; }
  code { font:13px/1.5 ui-monospace, monospace; background:var(--raise); border-radius:5px; padding:2px 5px; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:14px 16px; overflow:auto; }
  pre code { background:none; padding:0; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  img { max-width:100%; border-radius:9px; background:#fff; }
  hr { border:0; border-top:1px solid var(--line); margin:26px 0; }
  table { border-collapse:collapse; width:100%; margin:18px 0; font-size:14px; }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-size:10px; letter-spacing:.12em; text-transform:uppercase; font-weight:500; }
</style>
</head>
<body><main class="wrap" id="doc"></main>
<script>${MARKDOWN_CLIENT_FOR_BARE}</script>
<script>window.__DOC__ = ${doc}; document.getElementById('doc').innerHTML = artifactMarkdown(window.__DOC__.content, { fileBase: window.__DOC__.raw });</script>
</body>
</html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src * data:; script-src 'unsafe-inline'",
  });
  if (req.method === 'HEAD') res.end();
  else res.end(html);
}

function escapeTitle(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}

/** Код markdown-рендера для «без панели»: тот же файл, что у панели. */
const MARKDOWN_CLIENT_FOR_BARE = fs.readFileSync(new URL('./artifacts-markdown.js', import.meta.url), 'utf8');
