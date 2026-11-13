// Icarus's Telegram bot: long polling of the Bot API and a live pi session per conversation.
//
// The bot doesn't create people itself: it recognizes a person by the username from the
// message and takes their id from `telegram.mapping` in config.yaml. We answer a stranger
// with a hint, not a conversation: without the map it's unclear whose memory and whose
// container this is.
//
// A person has as many conversations as they want: in a DM — topics (Bot API 9.4, enabled
// via Threaded Mode in BotFather), in a group — one conversation per person. A conversation
// in pi terms is a “chat + topic” pair (see conversationIdFor): each has its own process and
// its own history. The person creates topics themselves in the Telegram client; the bot
// learns about a new topic from the service message forum_topic_created and doesn't get in
// its way.
//
// We parse the same attachments as the HTTP input: images go to the model natively and land
// in incoming/, voice ones — via transcription (see attachments.ts, speech.ts).
import { DEFAULT_WORKSPACE, findTelegramUser, findUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { buildPrompt } from '../prompt.ts';
import { subagentStatus } from '../reasoning.ts';
import { actionForTool, THINKING_ACTION } from './chat-action.ts';
import { mcpReauthNotice } from '../mcp/reauth.ts';
import { speechTranscriber, type Transcriber } from '../speech.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import type { PiSession } from '../sessions/pi-session.ts';
import {
  archiveChat,
  findChatRecord,
  lastTurnOf,
  recordTurn,
  refreshChatTitle,
  renameChat,
  setChatTelegram,
  setChatWorkspace,
  setTopicTitle,
  workspaceForConversation,
  type ChatRecord,
} from '../sessions/chats.ts';
import { AUTO_TITLE_TIMEOUT_MS, refineChatTitle } from '../control/chat.ts';
import { watchAll } from '../control/chat-live.ts';
import type { ChatChannel } from '../sessions/identity.ts';
import {
  findSelectableWorkspace,
  listWorkspaces,
  selectableWorkspaces,
  type Workspace,
} from '../workspaces.ts';
import {
  clearText,
  compactText,
  parseCommand,
  REMOVED_COMMANDS,
  RENAME_NEEDS_NAME,
  renameFailed,
  renameText,
  skillsText,
  statsText,
  stopText,
  TOPICS_REMOVED,
  UNKNOWN_COMMAND,
  type ParsedCommand,
} from '../sessions/commands.ts';
import { collectIncoming, type Incoming, type IncomingVoice } from './attachments.ts';
import {
  describeTelegramError,
  TelegramApi,
  TOPIC_NAME_LIMIT,
  type TelegramMessage,
  type TelegramUpdate,
} from './api.ts';
import { TelegramReply } from './reply.ts';
import { answerFiles, deliverFiles, filesFailedText, stripLocalRefs, type FileRef } from './outgoing.ts';

// Texts and command parsing are shared with the web chat (sessions/commands.ts). The
// re-export keeps the former entry point for those who already take them from the bot —
// and for the tests too.
export {
  clearText,
  compactText,
  parseCommand,
  REMOVED_COMMANDS,
  RENAME_NEEDS_NAME,
  renameText,
  skillsText,
  statsText,
  stopText,
  UNKNOWN_COMMAND,
};
export type { ParsedCommand };

/** Long polling: Telegram holds the request until a message appears. */
export const POLL_TIMEOUT_SECONDS = 50;
/** Minimum between edits of one message: more often — 429. */
export const EDIT_INTERVAL_MS = 1200;
/** Pause after a failed poll: the network blinked — we don't hammer Telegram in a loop. */
const RETRY_AFTER_FAILURE_MS = 3000;
/**
 * How long a “fresh topic” lives — a topic Telegram created from the general feed. We
 * give the client that much time for the message itself to arrive right after.
 */
export const FRESH_TOPIC_WINDOW_MS = 60_000;

/** Bot commands: the same ones in the Telegram menu (descriptions are short — little room there). */
export const COMMANDS = [
  { command: 'help', description: 'что я умею' },
  { command: 'compact', description: 'подвести итог разговора' },
  { command: 'stop', description: 'остановить ответ' },
  { command: 'stats', description: 'токены, деньги, контекст' },
  { command: 'clear', description: 'начать разговор с чистого листа' },
  { command: 'rename', description: 'переименовать текущий чат' },
  { command: 'archive', description: 'убрать разговор в архив' },
  { command: 'workspace', description: 'рабочая папка разговора' },
  { command: 'skills', description: 'скиллы и шаблоны' },
];

/**
 * Commands the bot parses itself. Everything else starting with a slash is a reply for pi:
 * it has its own commands (`/skill:name`, prompt templates), and one mustn't take them from
 * the person.
 */
export const BOT_COMMANDS = new Set([
  'start',
  'help',
  'compact',
  'stop',
  'stats',
  'clear',
  'rename',
  'archive',
  'workspace',
  'skills',
]);

export const GREETING = [
  'Привет! Я Икар.',
  '',
  'Пиши как есть — я помню наши разговоры и умею много чего руками: искать в интернете, считать, читать файлы.',
  'Присылай фото и голосовые: посмотрю и послушаю.',
  '',
  '/help — что я умею.',
].join('\n');

/** What to show on /help: the same commands as in the Telegram menu, but with an explanation. */
export const HELP = [
  'Что я умею в чате:',
  '',
  '/compact — подвести итог разговора, если он разросся',
  '/compact <пожелание> — то же, но с оговоркой, что важно сохранить',
  '/stop — остановиться, если я ушёл не туда',
  '/stats — сколько токенов и денег ушло и сколько занято в контексте',
  '/clear — начать разговор с чистого листа (память остаётся при мне)',
  '/rename <имя> — переименовать текущий чат',
  '/archive — убрать этот разговор в архив: здесь топик удалится вместе с сообщениями',
  '/workspace — рабочая папка этого разговора и куда ещё можно переключиться',
  '/workspace <имя> — переключить разговор в другую папку',
  '/skills — что у меня есть сверх разговора: скиллы и шаблоны',
  '',
  'Ещё я понимаю фото и голосовые, помню прошлые разговоры и умею искать в интернете.',
  'Всё остальное — просто пиши словами.',
].join('\n');

/**
 * A private workspace is not selectable in Telegram: it is read-only, and a conversation
 * can't be switched into it — neither from the list nor by name.
 */
export const WORKSPACE_PRIVATE_REFUSED = 'В приватный workspace переключить нельзя: он только для чтения.';

/**
 * `/workspace` without a name: where the conversation is now and which folders exist. The
 * names are the same as in the panel: a person looks for “Work”, not the slug `rabota`.
 */
export function workspacesText(current: string, available: Workspace[]): string {
  if (available.length === 0) return 'Переключать некуда: рабочих папок нет.';
  return [`Сейчас: ${current}`, '', 'Доступны:', ...available.map((item) => item.name)].join('\n');
}

export function workspaceSwitched(name: string): string {
  return `Переключил на «${name}».`;
}

export function workspaceUnknown(name: string): string {
  return `Нет такого workspace: «${name}». /workspace — покажу, какие есть.`;
}

export function workspaceFailed(reason: string): string {
  return `Не получилось переключить: ${reason}`;
}

/**
 * `/archive` succeeded: the topic is deleted together with the messages. We write to the
 * chat root — in the topic itself there's nothing left to say with. The return lives only
 * in the panel: if it's gone, it's gone, Telegram doesn't create a second topic.
 */
export function archivedText(title: string, removedTopic: boolean): string {
  const head = `🗄 Убрал «${title}» в архив.`;
  return removedTopic
    ? `${head}\nТопик здесь удалён вместе с сообщениями — вернуть его Telegram не умеет. В панели разговор лежит в архиве, оттуда его можно вернуть.`
    : `${head}\nТопика здесь нет — удалять в Telegram нечего. В панели разговор в архиве.`;
}

/** The topic wasn't deleted — the conversation remained in Telegram, but it went to the archive anyway. */
export function archiveTopicFailed(reason: string): string {
  return `Убрал в архив, но топик не удалился: ${reason}. В Telegram разговор остался на месте.`;
}

export const ARCHIVE_NOT_FOUND = 'Не нашёл этот разговор в реестре — архивировать нечего.';

/**
 * The answer didn't reach the topic. We say this in the chat root: in the topic the person
 * would wait in silence, and after server-side topic failures in DMs (Bot API 10.0) — this
 * is not theory.
 */
export function topicDeliveryFailed(reason: string): string {
  return [
    `Не смог ответить в топик: ${reason}`,
    '',
    'Ответа в топике не будет — напиши в корень чата, и продолжим здесь.',
  ].join('\n');
}

export const NO_USERNAME =
  'Не могу тебя узнать: в Telegram у тебя не задан username, а я различаю людей по нему. ' +
  'Заведи username в настройках Telegram и напиши ещё раз.';

/** A message from which there's nothing to take: neither text nor attachment. */
export const NOTHING_TO_READ = 'Тут нечего разбирать: пришли текстом, фото или голосовым.';

/** A voice message but nothing to transcribe with: no speech provider or it's disabled. */
export const VOICE_NO_SPEECH =
  'Голосовые пока не расшифровываю: в конфиге не задана модель распознавания речи. Напиши словами.';

/** The transcription came out empty: silence, music, or too quiet a recording. */
export const VOICE_EMPTY = 'В голосовом не разобрал ни слова — попробуй ещё раз или напиши словами.';

export const BUSY = 'Ещё думаю над прошлым сообщением — секунду.';

/**
 * A note in Telegram before the answer if the previous reply of the conversation came from
 * another channel. We have one conversation for all inputs, so what was said in the panel
 * (and its files) already lies in the pi context. We can't silently mix this into the answer:
 * the person must see where Icarus knows this from — otherwise personal correspondence from
 * the panel quietly becomes a window into Telegram.
 */
export function crossChannelNote(channel: ChatChannel): string {
  const from = channel === 'web' ? 'в панели' : channel === 'api' ? 'через API' : 'в другом канале';
  return `🧵 Продолжаю разговор, который шёл ${from}: эти реплики уже в контексте. /clear — начать с чистого листа.\n\n`;
}

/**
 * A reply on top of an ongoing turn. There are no buttons in Telegram, so the operation is
 * a single one — “now”: the previous answer is cut off. We can't stay silent about this,
 * otherwise it looks like Icarus just stopped answering.
 */
export const INTERRUPTED_NOTE = '⏹ Прервал прошлый ответ, чтобы взяться за твоё сообщение.\n\n';

export function unknownUser(username: string): string {
  return (
    `Не знаю тебя: @${username} не привязан ни к кому в конфиге. ` +
    'Попроси добавить твой telegram-username в telegram.mapping.'
  );
}

/** An attachment the bot doesn't parse: video, sticker, audio file, document. */
export function unsupportedText(kind: string): string {
  // A document is the only thing a person can send as an image: we give a hint.
  return kind === 'документ'
    ? 'Пока не разбираю документы: пришли нужное картинкой или словами.'
    : `Пока не разбираю ${kind}: пришли то же самое словами.`;
}

export function attachmentFailed(reason: string): string {
  return `Не смог забрать вложение из Telegram: ${reason}`;
}

export function transcriptionFailed(reason: string): string {
  return `Не разобрал голосовое: ${reason}`;
}

/**
 * We mark a voice message in the reply: Icarus must know it was dictation — speech has
 * neither punctuation nor markup, and there's no point demanding them from the person.
 */
export function voicePrompt(text: string, duration: number | null): string {
  const mark = duration === null ? '[голосовое]' : `[голосовое, ${Math.round(duration)} с]`;
  return `${mark} ${text}`;
}

/**
 * The topic number if the message came inside it. The chat root and the General topic are
 * the same place, and it arrives sometimes with `message_thread_id = 1`, sometimes without
 * it at all, so we count “one” as the root too: otherwise one conversation would split into
 * two.
 */
export function topicThreadId(message: TelegramMessage): number | null {
  const threadId = message.message_thread_id;
  if (!threadId || threadId === 1) return null;
  return threadId;
}

/**
 * A conversation in pi session terms — “chat + topic + person”.
 *
 * In a DM without topics the conversation is one per chat, and it survives a service
 * restart. With topics each topic is a separate conversation: it has its own pi process,
 * its own history in /workspace/.icarus/sessions and its own /compact. In a group there can be
 * several people, and each has their own conversation — otherwise they'd fight over one
 * session (there's one turn in it); a topic in a group separates them too.
 *
 * The topic number can be set explicitly: for a message from the general feed it's derived
 * not from the message itself but from the fresh topic (see TelegramBot.resolveThread).
 */
export function conversationIdFor(
  message: TelegramMessage,
  userId: string,
  threadId: number | null = topicThreadId(message),
): string {
  const base =
    message.chat.type === 'private' ? `telegram-${message.chat.id}` : `telegram-${message.chat.id}-${userId}`;
  return threadId === null ? base : `${base}-${threadId}`;
}

/**
 * Where the person's reply belongs: the topic (adjusted for a fresh topic from the general
 * feed), the conversation in pi terms, and the anchor — the message inside the same topic
 * that Telegram will put the answer as a reply to, even if it rejects `message_thread_id`.
 */
type Route = { threadId: number | null; conversationId: string; anchor?: number };

/**
 * The topic number the message belongs to. Counting it here rather than in the handler is
 * needed because the service message about a new topic and the first message from the
 * general feed travel in different queues (see TelegramBot.resolveThread).
 */
type ThreadRoute = { threadId: number | null };

export type TelegramBotOptions = {
  api?: TelegramApi;
  pollTimeoutSeconds?: number;
  editIntervalMs?: number;
  /** Minimum between Telegram actions; in tests they collapse to zero. */
  actionGapMs?: number;
  /** How often to repeat the action while the turn goes on; in tests — so as not to wait. */
  actionIntervalMs?: number;
  /** How long a “fresh topic” lives; in tests the window is collapsed to zero. */
  freshTopicWindowMs?: number;
  /** What to transcribe voice with; null — we don't transcribe (substituted in tests). */
  transcribe?: Transcriber | null;
};

/**
 * A queue by key: messages of one chat are processed strictly in order (there's one turn at a
 * time in a pi session), while other chats don't wait for each other. A failure of one task
 * doesn't break the queue — the next one will still go after it.
 */
export class KeyedQueue {
  private chains = new Map<string, Promise<void>>();

  add(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const settled = previous.then(task, task);
    const tail = settled.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return settled;
  }
}

export class TelegramBot {
  private config: IcarusConfig;
  private registry: SessionRegistry;
  private api: TelegramApi;
  private pollTimeoutSeconds: number;
  private editIntervalMs: number;
  private actionGapMs: number | undefined;
  private actionIntervalMs: number | undefined;
  /** null — speech recognition isn't configured: we honestly ask for words instead of voice. */
  private transcribe: Transcriber | null;

  private stopped = false;
  private abort = new AbortController();
  private offset: number | undefined;
  /** Queue by chat and topic: two messages in a row must not fight over one session. */
  private queue = new KeyedQueue();
  /**
   * Ongoing turns by chat and topic. Needed so a new message can interrupt the current turn
   * right away rather than wait its turn: in Telegram nobody stops the person from writing
   * on top, and they won't wait five minutes for subagents to answer.
   */
  private turns = new Map<string, { interrupt: () => Promise<void> }>();
  /** Chats where a new reply has already interrupted the turn: the answer must say so. */
  private interrupted = new Set<string>();
  /**
   * A topic the person just created from the general feed: the client creates the topic, and
   * the message itself arrives as a root message — see resolveThread.
   */
  private freshTopics = new Map<number, { threadId: number; at: number; name: string }>();
  private freshTopicWindowMs: number;
  /** Rename queue: two title events in a row must not fight over the topic. */
  private titles = new KeyedQueue();
  /** Unsubscribe from the panel summary — set at start and removed in `stop`. */
  private unwatchTitles: (() => void) | null = null;

  constructor(config: IcarusConfig, registry: SessionRegistry, options: TelegramBotOptions = {}) {
    if (!config.telegram) throw new Error('telegram-бот не настроен: нет токена или маппинга');
    this.config = config;
    this.registry = registry;
    this.api = options.api ?? new TelegramApi(config.telegram.token);
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? POLL_TIMEOUT_SECONDS;
    this.editIntervalMs = options.editIntervalMs ?? EDIT_INTERVAL_MS;
    this.actionGapMs = options.actionGapMs;
    this.actionIntervalMs = options.actionIntervalMs;
    this.freshTopicWindowMs = options.freshTopicWindowMs ?? FRESH_TOPIC_WINDOW_MS;
    this.transcribe = options.transcribe === undefined ? speechTranscriber(config) : options.transcribe;
  }

  start(): void {
    void this.announce();
    void this.loop();
    this.watchTitles();
    log.info('телеграм-бот запущен', { users: Object.keys(this.config.telegram?.mapping ?? {}).length });
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.unwatchTitles?.();
    this.unwatchTitles = null;
  }

  /** Introduction: we write to the log under whose name we work, and set up the command menu. */
  private async announce(): Promise<void> {
    try {
      const me = await this.api.getMe();
      log.info('телеграм-бот на связи', {
        username: me.username ?? '?',
        id: me.id,
      });
      await this.api.setMyCommands(COMMANDS);
    } catch (error) {
      log.warn('телеграм: не поздоровался', { error: describeTelegramError(error) });
    }
  }

  /**
   * Remembers a topic the person just created from the general feed. The service message
   * `forum_topic_created` arrives before the first message, and the message itself may
   * arrive without `message_thread_id` — see resolveThread.
   */
  private noteTopicCreated(message: TelegramMessage): void {
    const topic = message.forum_topic_created;
    const threadId = topicThreadId(message);
    if (!topic || threadId === null || message.chat.type !== 'private') return;
    this.freshTopics.set(message.chat.id, {
      threadId,
      at: Date.now(),
      name: topic.name,
    });
  }

  /**
   * The topic the message actually belongs to.
   *
   * The usual case is the topic number in the message itself. But the first message of a
   * topic created by a person from the general feed arrives as a root message: the Telegram
   * client creates the topic, and the text goes without `message_thread_id` (in DMs with
   * topics this has been caught both by us and by neighbors). Such a message can't be counted
   * as the root — the answer would go to the general feed, and the topic would stay empty and
   * the person would decide the conversation got lost. So we give it to the fresh topic (see
   * noteTopicCreated), and if the message came with a real topic number — we clear the fresh
   * slot: the client managed on its own.
   */
  private resolveThread(message: TelegramMessage): ThreadRoute {
    this.noteTopicCreated(message);
    const chatId = message.chat.id;
    const threadId = topicThreadId(message);

    if (threadId !== null) {
      // The service message about creating a topic is not “the client tied the message itself”:
      // the topic was just created, and the first message will still arrive in it (possibly
      // without a number).
      if (!message.forum_topic_created && this.freshTopics.get(chatId)?.threadId === threadId) {
        this.freshTopics.delete(chatId);
      }
      return { threadId };
    }
    // A service message without a topic number and other people's chats are none of our
    // business: they don't create topics there.
    if (message.forum_topic_created || message.chat.type !== 'private') {
      return { threadId: null };
    }

    const fresh = this.freshTopics.get(chatId);
    if (!fresh) return { threadId: null };
    this.freshTopics.delete(chatId);
    if (Date.now() - fresh.at > this.freshTopicWindowMs) return { threadId: null };

    log.info('телеграм: сообщение из общей ленты относим к свежему топику', {
      chatId,
      threadId: fresh.threadId,
      name: fresh.name,
    });
    return { threadId: fresh.threadId };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates({
          offset: this.offset,
          timeoutSeconds: this.pollTimeoutSeconds,
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout((this.pollTimeoutSeconds + 15) * 1000),
          ]),
        });
        for (const update of updates) {
          // We confirm right away: it's better not to replay an unfinished message on restart —
          // the person will see the turn's error as a reply, not as silence.
          this.offset = update.update_id + 1;
          void this.enqueue(update);
        }
      } catch (error) {
        if (this.stopped) return;
        log.warn('телеграм: опрос не удался', { error: describeTelegramError(error) });
        await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_FAILURE_MS));
      }
    }
  }

  /**
   * Puts the message into its chat's and topic's queue: conversations of different people and
   * different topics don't wait for each other. `/stop` goes past the queue: the turn it
   * cancels is in progress right now, and waiting for it to end means canceling nothing.
   *
   * We count the topic here rather than in the handler: the service `forum_topic_created` and
   * the first message of the topic travel in different queues (they have different topic
   * numbers), and if we parse them in order, the topic may arrive late for its own message.
   */
  enqueue(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const thread = message ? this.resolveThread(message) : { threadId: null };
    const key = message ? `${message.chat.id}:${thread.threadId ?? 0}` : 'unknown';
    const text = message?.text ?? message?.caption ?? '';
    const command = parseCommand(text);
    const task = (): Promise<void> => this.handleUpdate(update, thread);

    // A reply on top of an ongoing turn — this is not “let it wait”: at that moment Icarus
    // may be holding two dozen subagents, and the person waits for them in silence. We
    // interrupt right away; the reply itself will queue up and start a new turn when the
    // previous one actually settles (see runTurn).
    //
    // Bot commands (/stats, /compact) don't touch the turn: they exist precisely so as not to
    // spend tokens. But a skill or a prompt template (`/skill:... text`) is a normal reply for
    // pi, and it does interrupt.
    const botCommand = command !== null && BOT_COMMANDS.has(command.name);
    const startsTurn = !botCommand && (command === null || command.args !== '');
    if (startsTurn) {
      const running = this.turns.get(key);
      if (running) {
        log.info('телеграм: новое сообщение прерывает текущий ход', { key });
        // The answer to this message will start with an honest line: the previous answer was interrupted.
        this.interrupted.add(key);
        void running.interrupt().catch((error) => {
          log.warn('телеграм: прервать ход не вышло', { error: describeTelegramError(error) });
        });
      }
    }

    const settled = command?.name === 'stop' ? task() : this.queue.add(key, task);
    void settled.catch((error) => log.error('телеграм: сообщение сорвалось', { error: describeTelegramError(error) }));
    return settled;
  }

  /**
   * Parses the message. The topic comes from `enqueue` — it also decides which pi session and
   * which topic the answer will go to. On a direct call (tests, debugging) we count it ourselves.
   */
  async handleUpdate(update: TelegramUpdate, routed?: ThreadRoute): Promise<void> {
    const message = update.message;
    if (!message?.from) return;

    const chatId = message.chat.id;
    const thread = routed ?? this.resolveThread(message);
    const threadId = thread.threadId;

    // Service messages of topics: created or renamed. There's nothing to answer them with,
    // and they aren't a conversation — but a rename by a person means the topic name is
    // theirs, and it must be remembered (see noteTopicEdited).
    if (message.forum_topic_created || message.forum_topic_edited) {
      this.noteTopicEdited(message);
      return;
    }

    const user = findTelegramUser(this.config, message.from.username);
    if (!user) {
      log.warn('телеграм: сообщение от незнакомца', { username: message.from.username ?? null });
      await this.say(chatId, message.from.username ? unknownUser(message.from.username) : NO_USERNAME, threadId);
      return;
    }

    // We count where the reply belongs once: the queue, the answer and the pi session must
    // all speak of the same place.
    const route = this.routeFor(message, user.id, thread);
    // The log shows both the topic and the conversation: complaints of “the answer went to
    // the wrong place” are later sorted out by these lines — Telegram itself doesn't show
    // topic numbers.
    log.info('телеграм: сообщение принято', {
      user: user.id,
      chatId,
      threadId: route.threadId,
      conversation: route.conversationId,
    });

    let incoming: Incoming;
    try {
      incoming = await collectIncoming(this.api, message, userPaths(this.config, user).incoming);
    } catch (error) {
      log.warn('телеграм: вложение не забралось', { user: user.id, error: describeTelegramError(error) });
      await this.say(chatId, attachmentFailed(describeTelegramError(error)), route.threadId, route.anchor);
      return;
    }

    if (incoming.unsupported) {
      await this.say(chatId, unsupportedText(incoming.unsupported), route.threadId, route.anchor);
      return;
    }

    // A command can also be a photo caption: a person sends a shot and asks for a summary.
    const command = parseCommand(incoming.text);
    if (command) {
      if (BOT_COMMANDS.has(command.name)) {
        await this.runCommand(message, user, command, route);
        return;
      }
      // We explain removed commands ourselves — even with arguments, otherwise they'd go to pi.
      if (REMOVED_COMMANDS.has(command.name)) {
        await this.say(chatId, TOPICS_REMOVED, route.threadId, route.anchor);
        return;
      }
      // An unknown command without arguments is almost certainly a typo: we give a hint.
      // With arguments it's already a reply: pi has its own commands, and one mustn't take them.
      if (command.args === '') {
        await this.say(chatId, UNKNOWN_COMMAND, route.threadId, route.anchor);
        return;
      }
    }

    // Neither text nor attachment: the bot would have named the rest as a refusal itself.
    if (incoming.text === '' && incoming.images.length === 0 && !incoming.voice) {
      await this.say(chatId, NOTHING_TO_READ, route.threadId, route.anchor);
      return;
    }

    await this.runTurn(message, user, incoming, route);
  }

  /**
   * Where the reply belongs: the topic (adjusted for a fresh topic from the general feed),
   * the pi conversation and the anchor — the person's message in the same topic. The anchor
   * is needed for when Telegram rejects `message_thread_id`: a reply to a message from a
   * topic reaches the topic. A message from the general feed has no topic, and it can't have
   * an anchor — otherwise the answer would return to the feed.
   */
  private routeFor(message: TelegramMessage, userId: string, thread: ThreadRoute): Route {
    return {
      threadId: thread.threadId,
      conversationId: conversationIdFor(message, userId, thread.threadId),
      ...(thread.threadId !== null && topicThreadId(message) === thread.threadId
        ? { anchor: message.message_id }
        : {}),
    };
  }

  /**
   * A bot command: the person expects a short answer, not a stream from the model. The bot
   * parses the commands, not pi: pi has a separate RPC call for each of them, and half the
   * point of the command is that it spends neither tokens nor conversation context.
   */
  private async runCommand(
    message: TelegramMessage,
    user: UserConfig,
    command: ParsedCommand,
    route: Route,
  ): Promise<void> {
    const chatId = message.chat.id;
    const conversationId = route.conversationId;
    // The answer to the command goes to the same topic where it was written.
    const { threadId, anchor } = route;
    const say = (text: string): Promise<void> => this.say(chatId, text, threadId, anchor);

    switch (command.name) {
      case 'start':
        return say(GREETING);
      case 'help':
        return say(HELP);
      case 'compact':
        return say(compactText(await this.registry.compact(user, conversationId, command.args || undefined)));
      case 'stop':
        return say(stopText(await this.registry.abort(user, conversationId)));
      case 'stats':
        return say(statsText(await this.registry.stats(user, conversationId)));
      case 'clear':
        return say(clearText(await this.registry.clear(user, conversationId)));
      case 'rename':
        return this.renameChat(message, user, command.args, route);
      case 'archive':
        return this.archive(message, user, route);
      case 'workspace':
        return this.selectWorkspace(message, user, command.args, route);
      case 'skills':
        return say(skillsText(await this.registry.commands(user, conversationId)));
      default:
        return say(UNKNOWN_COMMAND);
    }
  }

  /**
   * A voice message — into text. null means “transcription failed”: the person has already
   * been told why, and there's no point starting a turn.
   */
  private async listen(voice: IncomingVoice, reply: TelegramReply): Promise<string | null> {
    if (!this.transcribe) {
      reply.push(VOICE_NO_SPEECH);
      await reply.finish();
      return null;
    }

    // The action is already set from the start of the turn (see runTurn): here we don't
    // move it, only wait for the transcription.
    let transcript: string;
    try {
      transcript = await this.transcribe(voice.audio, voice.mimeType);
    } catch (error) {
      log.warn('телеграм: голосовое не расшифровалось', { error: describeTelegramError(error) });
      reply.push(transcriptionFailed(describeTelegramError(error)));
      await reply.finish();
      return null;
    }
    // Then it's the model's turn again: nothing goes outside, and there's nothing to show.
    reply.setAction(THINKING_ACTION);

    // An empty transcription is silence or music: there's no point starting a turn.
    const spoken = transcript.trim();
    if (spoken === '') {
      reply.push(VOICE_EMPTY);
      await reply.finish();
      return null;
    }
    return voicePrompt(spoken, voice.duration);
  }

  /** Turn: a Telegram action, voice transcription, a reply into pi, the event stream — into message edits. */
  private async runTurn(message: TelegramMessage, user: UserConfig, incoming: Incoming, route: Route): Promise<void> {
    const conversationId = route.conversationId;
    const reply = new TelegramReply(this.api, message.chat.id, {
      intervalMs: this.editIntervalMs,
      // The default action is “typing”, and each phase of the turn only changes it
      // (see chat-action.ts): there's no verbal status in the answer anymore.
      ...(this.actionGapMs === undefined ? {} : { actionGapMs: this.actionGapMs }),
      ...(this.actionIntervalMs === undefined ? {} : { actionIntervalMs: this.actionIntervalMs }),
      // The conversation goes in a topic — the answer, “typing…”, and continuations go there too.
      threadId: route.threadId,
      // If Telegram rejects the topic, the answer will go as a reply to the person's message —
      // into the same topic.
      ...(route.anchor === undefined ? {} : { anchorMessageId: route.anchor }),
    });
    // The turn starts right away, before the session is brought up: the container and pi take
    // seconds to start, and the person must see they were heard — with an action, not a
    // placeholder with an ellipsis. A voice message starts with transcription, and promising
    // “choosing a sticker” during that would be a lie.
    reply.start(incoming.voice && this.transcribe ? 'record_voice' : THINKING_ACTION);

    let text = incoming.text;
    if (incoming.voice) {
      const spoken = await this.listen(incoming.voice, reply);
      if (spoken === null) return;
      text = spoken;
    }

    // We mark the turn before bringing up the session: the container and pi take seconds to
    // start, and a message that arrives during this must interrupt a turn that hasn't even
    // begun yet, not queue up behind it for five minutes.
    const turnKey = `${message.chat.id}:${route.threadId ?? 0}`;
    const turn = {
      interrupt: async (): Promise<void> => {
        await this.registry.interrupt(user, conversationId);
      },
    };
    // The only second operation here: this turn has already interrupted the previous one. We
    // say this on the first line of the answer — Telegram has neither a “queue” button nor an
    // indicator.
    if (this.interrupted.delete(turnKey)) reply.push(INTERRUPTED_NOTE);
    this.turns.set(turnKey, turn);
    const dropTurn = (): void => {
      if (this.turns.get(turnKey) === turn) this.turns.delete(turnKey);
    };

    let session: PiSession;
    try {
      session = await this.registry.acquire(user, conversationId);
    } catch (error) {
      log.error('телеграм: сессия не поднялась', { user: user.id, error: redact(String(error)) });
      dropTurn();
      reply.push(`Не смог начать: ${error instanceof Error ? error.message : String(error)}`);
      await reply.finish();
      return;
    }

    // The conversation's place in Telegram — into the registry: from it the topic is renamed
    // from the panel and deleted on archiving, and it survives a service restart (see setChatTelegram).
    setChatTelegram(this.config, user, conversationId, message.chat.id, route.threadId);

    // There's nothing to interrupt compaction with: it's not a turn but a rewriting of the
    // context. Here we honestly ask to wait. Everything else is a race with the interrupt from
    // enqueue: the turn is already being stopped, it's just that `agent_settled` hasn't arrived yet.
    if (session.compacting) {
      dropTurn();
      reply.push(BUSY);
      await reply.finish();
      return;
    }
    if (session.busy) {
      log.info('телеграм: жду, пока встанет прошлый ход', { user: user.id, conversation: conversationId });
      await session.interrupt();
    }

    // The previous reply was not from here — so the context contains another channel: we say
    // this before the answer, not after. The panel may be a personal window, and Telegram must
    // not silently become its continuation.
    const previous = lastTurnOf(this.config, user, conversationId);
    if (previous && previous.channel !== 'telegram') reply.push(crossChannelNote(previous.channel));

    // The turn's channel: the session file doesn't distinguish inputs, while the panel header
    // and the Telegram note live by this mark.
    recordTurn(this.config, user, conversationId, 'telegram');

    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const toolArgs = new Map<string, Record<string, unknown>>();
    const reauth = new Map<string, { name: string; url: string }>();

    // The answer accumulates in full: from it you can see which files the agent referenced,
    // while from the delta parts you can't — the path arrives in pieces.
    let answer = '';

    const unsubscribe = session.onEvent((event) => {
      switch (event.type) {
        case 'message_update': {
          const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.delta) {
            answer += delta.delta;
            reply.push(delta.delta);
            // The text has gone to the person — and the indicator honestly becomes “typing”.
            reply.setAction('typing');
          }
          break;
        }
        case 'tool_execution_start': {
          const args = (event.args ?? {}) as Record<string, unknown>;
          toolArgs.set(String(event.toolCallId ?? ''), args);
          reply.setAction(actionForTool(String(event.toolName)));
          break;
        }
        case 'tool_execution_update': {
          // Progress comes only from subagents: it's also a reason to show that the agents
          // are still running. Which ones exactly and in what order — that's the panel, not Telegram.
          const partial = event.partialResult as { details?: unknown } | undefined;
          if (subagentStatus(partial?.details)) reply.setAction(actionForTool('subagent'));
          break;
        }
        case 'tool_execution_end': {
          const tool = String(event.toolName);
          const id = String(event.toolCallId ?? '');
          const notice = mcpReauthNotice({
            config: this.config,
            userId: user.id,
            toolName: tool,
            args: toolArgs.get(id) ?? {},
            isError: Boolean(event.isError),
            result: event.result,
          });
          if (notice && !reauth.has(notice.server)) {
            reauth.set(notice.server, { name: notice.name, url: notice.url });
          }
          reply.setAction(THINKING_ACTION);
          break;
        }
        case 'agent_settled': {
          settle();
          break;
        }
        case 'error':
        case 'extension_error': {
          log.error('телеграм: ошибка у pi', { detail: JSON.stringify(event).slice(0, 300) });
          break;
        }
        default:
          break;
      }
    });

    try {
      // Images go to the model natively, and the path to them — in the reply: without a
      // caption the text stays empty, and the note about files keeps the reply non-empty.
      await session.prompt(
        buildPrompt(
          text,
          incoming.images.map((image) => image.file),
        ),
        incoming.images.map(({ data, mimeType }) => ({ data, mimeType })),
      );
      await settled;
    } catch (error) {
      log.error('телеграм: ход сорвался', { user: user.id, error: redact(String(error)) });
      reply.push(`⚠️ Ход сорвался: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // We give the re-entry link after the model's answer: it must not look like part of its
      // text, but must be in the same message.
      for (const item of reauth.values()) {
        reply.push(`\n\n🔑 Доступ к MCP «${item.name}» истёк. Переподключить: ${item.url}`);
      }
      dropTurn();
      unsubscribe();
      // We replace links to local files in the text with attachments: the text is clearer
      // without them, and the person will see the file itself as a separate message (see outgoing.ts).
      const files = answerFiles(answer);
      if (files.length > 0) reply.mapTail(stripLocalRefs);
      await reply.finish();
      if (files.length > 0) await this.deliverAnswerFiles(message, user, files, route);
      await this.reportUndelivered(message, route, reply);
      // The conversation name — after the answer: the model may think for seconds, and the
      // person must not wait for it just for the topic name.
      void this.settleTitle(user, route).catch((error) => {
        log.warn('телеграм: заголовок разговора не вышел', { user: user.id, error: describeTelegramError(error) });
      });
    }
  }

  /**
   * The person renamed the topic in the Telegram client — this is their name, and it must not
   * be touched anymore: we remember it as manual and carry it into the conversation title so
   * the panel shows the same as the person sees in Telegram. We recognize our own renames by
   * the name we set ourselves: it's already in `topicTitle`.
   */
  private noteTopicEdited(message: TelegramMessage): void {
    const name = message.forum_topic_edited?.name?.replace(/\s+/g, ' ').trim();
    if (!name) return;
    // We find the person and the conversation ourselves: by chat and topic the conversation
    // place can't be looked up, and the topic number can't be parsed out of `conversationId`
    // (see conversationIdFor).
    const user = findTelegramUser(this.config, message.from?.username);
    if (!user) return;
    const threadId = topicThreadId(message);
    const conversationId = conversationIdFor(message, user.id, threadId);
    const chat = findChatRecord(this.config, user, conversationId);
    if (!chat || chat.topicTitle === name) return;
    renameChat(this.config, user, conversationId, name);
    setTopicTitle(this.config, user, conversationId, name);
    log.info('телеграм: топик назван человеком', { user: user.id, threadId, name });
  }

  /**
   * The conversation name after a turn. The heuristic from the first reply may already have
   * been set by the pi session; the model refines it from the first replies. For Telegram this
   * is also the topic name — the only place where it can be changed (see pushTopicTitle).
   */
  private async settleTitle(user: UserConfig, route: Route): Promise<void> {
    refreshChatTitle(this.config, user, route.conversationId);
    const refined = await refineChatTitle(
      this.config,
      user,
      (prompt) => this.registry.oneShot(user, prompt, { timeoutMs: AUTO_TITLE_TIMEOUT_MS }),
      route.conversationId,
    );
    const chat = findChatRecord(this.config, user, route.conversationId);
    // The conversation is not in the registry — and there's nothing to rename: the name lives in chats.json.
    if (!chat) return;
    await this.pushTopicTitle(user, route.conversationId, refined ?? chat.title);
  }

  /**
   * Sets the topic to the conversation name if it's not already there. Telegram doesn't return
   * the current topic name, so we compare with what we set ourselves (`topicTitle` in
   * chats.json): without this, every title refinement would send `editForumTopic` again, and
   * Telegram leaves a rename service message in the topic.
   */
  private pushTopicTitle(user: UserConfig, conversationId: string, title: string): Promise<void> {
    // We take the conversation's place from the registry, not from the bot's memory: it
    // survives a service restart, so a name from the panel reaches the topic after it too
    // (see setChatTelegram).
    const place = findChatRecord(this.config, user, conversationId)?.telegram;
    const threadId = place?.threadId ?? null;
    // The chat root is not a topic: there's nothing to change the name with there.
    if (!place || threadId === null) return Promise.resolve();
    const name = title.replace(/\s+/g, ' ').trim().slice(0, TOPIC_NAME_LIMIT);
    if (!name) return Promise.resolve();
    return this.titles.add(conversationId, async () => {
      const chat = findChatRecord(this.config, user, conversationId);
      if (chat?.topicTitle === name) return;
      try {
        await this.api.editForumTopic(place.chatId, threadId, name);
        setTopicTitle(this.config, user, conversationId, name);
        log.info('телеграм: топик назван по разговору', {
          user: user.id,
          threadId,
          name,
        });
      } catch (error) {
        // Not a forum or no rights — we stay silent: the name is already in chats.json, the panel sees it.
        log.warn('телеграм: топик не переименовался', {
          user: user.id,
          threadId,
          error: describeTelegramError(error),
        });
      }
    });
  }

  /**
   * Subscription to title refinement. A conversation can be continued from the panel too — the
   * web chat changes the name of a Telegram conversation — while the topic name lives only in
   * Telegram, so we watch the panel summary too.
   */
  watchTitles(): () => void {
    if (this.unwatchTitles) return this.unwatchTitles;
    this.unwatchTitles = watchAll((event) => {
      if (event.type !== 'title' || !event.chat) return;
      const chat = event.chat as { id?: unknown; title?: unknown; conversationId?: unknown };
      if (typeof chat.id !== 'string' || typeof chat.title !== 'string') return;
      const user = findUser(this.config, event.userId);
      if (!user) return;
      const conversationId = typeof chat.conversationId === 'string' ? chat.conversationId : chat.id;
      void this.pushTopicTitle(user, conversationId, chat.title).catch((error) => {
        log.warn('телеграм: топик не переименовался по сводке панели', { error: String(error) });
      });
    });
    return this.unwatchTitles;
  }

  /**
   * Files the agent referenced — as attachments after the text. We don't hide the error: if the
   * agent wrote “here's the chart”, the person must know why there's no chart.
   */
  private async deliverAnswerFiles(
    message: TelegramMessage,
    user: UserConfig,
    files: FileRef[],
    route: Route,
  ): Promise<void> {
    const delivered = await deliverFiles(this.api, this.config, user, message.chat.id, files, {
      threadId: route.threadId,
    });
    if (delivered.sent > 0) {
      log.info('телеграм: файлы из ответа отправлены', { user: user.id, sent: delivered.sent });
    }
    if (delivered.errors.length === 0) return;
    await this.say(message.chat.id, filesFailedText(delivered.errors), route.threadId, route.anchor);
  }

  /**
   * The answer didn't reach the topic (Telegram rejected both `message_thread_id` and the
   * anchor). In the topic the person would wait in silence, so we say in the chat root: “there
   * will be no answer, write here”.
   */
  private async reportUndelivered(message: TelegramMessage, route: Route, reply: TelegramReply): Promise<void> {
    if (!reply.failed || route.threadId === null) return;
    const reason = describeTelegramError(reply.failed);
    log.error('телеграм: ответ не доехал до топика', {
      chatId: message.chat.id,
      threadId: route.threadId,
      error: reason,
    });
    await this.say(message.chat.id, topicDeliveryFailed(reason));
  }

  /**
   * `/rename name`: renames the current conversation. The name lives in chats.json and is
   * visible in the panel; if the conversation goes in a Telegram topic, we rename that too —
   * the person must see the new name where they talk.
   */
  private async renameChat(
    message: TelegramMessage,
    user: UserConfig,
    argument: string,
    route: Route,
  ): Promise<void> {
    const chatId = message.chat.id;
    const name = argument.replace(/\s+/g, ' ').trim().slice(0, TOPIC_NAME_LIMIT);
    if (name === '') {
      await this.say(chatId, RENAME_NEEDS_NAME, route.threadId, route.anchor);
      return;
    }

    if (route.threadId !== null) {
      try {
        await this.api.editForumTopic(chatId, route.threadId, name);
      } catch (error) {
        const reason = describeTelegramError(error);
        log.warn('телеграм: топик не переименовался', { chatId, threadId: route.threadId, error: reason });
        await this.say(chatId, renameFailed(reason), route.threadId, route.anchor);
        return;
      }
    }

    const outcome = await this.registry.rename(user, route.conversationId, name);
    // We remember the name so that the auto-title doesn't rename the topic a second time.
    // After `registry.rename`: before it the conversation record may not exist yet.
    if (route.threadId !== null) setTopicTitle(this.config, user, route.conversationId, name);
    await this.say(chatId, renameText(outcome), route.threadId, route.anchor);
  }

  /**
   * `/archive`: the conversation goes to the panel archive and is removed from Telegram. This
   * is one action: in the panel the archive is “out of sight”, and in Telegram the topic is
   * removed the same way — entirely, together with the messages. Telegram can't bring it back,
   * so a conversation returns from the archive only into the panel (see archiveChat).
   */
  private async archive(message: TelegramMessage, user: UserConfig, route: Route): Promise<void> {
    const chatId = message.chat.id;
    // Whether there's anything to delete in Telegram: the chat root has no topic.
    const hadTopic = (findChatRecord(this.config, user, route.conversationId)?.telegram?.threadId ?? null) !== null;
    const outcome = await archiveChat(this.config, user, route.conversationId, true, (chat) =>
      this.removeTopic(user, chat),
    );
    const chat = outcome.chat;
    if (!chat) {
      await this.say(chatId, ARCHIVE_NOT_FOUND, route.threadId, route.anchor);
      return;
    }
    // The topic wasn't deleted — the conversation is in the archive anyway, but we say it where
    // the person wrote.
    if (outcome.topicError) {
      await this.say(chatId, archiveTopicFailed(outcome.topicError), route.threadId, route.anchor);
      return;
    }
    // The topic is deleted together with the messages — there's nothing left to answer in it:
    // we write to the chat root.
    await this.say(chatId, archivedText(chat.title, hadTopic));
  }

  /**
   * Removes the conversation from Telegram: the topic is deleted together with the messages.
   * Both `/archive` and the panel call it — archiving is one action for them (see archiveChat).
   */
  async removeTopic(user: UserConfig, chat: ChatRecord): Promise<void> {
    const place = chat.telegram;
    if (!place || place.threadId === null) return;
    await this.api.deleteForumTopic(place.chatId, place.threadId);
    log.info('телеграм: топик удалён вместе с разговором', {
      user: user.id,
      chatId: place.chatId,
      threadId: place.threadId,
    });
  }

  /**
   * `/workspace [name]`: the conversation's working folder. Without a name — the current one
   * and the list of available ones, with a name — switching. The choice lives in chats.json
   * together with the conversation: the panel sees it, and it survives a bot restart. A private
   * workspace participates neither in the list nor in switching.
   */
  private async selectWorkspace(
    message: TelegramMessage,
    user: UserConfig,
    argument: string,
    route: Route,
  ): Promise<void> {
    const say = (text: string): Promise<void> => this.say(message.chat.id, text, route.threadId, route.anchor);

    const slug = workspaceForConversation(this.config, user, route.conversationId) ?? DEFAULT_WORKSPACE;
    const current = listWorkspaces(this.config, user).find((item) => item.slug === slug)?.name ?? slug;
    // A name with spaces is a common thing: “Work on Atlas” is written by a person in full.
    const name = argument.replace(/\s+/g, ' ').trim();

    if (name === '') {
      await say(workspacesText(current, selectableWorkspaces(this.config, user)));
      return;
    }

    const workspace = findSelectableWorkspace(this.config, user, name);
    if (workspace === 'private') {
      await say(WORKSPACE_PRIVATE_REFUSED);
      return;
    }
    if (!workspace) {
      await say(workspaceUnknown(name));
      return;
    }

    try {
      setChatWorkspace(this.config, user, route.conversationId, workspace.slug);
    } catch (error) {
      log.warn('телеграм: workspace не переключился', {
        user: user.id,
        conversation: route.conversationId,
        error: String(error),
      });
      await say(workspaceFailed(error instanceof Error ? error.message : String(error)));
      return;
    }
    log.info('телеграм: разговор переключён в другой workspace', {
      user: user.id,
      conversation: route.conversationId,
      workspace: workspace.slug,
    });
    await say(workspaceSwitched(workspace.name));
  }

  /**
   * A short message without a stream: a greeting, a refusal, an answer to a command. The
   * anchor is the id of the person's reply in the same topic: if Telegram rejects the topic,
   * the answer will go as a reply to it, that is, into the topic anyway (see
   * TelegramApi.sendMessage).
   *
   * It didn't reach the topic — we say so in the root: in the topic the person would wait in
   * silence. No recursion: a message in the root goes without a topic number, and there
   * won't be a second attempt to “say that it wasn't said”.
   */
  private async say(chatId: number, text: string, threadId: number | null = null, anchor?: number): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text, threadId, anchor);
    } catch (error) {
      const reason = describeTelegramError(error);
      log.warn('телеграм: сообщение не отправилось', { error: reason });
      if (threadId !== null) await this.say(chatId, topicDeliveryFailed(reason));
    }
  }
}

/** Brings up the bot if it's configured: no token or mapping — the service lives as before. */
export function startTelegramBot(config: IcarusConfig, registry: SessionRegistry): TelegramBot | null {
  if (!config.telegram) return null;
  const bot = new TelegramBot(config, registry);
  bot.start();
  return bot;
}
