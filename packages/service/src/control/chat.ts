// Чат в панели: список диалогов, история из файлов pi и живой поток ответа.
//
// Разговор здесь — тот же, что у Telegram: (человек, conversationId) → сессия pi.
// Поэтому веб-чат не заводит второй агент, а просто даёт ещё один вход к тому же
// контейнеру и той же памяти. Метаданные диалога (заголовок, превью, время) лежат
// отдельным chats.json рядом с сессиями: pi про них ничего не знает, а читать
// заголовок из первого сообщения на каждый список — лишний обход файлов.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONTAINER_INCOMING, findUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { titleFromText } from '../http/title.ts';
import { buildPrompt } from '../prompt.ts';
import { sessionIdFor } from '../sessions/pi-session.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import { log } from '../log.ts';

export type ChatTraceStep = {
  id: string;
  tool: string;
  label: string;
  detail: string;
  status: 'running' | 'ok' | 'error';
  result?: string;
};

/** Вложение в истории: путь внутри контейнера и признак «это картинка». */
export type ChatAttachment = { path: string; image: boolean };

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  thinking?: string;
  trace?: ChatTraceStep[];
  attachments?: ChatAttachment[];
};

export type ChatSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatHistory = { chat: ChatSummary; messages: ChatMessage[] };

export type ChatApiContext = {
  config: IcarusConfig;
  userId: string;
  /** null — панель поднята без докера: чат честно скажет, что ему некуда идти. */
  registry?: SessionRegistry;
};

const NEW_CHAT = 'Новый чат';
const PREVIEW_CHARS = 110;

function chatsFile(config: IcarusConfig, user: UserConfig): string {
  return path.join(userPaths(config, user).root, 'chats.json');
}

function isSummary(value: unknown): value is ChatSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['id', 'title', 'preview', 'createdAt', 'updatedAt'].every((key) => typeof item[key] === 'string');
}

/** Список диалогов читается целиком: их десятки, а не миллионы. */
export function readChats(config: IcarusConfig, user: UserConfig): ChatSummary[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(chatsFile(config, user), 'utf8')) as { chats?: unknown };
    return Array.isArray(parsed.chats) ? parsed.chats.filter(isSummary) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('не читается список чатов', { user: user.id, error: String(error) });
    }
    return [];
  }
}

