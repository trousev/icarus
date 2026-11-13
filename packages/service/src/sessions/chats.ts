// A person's conversation registry: chats.json.
//
// Only metadata here: id, title, when created, channel and conversationId
// for the session file. We don't store the preview or last-message time — the session
// jsonl file provides them, and we read it only for the page we've shown.
//
// The registry is shared across all channels: web chat, Telegram and the OpenAI client. From it
// the panel shows the list and decides where writing is allowed and where it's view-only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WORKSPACE, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { titleFromText } from '../http/title.ts';
import { log } from '../log.ts';
import { channelForConversation, sessionIdFor, type ChatChannel } from './identity.ts';
import {
  createdAtFromFileName,
  discoverSessionFiles,
  readFirstUserText,
  sessionFileForId,
} from './files.ts';

export const NEW_CHAT_TITLE = 'Новый чат';
export const NEW_CHAT_PREVIEW = 'Расскажи, что нужно сделать.';

/** One pi session in a conversation's life: /clear starts a new one, old ones stay in history. */
export type SessionEpoch = {
  sessionId: string;
  /** When this session started: the separator in the feed is drawn by this mark. */
  startedAt: string;
};

/**
 * Where the last reply came from. A conversation's pi session is shared across all channels, and
 * the history file doesn't remember which one sent it: the panel, Telegram and API write to the same
 * jsonl. So the channel is recorded by whoever accepted the message — otherwise in the
 * shared feed you can't tell who said it.
 */
export type ChatTurn = {
  channel: ChatChannel;
  at: string;
};

/**
 * A conversation's place in Telegram: chat and topic. We keep it here, not in the bot's memory:
 * after a service restart we otherwise couldn't find which topic the conversation lives in —
 * and it's needed both to rename the topic from the panel's summary and to delete it
 * on archiving. You can't parse the place out of `conversationId` (in a group there's also a
 * person there), and the chat root is `threadId: null`.
 */
export type ChatTelegram = {
  chatId: number;
  threadId: number | null;
};

/**
 * The conversation was started by a scheduled task. This is not a folder: a person doesn't move
 * such a chat around by hand, and the panel assembles a virtual "Tasks" tree from the marks.
 * We store the name here rather than take it from the task: the task could have been deleted, but the branch
 * label must stay the same.
 */
export type ChatTaskMark = { id: string; name: string };

export type ChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  channel: ChatChannel;
  /** The conversation in pi terms: the history file is found by it. */
  conversationId?: string;
  /**
   * The chain of pi sessions: the first is how the conversation started, each next is after
   * `/clear`. We don't delete old sessions: the history before the separator is assembled from them.
   * The field is absent on old records — then there's one session and it's derived from the conversation.
   */
  sessions?: SessionEpoch[];
  /** The conversation's working folder: a conversation permanently stays in its own workspace. */
  workspace: string;
  /**
   * The folder in the left menu. It has nothing to do with the working directory: a person simply
   * files conversations onto shelves, and chats without a folder show up in "Inbox".
   * The field is absent — meaning the conversation is in "Inbox".
   */
  folder?: string;
  /**
   * Where the conversation lives in Telegram: its chat and topic. The field is absent on non-Telegram
   * conversations and on old records — before the bot's first message.
   */
  telegram?: ChatTelegram;
  /**
   * The "chat created by a task" mark. Such a conversation is not shown in the general list,
   * but lives in the virtual "Tasks" tree; folders.json says nothing about it.
   */
  task?: ChatTaskMark;
  /** When the task ran: the conversation sits in the tree branch by this date. */
  runAt?: string;
  /**
   * The artifact this conversation edits. A regular chat works in workspace,
   * while an artifact one — strictly in the artifact's folder, so workspace alone
   * is not enough for it: the folder is taken from the pi session, not from the working directory.
   */
  artifact?: string;
  /** Where the last reply came from: the panel labels the header by it. */
  lastTurn?: ChatTurn;
  /**
   * When the conversation was archived. Archive means "I don't see it every day", not
   * deletion: the record stays in chats.json, the session file and attachments are intact,
   * and the conversation can be returned. So this is a mark, not a "deleted" flag.
   */
  archivedAt?: string;
  /**
   * Who named the conversation. `auto` — us: a heuristic from the first reply or the model,
   * and such a name can still be refined during the first turns. `manual` — a person via
   * `/rename` or from the list, and we don't touch it. The field is absent on old records —
   * we assume the name has settled and don't rewrite it with the model.
   */
  titleSource?: 'auto' | 'manual';
  /**
   * The name the bot has already set for the Telegram topic. Telegram doesn't return the current
   * topic name, so we remember it ourselves: without this mark every refinement
   * of the title would send `editForumTopic` again, and Telegram leaves a service message
   * about it in the topic. At the chat root there's no topic — the field doesn't appear.
   */
  topicTitle?: string;
};

