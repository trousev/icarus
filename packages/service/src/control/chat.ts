// Chat in the panel: list of dialogs, history from pi files, and the live answer stream.
//
// A conversation here is the same as in Telegram: (person, conversationId) → pi session.
// That's why the web chat doesn't spin up a second agent, it just gives another entry point
// to the same container and the same memory. chats.json stores only conversation metadata;
// preview and last-message time are read from the session file — and only for
// the page of the list that the panel displayed.
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
import { askModelTitle, titleFromText } from '../http/title.ts';
import { buildPrompt } from '../prompt.ts';
import { type ChatChannel } from '../sessions/identity.ts';
import {
  NEW_CHAT_PREVIEW,
  applyAutoTitle,
  archiveChat,
  createChatRecord,
  findChatRecord,
  isAutoTitle,
  isGenericTitle,
  panelCanWrite,
  readChats,
  recordTurn,
  renameChat,
  sessionEpochsOf,
  sessionIdOf,
  sessionIdsOf,
  setChatFolder,
  updateChatTitles,
  type ChatRecord,
  type ChatTurn,
} from '../sessions/chats.ts';
import { findFolder } from '../sessions/folders.ts';
import {
  readOpeningExchange,
  sessionFileForId,
  sessionFilesFor,
  textOfContent as textOf,
  type FileSession,
  type OpeningExchange,
} from '../sessions/files.ts';
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
import {
  broadcast,
  emit,
  finishTurn,
  liveTurn,
  runningTurn,
  startTurn,
  subscribe,
  watchAll,
  whenTurnDone,
  type Turn,
} from './chat-live.ts';
import {
  QUEUE_LIMIT,
  clearQueue,
  dropQueued,
  enqueue,
  queueView,
  queued,
  takeNext,
} from './chat-queue.ts';
import { log } from '../log.ts';

export { readChats };

/** One subagent in the trace: who, what it does, and how it ended. */
export type ChatSubagentStep = {
  agent: string;
  task: string;
  /** queued | running | ok | error | aborted | skipped — as in the tool. */
  status: string;
  /** What it's busy with right now while alive: «web_search: amazon.ie». */
  activity?: string;
  /** Where the child has already been: the last steps for the nested list in the panel. */
  actions?: string[];
  /** Total number of steps: the list stores only the last ones. */
  actionsTotal?: number;
  /** How long it has been or was working: the panel counts seconds by it. */
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
  /** Only on a subagent step: the list of children and their state. */
  subagents?: ChatSubagentStep[];
};

/** How many task characters are visible in the panel: in full it takes up half the screen. */
const SUBAGENT_TASK_CHARS = 160;
/** We show no more than ten child steps: this is a hint, not a report. */
const SUBAGENT_ACTION_LIMIT = 10;

/**
 * Subagents from the tool details. Details arrive twice — in the progress and in the result,
 * the shape is the same, so the parsing is the same. Garbage in the details must not crash the
 * turn: if we couldn't parse it, we just don't show it.
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

/** Tasks from the call arguments: before there's progress, the list can already be shown. */
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

/** An attachment in the history: the path inside the container and an «is this an image» flag. */
export type ChatAttachment = { path: string; image: boolean };

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  thinking?: string;
  trace?: ChatTraceStep[];
  attachments?: ChatAttachment[];
  /** Not a message but a boundary between sessions: after /clear the context was started anew. */
  divider?: 'clear';
};

export type ChatSummary = {
  id: string;
  title: string;
  /** The last answer (or the person's message) from the session file. */
  preview: string;
  createdAt: string;
  /** Time of the last message from the file; for an empty conversation — createdAt. */
  updatedAt: string;
  channel: ChatChannel;
  /** The conversation's workspace. */
  workspace: string;
  /** Folder in the left menu; if absent, the conversation is in «Inbox». */
  folder?: string;
  /**
   * Writing from here is not allowed. The panel runs the web chat and Telegram (it's one
   * conversation); conversations via the API it only watches.
   */
  readOnly: boolean;
  /** Where the last message came from: this is what the conversation header is signed with. */
  lastTurn?: ChatTurn;
  /** The conversation is archived: it lives in its own section, not in the general list. */
  archived: boolean;
};

export type ChatHistory = { chat: ChatSummary; messages: ChatMessage[] };

/** Page of the list: the cursor is an offset, so as not to drag the whole registry into the browser. */
export type ChatPage = { chats: ChatSummary[]; nextCursor: string | null; total: number };