/** Пишем через временный файл: падение посреди записи не должно съесть весь список. */
function writeChats(config: IcarusConfig, user: UserConfig, chats: ChatSummary[]): void {
  const file = chatsFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ chats }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function listChats(config: IcarusConfig, user: UserConfig, query = ''): ChatSummary[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  return readChats(config, user)
    .filter((chat) => !needle || `${chat.title}\n${chat.preview}`.toLocaleLowerCase('ru').includes(needle))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getChat(config: IcarusConfig, user: UserConfig, id: string): ChatSummary | null {
  return readChats(config, user).find((chat) => chat.id === id) ?? null;
}

export function createChat(config: IcarusConfig, user: UserConfig, now = new Date()): ChatSummary {
  const stamp = now.toISOString();
  const id = `web-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const chat: ChatSummary = {
    id,
    title: NEW_CHAT,
    preview: 'Расскажи, что нужно сделать.',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const chats = readChats(config, user);
  chats.unshift(chat);
  writeChats(config, user, chats);
  return chat;
}

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_ATTACHMENTS = 8;
/** Декодированный предел: JSON с base64 должен влезать в readJsonBody (16 МБ). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PROMPT_FILES_MARKER = '\n\n[Пользователь приложил файлы, они уже лежат на диске:';

export type UploadedAttachments = {
  files: string[];
  images: Array<{ data: string; mimeType: string }>;
  names: string[];
  paths: ChatAttachment[];
};

function emptyAttachments(): UploadedAttachments {
  return { files: [], images: [], names: [], paths: [] };
}

function extensionForMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') ?? '';
  if (subtype === 'jpeg') return 'jpg';
  return subtype || 'bin';
}

function safeAttachmentName(name: string): string {
  return path
    .basename(name)
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^[._]+/, '')
    .slice(0, 64);
}

/**
 * Вложения из браузера: base64 в JSON, потому что разбирать multipart в node:http
 * без зависимости — лишний слой. Файлы ложим в incoming/ человека, картинки ещё и
 * отдаём модели нативно; имя на диске своё, чтобы два «photo.jpg» не спорили.
 */
export function parseUploadAttachments(value: unknown, incomingDir: string): UploadedAttachments {
  if (value === undefined) return emptyAttachments();
  if (!Array.isArray(value)) throw new Error('attachments должен быть массивом');
  if (value.length > MAX_ATTACHMENTS) throw new Error(`не больше ${MAX_ATTACHMENTS} вложений`);

  const result = emptyAttachments();
  let total = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') throw new Error('вложение должно быть объектом');
    const item = raw as Record<string, unknown>;
    const original = typeof item.name === 'string' ? item.name : 'файл';
    const mimeType = typeof item.type === 'string' && item.type ? item.type : 'application/octet-stream';
    const encoded = typeof item.data === 'string' ? item.data : '';
    const base64 = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded;
    if (!base64) throw new Error(`вложение «${original}» пустое`);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw new Error(`вложение «${original}» не декодируется`);
    total += bytes.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`вложения больше ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} МБ`);
    }

    const safe = safeAttachmentName(original) || 'file';
    const name = path.extname(safe) ? safe : `${safe}.${extensionForMime(mimeType)}`;
    const stored = `web-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${name}`;
    fs.mkdirSync(incomingDir, { recursive: true });
    fs.writeFileSync(path.join(incomingDir, stored), bytes);

    const containerPath = `${CONTAINER_INCOMING}/${stored}`;
    result.files.push(containerPath);
    result.names.push(original || name);
    const image = IMAGE_MIME.has(mimeType);
    result.paths.push({ path: containerPath, image });
    if (image) result.images.push({ data: base64, mimeType });
  }
  return result;
}

/** Разбирает след вложения в реплике pi: путь остаётся в prompt, а в чате — плашкой. */
export function splitPromptAttachments(text: string): { text: string; attachments: ChatAttachment[] } {
  const at = text.indexOf(PROMPT_FILES_MARKER);
  if (at === -1) return { text, attachments: [] };
  const tail = text.slice(at + PROMPT_FILES_MARKER.length);
  const end = tail.lastIndexOf(']');
  if (end === -1) return { text, attachments: [] };
  const paths = tail
    .slice(0, end)
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean);
  return {
    text: text.slice(0, at).trimEnd(),
    attachments: paths.map((file) => ({
      path: file,
      image: /\.(?:png|jpe?g|gif|webp)$/i.test(file),
    })),
  };
}

function previewOf(text: string): string {
  // В превью не должно быть markdown-картинки: в списке диалогов она выглядит
  // как «!\[котик](/workspace/...)». Сам путь оставляем: если человек спросил
  // адрес файла, именно он и должен быть виден в строке превью.
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, PREVIEW_CHARS);
}

/**
 * Закрывает ход: первый вопрос становится заголовком, последний ответ — превью.
 * Вызывается после agent_settled; ошибки записи не должны отменять сам ответ.
 */
export function finishChat(
  config: IcarusConfig,
  user: UserConfig,
  id: string,
  userText: string,
  assistantText: string,
): ChatSummary | null {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.id === id);
  if (!chat) return null;

  if (!chat.title || chat.title === NEW_CHAT) {
    const generated = titleFromText(userText);
    chat.title = generated.length >= 47 ? `${generated.slice(0, 46).trimEnd()}…` : generated || NEW_CHAT;
  }
  if (assistantText.trim()) chat.preview = previewOf(assistantText);
  else if (userText.trim()) chat.preview = previewOf(userText);
  chat.updatedAt = new Date().toISOString();
  writeChats(config, user, chats);
  return chat;
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/**
 * Картинка из workspace по пути, который модель написала в markdown. Наружу
 * отдаём только incoming/ и maple/: там лежат вложения и графики, и оба каталога
 * уже смонтированы в контейнер. Всё остальное — 404, а не «почитай хост».
 */
export function chatImageFile(
  config: IcarusConfig,
  user: UserConfig,
  raw: unknown,
): { file: string; type: string } | null {
  if (typeof raw !== 'string') return null;
  let relative = raw.trim();
  if (!relative || relative.includes('\u0000')) return null;
  if (relative.startsWith('file://')) relative = relative.slice('file://'.length);
  if (relative.startsWith('/workspace/')) relative = relative.slice('/workspace/'.length);
  else if (relative.startsWith('workspace/')) relative = relative.slice('workspace/'.length);
  else if (relative.startsWith('/')) relative = relative.slice(1);

  const paths = userPaths(config, user);
  let root = paths.incoming;
  if (relative.startsWith('incoming/')) relative = relative.slice('incoming/'.length);
  else if (relative.startsWith('maple/')) {
    root = paths.maple;
    relative = relative.slice('maple/'.length);
  }

  if (!relative || relative.includes('..')) return null;
  const full = path.resolve(root, relative);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  const type = IMAGE_TYPES[path.extname(full).toLowerCase()];
  if (!type || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { file: full, type };
}

/** Файл сессии pi для этого разговора: pi дописывает `<время>_<id>.jsonl`. */
export function sessionFile(config: IcarusConfig, user: UserConfig, chatId: string): string | null {
  const id = sessionIdFor(user.id, chatId);
  const dir = userPaths(config, user).sessions;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const matches = names.filter((name) => name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`));
  if (matches.length === 0) return null;
  return matches
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .at(-1) ?? null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === 'object')
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('\n');
}

