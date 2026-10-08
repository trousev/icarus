// Telegram-бот Икара: длинный опрос Bot API и живая сессия pi на разговор.
//
// Бот не заводит людей сам: человека он узнаёт по username из сообщения и берёт его
// id из `telegram.mapping` в config.yaml. Незнакомцу отвечаем подсказкой, а не
// разговором: без карты непонятно, чья это память и чей контейнер.
//
// Разговоров у человека столько, сколько он захочет: в личке — топики (Bot API 9.4,
// включаются Threaded Mode в BotFather), в группе — по разговору на человека. Разговор
// в терминах pi — это пара «чат + топик» (см. conversationIdFor): у каждого свой
// процесс, своя история и свой /compact. Топики, заведённые человеком, бот узнаёт по
// служебному сообщению forum_topic_created: списком топиков Bot API не делится.
//
// Вложения разбираем те же, что и вход LibreChat: картинки уезжают модели нативно
// и ложатся в incoming/, голосовые — расшифровкой (см. attachments.ts, speech.ts).
import { findTelegramUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { buildPrompt } from '../prompt.ts';
import { phraseForToolStart, phraseForToolEnd } from '../reasoning.ts';
import { speechTranscriber, type Transcriber } from '../speech.ts';
import type {
  AbortOutcome,
  ClearOutcome,
  CommandsOutcome,
  CompactOutcome,
  SessionRegistry,
  StatsOutcome,
} from '../sessions/registry.ts';
import type { PiSession } from '../sessions/pi-session.ts';
import { collectIncoming, type Incoming, type IncomingVoice } from './attachments.ts';
import {
  describeTelegramError,
  TelegramApi,
  TelegramError,
  TOPIC_NAME_LIMIT,
  type ForumTopic,
  type TelegramMessage,
  type TelegramUpdate,
} from './api.ts';
import { TelegramReply } from './reply.ts';

/** Длинный опрос: Telegram держит запрос, пока не появится сообщение. */
export const POLL_TIMEOUT_SECONDS = 50;
/** Минимум между правками одного сообщения: чаще — 429. */
export const EDIT_INTERVAL_MS = 1200;
/** Пауза после сбойного опроса: сеть моргнула — не долбим Telegram в цикле. */
const RETRY_AFTER_FAILURE_MS = 3000;

/** Команды бота: они же в меню Telegram (описания короткие — там мало места). */
export const COMMANDS = [
  { command: 'help', description: 'что я умею' },
  { command: 'compact', description: 'подвести итог разговора' },
  { command: 'stop', description: 'остановить ответ' },
  { command: 'stats', description: 'токены, деньги, контекст' },
  { command: 'clear', description: 'начать разговор заново' },
  { command: 'topic', description: 'завести отдельный разговор-топик' },
  { command: 'topics', description: 'какие топики я помню' },
  { command: 'rename', description: 'переименовать текущий топик' },
  { command: 'skills', description: 'скиллы и шаблоны' },
];

/**
 * Команды, которые бот разбирает сам. Всё остальное с косой черты — реплика для pi:
 * у него свои команды (`/skill:имя`, промпт-шаблоны), и отбирать их у человека нельзя.
 *
 * `/topic`, `/topics` и `/rename` имеют смысл только в чате с включённым Threaded
 * Mode, но меню одно на все чаты: в выключенном режиме они объясняют, где галочка,
 * вместо «400 the chat is not a forum».
 */
export const BOT_COMMANDS = new Set([
  'start',
  'help',
  'compact',
  'stop',
  'stats',
  'clear',
  'topic',
  'topics',
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
  '/topic [имя] — завести отдельный разговор-топик: у него своя история и свой /compact',
  '/topics — какие топики я помню',
  '/rename <имя> — переименовать топик, в котором написано',
  '/skills — что у меня есть сверх разговора: скиллы и шаблоны',
  '',
  'Ещё я понимаю фото и голосовые, помню прошлые разговоры и умею искать в интернете.',
  'Всё остальное — просто пиши словами.',
].join('\n');

/** Приветствие с оговоркой про топики: обещать /topic там, где он не работает, нельзя. */
export function greetingFor(topicsEnabled: boolean): string {
  return topicsEnabled
    ? `${GREETING}\n/topic — завести отдельный разговор: топики в шапке чата.`
    : GREETING;
}

/** Threaded Mode выключен: объясняем, где галочка, — в личке её нет. */
export const NO_TOPICS_MODE = [
  'Отдельные разговоры (топики) у меня пока выключены.',
  '',
  'Это не в чате, а в @BotFather: My bots → этот бот → Bot Settings → Threads Settings →',
  'включить Threaded Mode. После этого /new заведёт первый топик.',
].join('\n');

/** Что отвечаем на /new: топик заведён, разговор у него свой. */
export function topicCreated(name: string): string {
  return [
    `Завёл разговор «${name}».`,
    '',
    'Всё, что напишешь здесь, живёт отдельно от других топиков: своя история, свой /compact.',
  ].join('\n');
}

/** Не вышло завести топик: имя у человека или у Telegram — показываем причину как есть. */
export function topicFailed(reason: string): string {
  return `Не смог завести топик: ${reason}`;
}

/** /topics: Bot API не отдаёт список топиков, поэтому показываем то, что видели сами. */
export function topicsList(topics: Array<{ name: string }>): string {
  if (topics.length === 0) {
    return [
      'Пока не знаю ни одного топика.',
      '',
      'Telegram не показывает боту список топиков: я вижу только те, что заводил сам или в которых',
      'при мне писали. Заведи /new — или ткни в «All Messages» в шапке чата, и он появится здесь.',
    ].join('\n');
  }
  return [
    'Разговоры, которые я помню:',
    '',
    ...topics.map((topic) => `• ${topic.name}`),
    '',
    'Переключиться — тапом по топику в шапке чата. Новый — /new.',
  ].join('\n');
}

/** /rename: имя топика меняется только изнутри топика. */
export const RENAME_OUTSIDE = 'Переименовать можно только разговор: открой топик и напиши /rename новое имя.';
/** /rename без имени: подсказываем форму, а не угадываем. */
export const RENAME_NEEDS_NAME = 'Напиши так: /rename Письмо из налоговой.';

export function renamed(name: string): string {
  return `Теперь этот разговор называется «${name}».`;
}

/** Имя топика по умолчанию: человек написал /new без названия. */
export const DEFAULT_TOPIC_NAME = 'Новый разговор';
/** Служебное имя, которым Telegram помечает топик, заведённый «All Messages». */
export const IMPLICIT_TOPIC_NAME = 'New Topic';

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

export const UNKNOWN_COMMAND = 'Такой команды не знаю. /help — что я умею.';

export const BUSY = 'Ещё думаю над прошлым сообщением — секунду.';

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
 * в /workspace/.sessions и свой /compact. В группе людей может быть несколько, и у
 * каждого свой разговор — иначе они бы передрались за одну сессию (ход в ней один);
 * топик в группе разделяет и их тоже.
 */
export function conversationIdFor(message: TelegramMessage, userId: string): string {
  const threadId = topicThreadId(message);
  const base =
    message.chat.type === 'private' ? `telegram-${message.chat.id}` : `telegram-${message.chat.id}-${userId}`;
  return threadId === null ? base : `${base}-${threadId}`;
}

/** Разобранная команда: имя без «/» и без «@бота», и всё, что человек написал после. */
export type ParsedCommand = { name: string; args: string };

/**
 * `/compact`, `/compact@the_icarus_bot`, `/compact пожелание` — команда; `/etc/hosts`
 * и «а /compact потом» — реплика. Аргументы разбираем только у своих команд: у pi
 * есть собственные (`/skill:имя`, промпт-шаблоны), и в них мы не лезем.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!name) return null;
  return { name: name.toLowerCase(), args: (match?.[2] ?? '').trim() };
}

function tokens(value: number): string {
  return Math.round(value).toLocaleString('ru-RU');
}

/** Число из ответа pi: там всё необязательное, и падать на пропуске незачем. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Деньги в отчёте: у разговора на день копейки и есть цена, округлять их жалко. */
function money(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

/** Что ответить на /compact: решает не бот, а реестр сессий. */
export function compactText(outcome: CompactOutcome): string {
  switch (outcome.status) {
    case 'compacted':
      return `Подвёл итог: ${tokens(outcome.tokensBefore)} → ${tokens(outcome.tokensAfter)} токенов. Продолжаем с этого места.`;
    case 'nothing':
      return 'Сжимать пока нечего: разговор короткий или уже сжат.';
    case 'no-session':
      return 'Сжимать нечего: разговор ещё не начат или уже сжат и закрыт — начнём, когда напишешь.';
    case 'busy':
      return 'Сейчас думаю над ответом — сожму, когда договорю.';
    case 'failed':
      return `Не получилось сжать: ${outcome.error}`;
  }
}

/** Что ответить на /stop. */
export function stopText(outcome: AbortOutcome): string {
  switch (outcome.status) {
    case 'stopped':
      return 'Остановился. Скажи, если нужно иначе.';
    case 'idle':
      return 'Я и так ничего не делаю — можно писать.';
    case 'no-session':
      return 'Останавливать нечего: разговор ещё не начат или уже закрыт.';
    case 'failed':
      return `Не получилось остановиться: ${outcome.error}`;
  }
}

/** Что ответить на /stats: цифры разговора человеческими словами. */
export function statsText(outcome: StatsOutcome): string {
  if (outcome.status === 'failed') return `Не смог посчитать: ${outcome.error}`;

  const stats = outcome.stats;
  const used = (stats.tokens ?? {}) as Record<string, unknown>;
  const context = (stats.contextUsage ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  const replies = count(stats.userMessages);
  const tools = count(stats.toolCalls);
  if (replies !== null) {
    lines.push(
      tools !== null && tools > 0
        ? `Твоих реплик: ${tokens(replies)}, шагов с инструментами: ${tokens(tools)}.`
        : `Твоих реплик: ${tokens(replies)}.`,
    );
  }

  const total = count(used.total);
  if (total !== null && total > 0) {
    const parts = [`вход ${tokens(count(used.input) ?? 0)}`, `выход ${tokens(count(used.output) ?? 0)}`];
    const cached = count(used.cacheRead);
    if (cached !== null && cached > 0) parts.push(`из кэша ${tokens(cached)}`);
    lines.push(`Токенов всего: ${tokens(total)} (${parts.join(', ')}).`);
  }

  const percent = count(context.percent);
  const contextTokens = count(context.tokens);
  const window = count(context.contextWindow);
  if (percent !== null && contextTokens !== null && window !== null) {
    lines.push(`Занято в контексте: ${Math.round(percent)}% (${tokens(contextTokens)} из ${tokens(window)}).`);
  }

  const cost = count(stats.cost);
  if (cost !== null && cost > 0) lines.push(`Потрачено: ${money(cost)}.`);

  return lines.length > 0 ? lines.join('\n') : 'Разговор пока пустой: ни реплик, ни токенов.';
}

/** Что ответить на /clear. */
export function clearText(outcome: ClearOutcome): string {
  switch (outcome.status) {
    case 'started':
      return 'Начали с чистого листа: прошлую нить убрал в архив. Память не трогал — то, что я о вас знаю, осталось.';
    case 'empty':
      return 'Разговор и так с чистого листа — начинать заново нечего.';
    case 'busy':
      return 'Сейчас думаю над ответом: сначала /stop, потом начнём заново.';
    case 'failed':
      return `Не получилось начать заново: ${outcome.error}`;
  }
}

/** Порядок в списке команд: сначала скиллы человека, потом шаблоны и команды. */
function commandRank(source: string | undefined): number {
  if (source === 'skill') return 0;
  if (source === 'prompt') return 1;
  return 2;
}

/** Что ответить на /skills: что человек может позвать сам. */
export function skillsText(outcome: CommandsOutcome): string {
  if (outcome.status === 'failed') return `Не смог спросить у pi: ${outcome.error}`;
  if (outcome.commands.length === 0) {
    return 'Сверх разговора у меня сейчас ничего нет — только память, поиск и руки. Скажи, чего не хватает.';
  }

  const lines = ['Вот что можно позвать прямо в чате:', ''];
  const commands = [...outcome.commands].sort(
    (a, b) => commandRank(a.source) - commandRank(b.source) || a.name.localeCompare(b.name),
  );
  for (const command of commands) {
    lines.push(command.description ? `/${command.name} — ${command.description}` : `/${command.name}`);
  }
  return lines.join('\n');
}

export type TelegramBotOptions = {
  api?: TelegramApi;
  pollTimeoutSeconds?: number;
  editIntervalMs?: number;
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

/**
 * Что бот помнит о топиках: номер → имя, по чатам. Bot API не даёт списка топиков
 * (это умеет только клиентский TDLib), поэтому копим то, что видели сами: завели
 * через /new — запомнили ответ createForumTopic; человек завёл сам — пришло
 * служебное forum_topic_created. Память живёт до перезапуска: после него /topics
 * честно скажет, что видит только новые топики.
 */
export class TopicsCache {
  private chats = new Map<number, Map<number, string>>();

  remember(chatId: number, threadId: number, name: string): void {
    let topics = this.chats.get(chatId);
    if (!topics) {
      topics = new Map();
      this.chats.set(chatId, topics);
    }
    topics.set(threadId, name);
  }

  name(chatId: number, threadId: number): string | undefined {
    return this.chats.get(chatId)?.get(threadId);
  }

  list(chatId: number): Array<{ threadId: number; name: string }> {
    const topics = this.chats.get(chatId);
    if (!topics) return [];
    return [...topics].map(([threadId, name]) => ({ threadId, name }));
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
  /** Что знаем о топиках: Bot API списка не отдаёт, копим увиденное (см. TopicsCache). */
  private topics = new TopicsCache();
  /** Threaded Mode у бота: null — ещё не спрашивали (getMe не ответил). */
  private topicsEnabled: boolean | null = null;

  constructor(config: IcarusConfig, registry: SessionRegistry, options: TelegramBotOptions = {}) {
    if (!config.telegram) throw new Error('telegram-бот не настроен: нет токена или маппинга');
    this.config = config;
    this.registry = registry;
    this.api = options.api ?? new TelegramApi(config.telegram.token);
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? POLL_TIMEOUT_SECONDS;
    this.editIntervalMs = options.editIntervalMs ?? EDIT_INTERVAL_MS;
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
      // Топики в личке — не наша настройка, а флаг бота: без Threaded Mode /new
      // отвечает не «400 the chat is not a forum», а понятной инструкцией.
      this.topicsEnabled = Boolean(me.has_topics_enabled);
      log.info('телеграм-бот на связи', {
        username: me.username ?? '?',
        id: me.id,
        topics: this.topicsEnabled,
        // Человек заводит топики сам только с этим флагом — иначе только через /new.
        usersCreateTopics: Boolean(me.allows_users_to_create_topics),
      });
      await this.api.setMyCommands(COMMANDS);
    } catch (error) {
      log.warn('телеграм: не поздоровался', { error: describeTelegramError(error) });
    }
  }

  /**
   * Включены ли топики в личке. Спрашиваем лениво: getMe на старте мог не ответить
   * (сеть моргнула), а звать createForumTopic вслепую — значит показать человеку
   * «the chat is not a forum» вместо того, где включается режим. Неудачу не
   * запоминаем: следующий /new спросит снова.
   */
  private async topicsAvailable(): Promise<boolean> {
    if (this.topicsEnabled !== null) return this.topicsEnabled;
    try {
      const me = await this.api.getMe();
      this.topicsEnabled = Boolean(me.has_topics_enabled);
      return this.topicsEnabled;
    } catch (error) {
      log.warn('телеграм: не спросил про топики', { error: describeTelegramError(error) });
      return false;
    }
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
   */
  enqueue(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const key = message ? `${message.chat.id}:${topicThreadId(message) ?? 0}` : 'unknown';
    const text = message?.text ?? message?.caption ?? '';
    const task = (): Promise<void> => this.handleUpdate(update);
    const settled = parseCommand(text)?.name === 'stop' ? task() : this.queue.add(key, task);
    void settled.catch((error) => log.error('телеграм: сообщение сорвалось', { error: describeTelegramError(error) }));
    return settled;
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.from) return;

    const chatId = message.chat.id;
    const threadId = topicThreadId(message);

    // Служебное: завели топик — запоминаем имя, иначе /topics нечего показать.
    // Список топиков Bot API не отдаёт, так что это единственный источник правды.
    if (message.forum_topic_created) {
      if (threadId !== null) {
        this.topics.remember(chatId, threadId, message.forum_topic_created.name);
      }
      return;
    }
    if (message.forum_topic_edited?.name && threadId !== null) {
      this.topics.remember(chatId, threadId, message.forum_topic_edited.name);
      return;
    }

    const user = findTelegramUser(this.config, message.from.username);
    if (!user) {
      log.warn('телеграм: сообщение от незнакомца', { username: message.from.username ?? null });
      await this.say(chatId, message.from.username ? unknownUser(message.from.username) : NO_USERNAME, threadId);
      return;
    }

    let incoming: Incoming;
    try {
      incoming = await collectIncoming(this.api, message, userPaths(this.config, user).incoming);
    } catch (error) {
      log.warn('телеграм: вложение не забралось', { user: user.id, error: describeTelegramError(error) });
      await this.say(chatId, attachmentFailed(describeTelegramError(error)), threadId);
      return;
    }

    if (incoming.unsupported) {
      await this.say(chatId, unsupportedText(incoming.unsupported), threadId);
      return;
    }

    // Командой может быть и подпись к фото: человек шлёт снимок и просит подвести итог.
    const command = parseCommand(incoming.text);
    if (command) {
      if (BOT_COMMANDS.has(command.name)) {
        await this.runCommand(message, user, command);
        return;
      }
      // Незнакомая команда без аргументов — почти наверняка опечатка: подсказываем.
      // С аргументами это уже реплика: у pi есть свои команды, и отбирать их нельзя.
      if (command.args === '') {
        await this.say(chatId, UNKNOWN_COMMAND, threadId);
        return;
      }
    }

    // Ни текста, ни вложения: остальное бот уже назвал бы отказом.
    if (incoming.text === '' && incoming.images.length === 0 && !incoming.voice) {
      await this.say(chatId, NOTHING_TO_READ, threadId);
      return;
    }

    await this.runTurn(message, user, incoming);
  }

  /**
   * Команда бота: человек ждёт короткого ответа, а не потока от модели. Разбирает
   * команды бот, а не pi: у pi на каждую из них свой RPC-вызов, и половина смысла
   * команды — в том, что она не тратит ни токенов, ни контекста разговора.
   */
  private async runCommand(message: TelegramMessage, user: UserConfig, command: ParsedCommand): Promise<void> {
    const chatId = message.chat.id;
    const conversationId = conversationIdFor(message, user.id);
    // Ответ на команду уезжает в тот же топик, где её написали.
    const threadId = topicThreadId(message);

    switch (command.name) {
      case 'start':
        return this.say(chatId, greetingFor(await this.topicsAvailable()), threadId);
      case 'help':
        return this.say(chatId, HELP, threadId);
      case 'compact':
        return this.say(
          chatId,
          compactText(await this.registry.compact(user, conversationId, command.args || undefined)),
          threadId,
        );
      case 'stop':
        return this.say(chatId, stopText(await this.registry.abort(user, conversationId)), threadId);
      case 'stats':
        return this.say(chatId, statsText(await this.registry.stats(user, conversationId)), threadId);
      case 'clear':
        return this.say(chatId, clearText(await this.registry.clear(user, conversationId)), threadId);
      case 'topic':
        return this.createTopic(message, user, command.args, threadId);
      case 'topics':
        return this.say(chatId, topicsList(this.topics.list(chatId)), threadId);
      case 'rename':
        return this.renameTopic(message, command.args, threadId);
      case 'skills':
        return this.say(chatId, skillsText(await this.registry.commands(user, conversationId)), threadId);
      default:
        return this.say(chatId, UNKNOWN_COMMAND, threadId);
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
  private async runTurn(message: TelegramMessage, user: UserConfig, incoming: Incoming): Promise<void> {
    const conversationId = conversationIdFor(message, user.id);
    const reply = new TelegramReply(this.api, message.chat.id, {
      intervalMs: this.editIntervalMs,
      // Разговор идёт в топике — ответ, «печатает…» и продолжения уезжают туда же.
      threadId: topicThreadId(message),
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

    let session: PiSession;
    try {
      session = await this.registry.acquire(user, conversationId);
    } catch (error) {
      log.error('телеграм: сессия не поднялась', { user: user.id, error: redact(String(error)) });
      reply.push(`Не смог начать: ${error instanceof Error ? error.message : String(error)}`);
      await reply.finish();
      return;
    }

    if (session.busy) {
      reply.push(BUSY);
      await reply.finish();
      return;
    }

    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const unsubscribe = session.onEvent((event) => {
      switch (event.type) {
        case 'message_update': {
          const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.delta) reply.push(delta.delta);
          break;
        }
        case 'tool_execution_start': {
          const phrase = phraseForToolStart(String(event.toolName), (event.args ?? {}) as Record<string, unknown>);
          if (phrase) reply.setStatus(`⚙ ${phrase}`);
          break;
        }
        case 'tool_execution_end': {
          reply.setStatus(`⚙ ${phraseForToolEnd(String(event.toolName), Boolean(event.isError))}`);
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
      unsubscribe();
      await reply.finish();
    }
  }

  /**
   * `/topic [имя]`: заводит топик и отвечает уже внутри него — человек сразу видит,
   * где теперь живёт этот разговор. В личке без Threaded Mode не зовём API вовсе:
   * объяснить, где галочка, полезнее, чем показать «the chat is not a forum».
   */
  private async createTopic(
    message: TelegramMessage,
    user: UserConfig,
    argument: string,
    threadId: number | null,
  ): Promise<void> {
    const chatId = message.chat.id;
    if (message.chat.type === 'private' && !(await this.topicsAvailable())) {
      await this.say(chatId, NO_TOPICS_MODE, threadId);
      return;
    }

    const name = (argument || DEFAULT_TOPIC_NAME).slice(0, TOPIC_NAME_LIMIT);
    let topic: ForumTopic;
    try {
      topic = await this.api.createForumTopic(chatId, name);
    } catch (error) {
      const reason = describeTelegramError(error);
      log.warn('телеграм: топик не завёлся', { user: user.id, error: reason });
      // Топики выключены или бот не админ — это одна и та же беда с разных сторон.
      const noTopics = error instanceof TelegramError && /not a forum|not enough rights|CHAT_ADMIN_REQUIRED/i.test(reason);
      await this.say(chatId, noTopics ? NO_TOPICS_MODE : topicFailed(reason), threadId);
      return;
    }

    this.topics.remember(chatId, topic.message_thread_id, topic.name);
    await this.say(chatId, topicCreated(topic.name), topic.message_thread_id);
  }

  /** `/rename имя`: переименовывает текущий топик — из корня чата переименовывать нечего. */
  private async renameTopic(message: TelegramMessage, argument: string, threadId: number | null): Promise<void> {
    const chatId = message.chat.id;
    if (threadId === null) {
      await this.say(chatId, RENAME_OUTSIDE, threadId);
      return;
    }
    const name = argument.slice(0, TOPIC_NAME_LIMIT);
    if (name === '') {
      await this.say(chatId, RENAME_NEEDS_NAME, threadId);
      return;
    }

    try {
      await this.api.editForumTopic(chatId, threadId, name);
    } catch (error) {
      log.warn('телеграм: топик не переименовался', { error: describeTelegramError(error) });
      await this.say(chatId, topicFailed(describeTelegramError(error)), threadId);
      return;
    }
    this.topics.remember(chatId, threadId, name);
    await this.say(chatId, renamed(name), threadId);
  }

  /** Короткое сообщение без потока: приветствие, отказ, ответ на команду. */
  private async say(chatId: number, text: string, threadId: number | null = null): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text, threadId);
    } catch (error) {
      log.warn('телеграм: сообщение не отправилось', { error: describeTelegramError(error) });
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