function chatsFile(config: IcarusConfig, user: UserConfig): string {
  return path.join(userPaths(config, user).root, 'chats.json');
}

function legacyIndexFile(config: IcarusConfig, user: UserConfig): string {
  return path.join(userPaths(config, user).root, 'session-index.json');
}

function isChannel(value: unknown): value is ChatChannel {
  return value === 'web' || value === 'telegram' || value === 'api';
}

/** Default title: while the first reply isn't available to take one from. */
export function defaultTitle(channel: ChatChannel): string {
  switch (channel) {
    case 'telegram':
      return 'Разговор в Telegram';
    case 'api':
      return 'Разговор через API';
    default:
      return NEW_CHAT_TITLE;
  }
}

/** The title hasn't formed from the first reply yet — it can be replaced. */
export function isGenericTitle(chat: ChatRecord): boolean {
  return !chat.title.trim() || chat.title === NEW_CHAT_TITLE || chat.title === defaultTitle(chat.channel);
}

export function panelCanWrite(chat: Pick<ChatRecord, 'channel'>): boolean {
  return chat.channel === 'web' || chat.channel === 'telegram';
}

/** We gave the name, not a person: this one can still be refined by the model. */
export function isAutoTitle(chat: ChatRecord): boolean {
  return chat.titleSource === 'auto';
}

function inferChannel(id: string): ChatChannel {
  if (id.startsWith('web-')) return 'web';
  if (id.startsWith('telegram-')) return 'telegram';
  return 'api';
}

/** Telegram place from a registry record: only numbers and an explicit root are valid. */
function telegramOf(value: unknown): ChatTelegram | null {
  if (!value || typeof value !== 'object') return null;
  const place = value as Record<string, unknown>;
  const chatId = typeof place.chatId === 'number' && Number.isFinite(place.chatId) ? place.chatId : null;
  if (chatId === null) return null;
  const threadId =
    place.threadId === null
      ? null
      : typeof place.threadId === 'number' && Number.isFinite(place.threadId)
        ? place.threadId
        : undefined;
  if (threadId === undefined) return null;
  return { chatId, threadId };
}

/**
 * Brings a record to the current schema. Old web records carry preview/updatedAt —
 * we drop them, and build up the channel and conversationId: the web chat id is itself the
 * conversationId. Records from the old session-index already have a conversationId.
 */
