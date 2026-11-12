// Чат в панели: список диалогов, история из файлов pi и живой поток ответа.
//
// Разговор здесь — тот же, что у Telegram: (человек, conversationId) → сессия pi.
// Поэтому веб-чат не заводит второй агент, а просто даёт ещё один вход к тому же
// контейнеру и той же памяти. chats.json хранит только метаданные разговора;
// превью и время последнего сообщения читаются из файла сессии — и только для
// той страницы списка, которую панель показала.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONTAINER_INCOMING,
  DEFAULT_WORKSPACE,
  findUser,
  userPaths,
  type IcarusConfig,
  type UserConfig,
} from '../config.ts';
import { isRasterImage, localFileOf } from '../local-files.ts';
import { findWorkspace } from '../workspaces.ts';
import { downloadHeader } from './files.ts';
import { readJsonBody } from '../http/openai.ts';
import { errorBody } from '../http/sse.ts';
import { titleFromText } from '../http/title.ts';
import { buildPrompt } from '../prompt.ts';
import { type ChatChannel } from '../sessions/identity.ts';
import {
  NEW_CHAT_PREVIEW,
  createChatRecord,
  findChatRecord,
  isGenericTitle,
  panelCanWrite,
  readChats,
  recordTurn,
  sessionEpochsOf,
  sessionIdsOf,
  setChatFolder,
  updateChatTitles,
  type ChatRecord,
  type ChatTurn,
} from '../sessions/chats.ts';
import { findFolder } from '../sessions/folders.ts';
import { sessionFileForId, sessionFilesFor, textOfContent as textOf, type FileSession } from '../sessions/files.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import {
  clearText,
  compactText,
  parseCommand,
  REMOVED_COMMANDS,
  renameText,
  skillsText,
  statsText,
  stopText,
  TOPICS_REMOVED,
  UNKNOWN_COMMAND,
  WEB_COMMAND_NAMES,
  WEB_HELP,
} from '../sessions/commands.ts';
import { mcpReauthNotice } from '../mcp/reauth.ts';
import { broadcast, emit, finishTurn, liveTurn, runningTurn, startTurn, subscribe, watchAll } from './chat-live.ts';
import { log } from '../log.ts';

export { readChats };

/** Один субагент в трассировке: кто, что делает и чем кончил. */
export type ChatSubagentStep = {
  agent: string;
  task: string;
  /** queued | running | ok | error | aborted | skipped — как в инструменте. */
  status: string;
  /** Чем занят прямо сейчас, пока жив: «web_search: amazon.ie». */
  activity?: string;
  /** Куда ребёнок уже ходил: последние шаги для вложенного списка в панели. */
  actions?: string[];
  /** Сколько шагов было всего: список хранит только последние. */
  actionsTotal?: number;
  /** Сколько уже работает или работал: панель считает по нему секунды. */
  startedAt?: number;
  ms?: number;
  error?: string;
};
export type ChatTraceStep = {
  id: string;
  tool: string;
  label: string;
  detail: string;
  status: 'running' | 'ok' | 'error';
  result?: string;
  /** Только у шага subagent: список детей и их состояние. */
  subagents?: ChatSubagentStep[];
};

/** Сколько символов задания видно в панели: целиком оно занимает пол-экрана. */
const SUBAGENT_TASK_CHARS = 160;
/** Шагов ребёнка показываем не больше десяти: это подсказка, а не отчёт. */
const SUBAGENT_ACTION_LIMIT = 10;

/**
 * Субагенты из деталей инструмента. Детали приходят дважды — в прогрессе и в итоге,
 * форма одна, поэтому и разбор один. Мусор в деталях не должен ронять ход: не
 * разобрали — просто не показываем.
 */
export function subagentsOf(value: unknown): ChatSubagentStep[] {
  if (!Array.isArray(value)) return [];
  const states: ChatSubagentStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const state = item as Record<string, unknown>;
    if (typeof state.agent !== 'string' || typeof state.task !== 'string') continue;
    const actions = Array.isArray(state.actions)
      ? state.actions
          .filter((action): action is string => typeof action === 'string' && action.trim() !== '')
          .slice(-SUBAGENT_ACTION_LIMIT)
          .map((action) => clip(action, SUBAGENT_TASK_CHARS))
      : [];
    states.push({
      agent: state.agent,
      task: clip(state.task, SUBAGENT_TASK_CHARS),
      status: typeof state.status === 'string' ? state.status : 'queued',
      ...(actions.length > 0 ? { actions } : {}),
      ...(Number.isFinite(Number(state.actionsTotal)) && Number(state.actionsTotal) > 0
        ? { actionsTotal: Math.floor(Number(state.actionsTotal)) }
        : actions.length > 0
          ? { actionsTotal: actions.length }
          : {}),
      ...(typeof state.activity === 'string' && state.activity ? { activity: clip(state.activity, 120) } : {}),
      ...(typeof state.startedAt === 'number' ? { startedAt: state.startedAt } : {}),
      ...(typeof state.ms === 'number' ? { ms: state.ms } : {}),
      ...(typeof state.error === 'string' && state.error ? { error: clip(state.error, 200) } : {}),
    });
  }
  return states;
}