export type ChatApiContext = {
  config: IcarusConfig;
  userId: string;
  /** null — the panel is running without Docker: the chat will honestly say it has nowhere to go. */
  registry?: SessionRegistry;
  /**
   * Take a Telegram conversation out of Telegram: archiving in the panel and in the bot is one
   * action, and the topic is deleted along with the messages (see archiveChat). Not
   * passed — panel without a bot: the archive remains just a mark in the registry.
   */
  archiveTelegram?: (user: UserConfig, chat: ChatRecord) => Promise<void>;
};

/** Refusal to write where the history is owned not by the panel. */
const READ_ONLY_CHAT = 'этот разговор идёт через API: в панели он только для чтения';

/** How long we wait for the interrupted turn to finish writing before starting a new one. */
const INTERRUPT_WAIT_MS = 10_000;

const PREVIEW_CHARS = 110;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/** How many conversations to return at once: the client loads the next page by scrolling. */
export function pageLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(parsed)));
}

/** The cursor is an offset in the already sorted list; negative and garbage mean the start. */
function pageOffset(cursor: unknown): number {
  const parsed = typeof cursor === 'string' ? Number(cursor) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

/** New web chat; other channels appear in the registry on their own on the first turn. */
export function createChat(
  config: IcarusConfig,
  user: UserConfig,
  // The third argument is the workspace, but old calls passed a date here: we tell them apart.
  workspaceOrNow: string | Date = DEFAULT_WORKSPACE,
  now = new Date(),
): ChatSummary {
  const workspace = typeof workspaceOrNow === 'string' ? workspaceOrNow : DEFAULT_WORKSPACE;
  const createdAt = workspaceOrNow instanceof Date ? workspaceOrNow : now;
  return summaryOf(createChatRecord(config, user, workspace, createdAt), null);
}

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_ATTACHMENTS = 8;
/** Decoded limit: the JSON with base64 must fit into readJsonBody (16 MB). */
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
 * Attachments from the browser: base64 in JSON, because parsing multipart in node:http
 * without a dependency is an extra layer. We put files into the person's incoming/, images
 * additionally go to the model natively; the name on disk is our own so two «photo.jpg» don't clash.
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

/** Parses the attachment trail in the pi message: the path stays in the prompt, and in the chat it becomes a chip. */
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
  // The preview must not contain a markdown image: in the dialog list it looks
  // like «!\[kitty](/workspaces/.icarus/...)». We keep the path itself: if the person asked
  // for a file address, that's exactly what should be visible in the preview line.
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, PREVIEW_CHARS);
}

/**
 * Closes the web chat turn: the first message becomes the title. Preview and time
 * are not stored in the registry — the session file computes them when the list shows the chat.
 */
export function finishChat(
  config: IcarusConfig,
  user: UserConfig,
  id: string,
  userText: string,
): ChatRecord | null {
  // The only place where the turn is closed for good: success, failure, and the abort
  // of the "closed" request pass through it, while a crashed turn in catch never
  // reaches it. That's why we send the summary from here, not from streamTurn: otherwise any
  // early exit would leave the conversation yellow forever.
  const chat = findChatRecord(config, user, id);
  const settled = !chat || !isGenericTitle(chat) ? chat : retitleChat(config, user, chat, userText);
  broadcast({ userId: user.id, chatId: id, type: 'idle', chat: settled ?? undefined });
  return settled;
}

/** The first message becomes the title: later turns no longer touch it. */
function retitleChat(
  config: IcarusConfig,
  user: UserConfig,
  chat: ChatRecord,
  userText: string,
): ChatRecord {
  const generated = titleFromText(userText);
  if (!generated) return chat;
  const title = generated.length >= 47 ? `${generated.slice(0, 46).trimEnd()}…` : generated;
  // The name is ours, not the person's: the model may still refine it from the first messages.
  return applyAutoTitle(config, user, chat.id, title) ?? chat;
}

/** How many first messages take part in the live title: after that the name should settle. */
const AUTO_TITLE_TURNS = 3;

/** How long we wait for the model for a title in the panel: the answer to the person has already gone out, and there's no point hanging around. */
export const AUTO_TITLE_TIMEOUT_MS = 8_000;

/** The conversation for the title prompt: the person's first messages and Icarus's first answer. */
function titleConversation(opening: OpeningExchange): string {
  const lines = opening.users.map((text) => `User: ${text}`);
  if (opening.assistant) lines.push(`AI: ${opening.assistant}`);
  return lines.join('\n');
}