function normalize(value: unknown): ChatRecord | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id) return null;

  const channel = isChannel(item.channel) ? item.channel : inferChannel(item.id);
  const explicitConversation = typeof item.conversationId === 'string' && item.conversationId !== '';
  const conversationId = explicitConversation
    ? (item.conversationId as string)
    : item.id.startsWith('session:')
      ? undefined
      : item.id;
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString();
  const sessions: SessionEpoch[] = Array.isArray(item.sessions)
    ? item.sessions
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const epoch = entry as Record<string, unknown>;
          const sessionId = typeof epoch.sessionId === 'string' ? epoch.sessionId.trim() : '';
          const startedAt = typeof epoch.startedAt === 'string' ? epoch.startedAt : '';
          return sessionId ? { sessionId, startedAt: startedAt || createdAt } : null;
        })
        .filter((epoch): epoch is SessionEpoch => epoch !== null)
    : [];
  // A record could have been written with a single sessionId (an intermediate format):
  // we don't lose the session but expand it into a chain.
  const legacySessionId = typeof item.sessionId === 'string' && item.sessionId.trim() ? item.sessionId : '';
  if (sessions.length === 0 && legacySessionId) sessions.push({ sessionId: legacySessionId, startedAt: createdAt });

  const telegram = telegramOf(item.telegram);
  const turn = item.lastTurn && typeof item.lastTurn === 'object' ? (item.lastTurn as Record<string, unknown>) : null;
  const lastTurn: ChatTurn | null =
    turn && isChannel(turn.channel) && typeof turn.at === 'string' && turn.at
      ? { channel: turn.channel, at: turn.at }
      : null;

  // A task mark without an id or a name is useless: there is nowhere to put such a chat in the tree,
  // and it honestly remains a regular conversation.
  const task = item.task && typeof item.task === 'object' ? (item.task as Record<string, unknown>) : null;
  const taskId = task && typeof task.id === 'string' ? task.id.trim() : '';
  const taskName = task && typeof task.name === 'string' ? task.name.trim() : '';
  const taskMark: ChatTaskMark | null = taskId && taskName ? { id: taskId, name: taskName } : null;

  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : defaultTitle(channel),
    createdAt,
    channel,
    // Records before workspaces appeared all lived in "Conversation".
    workspace: typeof item.workspace === 'string' && item.workspace ? item.workspace : DEFAULT_WORKSPACE,
    ...(conversationId ? { conversationId } : {}),
    ...(sessions.length > 0 ? { sessions } : {}),
    // An empty folder never happens: a reference to a deleted folder is the same as "Inbox".
    ...(typeof item.folder === 'string' && item.folder !== '' ? { folder: item.folder } : {}),
    ...(taskMark ? { task: taskMark } : {}),
    // We don't store a run date without a mark: for a regular chat createdAt plays its role.
    ...(taskMark && typeof item.runAt === 'string' && item.runAt ? { runAt: item.runAt } : {}),
    // An empty string means "a regular chat", not an artifact with an empty name.
    ...(typeof item.artifact === 'string' && item.artifact !== '' ? { artifact: item.artifact } : {}),
    ...(telegram ? { telegram } : {}),
    ...(lastTurn ? { lastTurn } : {}),
    ...(typeof item.archivedAt === 'string' && item.archivedAt !== '' ? { archivedAt: item.archivedAt } : {}),
    ...(item.titleSource === 'auto' || item.titleSource === 'manual' ? { titleSource: item.titleSource } : {}),
    ...(typeof item.topicTitle === 'string' && item.topicTitle !== '' ? { topicTitle: item.topicTitle } : {}),
  };
}

/** The registry is read in full: it's a small index, not a conversation history. */
export function readChats(config: IcarusConfig, user: UserConfig): ChatRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(chatsFile(config, user), 'utf8')) as { chats?: unknown };
    if (!Array.isArray(parsed.chats)) return [];
    const seen = new Set<string>();
    return parsed.chats
      .map(normalize)
      .filter((chat): chat is ChatRecord => chat !== null)
      .filter((chat) => {
        if (seen.has(chat.id)) return false;
        seen.add(chat.id);
        return true;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('не читается список чатов', { user: user.id, error: String(error) });
    }
    return [];
  }
}

