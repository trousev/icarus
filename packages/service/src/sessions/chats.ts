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

/** Одна сессия pi в жизни разговора: /clear начинает новую, старые остаются в истории. */
export type SessionEpoch = {
  sessionId: string;
  /** Когда началась эта сессия: по этой отметке в ленте рисуется разделитель. */
  startedAt: string;
};

/**
 * Откуда пришла последняя реплика. Сессия pi у разговора одна на все каналы, и
 * файл истории не помнит, чем её прислали: панель, Telegram и API пишут в один и
 * тот же jsonl. Поэтому канал записывает тот, кто принял сообщение, — иначе в
 * общей ленте не понять, кто это сказал.
 */
export type ChatTurn = {
  channel: ChatChannel;
  at: string;
};

/**
 * Место разговора в Telegram: чат и топик. Храним здесь, а не в памяти бота:
 * после перезапуска сервиса иначе не найти, в каком топике живёт разговор, —
 * а он нужен и чтобы переименовать топик по сводке панели, и чтобы удалить его
 * при архивации. В `conversationId` место не разобрать (в группе там ещё и
 * человек), а корень чата — это `threadId: null`.
 */
export type ChatTelegram = {
  chatId: number;
  threadId: number | null;
};

/**
 * Разговор завела задача по расписанию. Это не папка: человек такой чат руками
 * не перекладывает, а панель собирает из меток виртуальное дерево «Задачи».
 * Имя храним здесь, а не берём из задачи: задачу могли удалить, а подпись ветки
 * должна остаться прежней.
 */
export type ChatTaskMark = { id: string; name: string };

export type ChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  channel: ChatChannel;
  /** Разговор в терминах pi: по нему находится файл истории. */
  conversationId?: string;
  /**
   * Цепочка сессий pi: первая — как разговор начался, каждая следующая — после
   * `/clear`. Старые сессии не удаляем: по ним собирается история до разделителя.
   * Поля нет у старых записей — тогда сессия одна и выводится из разговора.
   */
  sessions?: SessionEpoch[];
  /** Рабочая папка разговора: разговор навсегда остаётся в своём workspace'е. */
  workspace: string;
  /**
   * Папка в левом меню. К рабочему каталогу отношения не имеет: человек просто
   * раскладывает разговоры по полкам, а chats без папки показывает «Входящие».
   * Поля нет — значит, разговор лежит во «Входящих».
   */
  folder?: string;
  /**
   * Где разговор живёт в Telegram: его чат и топик. Поля нет у не-Telegram
   * разговоров и у старых записей — до первого сообщения бота.
   */
  telegram?: ChatTelegram;
  /**
   * Признак «чат создан задачей». В общем списке такой разговор не показывается,
   * а живёт в виртуальном дереве «Задачи»; в folders.json про него ничего нет.
   */
  task?: ChatTaskMark;
  /** Когда задача запустилась: по этой дате разговор лежит в ветке дерева. */
  runAt?: string;
  /**
   * Артефакт, который правит этот разговор. Обычный чат работает в workspace,
   * а артефактный — строго в папке артефакта, поэтому одной только workspace
   * для него мало: папка берётся из сессии pi, а не из рабочего каталога.
   */
  artifact?: string;
  /** Откуда пришла последняя реплика: по ней панель подписывает шапку. */
  lastTurn?: ChatTurn;
  /**
   * Когда разговор убран в архив. Архив — это «не вижу каждый день», а не
   * удаление: запись остаётся в chats.json, файл сессии и вложения целы,
   * разговор можно вернуть. Поэтому здесь отметка, а не флаг «удалён».
   */
  archivedAt?: string;
  /**
   * Кто назвал разговор. `auto` — мы: эвристика из первой реплики или модель,
   * и такое имя первые ходы ещё можно уточнить. `manual` — человек через
   * `/rename` или из списка, и его не трогаем. Поля нет у старых записей —
   * считаем, что имя уже устоялось, и моделью его не переписываем.
   */
  titleSource?: 'auto' | 'manual';
  /**
   * Имя, которое бот уже поставил топику Telegram. Telegram не отдаёт текущее
   * имя топика, поэтому помним сами: без этой отметки каждое уточнение
   * заголовка слало бы `editForumTopic` заново, а Telegram оставляет об этом
   * служебку в топике. В корне чата топика нет — поля не появляется.
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

export function panelCanWrite(chat: Pick<ChatRecord, 'channel'>): boolean {
  return chat.channel === 'web' || chat.channel === 'telegram';
}

/** Имя дали мы, а не человек: такое ещё можно уточнить моделью. */
export function isAutoTitle(chat: ChatRecord): boolean {
  return chat.titleSource === 'auto';
}