/** Задачи из аргументов вызова: пока прогресса нет, список уже можно показать. */
function queuedSubagents(args: Record<string, unknown>): ChatSubagentStep[] {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  const states: ChatSubagentStep[] = [];
  for (const item of tasks) {
    if (!item || typeof item !== 'object') continue;
    const task = item as Record<string, unknown>;
    if (typeof task.agent !== 'string') continue;
    states.push({
      agent: task.agent,
      task: clip(String(task.task ?? ''), SUBAGENT_TASK_CHARS),
      status: 'queued',
    });
  }
  return states;
}

/** Вложение в истории: путь внутри контейнера и признак «это картинка». */
export type ChatAttachment = { path: string; image: boolean };

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  thinking?: string;
  trace?: ChatTraceStep[];
  attachments?: ChatAttachment[];
  /** Не реплика, а граница между сессиями: после /clear контекст начат заново. */
  divider?: 'clear';
};

export type ChatSummary = {
  id: string;
  title: string;
  /** Последний ответ (или реплика человека) из файла сессии. */
  preview: string;
  createdAt: string;
  /** Время последнего сообщения из файла; у пустого разговора — createdAt. */
  updatedAt: string;
  channel: ChatChannel;
  /** Рабочая папка разговора. */
  workspace: string;
  /** Папка в левом меню; нет поля — разговор во «Входящих». */
  folder?: string;
  /**
   * Писать отсюда нельзя. Веб-чат и Telegram панель ведёт (это один разговор),
   * разговоры через API — только смотрит.
   */
  readOnly: boolean;
  /** Откуда пришла последняя реплика: этим подписывается шапка разговора. */
  lastTurn?: ChatTurn;
};

export type ChatHistory = { chat: ChatSummary; messages: ChatMessage[] };

/** Страница списка: курсор — это смещение, чтобы не тащить в браузер весь реестр. */
export type ChatPage = { chats: ChatSummary[]; nextCursor: string | null; total: number };

export type ChatApiContext = {
  config: IcarusConfig;
  userId: string;
  /** null — панель поднята без докера: чат честно скажет, что ему некуда идти. */
  registry?: SessionRegistry;
};

/** Отказ писать туда, где историей владеет не панель. */
const READ_ONLY_CHAT = 'этот разговор идёт через API: в панели он только для чтения';

const PREVIEW_CHARS = 110;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/** Сколько разговоров отдать за раз: клиент догружает следующую страницу скроллом. */
export function pageLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(parsed)));
}

/** Курсор — смещение в уже отсортированном списке; отрицательное и мусор — начало. */
function pageOffset(cursor: unknown): number {
  const parsed = typeof cursor === 'string' ? Number(cursor) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

/** Новый веб-чат; остальные каналы появляются в реестре сами при первом ходе. */
export function createChat(
  config: IcarusConfig,
  user: UserConfig,
  // Третий аргумент — workspace, но старые вызовы передавали сюда дату: различаем.
  workspaceOrNow: string | Date = DEFAULT_WORKSPACE,
  now = new Date(),
): ChatSummary {
  const workspace = typeof workspaceOrNow === 'string' ? workspaceOrNow : DEFAULT_WORKSPACE;
  const createdAt = workspaceOrNow instanceof Date ? workspaceOrNow : now;
  return summaryOf(createChatRecord(config, user, workspace, createdAt), null);
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
  // как «!\[котик](/workspaces/.icarus/...)». Сам путь оставляем: если человек спросил
  // адрес файла, именно он и должен быть виден в строке превью.
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, PREVIEW_CHARS);
}

/**
 * Закрывает ход веб-чата: первая реплика становится заголовком. Превью и время
 * в реестре не хранятся — их посчитает файл сессии, когда список покажет чат.
 */
export function finishChat(
  config: IcarusConfig,
  user: UserConfig,
  id: string,
  userText: string,
): ChatRecord | null {
  // Единственное место, где ход закрывается окончательно: успех, провал и обрыв
  // запроса "closed" проходят через него, а сорвавшийся ход в catch в него не
  // доходит. Поэтому сводку шлём отсюда, а не из streamTurn: иначе любой ранний
  // выход оставил бы разговор жёлтым навсегда.
  const chat = findChatRecord(config, user, id);
  const settled = !chat || !isGenericTitle(chat) ? chat : retitleChat(config, user, chat, userText);
  broadcast({ userId: user.id, chatId: id, type: 'idle', chat: settled ?? undefined });
  return settled;
}

/** Первая реплика становится заголовком: остальные ходы его уже не трогают. */
function retitleChat(
  config: IcarusConfig,
  user: UserConfig,
  chat: ChatRecord,
  userText: string,
): ChatRecord {
  const generated = titleFromText(userText);
  if (!generated) return chat;
  const title = generated.length >= 47 ? `${generated.slice(0, 46).trimEnd()}…` : generated;
  updateChatTitles(config, user, new Map([[chat.id, title]]));
  return { ...chat, title };
}

