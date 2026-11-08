// Панель артефактов и публичный просмотр: HTTP-часть.
//
// Раздел живёт отдельно от памяти и скиллов: у артефакта нет построчных записей,
// git-истории и редактора. Это папка с готовой вещью, которую человек открывает,
// скачивает или показывает по ссылке. Поэтому здесь только список, чтение, ссылки
// и удаление; создаёт артефакты сам агент своими файловыми инструментами.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AI_FILE,
  ArtifactError,
  artifactFile,
  artifactWorkspaces,
  clearPublicId,
  countArtifacts,
  displayPath,
  ensurePublicId,
  listArtifacts,
  publicArtifact,
  readArtifact,
  trashArtifact,
  type Artifact,
} from '../artifacts.ts';
import { DEFAULT_WORKSPACE, findUser, type IcarusConfig } from '../config.ts';
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

/** Имя файла в заголовке: кириллица едет и в ASCII-заменителе, и в RFC 5987. */
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
    // HTML и SVG — чужой код. Песочница без same-origin не даёт ему дотянуться
    // до панели и её SSO-куки, даже если артефакт открыли прямо, а не в iframe.
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

function workspaceOf(url: URL, body?: Record<string, unknown>): string {
  const raw = body?.workspace ?? url.searchParams.get('workspace');
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_WORKSPACE;
}

