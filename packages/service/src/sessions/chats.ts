// Реестр разговоров человека: chats.json.
//
// Здесь только метаданные: id, заголовок, когда создан, канал и conversationId
// для файла сессии. Превью и время последнего сообщения не храним — их даёт
// jsonl-файл сессии, и читаем мы его только для той страницы, которую показали.
//
// Реестр общий для всех каналов: веб-чат, Telegram и OpenAI-клиент. По нему
// панель показывает список и решает, куда писать можно, а куда — только смотреть.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
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

export type ChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  channel: ChatChannel;
  /** Разговор в терминах pi: по нему находится файл истории. */
  conversationId?: string;
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

/** Заголовок по умолчанию: пока первую реплику ещё не из чего взять. */
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

/** Заголовок ещё не сложился из первой реплики — его можно заменить. */
export function isGenericTitle(chat: ChatRecord): boolean {
  return !chat.title.trim() || chat.title === NEW_CHAT_TITLE || chat.title === defaultTitle(chat.channel);
}

function inferChannel(id: string): ChatChannel {
  if (id.startsWith('web-')) return 'web';
  if (id.startsWith('telegram-')) return 'telegram';
  return 'api';
}

/**
 * Приводит запись к текущей схеме. Старые веб-записи несут preview/updatedAt —
 * их выбрасываем, а канал и conversationId достраиваем: id веб-чата и есть
 * conversationId. У записей из старого session-index conversationId уже есть.
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

  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : defaultTitle(channel),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    channel,
    ...(conversationId ? { conversationId } : {}),
  };
}

/** Реестр читается целиком: это маленький индекс, а не история разговоров. */
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

/** Пишем через временный файл: падение посреди записи не должно съесть реестр. */
export function writeChats(config: IcarusConfig, user: UserConfig, chats: ChatRecord[]): void {
  const file = chatsFile(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const unique = new Map<string, ChatRecord>();
  for (const chat of chats) {
    const existing = unique.get(chat.id);
    // Запись с conversationId полезнее: по ней находится файл истории.
    if (!existing || (!existing.conversationId && chat.conversationId)) unique.set(chat.id, chat);
  }
  fs.writeFileSync(tmp, `${JSON.stringify({ chats: [...unique.values()] }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** id сессии pi, к которой относится запись: по нему ищется файл истории. */
export function sessionIdOf(chat: ChatRecord, user: UserConfig): string {
  if (chat.conversationId) return sessionIdFor(user.id, chat.conversationId);
  if (chat.id.startsWith('session:')) return chat.id.slice('session:'.length);
  return sessionIdFor(user.id, chat.id);
}

/** Новый веб-чат: единственный канал, который панель создаёт сама. */
export function createChatRecord(config: IcarusConfig, user: UserConfig, now = new Date()): ChatRecord {
  const id = `web-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const chat: ChatRecord = {
    id,
    title: NEW_CHAT_TITLE,
    createdAt: now.toISOString(),
    channel: 'web',
    conversationId: id,
  };
  const chats = readChats(config, user);
  chats.unshift(chat);
  writeChats(config, user, chats);
  return chat;
}

/**
 * Разговор поднялся — значит, он существует. Реестр знает о нём, даже если
 * человек ни разу не открывал панель. Старую запись `session:<id>` без
 * conversationId обновляем на настоящий id разговора, чтобы она не раздвоилась.
 */
export function ensureChat(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  channel: ChatChannel,
  now = new Date(),
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
      conversationId,
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
  if (changed) writeChats(config, user, chats);
  return chat;
}

/** Заголовок обновился: пишем один раз, а не на каждый показ списка. */
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
 * Заголовок из первой реплики человека. Читаем голову файла и только если
 * заголовок ещё служебный: у Telegram/API нет своего finishChat, поэтому
 * первый же ход даёт имя разговору, а панель потом показывает его как обычный.
 */
export function refreshChatTitle(config: IcarusConfig, user: UserConfig, conversationId: string): void {
  try {
    const chats = readChats(config, user);
    const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
    if (!chat || !isGenericTitle(chat)) return;

    const file = sessionFileForId(userPaths(config, user).sessions, sessionIdOf(chat, user));
    if (!file) return;
    const text = readFirstUserText(file);
    if (!text) return;
    const title = titleFromText(text.replace(/^\[(?:голосовое|voice)[^\]]*\]\s*/i, ''));
    if (!title || title === chat.title) return;
    chat.title = title;
    writeChats(config, user, chats);
  } catch (error) {
    // Заголовок — украшение: его сбой не должен отменять ответ человеку.
    log.warn('не обновился заголовок разговора', { user: user.id, error: String(error) });
  }
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
 * Разовый проход по файлам сессий при старте: всё, что уже лежит на диске,
 * должно попасть в реестр. Полных чтений тут нет — только имена и mtime;
 * заголовки доезжают, когда разговор впервые показывается или получает ход.
 *
 * Заодно переносим старый session-index.json (sessionId → conversationId)
 * в основной реестр и удаляем его: второго индекса больше нет.
 */
export function backfillChats(config: IcarusConfig, user: UserConfig): void {
  try {
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
        ...(mappedConversation ? { conversationId: mappedConversation } : {}),
      });
    }

    // Две записи могли смотреть на один файл (старый session:<id> и настоящий
    // conversationId). Оставляем одну — ту, где есть conversationId и живой заголовок.
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

    // Пишем всегда: заодно выбрасываем preview/updatedAt из старой схемы.
    writeChats(config, user, [...unique.values()]);

    // Битой файл оставляем на месте: удалять то, что не смогли прочитать, — хуже, чем показать предупреждение.
    if (legacy.readable && fs.existsSync(legacyIndexFile(config, user))) {
      fs.rmSync(legacyIndexFile(config, user), { force: true });
      log.info('старый session-index.json перенесён в chats.json и удалён', { user: user.id });
    }
  } catch (error) {
    log.warn('не удалось собрать реестр разговоров', { user: user.id, error: String(error) });
  }
}

/** Находит запись по id панели, conversationId или старому `session:<id>`. */
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