/**
 * Картинка по пути, который модель написала в markdown. Наружу отдаём только
 * картинки из вложений и рабочих папок человека: оба каталога уже смонтированы
 * в контейнер. Всё остальное — 404, а не «почитай хост».
 *
 * Путь разбирает localFileOf — там же, где его разбирает Telegram: оба канала
 * должны показывать человеку одно и то же.
 */
export function chatImageFile(
  config: IcarusConfig,
  user: UserConfig,
  raw: unknown,
): { file: string; type: string } | null {
  const found = localFileOf(config, user, raw);
  return found !== null && isRasterImage(found.type) ? found : null;
}

/**
 * Любой файл по пути из markdown: панель отдаёт его ссылкой на скачивание.
 * Тот же localFileOf, что и у картинки, — но без ограничения «только картинка».
 */
export function chatAttachmentFile(
  config: IcarusConfig,
  user: UserConfig,
  raw: unknown,
): { file: string; type: string } | null {
  return localFileOf(config, user, raw);
}

type SessionDigest = {
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
};

/**
 * Кэш пересказов файлов: список диалогов запрашивается на каждый поисковый ввод,
 * а файлы сессий бывают большими. Ключ — путь, свежесть — mtime и размер.
 */
const digestCache = new Map<string, { mtimeMs: number; size: number; digest: SessionDigest | null }>();

/** Первое сообщение — заголовок, последний ответ — превью, без полной истории. */
function digestSessionFile(session: FileSession): SessionDigest | null {
  const cached = digestCache.get(session.file);
  if (cached && cached.mtimeMs === session.mtimeMs && cached.size === session.size) return cached.digest;

  let lines: string[];
  try {
    lines = fs.readFileSync(session.file, 'utf8').split('\n');
  } catch {
    return null;
  }

  let titleText = '';
  let lastUser = '';
  let lastAssistant = '';
  let created = '';
  let updated = '';
  let messages = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; timestamp?: string; message?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const stamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';
    if (entry.type === 'session') {
      if (stamp) created ||= stamp;
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    if (stamp) {
      created ||= stamp;
      updated = stamp;
    }
    const message = entry.message;
    if (message.role === 'user') {
      const parsed = splitPromptAttachments(textOf(message.content).trim());
      // В списке «[голосовое, 4 с] Разговор» выглядит шумно: пометку оставляем
      // в истории и превью, а заголовок берём с текста.
      const clean = parsed.text.replace(/^\[(?:голосовое|voice)[^\]]*\]\s*/i, '');
      if (clean && !titleText) titleText = clean;
      if (parsed.text) lastUser = parsed.text;
      messages += 1;
    } else if (message.role === 'assistant') {
      const text = textOf(message.content).trim();
      if (text) lastAssistant = text;
      messages += 1;
    }
  }

  // Пустой файл — не разговор: такие остаются после /stats на новом разговоре.
  if (messages === 0) {
    digestCache.set(session.file, { mtimeMs: session.mtimeMs, size: session.size, digest: null });
    return null;
  }

  const generated = titleText ? titleFromText(titleText) : '';
  const title = generated.length >= 47 ? `${generated.slice(0, 46).trimEnd()}…` : generated;
  const digest: SessionDigest = {
    title,
    preview: previewOf(lastAssistant || lastUser),
    createdAt: created || new Date(session.mtimeMs).toISOString(),
    updatedAt: updated || new Date(session.mtimeMs).toISOString(),
    messages,
  };
  digestCache.set(session.file, { mtimeMs: session.mtimeMs, size: session.size, digest });
  return digest;
}

/** Сводка для браузера: метаданные из реестра, превью и время — из файла сессии. */
function summaryOf(chat: ChatRecord, digest: SessionDigest | null): ChatSummary {
  return {
    id: chat.id,
    title: digest?.title && isGenericTitle(chat) ? digest.title : chat.title,
    preview: digest?.preview || (chat.channel === 'web' ? NEW_CHAT_PREVIEW : ''),
    createdAt: chat.createdAt,
    updatedAt: digest?.updatedAt || chat.createdAt,
    channel: chat.channel,
    workspace: chat.workspace,
    // Пустое поле не шлём: у разговора во «Входящих» папки просто нет.
    ...(chat.folder ? { folder: chat.folder } : {}),
    readOnly: !panelCanWrite(chat),
    ...(chat.lastTurn ? { lastTurn: chat.lastTurn } : {}),
  };
}