/** We write via a temporary file: a crash mid-write shouldn't eat the registry. */
export function writeChats(config: IcarusConfig, user: UserConfig, chats: ChatRecord[]): void {
  const file = chatsFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const unique = new Map<string, ChatRecord>();
  for (const chat of chats) {
    const existing = unique.get(chat.id);
    // A record with a conversationId is more useful: the history file is found by it.
    if (!existing || (!existing.conversationId && chat.conversationId)) unique.set(chat.id, chat);
  }
  fs.writeFileSync(tmp, `${JSON.stringify({ chats: [...unique.values()] }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** A conversation's sessions in order: old records have one and it's derived from the id. */
export function sessionEpochsOf(chat: ChatRecord, user: UserConfig): SessionEpoch[] {
  if (chat.sessions && chat.sessions.length > 0) return chat.sessions;
  return [{ sessionId: derivedSessionId(chat, user), startedAt: chat.createdAt }];
}

/** All of a conversation's sessions — the history is assembled from them with separators after /clear. */
export function sessionIdsOf(chat: ChatRecord, user: UserConfig): string[] {
  return sessionEpochsOf(chat, user).map((epoch) => epoch.sessionId);
}

/** id of the current (last) pi session: we continue the conversation and find a fresh file by it. */
export function sessionIdOf(chat: ChatRecord, user: UserConfig): string {
  const epochs = sessionEpochsOf(chat, user);
  return epochs.at(-1)?.sessionId ?? derivedSessionId(chat, user);
}

/** id of the session derived from the conversation: this is how records lived before the session chain. */
function derivedSessionId(chat: ChatRecord, user: UserConfig): string {
  if (chat.conversationId) return sessionIdFor(user.id, chat.conversationId);
  if (chat.id.startsWith('session:')) return chat.id.slice('session:'.length);
  return sessionIdFor(user.id, chat.id);
}

/**
 * Adds a new pi session to a conversation. `/clear` starts it in pi, and we append
 * it to the chain: old files remain the history before the separator, the new one is the current
 * context. We derive the first session from the conversationId if there's no chain yet.
 */
export function appendChatSession(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  sessionId: string,
  startedAt = new Date().toISOString(),
): ChatRecord | null {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat) return null;

  const epochs = sessionEpochsOf(chat, user).slice();
  if (epochs.at(-1)?.sessionId !== sessionId) epochs.push({ sessionId, startedAt });
  chat.sessions = epochs;
  writeChats(config, user, chats);
  return chat;
}

/** A person renamed the conversation: the name is no longer derived from the first reply. */
export function renameChat(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  title: string,
): ChatRecord | null {
  const name = title.trim();
  if (!name) return null;
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat) return null;
  // The person chose the name: the model no longer rewrites it, even if the conversation
  // just started. We also write when the name matched: the record could come from a version
  // without this field, and then the mark must be set, otherwise the model would rename.
  if (chat.title !== name || chat.titleSource !== 'manual') {
    chat.title = name;
    chat.titleSource = 'manual';
    writeChats(config, user, chats);
  }
  return chat;
}

/**
 * Archives the conversation or returns it back. Only the mark in the registry changes:
 * the history, session files and attachments stay in place, so
 * archive isn't confused with deletion. Re-archiving doesn't move the mark —
 * so the order in the archive doesn't jump from an extra click.
 */
export function setChatArchived(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  archived: boolean,
  now = new Date(),
): ChatRecord | null {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat) return null;
  if (archived) {
    if (chat.archivedAt) return chat;
    chat.archivedAt = now.toISOString();
  } else {
    if (!chat.archivedAt) return chat;
    delete chat.archivedAt;
  }
  writeChats(config, user, chats);
  return chat;
}

/**
 * Remembers where the conversation lives in Telegram: chat and topic. Called by the bot after
 * accepting a message — so the place survives a service restart. We write only
 * a change: otherwise every message in the chat would touch the registry for nothing.
 */
export function setChatTelegram(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  chatId: number,
  threadId: number | null,
): ChatRecord | null {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat) return null;
  if (chat.telegram?.chatId === chatId && chat.telegram.threadId === threadId) return chat;
  chat.telegram = { chatId, threadId };
  writeChats(config, user, chats);
  return chat;
}

/** A conversation's place in Telegram: null — the conversation wasn't started by the bot. */
export function telegramPlaceOf(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
): ChatTelegram | null {
  return findChatRecord(config, user, conversationId)?.telegram ?? null;
}

/** The topic was deleted together with the messages — the conversation has no Telegram place anymore. */
function clearChatTelegram(config: IcarusConfig, user: UserConfig, conversationId: string): void {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat?.telegram) return;
  delete chat.telegram;
  writeChats(config, user, chats);
}

/** What failed when removing the conversation from Telegram: this doesn't prevent archiving. */
export type ArchiveOutcome = { chat: ChatRecord | null; topicError?: string };

/**
 * Archives the conversation and — if asked — removes it from Telegram.
 * Archiving and topic deletion live together because in the panel and in the bot this is
 * one action: "clear from sight". The Telegram topic is deleted together with the
 * messages, and this is irreversible, so returning from the archive doesn't resurrect it:
 * the conversation returns only to the panel (see setChatArchived).
 *
 * Topic deletion is a side effect, not a condition of archiving: if Telegram refuses,
 * the conversation still goes to the archive, and the error is shown by whoever called it.
 * `removeTopic` not passed (panel without the bot) — we just move the mark.
 */
export async function archiveChat(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  archived = true,
  removeTopic?: (chat: ChatRecord) => Promise<void>,
): Promise<ArchiveOutcome> {
  const before = findChatRecord(config, user, conversationId);
  const chat = setChatArchived(config, user, conversationId, archived);
  if (!chat) return { chat: null };
  // Returning from the archive doesn't touch Telegram: the topic is already deleted, nothing to resurrect.
  // We also don't touch an already-archived conversation — otherwise a repeated /archive would keep
  // hammering deletion on a dead topic.
  if (!archived || before?.archivedAt || !removeTopic) return { chat };
  const place = chat.telegram;
  if (!place || place.threadId === null) return { chat };
  try {
    await removeTopic(chat);
  } catch (error) {
    return { chat, topicError: error instanceof Error ? error.message : String(error) };
  }
  clearChatTelegram(config, user, conversationId);
  return { chat };
}

/**
 * Removes a workspace: its dialogs return to "Conversation" (as the panel promises),
 * and the history files themselves aren't touched — they lie in the shared sessions folder.
 */
export function reassignChats(config: IcarusConfig, user: UserConfig, from: string, to = DEFAULT_WORKSPACE): number {
  const chats = readChats(config, user);
  let moved = 0;
  for (const chat of chats) {
    if (chat.workspace !== from) continue;
    chat.workspace = to;
    moved += 1;
  }
  if (moved > 0) writeChats(config, user, chats);
  return moved;
}

/**
 * Moves a conversation to a menu folder (or to "Inbox" if folder === null).
 * The session file, workspace and title don't change: this is only a shelf in the list.
 */
export function setChatFolder(
  config: IcarusConfig,
  user: UserConfig,
  id: string,
  folder: string | null,
): ChatRecord | null {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.id === id || item.conversationId === id);
  if (!chat) return null;
  if (chat.folder === (folder ?? undefined)) return chat;
  if (folder) chat.folder = folder;
  else delete chat.folder;
  writeChats(config, user, chats);
  return chat;
}

/** The folder was deleted: its conversations return to "Inbox" rather than being lost. */
export function reassignChatFolder(
  config: IcarusConfig,
  user: UserConfig,
  folder: string,
  to: string | null = null,
): number {
  const chats = readChats(config, user);
  let moved = 0;
  for (const chat of chats) {
    if (chat.folder !== folder) continue;
    if (to) chat.folder = to;
    else delete chat.folder;
    moved += 1;
  }
  if (moved > 0) writeChats(config, user, chats);
  return moved;
}

/** Which workspace the conversation lives in: records before the move are in "Conversation". */
export function workspaceForConversation(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
): string | undefined {
  return readChats(config, user).find(
    (chat) => chat.conversationId === conversationId || chat.id === conversationId,
  )?.workspace;
}

/**
 * Switches a conversation to another workspace. The folder lives in chats.json next to the
 * conversation, so all entry points see the choice and it survives a service restart.
 * The pi session learns about the move on the next turn: the registry compares the live
 * session's folder with the record and raises it anew in the new one (see SessionRegistry.acquire).
 */
export function setChatWorkspace(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  workspace: string,
): ChatRecord {
  // The record may not exist yet: /workspace is a legitimate first command
  // in a new conversation, before the first turn.
  ensureChat(config, user, conversationId, channelForConversation(conversationId), workspace);
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  // ensureChat just wrote the conversation, so we always find it; if
  // the file still didn't read, don't let the caller pretend it switched.
  if (!chat) throw new Error(`разговор ${conversationId} не записался в реестр`);
  if (chat.workspace === workspace) return chat;
  chat.workspace = workspace;
  writeChats(config, user, chats);
  return chat;
}

/** A conversation's artifact: a regular chat has none, an artifact edit has one. */
export function artifactForConversation(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
): string | undefined {
  return readChats(config, user).find(
    (chat) => chat.conversationId === conversationId || chat.id === conversationId,
  )?.artifact;
}

/**
 * Where the conversation's last reply came from. null — the turn hasn't been recorded by this
 * service yet (old sessions) or there's no record at all.
 */
export function lastTurnOf(config: IcarusConfig, user: UserConfig, conversationId: string): ChatTurn | null {
  return findChatRecord(config, user, conversationId)?.lastTurn ?? null;
}

/**
 * Records which channel the reply came from. Called by whoever accepted the message:
 * the panel, the bot and the OpenAI entry point. By this point the conversation already exists —
 * `registry.acquire` creates it; if there's no record, we silently do nothing: the reply
 * matters more than the label.
 */
export function recordTurn(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  channel: ChatChannel,
  at = new Date(),
): ChatRecord | null {
  try {
    const chats = readChats(config, user);
    const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
    if (!chat) return null;
    chat.lastTurn = { channel, at: at.toISOString() };
    writeChats(config, user, chats);
    return chat;
  } catch (error) {
    log.warn('не записался канал последней реплики', { user: user.id, error: String(error) });
    return null;
  }
}

/** New web chat: the only channel the panel creates itself. */
export function createChatRecord(
  config: IcarusConfig,
  user: UserConfig,
  workspace: string = DEFAULT_WORKSPACE,
  now = new Date(),
  options: { title?: string; artifact?: string; task?: ChatTaskMark } = {},
): ChatRecord {
  const id = `web-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const chat: ChatRecord = {
    id,
    title: options.title?.trim() || NEW_CHAT_TITLE,
    createdAt: now.toISOString(),
    channel: 'web',
    workspace,
    conversationId: id,
    ...(options.artifact ? { artifact: options.artifact } : {}),
    // The run date is the creation moment: for a task chat these are the same event.
    ...(options.task ? { task: options.task, runAt: now.toISOString() } : {}),
  };
  const chats = readChats(config, user);
  chats.unshift(chat);
  writeChats(config, user, chats);
  return chat;
}

/**
 * A conversation tied to an artifact. One artifact — one such chat: a person
 * returns to "the same edit" rather than starting a new dialog each time.
 */
export function findArtifactChat(
  config: IcarusConfig,
  user: UserConfig,
  artifact: string,
): ChatRecord | undefined {
  return readChats(config, user).find((chat) => chat.channel === 'web' && chat.artifact === artifact);
}

/**
 * The conversation was raised — so it exists. The registry knows about it even if
 * a person never opened the panel. We update an old `session:<id>` record without a
 * conversationId to the real conversation id so it doesn't split in two.
 */
export function ensureChat(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  channel: ChatChannel,
  workspace: string = DEFAULT_WORKSPACE,
  now = new Date(),
  artifact?: string,
): ChatRecord {
  const chats = readChats(config, user);
  const sessionId = sessionIdFor(user.id, conversationId);
  const legacyId = `session:${sessionId}`;
  let chat =
    chats.find((item) => item.conversationId === conversationId || item.id === conversationId || item.id === legacyId) ??
    chats.find((item) => sessionIdOf(item, user) === sessionId);

  if (!chat) {
    chat = {
      id: conversationId,
      title: defaultTitle(channel),
      createdAt: now.toISOString(),
      channel,
      workspace,
      conversationId,
      ...(artifact ? { artifact } : {}),
    };
    chats.unshift(chat);
    writeChats(config, user, chats);
    return chat;
  }

  let changed = false;
  if (chat.id === legacyId || chat.id.startsWith('session:')) {
    chat.id = conversationId;
    changed = true;
  }
  if (chat.conversationId !== conversationId) {
    chat.conversationId = conversationId;
    changed = true;
  }
  if (chat.channel !== channel) {
    chat.channel = channel;
    changed = true;
  }
  // The registry may be left over from a version without artifact chats: we build up
  // the conversation type on the first turn rather than lose the edit mode.
  if (artifact && chat.artifact !== artifact) {
    chat.artifact = artifact;
    changed = true;
  }
  if (changed) writeChats(config, user, chats);
  return chat;
}

/** The title updated: we write once, not on every list render. */
export function updateChatTitles(config: IcarusConfig, user: UserConfig, titles: Map<string, string>): void {
  if (titles.size === 0) return;
  const chats = readChats(config, user);
  let changed = false;
  for (const chat of chats) {
    const title = titles.get(chat.id);
    if (!title || title === chat.title) continue;
    chat.title = title;
    changed = true;
  }
  if (changed) writeChats(config, user, chats);
}

/**
 * A name from us: a heuristic from the first reply or the model. We mark it `auto` — only
 * such names the model can still refine; a name chosen by a person we don't touch.
 * We don't rename an archived conversation: it's been cleared from sight, and a new name there
 * is a trace of someone else's work, not what a person expects to see when returning the conversation.
 */
export function applyAutoTitle(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  title: string,
): ChatRecord | null {
  const name = title.trim();
  if (!name) return null;
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat || chat.archivedAt || chat.titleSource === 'manual') return null;
  if (chat.title !== name || chat.titleSource !== 'auto') {
    chat.title = name;
    chat.titleSource = 'auto';
    writeChats(config, user, chats);
  }
  return chat;
}