function resultText(result: unknown): string {
  if (typeof result === 'string') {
    // pi иногда кладёт в toolResult JSON-строку с блоками content — разворачиваем,
    // иначе в истории под шагом видно сырой [{"type":"text",…}].
    const text = result.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text);
        const nested = resultText(parsed);
        if (nested && nested !== text) return nested;
      } catch {
        /* это просто текст, не JSON */
      }
    }
    return result;
  }
  if (Array.isArray(result)) return textOf(result);
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) return textOf(content);
    try {
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }
  return '';
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Человеческий ярлык шага: по нему в трассировке видно, чем Икар занимался. */
export function traceLabel(tool: string, args: Record<string, unknown> = {}): string {
  const text = JSON.stringify(args);
  if (tool.startsWith('mcp_homeassistant')) return 'ДОМ';
  if (tool.startsWith('mcp_maple')) return 'MAPLE';
  if (tool === 'mcp_connect' || tool === 'mcp_status') return 'MCP';
  if (tool === 'web_search' || tool === 'web_fetch') return 'ПОИСК';
  if (tool === 'bash') {
    return /memory|journal|identity|preferences|projects/i.test(text) ? 'ПАМЯТЬ' : 'ТЕРМИНАЛ';
  }
  if (tool === 'read' || tool === 'grep' || tool === 'find' || tool === 'ls') {
    return /memory/i.test(text) ? 'ПАМЯТЬ' : 'ЧТЕНИЕ';
  }
  if (tool === 'write' || tool === 'edit') return 'ПРАВКА';
  if (tool === 'now') return 'ВРЕМЯ';
  if (tool === 'get_control_panel_link') return 'ПАНЕЛЬ';
  return 'ТУЛ';
}

/** Строка под ярлыком: команда, путь, запрос или имя MCP-сервера. */
export function traceDetail(tool: string, args: Record<string, unknown> = {}): string {
  const first = (value: unknown): string => (typeof value === 'string' ? value.split('\n')[0] ?? '' : '');
  const direct =
    first(args.path) ||
    first(args.file) ||
    first(args.query) ||
    first(args.name) ||
    first(args.command) ||
    first(args.url) ||
    first(args.server);
  if (direct) return clip(direct, 140);
  if (tool.startsWith('mcp_homeassistant')) {
    const domain = args.domain;
    if (Array.isArray(domain)) return clip(domain.join(', '), 140);
  }
  try {
    const json = JSON.stringify(args);
    return json && json !== '{}' ? clip(json, 140) : '';
  } catch {
    return '';
  }
}

function stepFor(tool: string, args: Record<string, unknown>, id: string): ChatTraceStep {
  return { id, tool, label: traceLabel(tool, args), detail: traceDetail(tool, args), status: 'running' };
}

/**
 * История разговора из файла сессии pi. Показываем только диалог: текст человека и
 * ответы Икара, а вызовы инструментов собираем в трассировку — так в чате видно,
 * что агент делал руками, но сырые результаты не засоряют ответ.
 */