/**
 * Live title: the model reads the start of the conversation and names it by meaning.
 * The turn has already been handed to the person by this point, so the name arrives as a separate
 * summary event and doesn't delay the answer. We refine only our own name and only
 * the first turns: after that the conversation is either already named by the person or the topic has settled.
 *
 * `ask` is a one-off call to a cheap model. A failure or timeout leaves the heuristic:
 * the name from the first message is already there, the model merely tries to make it better.
 */
export async function refineChatTitle(
  config: IcarusConfig,
  user: UserConfig,
  ask: (prompt: string) => Promise<string>,
  chatId: string,
): Promise<string | null> {
  const chat = findChatRecord(config, user, chatId);
  // The archived conversation is out of sight: the model doesn't rename it (see applyAutoTitle),
  // so there's no point calling it either.
  if (!chat || chat.archivedAt || !isAutoTitle(chat)) return null;

  const file = sessionFileForId(userPaths(config, user).sessions, sessionIdOf(chat, user));
  if (!file) return null;
  const opening = readOpeningExchange(file);
  if (opening.users.length === 0 || opening.turns > AUTO_TITLE_TURNS) return null;

  const asked = await askModelTitle({
    ask,
    conversation: titleConversation(opening),
    fallback: titleFromUserText(opening.users[0] ?? ''),
  });
  // The heuristic was already set by finishChat: we don't write the same name a second time.
  if (asked.source !== 'model') return null;

  // While the model was thinking, the person could have named the conversation themselves — their name wins.
  const updated = applyAutoTitle(config, user, chatId, asked.title);
  if (!updated || updated.title === chat.title) return null;
  broadcast({ userId: user.id, chatId: updated.id, type: 'title', chat: updated });
  log.info('заголовок разговора от модели', { user: user.id, chatId: updated.id, title: updated.title });
  return updated.title;
}

/**
 * An image at the path the model wrote in markdown. We expose only
 * images from the person's attachments and workspaces: both directories are already mounted
 * into the container. Everything else is a 404, not «read the host».
 *
 * The path is parsed by localFileOf — the same place where Telegram parses it: both channels
 * must show the person the same thing.
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
 * Any file at a path from markdown: the panel serves it as a download link.
 * The same localFileOf as for the image — but without the «image only» restriction.
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
 * Cache of file digests: the dialog list is requested on every search keystroke,
 * and session files can be large. The key is the path, freshness is mtime and size.
 */
const digestCache = new Map<string, { mtimeMs: number; size: number; digest: SessionDigest | null }>();

/** The first message is the title, the last answer is the preview, without the full history. */
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
      // In the list «[voice, 4 s] Conversation» looks noisy: we keep the marker
      // in the history and preview, and take the title from the text.
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

  // An empty file is not a conversation: such files remain after /stats on a new conversation.
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

/** Summary for the browser: metadata from the registry, preview and time from the session file. */
function summaryOf(chat: ChatRecord, digest: SessionDigest | null): ChatSummary {
  return {
    id: chat.id,
    title: digest?.title && isGenericTitle(chat) ? digest.title : chat.title,
    preview: digest?.preview || (chat.channel === 'web' ? NEW_CHAT_PREVIEW : ''),
    createdAt: chat.createdAt,
    updatedAt: digest?.updatedAt || chat.createdAt,
    channel: chat.channel,
    workspace: chat.workspace,
    // We don't send an empty field: a conversation in the «Inbox» simply has no folder.
    ...(chat.folder ? { folder: chat.folder } : {}),
    readOnly: !panelCanWrite(chat),
    ...(chat.lastTurn ? { lastTurn: chat.lastTurn } : {}),
    archived: Boolean(chat.archivedAt),
  };
}

/** Finds the session file for a registry record: the list and history take different paths. */
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
 * Page of the list. We sort by createdAt — the creation time doesn't change, so
 * pages don't jump because of a new message. Preview and last-message time
 * are read only for the displayed page; stat too only for it.
 *
 * The archive is a separate page of the same list (`archived`): the regular sidebar
 * doesn't show it, otherwise «out of sight» would change nothing.
 */