/**
 * A title from the person's first reply. We read the head of the file and only if
 * the title is still generic: Telegram/API have no finishChat of their own, so
 * the first turn gives the conversation a name, and the panel later shows it as a regular one.
 */
export function refreshChatTitle(config: IcarusConfig, user: UserConfig, conversationId: string): void {
  try {
    const chats = readChats(config, user);
    const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
    if (!chat || !isGenericTitle(chat) || chat.archivedAt) return;

    const file = sessionFileForId(userPaths(config, user).sessions, sessionIdOf(chat, user));
    if (!file) return;
    const text = readFirstUserText(file);
    if (!text) return;
    const title = titleFromText(text.replace(/^\[(?:голосовое|voice)[^\]]*\]\s*/i, ''));
    if (!title || title === chat.title) return;
    chat.title = title;
    // Telegram/API names are ours too: if a person didn't choose it, the model can later
    // refine it from the first replies — but the live title is counted in the web chat now,
    // and that's where we look.
    if (chat.titleSource !== 'manual') chat.titleSource = 'auto';
    writeChats(config, user, chats);
  } catch (error) {
    // The title is decoration: its failure shouldn't cancel the answer to a person.
    log.warn('не обновился заголовок разговора', { user: user.id, error: String(error) });
  }
}

/**
 * Remembered the name set for the Telegram topic. We have to compare our own name with the current
 * one ourselves: the Bot API can't ask what the topic is called right now.
 */