export function readHistory(config: IcarusConfig, user: UserConfig, chatId: string): ChatHistory | null {
  const chat = getChat(config, user, chatId);
  if (!chat) return null;
  const messages: ChatMessage[] = [];
  const file = sessionFile(config, user, chatId);
  if (!file) return { chat, messages };

  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (error) {
    log.warn('не читается история чата', { user: user.id, chatId, error: String(error) });
    return { chat, messages };
  }

  const byTool = new Map<string, ChatTraceStep>();
  let current: ChatMessage | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; timestamp?: string; message?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    const role = message.role;
    const timestamp =
      typeof entry.timestamp === 'string'
        ? entry.timestamp
        : typeof message.timestamp === 'number'
          ? new Date(message.timestamp).toISOString()
          : new Date().toISOString();

    if (role === 'user') {
      const raw = textOf(message.content).trim();
      const parsed = splitPromptAttachments(raw);
      current = null;
      if (raw) {
        messages.push({
          role: 'user',
          text: parsed.text,
          timestamp,
          ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
        });
      }
      continue;
    }

    if (role === 'assistant') {
      if (!current) {
        current = { role: 'assistant', text: '', timestamp, trace: [] };
        messages.push(current);
      }
      const content = message.content;
      if (typeof content === 'string') {
        current.text = [current.text, content].filter(Boolean).join('\n');
        continue;
      }
      for (const part of Array.isArray(content) ? content : []) {
        if (!part || typeof part !== 'object') continue;
        const block = part as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          current.text = [current.text, block.text].filter((item) => item && item.trim()).join('\n');
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          current.thinking = [current.thinking ?? '', block.thinking].filter(Boolean).join('\n');
        } else if (block.type === 'toolCall' && typeof block.name === 'string') {
          const args = (block.arguments ?? {}) as Record<string, unknown>;
          const id = typeof block.id === 'string' ? block.id : `${block.name}-${byTool.size}`;
          const step = stepFor(block.name, args, id);
          current.trace ??= [];
          current.trace.push(step);
          byTool.set(id, step);
        }
      }
      continue;
    }

    if (role === 'toolResult' && typeof message.toolCallId === 'string') {
      const step = byTool.get(message.toolCallId);
      if (!step) continue;
      step.status = message.isError === true ? 'error' : 'ok';
      const result = clip(resultText(message.content), 500);
      if (result) step.result = result;
    }
  }

  for (const message of messages) {
    if (!message.text.trim() && message.trace?.length === 0) message.text = '';
  }
  return { chat, messages };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function chatIdOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return (await readJsonBody(req)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`не разобрал тело запроса: ${String(error)}`, { cause: error });
  }
}

/**
 * Живой ход: NDJSON-поток событий, который читает chat-client.js. Формат намеренно
 * простой — по строке на событие, без SSE-обёрток: браузеру не нужен EventSource,
 * достаточно fetch + reader, а POST с текстом так короче.
 */
async function streamTurn(
  req: IncomingMessage,
  res: ServerResponse,
  config: IcarusConfig,
  user: UserConfig,
  registry: SessionRegistry,
  chatId: string,
  text: string,
  attachments: UploadedAttachments,
): Promise<void> {
  const prompt = buildPrompt(text, attachments.files);
  if (!getChat(config, user, chatId)) {
    json(res, 404, errorBody('разговор не найден'));
    return;
  }

  let session;
  try {
    session = await registry.acquire(user, chatId);
  } catch (error) {
    json(res, 503, errorBody(`сессия недоступна: ${String(error)}`, 'server_error'));
    return;
  }
  if (session.busy) {
    json(res, 409, errorBody('в этом разговоре уже идёт ответ', 'conflict_error'));
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let closed = false;
  let done = false;
  let answer = '';
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const steps: ChatTraceStep[] = [];
  const byId = new Map<string, ChatTraceStep>();
  const send = (event: Record<string, unknown>): void => {
    if (!closed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const settle = (): void => {
    if (done) return;
    done = true;
    resolveSettled();
  };

  const unsubscribe = session.onEvent((event) => {
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.delta) {
          answer += delta.delta;
          send({ type: 'text', text: delta.delta });
        }
        if (delta?.type === 'thinking_start') send({ type: 'status', text: 'думает…' });
        break;
      }
      case 'tool_execution_start': {
        const id = String(event.toolCallId ?? `${event.toolName}-${steps.length}`);
        const tool = String(event.toolName ?? 'tool');
        const step = stepFor(tool, (event.args ?? {}) as Record<string, unknown>, id);
        steps.push(step);
        byId.set(id, step);
        send({ type: 'step', step });
        break;
      }
      case 'tool_execution_end': {
        const id = String(event.toolCallId ?? '');
        const step = byId.get(id);
        if (!step) break;
        step.status = event.isError === true ? 'error' : 'ok';
        const result = clip(resultText(event.result), 500);
        if (result) step.result = result;
        send({ type: 'step-end', id, status: step.status, result: step.result });
        break;
      }
      case 'extension_error':
      case 'error': {
        send({ type: 'notice', message: clip(JSON.stringify(event), 300) });
        break;
      }
      case 'agent_settled': {
        settle();
        break;
      }
      default:
        break;
    }
  });

  res.on('close', () => {
    if (res.writableEnded || done) return;
    closed = true;
    log.info('чат: клиент ушёл — прерываю ход', { user: user.id, chatId });
    void session.abort();
    settle();
  });

  try {
    await session.prompt(prompt, attachments.images);
    await settled;
    if (closed) return;

    const chat = finishChat(config, user, chatId, text || attachments.names.join(', '), answer);
    send({ type: 'done', chat, steps });
    res.end();
    log.info('чат: ход завершён', {
      user: user.id,
      chatId,
      chars: answer.length,
      steps: steps.length,
      attachments: attachments.files.length,
    });
  } catch (error) {
    log.error('чат: ход сорвался', { user: user.id, chatId, error: String(error) });
    if (!closed && !res.writableEnded) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      res.end();
    }
  } finally {
    unsubscribe();
  }
}