function inferChannel(id: string): ChatChannel {
  if (id.startsWith('web-')) return 'web';
  if (id.startsWith('telegram-')) return 'telegram';
  return 'api';
}

/** Место в Telegram из записи реестра: годятся только числа и явный корень. */
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
  // Запись могли успеть записать с одиночным sessionId (промежуточный формат):
  // не теряем сессию, а разворачиваем её в цепочку.
  const legacySessionId = typeof item.sessionId === 'string' && item.sessionId.trim() ? item.sessionId : '';
  if (sessions.length === 0 && legacySessionId) sessions.push({ sessionId: legacySessionId, startedAt: createdAt });

  const telegram = telegramOf(item.telegram);
  const turn = item.lastTurn && typeof item.lastTurn === 'object' ? (item.lastTurn as Record<string, unknown>) : null;
  const lastTurn: ChatTurn | null =
    turn && isChannel(turn.channel) && typeof turn.at === 'string' && turn.at
      ? { channel: turn.channel, at: turn.at }
      : null;

  // Метка задачи без id или имени бесполезна: такой чат некуда положить в дерево,
  // и он честно остаётся обычным разговором.
  const task = item.task && typeof item.task === 'object' ? (item.task as Record<string, unknown>) : null;
  const taskId = task && typeof task.id === 'string' ? task.id.trim() : '';
  const taskName = task && typeof task.name === 'string' ? task.name.trim() : '';
  const taskMark: ChatTaskMark | null = taskId && taskName ? { id: taskId, name: taskName } : null;

  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : defaultTitle(channel),
    createdAt,
    channel,
    // Записи до появления workspace'ов все жили в «Разговоре».
    workspace: typeof item.workspace === 'string' && item.workspace ? item.workspace : DEFAULT_WORKSPACE,
    ...(conversationId ? { conversationId } : {}),
    ...(sessions.length > 0 ? { sessions } : {}),
    // Пустой папки не бывает: ссылка на удалённую папку равносильна «Входящим».
    ...(typeof item.folder === 'string' && item.folder !== '' ? { folder: item.folder } : {}),
    ...(taskMark ? { task: taskMark } : {}),
    // Дату запуска без метки не храним: у обычного чата её роль играет createdAt.
    ...(taskMark && typeof item.runAt === 'string' && item.runAt ? { runAt: item.runAt } : {}),
    // Пустая строка — это «обычный чат», а не артефакт с пустым именем.
    ...(typeof item.artifact === 'string' && item.artifact !== '' ? { artifact: item.artifact } : {}),
    ...(telegram ? { telegram } : {}),
    ...(lastTurn ? { lastTurn } : {}),
    ...(typeof item.archivedAt === 'string' && item.archivedAt !== '' ? { archivedAt: item.archivedAt } : {}),
    ...(item.titleSource === 'auto' || item.titleSource === 'manual' ? { titleSource: item.titleSource } : {}),
    ...(typeof item.topicTitle === 'string' && item.topicTitle !== '' ? { topicTitle: item.topicTitle } : {}),
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

/** Сессии разговора по порядку: у старых записей она одна и выводится из id. */
export function sessionEpochsOf(chat: ChatRecord, user: UserConfig): SessionEpoch[] {
  if (chat.sessions && chat.sessions.length > 0) return chat.sessions;
  return [{ sessionId: derivedSessionId(chat, user), startedAt: chat.createdAt }];
}

/** Все сессии разговора — по ним история собирается с разделителями после /clear. */
export function sessionIdsOf(chat: ChatRecord, user: UserConfig): string[] {
  return sessionEpochsOf(chat, user).map((epoch) => epoch.sessionId);
}

/** id текущей (последней) сессии pi: по нему продолжаем разговор и ищем свежий файл. */
export function sessionIdOf(chat: ChatRecord, user: UserConfig): string {
  const epochs = sessionEpochsOf(chat, user);
  return epochs.at(-1)?.sessionId ?? derivedSessionId(chat, user);
}

/** id сессии, выведенный из разговора: так жили записи до цепочки сессий. */
function derivedSessionId(chat: ChatRecord, user: UserConfig): string {
  if (chat.conversationId) return sessionIdFor(user.id, chat.conversationId);
  if (chat.id.startsWith('session:')) return chat.id.slice('session:'.length);
  return sessionIdFor(user.id, chat.id);
}