export function setTopicTitle(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  name: string,
): void {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat || chat.topicTitle === name) return;
  chat.topicTitle = name;
  writeChats(config, user, chats);
}

type LegacyIndexEntry = { sessionId: string; conversationId: string };

type LegacyIndex = { entries: Map<string, string>; readable: boolean };

function readLegacyIndex(config: IcarusConfig, user: UserConfig): LegacyIndex {
  const file = legacyIndexFile(config, user);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions?: unknown };
    if (!Array.isArray(parsed.sessions)) return { entries: new Map(), readable: true };
    const entries = parsed.sessions.filter(
      (entry): entry is LegacyIndexEntry =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).sessionId === 'string' &&
        typeof (entry as Record<string, unknown>).conversationId === 'string',
    );
    return { entries: new Map(entries.map((entry) => [entry.sessionId, entry.conversationId])), readable: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('не читается старый session-index.json', { user: user.id, error: String(error) });
    }
    return { entries: new Map(), readable: false };
  }
}

/**
 * Before the first migration we save the old chats.json: it has preview/updatedAt and
 * no channel. If the file is broken — we set it aside rather than overwrite it:
 * we'll restore the registry from sessions, and the contents remain for inspection.
 */
function backupLegacyChats(config: IcarusConfig, user: UserConfig): void {
  const file = chatsFile(config, user);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const broken = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, broken);
    log.warn('битый chats.json отложен в сторону', { user: user.id, file: broken });
    return;
  }

  const chats = (parsed as { chats?: unknown }).chats;
  if (!Array.isArray(chats)) {
    const broken = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, broken);
    log.warn('chats.json без массива chats отложен в сторону', { user: user.id, file: broken });
    return;
  }

  const legacy = chats.some(
    (item) =>
      Boolean(item) &&
      typeof item === 'object' &&
      (!('channel' in (item as object)) || 'preview' in (item as object) || 'updatedAt' in (item as object)),
  );
  if (!legacy) return;

  const backup = path.join(userPaths(config, user).root, 'chats.json.bak');
  if (fs.existsSync(backup)) return;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  log.info('старый chats.json сохранён перед миграцией', { user: user.id, backup });
}