/** Находит файл сессии для записи реестра: список и история ходят разными путями. */
function sessionForId(config: IcarusConfig, user: UserConfig, sessionId: string): FileSession | null {
  const file = sessionFileForId(userPaths(config, user).sessions, sessionId);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    return { sessionId, file, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}


/**
 * Страница списка. Сортируем по createdAt — время создания не меняется, поэтому
 * страницы не прыгают от нового сообщения. Превью и время последнего сообщения
 * читаются только для показанной страницы; stat — тоже только для неё.
 */
export function listChatPage(
  config: IcarusConfig,
  user: UserConfig,
  query = '',
  limit: unknown = DEFAULT_PAGE_SIZE,
  cursor?: string | null,
  workspace?: string | null,
): ChatPage {
  const needle = query.trim().toLocaleLowerCase('ru');
  const records = readChats(config, user)
    .filter((chat) => !workspace || chat.workspace === workspace)
    .filter(
      (chat) => !needle || `${chat.title}\n${chat.conversationId ?? ''}`.toLocaleLowerCase('ru').includes(needle),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  const offset = pageOffset(cursor);
  const size = pageLimit(limit);
  const page = records.slice(offset, offset + size);
  // У разговора после /clear несколько сессий: берём самую свежую непустую,
  // чтобы превью и время не обнулялись от одного очищенного контекста.
  const wanted = new Set(page.flatMap((chat) => sessionIdsOf(chat, user)));
  const sessions = sessionFilesFor(userPaths(config, user).sessions, wanted);
  const titles = new Map<string, string>();
  const chats = page.map((chat) => {
    let digest: SessionDigest | null = null;
    for (const sessionId of [...sessionIdsOf(chat, user)].reverse()) {
      const session = sessions.get(sessionId);
      digest = session ? digestSessionFile(session) : null;
      if (digest) break;
    }
    if (digest?.title && isGenericTitle(chat)) titles.set(chat.id, digest.title);
    return summaryOf(chat, digest);
  });
  if (titles.size > 0) updateChatTitles(config, user, titles);

  return {
    chats,
    nextCursor: offset + page.length < records.length ? String(offset + page.length) : null,
    total: records.length,
  };
}

/** Превью после хода: файл только что дописан, а ответ у нас уже в руках. */
export function summaryAfterTurn(chat: ChatRecord, userText: string, assistantText: string): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    preview: previewOf(assistantText || userText) || NEW_CHAT_PREVIEW,
    createdAt: chat.createdAt,
    updatedAt: new Date().toISOString(),
    workspace: chat.workspace,
    ...(chat.folder ? { folder: chat.folder } : {}),
    channel: chat.channel,
    readOnly: !panelCanWrite(chat),
    ...(chat.lastTurn ? { lastTurn: chat.lastTurn } : {}),
  };
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
  if (tool === 'mcp_connect' || tool === 'mcp_status') return 'MCP';
  // Любой пользовательский MCP: mcp_<сервер>_<инструмент>. Иначе всё, что человек
  // добавил сам, рисовалось бы безликим «ТУЛ».
  if (/^mcp_[a-z0-9]+_/.test(tool)) return 'MCP';
  if (tool === 'web_search') return 'ПОИСК';
  // Извлечение страницы — не поиск: в трассировке это разные занятия, и по
  // подписи должно быть видно, что Икар не искал, а открывал конкретный URL.
  if (tool === 'web_fetch') return 'СТРАНИЦА';
  if (tool === 'bash') {
    return /memory|journal|identity|preferences|projects/i.test(text) ? 'ПАМЯТЬ' : 'ТЕРМИНАЛ';
  }
  if (tool === 'read' || tool === 'grep' || tool === 'find' || tool === 'ls') {
    return /memory/i.test(text) ? 'ПАМЯТЬ' : 'ЧТЕНИЕ';
  }
  if (tool === 'subagent') return 'СУБАГЕНТЫ';
  if (tool === 'write' || tool === 'edit') return 'ПРАВКА';
  if (tool === 'now') return 'ВРЕМЯ';
  if (tool === 'get_control_panel_link') return 'ПАНЕЛЬ';
  return 'ТУЛ';
}

/**
 * Подпись шага с именем реального провайдера: «курс евро · brave».
 * Поисковый роутер отвечает чужим именем, и без этого в трассировке висит router.
 */
export function traceUpstream(detail: string, upstream: unknown): string {
  if (typeof upstream !== 'string' || upstream.trim() === '') return detail;
  return clip(detail ? `${detail} · ${upstream}` : upstream, 140);
}

/** Строка под ярлыком: команда, путь, запрос или имя MCP-сервера. */
export function traceDetail(tool: string, args: Record<string, unknown> = {}): string {
  const first = (value: unknown): string => (typeof value === 'string' ? value.split('\n')[0] ?? '' : '');
  if (tool === 'subagent') {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    const agents = tasks
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).agent : undefined))
      .filter((name): name is string => typeof name === 'string');
    if (tasks.length === 0) return 'задачи не переданы';
    const counted = [...new Set(agents)];
    const word = tasks.length === 1 ? 'задача' : tasks.length < 5 ? 'задачи' : 'задач';
    return clip(`${tasks.length} ${word} · ${counted.join(', ')}`, 140);
  }
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
  const step: ChatTraceStep = {
    id,
    tool,
    label: traceLabel(tool, args),
    detail: traceDetail(tool, args),
    status: 'running',
  };
  if (tool === 'subagent') {
    const queued = queuedSubagents(args);
    if (queued.length > 0) step.subagents = queued;
  }
  return step;
}