/**
 * Добавляет разговору новую сессию pi. `/clear` заводит её в pi, а мы дописываем
 * в цепочку: старые файлы остаются историей до разделителя, новый — текущим
 * контекстом. Первую сессию выводим из conversationId, если цепочки ещё нет.
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

/** Человек переименовал разговор: имя больше не выводится из первой реплики. */
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
  // Имя выбрал человек: модель его больше не переписывает, даже если разговор
  // только начался. Пишем и когда имя совпало: запись могла прийти из версии
  // без этого поля, и тогда метку надо поставить, иначе модель переименует.
  if (chat.title !== name || chat.titleSource !== 'manual') {
    chat.title = name;
    chat.titleSource = 'manual';
    writeChats(config, user, chats);
  }
  return chat;
}

/**
 * Убирает разговор в архив или возвращает обратно. Меняется только отметка
 * в реестре: история, файлы сессии и вложения остаются на месте, поэтому
 * архив не путается с удалением. Повторный уход в архив отметку не двигает —
 * так порядок в архиве не прыгает от лишнего клика.
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
 * Запоминает, где разговор живёт в Telegram: чат и топик. Зовёт бот, приняв
 * сообщение, — тогда место переживает перезапуск сервиса. Пишем только
 * изменение: иначе каждое сообщение в чате трогало бы реестр зря.
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

/** Место разговора в Telegram: null — разговор заведён не ботом. */
export function telegramPlaceOf(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
): ChatTelegram | null {
  return findChatRecord(config, user, conversationId)?.telegram ?? null;
}

/** Топик удалён вместе с сообщениями — места в Telegram у разговора больше нет. */
function clearChatTelegram(config: IcarusConfig, user: UserConfig, conversationId: string): void {
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  if (!chat?.telegram) return;
  delete chat.telegram;
  writeChats(config, user, chats);
}

/** Что не вышло при выносе разговора из Telegram: архиву это не мешает. */
export type ArchiveOutcome = { chat: ChatRecord | null; topicError?: string };

/**
 * Убирает разговор в архив и — если попросить — выносит его из Telegram.
 * Архив и удаление топика живут вместе, потому что в панели и в боте это
 * одно действие: «убрать с глаз». Топик Telegram удаляется вместе с
 * сообщениями, и это необратимо, поэтому возврат из архива его не воскрешает:
 * разговор вернётся только в панель (см. setChatArchived).
 *
 * Удаление топика — побочный эффект, а не условие архива: Telegram откажет —
 * разговор всё равно уйдёт в архив, а ошибку покажет тот, кто позвал.
 * `removeTopic` не передан (панель без бота) — просто двигаем отметку.
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
  // Возврат из архива Telegram не трогает: топик уже удалён, воскрешать нечего.
  // Уже архивный разговор тоже не трогаем — иначе повторный /archive долбил бы
  // удаление по мёртвому топику.
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
 * Убирает workspace: его диалоги возвращаются в «Разговор» (панель так и обещает),
 * а сами файлы истории не трогаются — они лежат в общей папке сессий.
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
 * Переносит разговор в папку меню (или во «Входящие», если folder === null).
 * Файл сессии, workspace и заголовок не меняются: это только полка в списке.
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

/** Папку удалили: её разговоры возвращаются во «Входящие», а не теряются. */
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

/** В каком workspace'е живёт разговор: у записей до переезда — «Разговор». */
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
 * Переключает разговор в другой workspace. Папка живёт в chats.json рядом с
 * разговором, поэтому выбор видят все входы и он переживает перезапуск сервиса.
 * Сессия pi о переезде узнаёт при следующем ходе: реестр сверяет папку живой
 * сессии с записью и поднимает её заново в новой (см. SessionRegistry.acquire).
 */
export function setChatWorkspace(
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  workspace: string,
): ChatRecord {
  // Запись может быть ещё не заведена: /workspace — законная первая команда
  // в новом разговоре, до первого хода.
  ensureChat(config, user, conversationId, channelForConversation(conversationId), workspace);
  const chats = readChats(config, user);
  const chat = chats.find((item) => item.conversationId === conversationId || item.id === conversationId);
  // ensureChat только что записал разговор, так что находим его всегда; если
  // файл всё же не прочитался, пусть вызывающий не делает вид, что переключил.
  if (!chat) throw new Error(`разговор ${conversationId} не записался в реестр`);
  if (chat.workspace === workspace) return chat;
  chat.workspace = workspace;
  writeChats(config, user, chats);
  return chat;
}