export function listChatPage(
  config: IcarusConfig,
  user: UserConfig,
  query = '',
  limit: unknown = DEFAULT_PAGE_SIZE,
  cursor?: string | null,
  workspace?: string | null,
  archived = false,
): ChatPage {
  const needle = query.trim().toLocaleLowerCase('ru');
  const records = readChats(config, user)
    .filter((chat) => Boolean(chat.archivedAt) === archived)
    .filter((chat) => !workspace || chat.workspace === workspace)
    .filter(
      (chat) => !needle || `${chat.title}\n${chat.conversationId ?? ''}`.toLocaleLowerCase('ru').includes(needle),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  const offset = pageOffset(cursor);
  const size = pageLimit(limit);
  const page = records.slice(offset, offset + size);
  // After /clear a conversation has several sessions: we take the freshest non-empty one,
  // so that the preview and time don't reset from a single cleared context.
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

/** Preview after a turn: the file has just been appended to, and we already have the answer in hand. */
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
    archived: Boolean(chat.archivedAt),
  };
}

function resultText(result: unknown): string {
  if (typeof result === 'string') {
    // pi sometimes puts a JSON string with content blocks into toolResult — we unwrap it,
    // otherwise the history under the step shows raw [{"type":"text",…}].
    const text = result.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text);
        const nested = resultText(parsed);
        if (nested && nested !== text) return nested;
      } catch {
        /* this is just text, not JSON */
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

/** Human label of the step: it shows in the trace what Icarus was doing. */
export function traceLabel(tool: string, args: Record<string, unknown> = {}): string {
  const text = JSON.stringify(args);
  if (tool.startsWith('mcp_homeassistant')) return 'ДОМ';
  if (tool === 'mcp_connect' || tool === 'mcp_status') return 'MCP';
  // Any custom MCP: mcp_<server>_<tool>. Otherwise everything the person
  // added themselves would be drawn as a faceless «TOOL».
  if (/^mcp_[a-z0-9]+_/.test(tool)) return 'MCP';
  if (tool === 'web_search') return 'ПОИСК';
  // Fetching a page is not search: in the trace these are different activities, and by
  // the label one should see that Icarus wasn't searching but opening a specific URL.
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
 * Step label with the real provider name: «euro rate · brave».
 * The search router answers under a foreign name, and without this «router» hangs in the trace.
 */
export function traceUpstream(detail: string, upstream: unknown): string {
  if (typeof upstream !== 'string' || upstream.trim() === '') return detail;
  return clip(detail ? `${detail} · ${upstream}` : upstream, 140);
}

/** The line under the label: command, path, query, or MCP server name. */
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

/** Parses the session file into a feed. Shared by the web chat and external conversations. */
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
      // pi puts the tool details into the same toolResult: from them the history knows
      // how each subagent ended, not just «how many there were».
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

/** Title from a message: the same length and tail as in finishChat. */
function titleFromUserText(text: string): string {
  const generated = titleFromText(text);
  return generated.length >= 47 ? `${generated.slice(0, 46).trimEnd()}…` : generated;
}

/**
 * Conversation history from the pi session file. We show only the dialog: the person's text and
 * Icarus's answers, while tool calls are gathered into the trace — this way the chat shows
 * what the agent did by hand, but raw results don't clutter the answer.
 *
 * We look up the conversation in the shared registry: the web chat by its own id, Telegram and API by
 * conversationId or the old `session:<id>`. We take the preview and time from the already
 * parsed messages so as not to read the file a second time.
 */
export function readHistory(config: IcarusConfig, user: UserConfig, chatId: string): ChatHistory | null {
  const chat = findChatRecord(config, user, chatId);
  if (!chat) return null;

  // There may be several sessions (after /clear): the old ones remain history,
  // the new one is the current context. Between them is a divider, not a lost feed.
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
      archived: Boolean(chat.archivedAt),
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

/** Conversation key: the hub also uses it so as not to confuse people. */
function turnKey(userId: string, chatId: string): string {
  return `${userId}\u0000${chatId}`;
}

/** Who is currently draining the queue: a second pass into the same conversation is pointless. */
const draining = new Set<string>();

/**
 * The conversation is busy with the «now» operation: the interrupted turn is finishing writing, and the queue
 * must not slip into this gap. Without the latch the next message would start at the same
 * moment, and two answers would get mixed up in the feed.
 */
const starting = new Set<string>();

/** Whether a turn is running in the conversation: the hub knows about the turn, the registry about the busy session. */
function inTurn(registry: SessionRegistry, userId: string, chatId: string): boolean {
  if (runningTurn(userId, chatId)) return true;
  const session = registry.get(userId, chatId);
  return Boolean(session && (session.busy || session.compacting));
}

/**
 * An interrupt only asks pi to stop — the turn finishes writing the answer and closes
 * the journal for another moment. We wait for the actual end: otherwise the new message would get into the busy
 * session and receive a 409.
 */
async function waitTurnEnd(userId: string, chatId: string, timeoutMs: number): Promise<void> {
  const turn = runningTurn(userId, chatId);
  if (!turn) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      whenTurnDone(turn),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One turn: the person's message, pi events, and recording the answer into the conversation. */
type TurnJob = {
  config: IcarusConfig;
  user: UserConfig;
  /** The registry is only for the live title: a one-off call to a cheap model. */
  registry: SessionRegistry;
  chatId: string;
  session: Awaited<ReturnType<SessionRegistry['acquire']>>;
  text: string;
  attachments: UploadedAttachments;
};

/**
 * Starts a turn and returns its journal and a promise of the end. The HTTP response is not part of this:
 * a turn from the queue lives without a request, and the panel attaches to the journal via the summary.
 * Errors are not thrown — they leave as an `error` event, as before.
 */
function beginTurn(job: TurnJob): { turn: Turn; finished: Promise<void> } {
  const { config, user, registry, chatId, session, text, attachments } = job;
  const prompt = buildPrompt(text, attachments.files);

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

  // The turn outlives the viewer: the hub accumulates events, and the HTTP response is only one of
  // the subscribers. F5 will cross it out, the turn keeps going, and the panel catches up later.
  const turn = startTurn(user.id, chatId);
  // The sidebar of other conversations must learn that thinking has started here.
  broadcast({ userId: user.id, chatId, type: 'busy' });
  const send = (event: Record<string, unknown>): void => emit(turn, event);
  // The message is part of the turn journal, not just the sender's DOM: after F5 the panel
  // replays the turn and must show what this is an answer to. The sender has already
  // drawn its bubble and will skip this event (see the client).
  send({ type: 'user', text: text || attachments.names.join(', ') });

  const unsubscribeSession = session.onEvent((event) => {
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        // We don't send the start of thinking as a separate event: the feed already shows
        // «Icarus is thinking», and the line under the composer doesn't show progress.
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
        // The search router answers under a foreign name: in the trace we show who
        // exactly went online, otherwise «router» keeps hanging in the step line.
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
        if (!done) {
          done = true;
          resolveSettled();
        }
        break;
      }
      default:
        break;
    }
  });

  const finished = (async () => {
    try {
      // We write the turn channel before prompt: the session file doesn't distinguish channels, and the panel
      // header and the Telegram footer must know who spoke last.
      recordTurn(config, user, chatId, 'web');
      await session.prompt(prompt, attachments.images);
      await settled;

      const userText = text || attachments.names.join(', ');
      // `finishChat` not only returns a record with the title but also sends `idle` to the
      // summary — that's why it must run before `done`, otherwise a race: the answer arrived,
      // but the dot in the sidebar is still yellow.
      const record = finishChat(config, user, chatId, userText);
      const summary = record ? summaryAfterTurn(record, userText, answer) : null;
      send({ type: 'done', chat: summary, steps });
      // The title catches up with the answer: the name from the model arrives as a separate summary
      // event, so the person doesn't wait for the model just to name the conversation.
      void refineChatTitle(
        config,
        user,
        (ask) => registry.oneShot(user, ask, { timeoutMs: AUTO_TITLE_TIMEOUT_MS }),
        chatId,
      ).catch((error: unknown) => {
        log.warn('чат: живой заголовок не вышел', { user: user.id, chatId, error: String(error) });
      });
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
      // A crashed turn also «settled»: `finishChat` doesn't reach it, so we send
      // `idle` here — otherwise the conversation would stick yellow forever.
      finishChat(config, user, chatId, text || attachments.names.join(', '));
    } finally {
      // The turn settled: the catching-up viewer will get the tail and close the connection itself,
      // and the queue learns it can take the next message.
      finishTurn(turn);
      unsubscribeSession();
    }
  })();

  return { turn, finished };
}

/**
 * One turn in response to HTTP: checks the conversation, brings up the session, writes the stream, and
 * closes the response when the turn settled. After that the queue can take the next message.
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
  const chat = findChatRecord(config, user, chatId);
  if (!chat) {
    json(res, 404, errorBody('разговор не найден'));
    return;
  }
  // The panel continues Telegram: it's the same conversation and the same pi session. Read
  // access here is only for the API entry — its client owns the history itself.
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
    // The turn is either running without a viewer (the panel was reloaded) or in another channel —
    // and it's the same turn. You can only attach to your own stream: a Telegram turn has none
    // in the panel, and a second answer must not be started. The live turn the panel will
    // catch up on its own, and for a foreign one it will see the channel mark.
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

  const { turn, finished } = beginTurn({ config, user, registry, chatId, session, text, attachments });
  // We write to the viewer only while it exists; the rest has already been accumulated in the hub.
  const unsubscribe = subscribe(turn, (event) => {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(event)}\n`);
  });

  try {
    await finished;
  } finally {
    unsubscribe();
    if (!res.writableEnded) res.end();
  }
}

/**
 * Drains the queue: after the end of a turn we take the next message and start it.
 *
 * A turn from the queue lives without an HTTP response — the hub accumulates its events, and the panel attaches
 * to them via the summary. That's why the queue survives F5: the message lies here, not in the
 * browser, and waits only for the end of someone else's turn.
 */
async function drainQueued(
  config: IcarusConfig,
  user: UserConfig,
  registry: SessionRegistry,
  chatId: string,
): Promise<void> {
  const key = turnKey(user.id, chatId);
  if (draining.has(key) || starting.has(key)) return;
  draining.add(key);
  try {
    for (;;) {
      const head = queued(user.id, chatId)[0];
      if (!head) return;
      // A turn is already running — it will call the queue itself when it settles. «Now» holds
      // the latch until its turn starts: otherwise we'd slip into the interrupt gap.
      if (runningTurn(user.id, chatId) || starting.has(key)) return;
      const chat = findChatRecord(config, user, chatId);
      if (!chat || !panelCanWrite(chat)) {
        clearQueued(user, chatId);
        return;
      }
      let session;
      try {
        session = await registry.acquire(user, chatId, chat.workspace, chat.artifact);
      } catch (error) {
        // No session — we don't drop the queue: the person will see it and decide themselves.
        log.warn('чат: очередь не смогла поднять сессию', {
          user: user.id,
          chatId,
          error: String(error),
        });
        return;
      }
      // Compaction is not a turn, but the session is busy with it: we wait, not refuse.
      if (session.compacting) await session.compacting;
      // While the session was coming up, someone else could have taken the conversation.
      if (session.busy || runningTurn(user.id, chatId) || starting.has(key)) return;

      takeNext(user.id, chatId);
      broadcastQueue(user.id, chatId);
      const { finished } = beginTurn({
        config,
        user,
        registry,
        chatId,
        session,
        text: head.text,
        attachments: head.attachments,
      });
      await finished;
    }
  } finally {
    draining.delete(key);
  }
}

/** The queue changed — we tell the panel so the indicator doesn't lie. */
function broadcastQueue(userId: string, chatId: string): void {
  broadcast({ userId, chatId, type: 'queue', queue: queueView(userId, chatId) });
}

/** Clears the conversation's queue and tells the panel about it. */
function clearQueued(user: UserConfig, chatId: string): number {
  const dropped = clearQueue(user.id, chatId).length;
  if (dropped > 0) broadcastQueue(user.id, chatId);
  return dropped;
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
        url.searchParams.get('archived') === '1',
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

    // Archiving is a mark in the registry, not a deletion: the session file and attachments
    // stay in place, so the route only moves the conversation between lists.
    if (pathname === '/panel/api/chat/archive' && req.method === 'POST') {
      const body = await bodyOf(req);
      const chatId = chatIdOf(body.chatId);
      if (!chatId) {
        json(res, 400, errorBody('нужен chatId'));
        return true;
      }
      const archived = body.archived !== false;
      const outcome = await archiveChat(
        ctx.config,
        user,
        chatId,
        archived,
        ctx.archiveTelegram ? (chat) => ctx.archiveTelegram!(user, chat) : undefined,
      );
      const chat = outcome.chat;
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      if (outcome.topicError) {
        // The archive happened but the Telegram topic remained: this is worth seeing in the log.
        log.warn('панель: топик Telegram не удалился при архивации', {
          user: user.id,
          chat: chat.id,
          error: outcome.topicError,
        });
      }
      json(res, 200, { chat: { id: chat.id, archived: Boolean(chat.archivedAt) } });
      return true;
    }

    // Conversation name from the chat list: the same entry in chats.json as for `/rename`
    // in the web chat, so both the panel and Telegram see the name. After this the automation
    // doesn't rename the conversation: the person chose the name.
    if (pathname === '/panel/api/chats' && req.method === 'PATCH') {
      const body = await bodyOf(req);
      const id = chatIdOf(body.id);
      if (!id) {
        json(res, 400, errorBody('не указан разговор'));
        return true;
      }
      // The same length as for /rename: a Telegram topic has a 128-character limit.
      const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 128) : '';
      if (!title) {
        json(res, 400, errorBody('пустое имя разговора'));
        return true;
      }
      const chat = renameChat(ctx.config, user, id, title);
      if (!chat) {
        json(res, 404, errorBody('разговор не найден'));
        return true;
      }
      broadcast({ userId: user.id, chatId: chat.id, type: 'title', chat });
      json(res, 200, { chat });
      return true;
    }

    // We serve the image before checking the registry: an already lying file can be shown even
    // when the chat is for some reason running without pi.
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

    // A file from the agent's answer: non-images it draws as a link, and on click the person
    // must receive it, not a 404 from static. We serve non-images as a download:
    // HTML from the model's answer, opened in the panel's origin, is a foreign page.
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

    // We read the history even without pi: it lies in the session file, and showing an old
    // conversation is possible even where the container isn't up yet. There's nowhere to
    // send a message without a session — we'll check that below.
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
      // The turn could have survived a panel reload: we report this right away along with the
      // history, so the client attaches to the stream instead of wondering why it's quiet.
      // Only about a running turn: an already replayed answer is in the history, and drawing it
      // from the stream a second time is not allowed.
      json(res, 200, {
        ...history,
        live: Boolean(runningTurn(user.id, id)),
        // The queue lives on the server: a reloaded panel must see that what was written
        // during the turn didn't disappear.
        queue: queueView(user.id, id),
      });
      return true;
    }

    // Summary for all conversations: which event goes to whom. As a separate channel, not the
    // live stream of a conversation — the panel needs to know about foreign turns without reading them
    // in full. There are no text deltas here: only the start and the finale.
    if (pathname === '/panel/api/chat/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // A comment line right away: the proxy and browser must see a live connection,
      // not decide that the response hung.
      res.write(': icarus bulletin\n\n');
      const off = watchAll((event) => {
        // Foreign turns are none of the person's business.
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
      // A snapshot for someone who just opened the panel or reconnected the summary:
      // events during the gap are lost, but the state is right here.
      json(res, 200, { busy: ctx.registry?.busyConversations(user.id) ?? [] });
      return true;
    }

    // Folders are menu layout, not agent work: moving is available even when
    // the panel runs without pi. That's why the route is before the registry check.
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

    // pi commands: skills, prompt templates, and extension commands. Only pi itself knows
    // their list, so the palette asks it lazily — when the person has already
    // typed «/». The chat's own commands arrive in the page, without a request.
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
      // Commands are about the conversation, not the channel: in an API conversation they can't
      // be sent anyway, and in Telegram the bot parses them.
      if (!panelCanWrite(chat)) {
        json(res, 200, { commands: [] });
        return true;
      }
      const outcome = await ctx.registry.commands(user, id);
      json(res, 200, { commands: outcome.status === 'ok' ? outcome.commands : [] });
      return true;
    }

    // A command in the web chat: we parse it here, not in the browser — one parse and
    // one set of texts for all entry points. `handled: false` means «this is a pi command»,
    // and the client will send it as a regular message.
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
      // Help doesn't depend on the conversation: it can be asked even before the first message.
      if (command.name === 'help') {
        json(res, 200, { handled: true, text: WEB_HELP });
        return true;
      }
      // Removed commands we explain ourselves instead of sending them to pi as a message.
      if (REMOVED_COMMANDS.has(command.name)) {
        json(res, 200, { handled: true, text: TOPICS_REMOVED });
        return true;
      }
      // An unfamiliar command without arguments is a typo; with arguments it's already
      // a message for pi (its templates and extension commands).
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
      // Commands edit the whole conversation (including one shared with Telegram), so the
      // API entry is closed here just like `chat/send`.
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
        // «Stop» means «stop everything»: the person has already cancelled the messages
        // waiting in the queue, otherwise in a second Icarus would start thinking again unprompted.
        const dropped = clearQueued(user, chatId);
        json(res, 200, { handled: true, text: stopText(await ctx.registry.abort(user, chatId), dropped) });
        return true;
      }
      if (command.name === 'stats') {
        json(res, 200, { handled: true, text: statsText(await ctx.registry.stats(user, chatId)) });
        return true;
      }
      if (command.name === 'clear') {
        clearQueued(user, chatId);
        const outcome = await ctx.registry.clear(user, chatId);
        // We don't re-read the feed: the old messages remain, the client draws the
        // «context cleared» divider. `cleared` says that it's appropriate.
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
          // The client updates the title and sidebar right away, without reloading the feed.
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

    // Catching up to a running turn: the panel opened again (F5, new tab) and wants
    // to attach to what's already happening. We return the accumulated data and hold
    // the connection until the end of the turn — that's «reconnect to the stream».
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
        // No turn: the panel just takes the history, it doesn't need the stream.
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
      // The viewer left (F5, closed tab) — we just cross it out. The turn keeps
      // going, and the next panel will catch up to it with the same accumulated journal.
      const detach = (): void => off();
      res.on('close', detach);
      // We leave right after `done`/`error`: there's nothing more to tell about the turn.
      off = subscribe(turn, (event) => {
        if (res.writableEnded) return;
        res.write(`${JSON.stringify(event)}\n`);
        if (event.type === 'done' || event.type === 'error') {
          off();
          res.end();
        }
      });
      // The turn managed to settle while we were subscribing: the tail was given on replay, we close.
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
      // We continue the web chat and the Telegram conversation: it's one pi session, and transport
      // is just a pipe. The API entry stays foreign: there the client owns the history.
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
      // Two different operations, not one: «enqueue» is a promise to arrive after the
      // current turn, «now» is cancelling someone else's work for your message. Without the
      // parameter we assume the person just wrote: then with a busy
      // conversation the message goes into the queue instead of silently disappearing.
      const now = body.mode === 'now';
      // Latch: while we interrupt the previous turn and start our own, the queue stays silent.
      const nowKey = now ? turnKey(user.id, chat.id) : '';
      if (nowKey) starting.add(nowKey);
      try {
        if (inTurn(ctx.registry, user.id, chat.id)) {
          if (now) {
            if (ctx.registry.get(user.id, chat.id)?.compacting) {
              json(res, 409, {
                ...errorBody('сжимаю контекст — это не ход, прерывать его не стоит', 'conflict_error'),
                retry: true,
              });
              return true;
            }
            const outcome = await ctx.registry.interrupt(user, chat.id);
            if (outcome.status === 'failed') {
              json(res, 409, { ...errorBody(`ход не прервался: ${outcome.error}`, 'conflict_error'), retry: true });
              return true;
            }
            // Waited: the previous turn finished writing a partial answer, and only now
            // can we start a new one without slipping into the busy session.
            if (outcome.status === 'stopped') await waitTurnEnd(user.id, chat.id, INTERRUPT_WAIT_MS);
          }
          // Didn't interrupt (a race at the end of the turn) — the message still doesn't disappear:
          // it goes into the queue and arrives when the conversation frees up.
          if (inTurn(ctx.registry, user.id, chat.id)) {
            const placed = enqueue(user.id, chat.id, { text, attachments });
            if (!placed) {
              json(
                res,
                429,
                errorBody(`в очереди уже ${QUEUE_LIMIT} реплик — дождись хотя бы одной`, 'rate_limit_error'),
              );
              return true;
            }
            broadcastQueue(user.id, chat.id);
            json(res, 202, {
              queued: true,
              position: placed.position,
              queue: queueView(user.id, chat.id),
              live: Boolean(runningTurn(user.id, chat.id)),
            });
            return true;
          }
        }
        await streamTurn(req, res, ctx.config, user, ctx.registry, chat.id, text, attachments);
      } finally {
        if (nowKey) starting.delete(nowKey);
      }
      // The turn settled — the next message from the queue, if any.
      await drainQueued(ctx.config, user, ctx.registry, chat.id);
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
      // The «stop» button stops everything: otherwise in a moment the first message from the queue
      // would start, and the person has already pressed «enough».
      const dropped = clearQueued(user, chat.id);
      json(res, 200, { ok, dropped });
      return true;
    }

    // Remove one message from the queue: the person changed their mind before it was sent.
    if (pathname === '/panel/api/chat/queue/drop' && req.method === 'POST') {
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
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id || !dropQueued(user.id, chat.id, id)) {
        json(res, 404, errorBody('такой реплики в очереди нет'));
        return true;
      }
      broadcastQueue(user.id, chat.id);
      json(res, 200, { queue: queueView(user.id, chat.id) });
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