/** Разбор файла сессии в ленту. Общий для веб-чата и для внешних разговоров. */
function readMessages(file: string, user: UserConfig, chatId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (error) {
    log.warn('не читается история чата', { user: user.id, chatId, error: String(error) });
    return messages;
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
      // pi кладёт детали инструмента в тот же toolResult: по ним история знает,
      // чем кончил каждый субагент, а не только «сколько их было».
      const details = message.details as Record<string, unknown> | undefined;
      const states = subagentsOf(details?.subagents);
      if (states.length > 0) step.subagents = states;
      else if (step.subagents) delete step.subagents;
    }
  }

  for (const message of messages) {
    if (!message.text.trim() && message.trace?.length === 0) message.text = '';
  }
  return messages;
}

/** Заголовок из реплики: та же длина и хвост, что у finishChat. */
function titleFromUserText(text: string): string {
  const generated = titleFromText(text);
  return generated.length >= 47 ? `${generated.slice(0, 46).trimEnd()}…` : generated;
}

/**
 * История разговора из файла сессии pi. Показываем только диалог: текст человека и
 * ответы Икара, а вызовы инструментов собираем в трассировку — так в чате видно,
 * что агент делал руками, но сырые результаты не засоряют ответ.
 *
 * Разговор ищем в общем реестре: веб-чат по своему id, Telegram и API — по
 * conversationId или старому `session:<id>`. Превью и время берём из уже
 * разобранных сообщений, чтобы не читать файл второй раз.
 */