/**
 * A one-time pass over session files at startup: everything already on disk
 * must get into the registry. There are no full reads here — only names and mtime;
 * titles arrive when a conversation is first shown or gets a turn.
 *
 * Along the way we migrate the old session-index.json (sessionId → conversationId)
 * into the main registry and delete it: there's no second index anymore.
 */
export function backfillChats(config: IcarusConfig, user: UserConfig): void {
  try {
    backupLegacyChats(config, user);
    const chats = readChats(config, user);
    const legacy = readLegacyIndex(config, user);
    const sessions = discoverSessionFiles(userPaths(config, user).sessions);

    for (const session of sessions) {
      const mappedConversation = legacy.entries.get(session.sessionId);
      const chat =
        chats.find((item) => sessionIdOf(item, user) === session.sessionId) ??
        (mappedConversation
          ? chats.find((item) => item.conversationId === mappedConversation || item.id === mappedConversation)
          : undefined);

      if (chat) {
        if (!mappedConversation) continue;
        const channel = channelForConversation(mappedConversation);
        if (chat.id.startsWith('session:')) chat.id = mappedConversation;
        if (chat.conversationId !== mappedConversation) chat.conversationId = mappedConversation;
        if (chat.channel !== channel) chat.channel = channel;
        continue;
      }

      const channel = mappedConversation ? channelForConversation(mappedConversation) : 'telegram';
      const id = mappedConversation ?? `session:${session.sessionId}`;
      chats.push({
        id,
        title: defaultTitle(channel),
        createdAt: createdAtFromFileName(path.basename(session.file)) ?? new Date(session.mtimeMs).toISOString(),
        channel,
        workspace: DEFAULT_WORKSPACE,
        ...(mappedConversation ? { conversationId: mappedConversation } : {}),
      });
    }

    // Two records could point at one file (the old session:<id> and the real
    // conversationId). We keep one — the one with a conversationId and a live title.
    const unique = new Map<string, ChatRecord>();
    for (const chat of chats) {
      const key = sessionIdOf(chat, user);
      const existing = unique.get(key);
      if (!existing) {
        unique.set(key, chat);
        continue;
      }
      if ((!existing.conversationId && chat.conversationId) || (isGenericTitle(existing) && !isGenericTitle(chat))) {
        unique.set(key, chat);
      }
    }

    // We always write: along the way we drop preview/updatedAt from the old schema.
    writeChats(config, user, [...unique.values()]);

    // We leave a broken file in place: deleting what we couldn't read is worse than showing a warning.
    if (legacy.readable && fs.existsSync(legacyIndexFile(config, user))) {
      fs.rmSync(legacyIndexFile(config, user), { force: true });
      log.info('старый session-index.json перенесён в chats.json и удалён', { user: user.id });
    }
  } catch (error) {
    log.warn('не удалось собрать реестр разговоров', { user: user.id, error: String(error) });
  }
}