/** Артефакт разговора: у обычного чата его нет, у правки артефакта — есть. */
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
 * Откуда пришла последняя реплика разговора. null — ход ещё не записан этим
 * сервисом (старые сессии) или записи нет вовсе.
 */
export function lastTurnOf(config: IcarusConfig, user: UserConfig, conversationId: string): ChatTurn | null {
  return findChatRecord(config, user, conversationId)?.lastTurn ?? null;
}

/**
 * Записывает, из какого канала пришла реплика. Зовёт тот, кто принял сообщение:
 * панель, бот и OpenAI-вход. Разговор к этому моменту уже существует — его
 * заводит `registry.acquire`; если записи нет, молча ничего не делаем: реплика
 * важнее подписи.
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

/** Новый веб-чат: единственный канал, который панель создаёт сама. */
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
    // Дата запуска — момент создания: у чата задачи это одно и то же событие.
    ...(options.task ? { task: options.task, runAt: now.toISOString() } : {}),
  };
  const chats = readChats(config, user);
  chats.unshift(chat);
  writeChats(config, user, chats);
  return chat;
}

/**
 * Разговор, привязанный к артефакту. Один артефакт — один такой чат: человек
 * возвращается к «той же правке», а не заводит новый диалог каждый раз.
 */
export function findArtifactChat(
  config: IcarusConfig,
  user: UserConfig,
  artifact: string,
): ChatRecord | undefined {
  return readChats(config, user).find((chat) => chat.channel === 'web' && chat.artifact === artifact);
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
  // Реестр мог остаться от версии без артефактных чатов: тип разговора
  // достраиваем при первом же ходе, а не теряем режим правки.
  if (artifact && chat.artifact !== artifact) {
    chat.artifact = artifact;
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
 * Имя от нас: эвристика из первой реплики или модель. Помечаем `auto` — только
 * такие имена модель ещё может уточнить; имя, выбранное человеком, не трогаем.
 * Архивный разговор не переименовываем: он убран с глаз, и новое имя там —
 * след чужой работы, а не то, что человек ждёт увидеть, вернув разговор.
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
 * Заголовок из первой реплики человека. Читаем голову файла и только если
 * заголовок ещё служебный: у Telegram/API нет своего finishChat, поэтому
 * первый же ход даёт имя разговору, а панель потом показывает его как обычный.
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
    // У Telegram/API имя тоже наше: если человек его не выбирал, модель потом
    // может уточнить его по первым репликам — но живой заголовок сейчас считается
    // в веб-чате, туда и смотрим.
    if (chat.titleSource !== 'manual') chat.titleSource = 'auto';
    writeChats(config, user, chats);
  } catch (error) {
    // Заголовок — украшение: его сбой не должен отменять ответ человеку.
    log.warn('не обновился заголовок разговора', { user: user.id, error: String(error) });
  }
}

/**
 * Запомнил имя, поставленное топику Telegram. Сравнивать своё имя с текущим
 * приходится самим: Bot API не умеет спросить, как топик называется сейчас.
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
 * Перед первой миграцией сохраняем старый chats.json: в нём preview/updatedAt и
 * нет channel. Если файл битый — откладываем его в сторону, а не затираем:
 * реестр восстановим из сессий, а содержимое останется для разбора.
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
 * Разовый проход по файлам сессий при старте: всё, что уже лежит на диске,
 * должно попасть в реестр. Полных чтений тут нет — только имена и mtime;
 * заголовки доезжают, когда разговор впервые показывается или получает ход.
 *
 * Заодно переносим старый session-index.json (sessionId → conversationId)
 * в основной реестр и удаляем его: второго индекса больше нет.
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

/**
 * Карта разговоров для агента: `conversationId` → id сессии pi и файл истории.
 *
 * Агент видит сессии только как файлы `<время>_<id>.jsonl`, а из имени обратно разговор
 * не восстановить (см. files.ts). Ссылка из панели несёт `conversationId`, и сам он
 * посчитать id сессии не может — тот считается хешем с id человека, которого в контейнере
 * нет. Поэтому карту рендерит сервис (у него есть и то, и другое) и кладёт рядом с
 * реестром, куда агент смотрит через read-only маунт (см. compose.ts, workspace.ts).
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