/** Раздел «Артефакты»: страница и её API. */
export async function handleArtifactsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: IcarusConfig,
  userId: string,
): Promise<void> {
  const route = url.pathname.replace(/^\/panel\/artifacts\/api\/?/, '').split('/')[0] ?? '';

  if (req.method === 'GET' && route === 'list') {
    const workspace = workspaceOf(url);
    try {
      const items = listArtifacts(config, userId, workspace);
      const user = findUser(config, userId);
      json(res, 200, {
        workspace,
        workspaces: artifactWorkspaces(config, userId).map((item) => ({
          slug: item.slug,
          name: item.name,
          kind: item.kind,
        })),
        total: user ? countArtifacts(config, userId) : items.length,
        items,
      });
    } catch (error) {
      fail(res, error, 'список не собрался');
    }
    return;
  }

  if (req.method === 'GET' && route === 'read') {
    const workspace = workspaceOf(url);
    const artifact = decode(url.searchParams.get('artifact') ?? '');
    try {
      const read = readArtifact(config, userId, workspace, artifact);
      json(res, 200, {
        artifact: read.artifact,
        aiContent: read.ai,
        content: read.content,
        path: displayPath(workspace, read.artifact.name, read.artifact.entry),
        aiFile: AI_FILE,
      });
    } catch (error) {
      fail(res, error, 'артефакт не прочитался');
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
  const workspace = workspaceOf(url, body);
  const artifact = typeof body.artifact === 'string' ? body.artifact : '';

  if (route === 'link') {
    try {
      const result = ensurePublicId(config, userId, workspace, artifact);
      json(res, 200, { artifact: result.artifact, urls: result.artifact.urls });
    } catch (error) {
      fail(res, error, 'публичная ссылка не сделалась');
    }
    return;
  }

  if (route === 'unpublish') {
    try {
      const next = clearPublicId(config, userId, workspace, artifact);
      json(res, 200, { artifact: next, urls: next.urls });
    } catch (error) {
      fail(res, error, 'ссылка не отозвалась');
    }
    return;
  }

  if (route === 'delete') {
    try {
      const target = trashArtifact(config, userId, workspace, artifact);
      log.info('артефакты: артефакт убран в корзину', { user: userId, workspace, artifact, target });
      json(res, 200, { ok: true, trashed: path.basename(target) });
    } catch (error) {
      fail(res, error, 'артефакт не удалился');
    }
    return;
  }

  json(res, 404, errorBody(`неизвестный маршрут артефактов: ${route}`));
}

/**
 * Файл артефакта для панели: `/panel/artifacts/raw/<workspace>/<артефакт>/<путь>`.
 * Путь, а не query, — чтобы относительные ссылки внутри HTML работали сами:
 * `style.css` рядом с `index.html` разрешается в соседний сегмент.
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
  const workspace = decode(parts[0]);
  const artifact = decode(parts[1]);
  const relative = parts.slice(2).map(decode).join('/');
  if (!workspace || !artifact || !relative) {
    json(res, 404, errorBody('файл не указан', 'not_found'));
    return;
  }
  const found = artifactFile(config, userId, workspace, artifact, relative);
  if (!found) {
    json(res, 404, errorBody('файл не найден или недоступен', 'not_found'));
    return;
  }
  sendFile(req, res, found.file, found.type, {
    download: url.searchParams.get('download') === '1',
    cache: 'private, max-age=60',
    sandbox: /^(text\/html|image\/svg\+xml)/.test(found.type),
  });
}

/** Страница публичного просмотра: только этот артефакт, без списка и без правки. */
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

  const rest = url.pathname.slice('/a/'.length);
  const parts = rest.split('/');
  const userId = decode(parts[0]);
  const workspace = decode(parts[1]);
  const artifactName = decode(parts[2]);
  const publicId = decode(parts[3]);
  const asset = parts.slice(4).map(decode).join('/');

  if (!userId || !workspace || !artifactName || !publicId) {
    json(res, 404, errorBody('публичная ссылка не полная', 'not_found'));
    return true;
  }

  const publicArtifactResult = publicArtifact(config, userId, workspace, artifactName, publicId);
  if (!publicArtifactResult) {
    json(res, 404, errorBody('артефакт не найден или ссылка отозвана', 'not_found'));
    return true;
  }
  const { artifact } = publicArtifactResult;

  // Ссылка на папку без слеша сломала бы относительные стили и картинки: браузер
  // отсчитывал бы их от родителя. Уводим на канонический адрес со слешем.
  if (asset === '' && !url.pathname.endsWith('/')) {
    res.writeHead(302, { location: `${url.pathname}/${url.search}` });
    res.end();
    return true;
  }

  loggerPublic(userId, workspace, artifactName);

  if (asset !== '') {
    const found = artifactFile(config, userId, workspace, artifactName, asset);
    if (!found) {
      json(res, 404, errorBody('файл артефакта не найден', 'not_found'));
      return true;
    }
    sendFile(req, res, found.file, found.type, {
      download: url.searchParams.get('download') === '1',
      cache: 'no-cache',
      sandbox: /^(text\/html|image\/svg\+xml)/.test(found.type),
    });
    return true;
  }

  const bare = url.searchParams.get('bare') === '1';
  if (bare) {
    serveBare(req, res, config, userId, workspace, artifact);
    return true;
  }

  // По умолчанию — внутри панели: шапка, подпись, тот же просмотрщик.
  const content =
    artifact.type === 'markdown'
      ? (() => {
          try {
            return fs.readFileSync(path.join(publicArtifactResult.dir, artifact.entry), 'utf8');
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
    // Панель публичного просмотра не должна давать артефакту доступ к своим API:
    // страница статична, скриптов в ней нет, но CSP — дешёвая страховка.
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
  userId: string,
  workspace: string,
  artifact: Artifact,
): void {
  if (artifact.type !== 'markdown') {
    const found = artifactFile(config, userId, workspace, artifact.name, artifact.entry);
    if (!found) {
      json(res, 404, errorBody('файл артефакта не найден', 'not_found'));
      return;
    }
    sendFile(req, res, found.file, found.type, {
      cache: 'no-cache',
      sandbox: /^(text\/html|image\/svg\+xml)/.test(found.type),
    });
    return;
  }

  const found = artifactFile(config, userId, workspace, artifact.name, artifact.entry);
  if (!found) {
    json(res, 404, errorBody('файл артефакта не найден', 'not_found'));
    return;
  }
  let content: string;
  try {
    content = fs.readFileSync(found.file, 'utf8');
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

/** Один лог на публичный просмотр: без URL-секрета и без лишних деталей. */
function loggerPublic(userId: string, workspace: string, artifact: string): void {
  log.debug('артефакт: публичный просмотр', { user: userId, workspace, artifact });
}

/** Код markdown-рендера для «без панели»: тот же файл, что у панели. */
const MARKDOWN_CLIENT_FOR_BARE = fs.readFileSync(new URL('./artifacts-markdown.js', import.meta.url), 'utf8');