export function readHistory(config: IcarusConfig, user: UserConfig, chatId: string): ChatHistory | null {
  const chat = findChatRecord(config, user, chatId);
  if (!chat) return null;

  // Сессий может быть несколько (после /clear): старые остаются историей,
  // новая — текущим контекстом. Между ними — разделитель, а не потерянная лента.
  const messages: ChatMessage[] = [];
  for (const [index, epoch] of sessionEpochsOf(chat, user).entries()) {
    if (index > 0) {
      messages.push({ role: 'assistant', text: '', timestamp: epoch.startedAt, divider: 'clear' });
    }
    const session = sessionForId(config, user, epoch.sessionId);
    if (session) messages.push(...readMessages(session.file, user, chat.id));
  }
  const firstUser = messages.find((message) => message.role === 'user' && message.text.trim())?.text ?? '';
  if (firstUser && isGenericTitle(chat)) {
    const clean = firstUser.replace(/^\[(?:голосовое|voice)[^\]]*\]\s*/i, '');
    const title = titleFromUserText(clean);
    if (title) {
      updateChatTitles(config, user, new Map([[chat.id, title]]));
      chat.title = title;
    }
  }

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && message.text.trim());
  const last = messages.at(-1);
  return {
    chat: {
      id: chat.id,
      title: chat.title,
      preview: previewOf(lastAssistant?.text ?? firstUser) || (chat.channel === 'web' ? NEW_CHAT_PREVIEW : ''),
      createdAt: chat.createdAt,
      updatedAt: last?.timestamp || chat.createdAt,
      workspace: chat.workspace,
      channel: chat.channel,
      readOnly: !panelCanWrite(chat),
      ...(chat.lastTurn ? { lastTurn: chat.lastTurn } : {}),
    },
    messages,
  };
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
  const chat = findChatRecord(config, user, chatId);
  if (!chat) {
    json(res, 404, errorBody('разговор не найден'));
    return;
  }
  // Telegram панель продолжает: это тот же разговор и та же сессия pi. Читать
  // отсюда можно только API-вход — его клиент владеет историей сам.
  if (!panelCanWrite(chat)) {
    json(res, 403, errorBody(READ_ONLY_CHAT, 'permission_error'));
    return;
  }

  let session;
  try {
    session = await registry.acquire(user, chatId, chat.workspace, chat.artifact);
  } catch (error) {
    json(res, 503, errorBody(`сессия недоступна: ${String(error)}`, 'server_error'));
    return;
  }
  if (session.busy) {
    // Ход идёт либо без зрителя (панель перезагрузили), либо в другом канале —
    // и это один и тот же ход. Прицепиться можно только к своему потоку: у
    // Telegram-хода его в панели нет, и второй ответ начинать нельзя.
    const live = Boolean(runningTurn(user.id, chat.id));
    json(res, 409, {
      ...errorBody('в этом разговоре уже идёт ответ', 'conflict_error'),
      live,
      ...(live ? {} : { busyIn: chat.lastTurn?.channel ?? 'telegram' }),
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let done = false;
  let answer = '';
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const steps: ChatTraceStep[] = [];
  const byId = new Map<string, ChatTraceStep>();
  const toolArgs = new Map<string, Record<string, unknown>>();
  const reauthSent = new Set<string>();

  // Ход переживает зрителя: события копит hub, а этот ответ — лишь один из
  // подписчиков. F5 вычеркнет его, ход продолжит идти, а панель потом догонит.
  const turn = startTurn(user.id, chatId);
  // Сайдбар других разговоров должен узнать, что тут начали думать.
  broadcast({ userId: user.id, chatId, type: 'busy' });
  const send = (event: Record<string, unknown>): void => emit(turn, event);
  const settle = (): void => {
    if (done) return;
    done = true;
    resolveSettled();
  };

  /** Пишем зрителю, только пока он есть; остальное уже накоплено в hub. */
  const writeTo = (target: ServerResponse, event: Record<string, unknown>): void => {
    if (target.writableEnded) return;
    target.write(`${JSON.stringify(event)}\n`);
  };
  const unsubscribe = subscribe(turn, (event) => writeTo(res, event));

  const unsubscribeSession = session.onEvent((event) => {
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        // Начало размышления отдельным событием не шлём: в ленте уже стоит
        // «Икар думает», а строка под композером прогресс не показывает.
        if (delta?.type === 'text_delta' && delta.delta) {
          answer += delta.delta;
          send({ type: 'text', text: delta.delta });
        }
        break;
      }
      case 'tool_execution_start': {
        const id = String(event.toolCallId ?? `${event.toolName}-${steps.length}`);
        const tool = String(event.toolName ?? 'tool');
        const args = (event.args ?? {}) as Record<string, unknown>;
        toolArgs.set(id, args);
        const step = stepFor(tool, args, id);
        steps.push(step);
        byId.set(id, step);
        send({ type: 'step', step });
        break;
      }
      case 'tool_execution_update': {
        const id = String(event.toolCallId ?? '');
        const step = byId.get(id);
        if (!step) break;
        const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined;
        const details = partial?.details as Record<string, unknown> | undefined;
        const states = subagentsOf(details?.subagents);
        if (states.length > 0) step.subagents = states;
        const text = clip(resultText(partial?.content), 300);
        if (text) step.result = text;
        send({ type: 'step-update', id, step: { ...step } });
        break;
      }
      case 'tool_execution_end': {
        const id = String(event.toolCallId ?? '');
        const step = byId.get(id);
        if (!step) break;
        const tool = String(event.toolName ?? 'tool');
        const notice = mcpReauthNotice({
          config,
          userId: user.id,
          toolName: tool,
          args: toolArgs.get(id) ?? {},
          isError: event.isError === true,
          result: event.result,
        });
        if (notice && !reauthSent.has(notice.url)) {
          reauthSent.add(notice.url);
          send({ type: 'reauth', server: notice.name, url: notice.url });
        }
        step.status = event.isError === true ? 'error' : 'ok';
        const result = clip(resultText(event.result), 500);
        if (result) step.result = result;
        const details = (event.result as { details?: unknown } | undefined)?.details as
          | Record<string, unknown>
          | undefined;
        const states = subagentsOf(details?.subagents);
        if (states.length > 0) step.subagents = states;
        // Поисковый роутер отвечает чужим именем: в трассировке показываем, кто
        // именно сходил в сеть, иначе в строке шага так и висит «router».
        step.detail = traceUpstream(step.detail, details?.upstream);
        send({
          type: 'step-end',
          id,
          status: step.status,
          result: step.result,
          detail: step.detail,
          subagents: step.subagents,
        });
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

  try {
    // Канал хода пишем до prompt: файл сессии каналы не различает, а шапка
    // панели и отбивка в Telegram должны знать, кто говорил последним.
    recordTurn(config, user, chat.id, 'web');
    await session.prompt(prompt, attachments.images);
    await settled;

    const userText = text || attachments.names.join(', ');
    // `finishChat` не только даёт запись с заголовком, но и шлёт в сводку
    // `idle` — поэтому он обязан стоять до `done`, иначе гонка: ответ дошёл,
    // а точка в сайдбаре ещё жёлтая.
    const record = finishChat(config, user, chatId, userText);
    const summary = record ? summaryAfterTurn(record, userText, answer) : null;
    send({ type: 'done', chat: summary, steps });
    // Ход встал: догоняющий зритель получит хвост и закроет соединение сам.
    finishTurn(turn);
    unsubscribe();
    unsubscribeSession();
    if (!res.writableEnded) res.end();
    log.info('чат: ход завершён', {
      user: user.id,
      chatId,
      chars: answer.length,
      steps: steps.length,
      attachments: attachments.files.length,
    });
  } catch (error) {
    log.error('чат: ход сорвался', { user: user.id, chatId, error: String(error) });
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    // Сорвавшийся ход тоже "встал": `finishChat` в него не доходит, поэтому
    // `idle` шлём здесь — иначе разговор залипнет жёлтым навсегда.
    finishChat(config, user, chatId, text || attachments.names.join(', '));
    finishTurn(turn);
    unsubscribe();
    unsubscribeSession();
    if (!res.writableEnded) res.end();
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
      const page = listChatPage(
        ctx.config,
        user,
        url.searchParams.get('q') ?? '',
        url.searchParams.get('limit'),
        url.searchParams.get('cursor'),
        url.searchParams.get('workspace'),
      );
      json(res, 200, page);
      return true;
    }

    if (pathname === '/panel/api/chats' && req.method === 'POST') {
      const body = await bodyOf(req);
      const workspace = typeof body.workspace === 'string' && body.workspace ? body.workspace : DEFAULT_WORKSPACE;
      if (!findWorkspace(ctx.config, user, workspace)) {
        json(res, 404, errorBody(`workspace «${workspace}» не найден`));
        return true;
      }
      json(res, 200, { chat: createChat(ctx.config, user, workspace) });
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

    // Файл из ответа агента: не картинку он рисует ссылкой, и по клику человек
    // должен получить его, а не 404 от статики. Не картинку отдаём скачиванием:
    // HTML из ответа модели, открытый в origin панели, — это чужая страница.
    if (pathname === '/panel/api/chat/file' && req.method === 'GET') {
      const file = chatAttachmentFile(ctx.config, user, url.searchParams.get('path'));
      if (!file) {
        json(res, 404, errorBody('файл не найден или недоступен'));
        return true;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': downloadHeader(path.basename(file.file)),
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
      });
      fs.createReadStream(file.file).pipe(res);
      return true;
    }

    // Историю читаем и без pi: она лежит в файле сессии, и показать старый
    // разговор можно даже там, где контейнер ещё не поднят. Отправлять реплику
    // без сессии некуда — это проверим ниже.
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
      // Ход мог пережить перезагрузку панели: сообщаем об этом сразу вместе с
      // историей, чтобы клиент цеплялся к потоку, а не гадал, почему тихо.
      // Только про идущий ход: доигранный ответ уже лежит в истории, и второй
      // раз рисовать его из потока нельзя.
      json(res, 200, { ...history, live: Boolean(runningTurn(user.id, id)) });
      return true;
    }

    // Сводка по всем разговорам: какое событие кому. Отдельным каналом, а не
    // живым потоком разговора, — панели нужно знать про чужие ходы, не читая их
    // целиком. Дельт текста тут нет: только старт и финал.
    if (pathname === '/panel/api/chat/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Комментарий-строка сразу: прокси и браузер должны увидеть живое соединение,
      // а не решить, что ответ завис.
      res.write(': icarus bulletin\n\n');
      const off = watchAll((event) => {
        // Чужие ходы человека не касаются.
        if (event.userId !== user.id) return;
        if (res.writableEnded) return;
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (error) {
          log.warn('чат: событие сводки не ушло', { error: String(error) });
        }
      });
      res.on('close', off);
      return true;
    }

    if (pathname === '/panel/api/chat/status' && req.method === 'GET') {
      // Снимок для того, кто только открыл панель или переподключил сводку:
      // события за время разрыва потеряны, а состояние — вот оно.
      json(res, 200, { busy: ctx.registry?.busyConversations(user.id) ?? [] });
      return true;
    }

    // Папки — это раскладка меню, а не работа агента: перенос доступен и тогда,
    // когда панель поднята без pi. Поэтому маршрут стоит до проверки реестра.
    if (pathname === '/panel/api/chat/folder' && req.method === 'POST') {
      const body = await bodyOf(req);
      const id = chatIdOf(body.id);
      if (!id) {
        json(res, 400, errorBody('не указан разговор'));
        return true;
      }
      const folder = typeof body.folder === 'string' && body.folder ? body.folder : null;
      if (folder && !findFolder(ctx.config, user, folder)) {
        json(res, 404, errorBody(`папка «${folder}» не найдена`));
        return true;
      }
      const chat = setChatFolder(ctx.config, user, id, folder);
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      json(res, 200, { ok: true, id: chat.id, folder });
      return true;
    }

    if (!ctx.registry) {
      json(res, 501, errorBody('чат недоступен: панель поднята без контейнера с pi', 'invalid_request_error'));
      return true;
    }

    // Команды pi: скиллы, промпт-шаблоны и команды расширений. Их список знает
    // только сам pi, поэтому палитра спрашивает его лениво — когда человек уже
    // набрал «/». Команды самого чата приезжают в странице, без запроса.
    if (pathname === '/panel/api/chat/commands' && req.method === 'GET') {
      const id = chatIdOf(url.searchParams.get('id'));
      if (!id) {
        json(res, 400, errorBody('не указан разговор'));
        return true;
      }
      const chat = findChatRecord(ctx.config, user, id);
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      // Команды — про разговор, а не про канал: в API-разговоре их всё равно
      // не отправить, а в Telegram их разбирает бот.
      if (!panelCanWrite(chat)) {
        json(res, 200, { commands: [] });
        return true;
      }
      const outcome = await ctx.registry.commands(user, id);
      json(res, 200, { commands: outcome.status === 'ok' ? outcome.commands : [] });
      return true;
    }

    // Команда в веб-чате: разбираем её здесь, а не в браузере, — один разбор и
    // один набор текстов на все входы. `handled: false` значит «это команда pi»,
    // и клиент отправит её обычной репликой.
    if (pathname === '/panel/api/chat/command' && req.method === 'POST') {
      const body = await bodyOf(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text.length > 16_000) {
        json(res, 400, errorBody('реплика слишком длинная'));
        return true;
      }
      const command = parseCommand(text);
      if (!command) {
        json(res, 200, { handled: false });
        return true;
      }
      // Справка не зависит от разговора: её можно спросить и до первого сообщения.
      if (command.name === 'help') {
        json(res, 200, { handled: true, text: WEB_HELP });
        return true;
      }
      // Убранные команды объясняем сами, а не отправляем их в pi репликой.
      if (REMOVED_COMMANDS.has(command.name)) {
        json(res, 200, { handled: true, text: TOPICS_REMOVED });
        return true;
      }
      // Незнакомая команда без аргументов — опечатка; с аргументами это уже
      // реплика для pi (его шаблоны и команды расширений).
      if (!WEB_COMMAND_NAMES.has(command.name)) {
        json(res, 200, command.args === '' ? { handled: true, text: UNKNOWN_COMMAND } : { handled: false });
        return true;
      }

      const chatId = chatIdOf(body.chatId);
      if (!chatId) {
        json(res, 400, errorBody('нужен chatId'));
        return true;
      }
      const chat = findChatRecord(ctx.config, user, chatId);
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      // Команды правят разговор целиком (в том числе общий с Telegram), поэтому
      // API-вход здесь закрыт так же, как и `chat/send`.
      if (!panelCanWrite(chat)) {
        json(res, 403, errorBody(READ_ONLY_CHAT, 'permission_error'));
        return true;
      }

      if (command.name === 'compact') {
        const outcome = await ctx.registry.compact(user, chatId, command.args || undefined);
        json(res, 200, { handled: true, text: compactText(outcome) });
        return true;
      }
      if (command.name === 'stop') {
        json(res, 200, { handled: true, text: stopText(await ctx.registry.abort(user, chatId)) });
        return true;
      }
      if (command.name === 'stats') {
        json(res, 200, { handled: true, text: statsText(await ctx.registry.stats(user, chatId)) });
        return true;
      }
      if (command.name === 'clear') {
        const outcome = await ctx.registry.clear(user, chatId);
        // Ленту не перечитываем: старые сообщения остаются, клиент рисует
        // разделитель «контекст очищен». `cleared` говорит, что он уместен.
        json(res, 200, {
          handled: true,
          text: clearText(outcome),
          ...(outcome.status === 'started' ? { cleared: true } : {}),
        });
        return true;
      }
      if (command.name === 'rename') {
        const outcome = await ctx.registry.rename(user, chatId, command.args);
        json(res, 200, {
          handled: true,
          text: renameText(outcome),
          // Клиент обновляет заголовок и сайдбар сразу, без перезагрузки ленты.
          ...(outcome.status === 'renamed' ? { title: outcome.title } : {}),
        });
        return true;
      }
      if (command.name === 'skills') {
        json(res, 200, { handled: true, text: skillsText(await ctx.registry.commands(user, chatId)) });
        return true;
      }
      json(res, 200, { handled: true, text: UNKNOWN_COMMAND });
      return true;
    }

    // Догон идущего хода: панель открылась заново (F5, новая вкладка) и хочет
    // прицепиться к тому, что уже происходит. Отдаём накопленное и держим
    // соединение до конца хода — это и есть «переподключиться к стриму».
    if (pathname === '/panel/api/chat/stream' && req.method === 'GET') {
      const id = chatIdOf(url.searchParams.get('id'));
      if (!id) {
        json(res, 400, errorBody('не указан разговор'));
        return true;
      }
      const chat = findChatRecord(ctx.config, user, id);
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      if (!panelCanWrite(chat)) {
        json(res, 403, errorBody(READ_ONLY_CHAT, 'permission_error'));
        return true;
      }
      const turn = liveTurn(user.id, id);
      if (!turn) {
        // Хода нет: панель просто берёт историю, поток ей не нужен.
        json(res, 200, { live: false });
        return true;
      }

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`${JSON.stringify({ type: 'live', resumed: true })}\n`);

      let off = (): void => {};
      // Зритель ушёл (F5, закрытая вкладка) — просто вычёркиваем его. Ход продолжает
      // идти, и следующая панель догонит его тем же накопленным журналом.
      const detach = (): void => off();
      res.on('close', detach);
      // Уходим сразу после `done`/`error`: дальше ход уже нечего рассказывать.
      off = subscribe(turn, (event) => {
        if (res.writableEnded) return;
        res.write(`${JSON.stringify(event)}\n`);
        if (event.type === 'done' || event.type === 'error') {
          off();
          res.end();
        }
      });
      // Ход успел встать, пока подписывались: хвост отдан на replay, закрываемся.
      if (turn.done && !res.writableEnded) {
        off();
        res.end();
      }
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
      // Продолжаем веб-чат и Telegram-разговор: это одна сессия pi, а транспорт —
      // только труба. API-вход остаётся чужим: там историей владеет клиент.
      const chat = findChatRecord(ctx.config, user, chatId);
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      if (!panelCanWrite(chat)) {
        json(res, 403, errorBody(READ_ONLY_CHAT, 'permission_error'));
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
      await streamTurn(req, res, ctx.config, user, ctx.registry, chat.id, text, attachments);
      return true;
    }

    if (pathname === '/panel/api/chat/abort' && req.method === 'POST') {
      const body = await bodyOf(req);
      const chatId = chatIdOf(body.chatId);
      const chat = chatId ? findChatRecord(ctx.config, user, chatId) : null;
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      if (!panelCanWrite(chat)) {
        json(res, 403, errorBody(READ_ONLY_CHAT, 'permission_error'));
        return true;
      }
      const session = ctx.registry.get(user.id, chat.id);
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
