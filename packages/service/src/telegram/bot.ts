// Telegram-бот Икара: длинный опрос Bot API и живая сессия pi на разговор.
//
// Бот не заводит людей сам: человека он узнаёт по username из сообщения и берёт его
// id из `telegram.mapping` в config.yaml. Незнакомцу отвечаем подсказкой, а не
// разговором: без карты непонятно, чья это память и чей контейнер.
//
// Разговоров у человека столько, сколько он захочет: в личке — топики (Bot API 9.4,
// включаются Threaded Mode в BotFather), в группе — по разговору на человека. Разговор
// в терминах pi — это пара «чат + топик» (см. conversationIdFor): у каждого свой
// процесс и своя история. Топики человек заводит сам в клиенте Telegram; бот узнаёт
// о новом топике по служебному сообщению forum_topic_created и не мешает ему.
//
// Вложения разбираем те же, что и HTTP-вход: картинки уезжают модели нативно
// и ложатся в incoming/, голосовые — расшифровкой (см. attachments.ts, speech.ts).
import { findTelegramUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { buildPrompt } from '../prompt.ts';
import { phraseForToolStart, phraseForToolEnd, subagentStatus } from '../reasoning.ts';
import { mcpReauthNotice } from '../mcp/reauth.ts';
import { speechTranscriber, type Transcriber } from '../speech.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import type { PiSession } from '../sessions/pi-session.ts';
import { lastTurnOf, recordTurn } from '../sessions/chats.ts';
import type { ChatChannel } from '../sessions/identity.ts';
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

// Тексты и разбор команд общие с веб-чатом (sessions/commands.ts). Реэкспорт
// оставляет прежний вход тем, кто уже берёт их из бота, — и тестам тоже.
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

/** Длинный опрос: Telegram держит запрос, пока не появится сообщение. */
export const POLL_TIMEOUT_SECONDS = 50;
/** Минимум между правками одного сообщения: чаще — 429. */
export const EDIT_INTERVAL_MS = 1200;
/** Пауза после сбойного опроса: сеть моргнула — не долбим Telegram в цикле. */
const RETRY_AFTER_FAILURE_MS = 3000;
/**
 * Сколько живёт «свежий топик» — топик, который Telegram завёл из общей ленты.
 * Столько даём клиенту на то, чтобы следом приехало само сообщение.
 */
export const FRESH_TOPIC_WINDOW_MS = 60_000;

/** Команды бота: они же в меню Telegram (описания короткие — там мало места). */
export const COMMANDS = [
  { command: 'help', description: 'что я умею' },
  { command: 'compact', description: 'подвести итог разговора' },
  { command: 'stop', description: 'остановить ответ' },
  { command: 'stats', description: 'токены, деньги, контекст' },
  { command: 'clear', description: 'начать разговор с чистого листа' },
  { command: 'rename', description: 'переименовать текущий чат' },
  { command: 'skills', description: 'скиллы и шаблоны' },
];

/**
 * Команды, которые бот разбирает сам. Всё остальное с косой черты — реплика для pi:
 * у него свои команды (`/skill:имя`, промпт-шаблоны), и отбирать их у человека нельзя.
 */
export const BOT_COMMANDS = new Set([
  'start',
  'help',
  'compact',
  'stop',
  'stats',
  'clear',
  'rename',
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

/** Что показать на /help: те же команды, что в меню Telegram, но с объяснением. */
export const HELP = [
  'Что я умею в чате:',
  '',
  '/compact — подвести итог разговора, если он разросся',
  '/compact <пожелание> — то же, но с оговоркой, что важно сохранить',
  '/stop — остановиться, если я ушёл не туда',
  '/stats — сколько токенов и денег ушло и сколько занято в контексте',
  '/clear — начать разговор с чистого листа (память остаётся при мне)',
  '/rename <имя> — переименовать текущий чат',
  '/skills — что у меня есть сверх разговора: скиллы и шаблоны',
  '',
  'Ещё я понимаю фото и голосовые, помню прошлые разговоры и умею искать в интернете.',
  'Всё остальное — просто пиши словами.',
].join('\n');

/**
 * Ответ не доехал до топика. Говорим об этом в корне чата: в топике человек ждал бы
 * молча, а после серверных поломок топиков в личке (Bot API 10.0) — это не теория.
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

/** Сообщение, из которого нечего взять: ни текста, ни вложения. */
export const NOTHING_TO_READ = 'Тут нечего разбирать: пришли текстом, фото или голосовым.';

/** Голосовое, а расшифровывать нечем: голосового провайдера нет или он выключен. */
export const VOICE_NO_SPEECH =
  'Голосовые пока не расшифровываю: в конфиге не задана модель распознавания речи. Напиши словами.';

/** Расшифровка вышла пустой: тишина, музыка или слишком тихая запись. */
export const VOICE_EMPTY = 'В голосовом не разобрал ни слова — попробуй ещё раз или напиши словами.';

export const BUSY = 'Ещё думаю над прошлым сообщением — секунду.';

/**
 * Отбивка в Telegram перед ответом, если прошлая реплика разговора пришла из
 * другого канала. Разговор у нас один на все входы, поэтому в контексте pi уже
 * лежат сказанное в панели (и её файлы). Молча подмешивать это в ответ нельзя:
 * человек должен видеть, откуда Икар это знает, — иначе личная переписка из
 * панели тихо становится окном в Telegram.
 */
export function crossChannelNote(channel: ChatChannel): string {
  const from = channel === 'web' ? 'в панели' : channel === 'api' ? 'через API' : 'в другом канале';
  return `🧵 Продолжаю разговор, который шёл ${from}: эти реплики уже в контексте. /clear — начать с чистого листа.\n\n`;
}

/**
 * Реплика поверх идущего хода. В Telegram кнопок нет, поэтому операция одна —
 * «сейчас»: прошлый ответ обрывается. Молчать об этом нельзя, иначе выглядит,
 * будто Икар просто перестал отвечать.
 */
export const INTERRUPTED_NOTE = '⏹ Прервал прошлый ответ, чтобы взяться за твоё сообщение.\n\n';

export function unknownUser(username: string): string {
  return (
    `Не знаю тебя: @${username} не привязан ни к кому в конфиге. ` +
    'Попроси добавить твой telegram-username в telegram.mapping.'
  );
}

/** Вложение, которое бот не разбирает: видео, стикер, аудиофайл, документ. */
export function unsupportedText(kind: string): string {
  // Документ — единственное, что человек может прислать картинкой: подсказываем.
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
 * Голосовое в реплике помечаем: Икар должен знать, что это была диктовка, — в речи
 * нет ни пунктуации, ни разметки, и требовать их с человека не за что.
 */
export function voicePrompt(text: string, duration: number | null): string {
  const mark = duration === null ? '[голосовое]' : `[голосовое, ${Math.round(duration)} с]`;
  return `${mark} ${text}`;
}

/**
 * Номер топика, если сообщение пришло внутри него. Корень чата и General-топик —
 * одно и то же место, и приходит оно то с `message_thread_id = 1`, то без него
 * вовсе, поэтому «единицу» тоже считаем корнем: иначе один разговор разъехался бы
 * на два.
 */
export function topicThreadId(message: TelegramMessage): number | null {
  const threadId = message.message_thread_id;
  if (!threadId || threadId === 1) return null;
  return threadId;
}

/**
 * Разговор в терминах сессий pi — «чат + топик + человек».
 *
 * В личке без топиков разговор один на чат, и он переживает перезапуск сервиса.
 * С топиками каждый топик — отдельный разговор: у него свой процесс pi, своя история
 * в /workspace/.icarus/sessions и свой /compact. В группе людей может быть несколько, и у
 * каждого свой разговор — иначе они бы передрались за одну сессию (ход в ней один);
 * топик в группе разделяет и их тоже.
 *
 * Номер топика можно задать явно: у сообщения из общей ленты он выводится не из самого
 * сообщения, а из свежего топика (см. TelegramBot.resolveThread).
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
 * Куда относится реплика человека: топик (с поправкой на свежий топик из общей ленты),
 * разговор в терминах pi и якорь — сообщение внутри того же топика, ответом на которое
 * Telegram положит ответ в топик, даже если `message_thread_id` отобьёт.
 */
type Route = { threadId: number | null; conversationId: string; anchor?: number };

/**
 * Номер топика, к которому относится сообщение. Считать его здесь, а не в обработчике,
 * нужно потому, что служебка о новом топике и первое сообщение из общей ленты едут
 * в разных очередях (см. TelegramBot.resolveThread).
 */
type ThreadRoute = { threadId: number | null };

export type TelegramBotOptions = {
  api?: TelegramApi;
  pollTimeoutSeconds?: number;
  editIntervalMs?: number;
  /** Сколько живёт «свежий топик»; в тестах окно схлопывают в ноль. */
  freshTopicWindowMs?: number;
  /** Чем расшифровывать голосовые; null — не расшифровываем (подменяется в тестах). */
  transcribe?: Transcriber | null;
};

/**
 * Очередь по ключу: сообщения одного чата обрабатываются строго по очереди (в сессии
 * pi один ход за раз), а чужие чаты друг друга не ждут. Сбой одной задачи очередь не
 * рвёт — следующая всё равно пойдёт после неё.
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
  /** null — распознавание речи не настроено: голосовые честно просим словами. */
  private transcribe: Transcriber | null;

  private stopped = false;
  private abort = new AbortController();
  private offset: number | undefined;
  /** Очередь по чату и топику: два сообщения подряд не должны спорить за одну сессию. */
  private queue = new KeyedQueue();
  /**
   * Идущие ходы по чату и топику. Нужны, чтобы новое сообщение могло прервать
   * текущий ход сразу, а не ждать своей очереди: в Telegram человеку никто не
   * мешает писать поверх, и ждать пять минут ответа субагентов он не станет.
   */
  private turns = new Map<string, { interrupt: () => Promise<void> }>();
  /** Чаты, где новая реплика уже прервала ход: в ответе надо сказать об этом. */
  private interrupted = new Set<string>();
  /**
   * Топик, который человек только что завёл из общей ленты: клиент создаёт топик, а
   * само сообщение приезжает как сообщение корня — см. resolveThread.
   */
  private freshTopics = new Map<number, { threadId: number; at: number; name: string }>();
  private freshTopicWindowMs: number;

  constructor(config: IcarusConfig, registry: SessionRegistry, options: TelegramBotOptions = {}) {
    if (!config.telegram) throw new Error('telegram-бот не настроен: нет токена или маппинга');
    this.config = config;
    this.registry = registry;
    this.api = options.api ?? new TelegramApi(config.telegram.token);
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? POLL_TIMEOUT_SECONDS;
    this.editIntervalMs = options.editIntervalMs ?? EDIT_INTERVAL_MS;
    this.freshTopicWindowMs = options.freshTopicWindowMs ?? FRESH_TOPIC_WINDOW_MS;
    this.transcribe = options.transcribe === undefined ? speechTranscriber(config) : options.transcribe;
  }

  start(): void {
    void this.announce();
    void this.loop();
    log.info('телеграм-бот запущен', { users: Object.keys(this.config.telegram?.mapping ?? {}).length });
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  /** Знакомство: пишем в лог, под чьим именем работаем, и раскладываем меню команд. */
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
   * Запоминает топик, который человек только что завёл из общей ленты. Служебка
   * `forum_topic_created` приходит раньше первого сообщения, а само сообщение
   * может приехать без `message_thread_id` — см. resolveThread.
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
   * Топик, к которому на самом деле относится сообщение.
   *
   * Обычный случай — номер топика в самом сообщении. Но первое сообщение топика,
   * заведённого человеком из общей ленты, приезжает как сообщение корня: клиент
   * Telegram заводит топик, а текст уходит без `message_thread_id` (в личке с топиками
   * это уже ловили и у нас, и у соседей). Считать такое сообщение корнем нельзя —
   * ответ уедет в общую ленту, а топик останется пустым и человек решит, что разговор
   * потерялся. Поэтому отдаём его свежему топику (см. noteTopicCreated), а если
   * сообщение пришло с настоящим номером топика — свежий слот гасим: клиент справился сам.
   */
  private resolveThread(message: TelegramMessage): ThreadRoute {
    this.noteTopicCreated(message);
    const chatId = message.chat.id;
    const threadId = topicThreadId(message);

    if (threadId !== null) {
      // Служебка о создании топика — не «клиент сам привязал сообщение»: топик только
      // что завели, и первое сообщение в него ещё приедет (возможно, без номера).
      if (!message.forum_topic_created && this.freshTopics.get(chatId)?.threadId === threadId) {
        this.freshTopics.delete(chatId);
      }
      return { threadId };
    }
    // Служебка без номера топика и чужие чаты — не наше дело: топиков там не заводят.
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
          // Подтверждаем сразу: недоигранное сообщение лучше не переигрывать при
          // перезапуске — ошибку хода человек увидит ответом, а не тишиной.
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
   * Ставит сообщение в очередь своего чата и топика: разговоры разных людей и разных
   * топиков не ждут друг друга. `/stop` идёт мимо очереди: ход, который он отменяет,
   * сейчас в работе, и ждать его конца — значит не отменить ничего.
   *
   * Топик считаем здесь, а не в обработчике: служебное `forum_topic_created` и первое
   * сообщение топика едут в разных очередях (у них разные номера топиков), и если
   * разбирать их по очереди, топик может опоздать к собственному сообщению.
   */
  enqueue(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const thread = message ? this.resolveThread(message) : { threadId: null };
    const key = message ? `${message.chat.id}:${thread.threadId ?? 0}` : 'unknown';
    const text = message?.text ?? message?.caption ?? '';
    const command = parseCommand(text);
    const task = (): Promise<void> => this.handleUpdate(update, thread);

    // Реплика поверх идущего хода — это не «пусть подождёт»: Икар в этот момент
    // может держать два десятка субагентов, и человек ждёт их молча. Прерываем
    // сразу; сама реплика встанет в очередь и начнёт новый ход, когда прошлый
    // действительно встанет (см. runTurn).
    //
    // Команды бота (/stats, /compact) ход не трогают: они для того и сделаны, чтобы
    // не тратить токены. А вот скилл или промпт-шаблон (`/skill:... текст`) — это
    // обычная реплика для pi, и она прерывает.
    const botCommand = command !== null && BOT_COMMANDS.has(command.name);
    const startsTurn = !botCommand && (command === null || command.args !== '');
    if (startsTurn) {
      const running = this.turns.get(key);
      if (running) {
        log.info('телеграм: новое сообщение прерывает текущий ход', { key });
        // Ответ на это сообщение начнётся с честной строки: прошлый ответ прерван.
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
   * Разбирает сообщение. Топик приходит из `enqueue` — он же решает, в какую сессию pi
   * и в какой топик уедет ответ. При прямом вызове (тесты, отладка) считаем его сами.
   */
  async handleUpdate(update: TelegramUpdate, routed?: ThreadRoute): Promise<void> {
    const message = update.message;
    if (!message?.from) return;

    const chatId = message.chat.id;
    const thread = routed ?? this.resolveThread(message);
    const threadId = thread.threadId;

    // Служебные сообщения топиков: завели или переименовали. Отвечать на них
    // нечего, а разговором они не являются. Имя в панели хранит /rename.
    if (message.forum_topic_created || message.forum_topic_edited) return;

    const user = findTelegramUser(this.config, message.from.username);
    if (!user) {
      log.warn('телеграм: сообщение от незнакомца', { username: message.from.username ?? null });
      await this.say(chatId, message.from.username ? unknownUser(message.from.username) : NO_USERNAME, threadId);
      return;
    }

    // Куда относится реплика, считаем один раз: очередь, ответ и сессия pi должны
    // говорить об одном и том же месте.
    const route = this.routeFor(message, user.id, thread);
    // В логе видно и топик, и разговор: по этим строкам потом разбираются жалобы
    // «ответ уехал не туда» — в самом Telegram номера топиков не показываются.
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

    // Командой может быть и подпись к фото: человек шлёт снимок и просит подвести итог.
    const command = parseCommand(incoming.text);
    if (command) {
      if (BOT_COMMANDS.has(command.name)) {
        await this.runCommand(message, user, command, route);
        return;
      }
      // Убранные команды объясняем сами — даже с аргументами, иначе они уедут в pi.
      if (REMOVED_COMMANDS.has(command.name)) {
        await this.say(chatId, TOPICS_REMOVED, route.threadId, route.anchor);
        return;
      }
      // Незнакомая команда без аргументов — почти наверняка опечатка: подсказываем.
      // С аргументами это уже реплика: у pi есть свои команды, и отбирать их нельзя.
      if (command.args === '') {
        await this.say(chatId, UNKNOWN_COMMAND, route.threadId, route.anchor);
        return;
      }
    }

    // Ни текста, ни вложения: остальное бот уже назвал бы отказом.
    if (incoming.text === '' && incoming.images.length === 0 && !incoming.voice) {
      await this.say(chatId, NOTHING_TO_READ, route.threadId, route.anchor);
      return;
    }

    await this.runTurn(message, user, incoming, route);
  }

  /**
   * Место реплики: топик (с поправкой на свежий топик из общей ленты), разговор pi и
   * якорь — сообщение человека в том же топике. Якорь нужен на случай, когда Telegram
   * отбивает `message_thread_id`: ответ на сообщение из топика доезжает до топика.
   * У сообщения из общей ленты топика нет, и якоря у него быть не может — иначе ответ
   * вернулся бы в ленту.
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
   * Команда бота: человек ждёт короткого ответа, а не потока от модели. Разбирает
   * команды бот, а не pi: у pi на каждую из них свой RPC-вызов, и половина смысла
   * команды — в том, что она не тратит ни токенов, ни контекста разговора.
   */
  private async runCommand(
    message: TelegramMessage,
    user: UserConfig,
    command: ParsedCommand,
    route: Route,
  ): Promise<void> {
    const chatId = message.chat.id;
    const conversationId = route.conversationId;
    // Ответ на команду уезжает в тот же топик, где её написали.
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
      case 'skills':
        return say(skillsText(await this.registry.commands(user, conversationId)));
      default:
        return say(UNKNOWN_COMMAND);
    }
  }

  /**
   * Голосовое — в текст. null значит «расшифровать не вышло»: человеку уже сказали
   * почему, и начинать ход не с чего.
   */
  private async listen(voice: IncomingVoice, reply: TelegramReply): Promise<string | null> {
    if (!this.transcribe) {
      reply.push(VOICE_NO_SPEECH);
      await reply.finish();
      return null;
    }

    // Расшифровка — тоже ожидание: человек должен видеть, что его слушают.
    reply.setStatus('🎤 слушаю голосовое');
    let transcript: string;
    try {
      transcript = await this.transcribe(voice.audio, voice.mimeType);
    } catch (error) {
      log.warn('телеграм: голосовое не расшифровалось', { error: describeTelegramError(error) });
      reply.push(transcriptionFailed(describeTelegramError(error)));
      await reply.finish();
      return null;
    }
    reply.setStatus('');

    // Пустая расшифровка — это тишина или музыка: ход начинать не с чего.
    const spoken = transcript.trim();
    if (spoken === '') {
      reply.push(VOICE_EMPTY);
      await reply.finish();
      return null;
    }
    return voicePrompt(spoken, voice.duration);
  }

  /** Ход: заготовка ответа, расшифровка голосового, реплика в pi, поток событий — в правки сообщения. */
  private async runTurn(message: TelegramMessage, user: UserConfig, incoming: Incoming, route: Route): Promise<void> {
    const conversationId = route.conversationId;
    const reply = new TelegramReply(this.api, message.chat.id, {
      intervalMs: this.editIntervalMs,
      // Разговор идёт в топике — ответ, «печатает…» и продолжения уезжают туда же.
      threadId: route.threadId,
      // Если Telegram отобьёт топик, ответ уедет ответом на реплику человека — в тот же топик.
      ...(route.anchor === undefined ? {} : { anchorMessageId: route.anchor }),
    });
    // Заготовку показываем до поднятия сессии: контейнер и pi стартуют секунды,
    // и человек должен видеть, что его услышали.
    await reply.start();

    let text = incoming.text;
    if (incoming.voice) {
      const spoken = await this.listen(incoming.voice, reply);
      if (spoken === null) return;
      text = spoken;
    }

    // Ход отмечаем до поднятия сессии: контейнер и pi стартуют секунды, и сообщение,
    // пришедшее в это время, должно прервать ещё не начавшийся ход, а не встать за
    // ним в очередь на пять минут.
    const turnKey = `${message.chat.id}:${route.threadId ?? 0}`;
    const turn = {
      interrupt: async (): Promise<void> => {
        await this.registry.interrupt(user, conversationId);
      },
    };
    // Вторая операция тут одна: этот ход уже прервал прошлый. Говорим об этом
    // первой строкой ответа — в Telegram нет ни кнопки «в очередь», ни индикатора.
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

    // Сжатие прерывать нечем: это не ход, а переписывание контекста. Здесь честно
    // просим подождать. Всё остальное — гонка с прерыванием из enqueue: ход уже
    // останавливают, просто `agent_settled` ещё не приехал.
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

    // Прошлая реплика была не отсюда — значит в контексте есть чужой канал:
    // говорим об этом до ответа, а не после. Панель может быть личным окном,
    // и Telegram не должен становиться его продолжением молча.
    const previous = lastTurnOf(this.config, user, conversationId);
    if (previous && previous.channel !== 'telegram') reply.push(crossChannelNote(previous.channel));

    // Канал хода: файл сессии входы не различает, а шапка панели и отбивка
    // в Telegram живут по этой отметке.
    recordTurn(this.config, user, conversationId, 'telegram');

    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const toolArgs = new Map<string, Record<string, unknown>>();
    const reauth = new Map<string, { name: string; url: string }>();

    // Ответ копится целиком: по нему видно, на какие файлы сослался агент, а по
    // частям deltas этого не понять — путь приезжает кусками.
    let answer = '';

    const unsubscribe = session.onEvent((event) => {
      switch (event.type) {
        case 'message_update': {
          const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.delta) {
            answer += delta.delta;
            reply.push(delta.delta);
          }
          break;
        }
        case 'tool_execution_start': {
          const args = (event.args ?? {}) as Record<string, unknown>;
          toolArgs.set(String(event.toolCallId ?? ''), args);
          const phrase = phraseForToolStart(String(event.toolName), args);
          if (phrase) reply.setStatus(`⚙ ${phrase}`);
          break;
        }
        case 'tool_execution_update': {
          // У субагентов прогресс содержательный: кто бежит, кто в очереди.
          const partial = event.partialResult as { details?: unknown } | undefined;
          const line = subagentStatus(partial?.details);
          if (line) reply.setStatus(`⚙ ${line}`);
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
          reply.setStatus(`⚙ ${phraseForToolEnd(tool, Boolean(event.isError))}`);
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
      // Картинки уезжают модели нативно, а путь к ним — в реплике: без подписи
      // текст остаётся пустым, и приписка про файлы держит реплику непустой.
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
      // Ссылку на повторный вход даём после ответа модели: она не должна
      // выглядеть частью её текста, но обязана быть в том же сообщении.
      for (const item of reauth.values()) {
        reply.push(`\n\n🔑 Доступ к MCP «${item.name}» истёк. Переподключить: ${item.url}`);
      }
      dropTurn();
      unsubscribe();
      // Ссылки на локальные файлы в тексте заменяем вложениями: текст без них
      // понятнее, а сам файл человек увидит отдельным сообщением (см. outgoing.ts).
      const files = answerFiles(answer);
      if (files.length > 0) reply.mapTail(stripLocalRefs);
      await reply.finish();
      if (files.length > 0) await this.deliverAnswerFiles(message, user, files, route);
      await this.reportUndelivered(message, route, reply);
    }
  }

  /**
   * Файлы, на которые сослался агент, — вложениями после текста. Ошибку не прячем:
   * если агент написал «вот график», человек должен знать, почему графика нет.
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
   * Ответ не доехал до топика (Telegram отбил и `message_thread_id`, и якорь). В топике
   * человек ждал бы молча, поэтому говорим в корне чата: «ответа не будет, пиши сюда».
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
   * `/rename имя`: переименовывает текущий разговор. Имя живёт в chats.json и
   * видно в панели; если разговор идёт в топике Telegram, переименовываем и его —
   * человек должен увидеть новое имя там, где разговаривает.
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
    await this.say(chatId, renameText(outcome), route.threadId, route.anchor);
  }

  /**
   * Короткое сообщение без потока: приветствие, отказ, ответ на команду. Якорь — id
   * реплики человека в том же топике: если Telegram отобьёт топик, ответ уедет ответом
   * на неё, то есть всё равно в топик (см. TelegramApi.sendMessage).
   *
   * Не доехало в топик — говорим об этом в корне: в топике человек ждал бы молча.
   * Рекурсии нет: сообщение в корне уходит без номера топика, и второй попытки
   * «сказать, что не сказалось» не будет.
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

/** Поднимает бота, если он настроен: нет токена или маппинга — сервис живёт как раньше. */
export function startTelegramBot(config: IcarusConfig, registry: SessionRegistry): TelegramBot | null {
  if (!config.telegram) return null;
  const bot = new TelegramBot(config, registry);
  bot.start();
  return bot;
}