/**
 * Conversation map for the agent: `conversationId` → pi session id and history file.
 *
 * The agent sees sessions only as files `<time>_<id>.jsonl`, and the conversation can't be
 * reconstructed back from the name (see files.ts). A panel link carries `conversationId`, and it
 * can't compute the session id itself — that's a hash with the person's id, which isn't in the container.
 * So the service renders the map (it has both) and puts it next to the
 * registry, where the agent looks through a read-only mount (see compose.ts, workspace.ts).
 */
export function renderSessionsMap(config: IcarusConfig, user: UserConfig): string {
  const paths = userPaths(config, user);
  const entries = readChats(config, user).map((chat) => {
    const conversationId = chat.conversationId ?? chat.id;
    const sessionId = sessionIdOf(chat, user);
    const file = sessionFileForId(paths.sessions, sessionId);
    return {
      conversationId,
      sessionId,
      channel: chat.channel,
      workspace: chat.workspace,
      ...(chat.artifact ? { artifact: chat.artifact } : {}),
      title: chat.title,
      ...(file ? { file } : {}),
    };
  });

  return `${JSON.stringify({ sessions: entries }, null, 2)}\n`;
}

/** Finds a record by panel id, conversationId or the old `session:<id>`. */
export function findChatRecord(config: IcarusConfig, user: UserConfig, id: string): ChatRecord | null {
  const chats = readChats(config, user);
  const direct = chats.find((chat) => chat.id === id || chat.conversationId === id);
  if (direct) return direct;

  if (id.startsWith('session:')) {
    const sessionId = id.slice('session:'.length);
    return chats.find((chat) => sessionIdOf(chat, user) === sessionId) ?? null;
  }

  const sessionId = sessionIdFor(user.id, id);
  return chats.find((chat) => sessionIdOf(chat, user) === sessionId) ?? null;
}