export async function handleChatApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ChatApiContext,
): Promise<boolean> {
  const pathname = url.pathname;
  if (pathname !== '/panel/api/chats' && !pathname.startsWith('/panel/api/chat/')) return false;

  const user = findUser(ctx.config, ctx.userId);
  if (!user) {
    json(res, 404, errorBody(`пользователь ${ctx.userId} не заведён`));
    return true;
  }

  try {
    if (pathname === '/panel/api/chats' && req.method === 'GET') {
      json(res, 200, { chats: listChats(ctx.config, user, url.searchParams.get('q') ?? '') });
      return true;
    }

    if (pathname === '/panel/api/chats' && req.method === 'POST') {
      json(res, 200, { chat: createChat(ctx.config, user) });
      return true;
    }

    // Картинку отдаём до проверки реестра: показать уже лежащий файл можно и
    // тогда, когда чат почему-то поднят без pi.
    if (pathname === '/panel/api/chat/image' && req.method === 'GET') {
      const image = chatImageFile(ctx.config, user, url.searchParams.get('path'));
      if (!image) {
        json(res, 404, errorBody('картинка не найдена или недоступна'));
        return true;
      }
      res.writeHead(200, { 'content-type': image.type, 'cache-control': 'private, max-age=300' });
      fs.createReadStream(image.file).pipe(res);
      return true;
    }

    if (!ctx.registry) {
      json(res, 501, errorBody('чат недоступен: панель поднята без контейнера с pi', 'invalid_request_error'));
      return true;
    }

    if (pathname === '/panel/api/chat/history' && req.method === 'GET') {
      const id = chatIdOf(url.searchParams.get('id'));
      if (!id) {
        json(res, 400, errorBody('не указан разговор'));
        return true;
      }
      const history = readHistory(ctx.config, user, id);
      if (!history) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      json(res, 200, history);
      return true;
    }

    if (pathname === '/panel/api/chat/send' && req.method === 'POST') {
      const body = await bodyOf(req);
      const chatId = chatIdOf(body.chatId);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!chatId) {
        json(res, 400, errorBody('нужен chatId'));
        return true;
      }
      if (text.length > 16_000) {
        json(res, 400, errorBody('реплика слишком длинная'));
        return true;
      }
      let attachments: UploadedAttachments;
      try {
        attachments = parseUploadAttachments(body.attachments, userPaths(ctx.config, user).incoming);
      } catch (error) {
        json(res, 400, errorBody(error instanceof Error ? error.message : String(error)));
        return true;
      }
      if (!text && attachments.files.length === 0) {
        json(res, 400, errorBody('нужны text или вложения'));
        return true;
      }
      await streamTurn(req, res, ctx.config, user, ctx.registry, chatId, text, attachments);
      return true;
    }

    if (pathname === '/panel/api/chat/abort' && req.method === 'POST') {
      const body = await bodyOf(req);
      const chatId = chatIdOf(body.chatId);
      const session = chatId ? ctx.registry.get(user.id, chatId) : undefined;
      const ok = session ? await session.abort() : false;
      json(res, 200, { ok });
      return true;
    }
  } catch (error) {
    log.error('чат: ошибка API', { user: user.id, error: String(error) });
    if (!res.headersSent) {
      json(res, 500, errorBody('чат сломался', 'server_error'));
    } else if (!res.writableEnded) {
      res.end();
    }
    return true;
  }

  json(res, 404, errorBody(`неизвестный маршрут чата: ${pathname}`));
  return true;
}
