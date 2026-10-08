// Telegram-бот Икара: длинный опрос Bot API и живая сессия pi на разговор.
//
// Бот не заводит людей сам: человека он узнаёт по username из сообщения и берёт его
// id из `telegram.mapping` в config.yaml. Незнакомцу отвечаем подсказкой, а не
// разговором: без карты непонятно, чья это память и чей контейнер.
//
// Разговоры у бота свои, отдельные от LibreChat: Telegram — другой канал и другой
// контекст. Память при этом одна и та же — она живёт у человека, а не у канала.
//
// Вложения разбираем те же, что и вход LibreChat: картинки уезжают модели нативно
// и ложатся в incoming/, голосовые — расшифровкой (см. attachments.ts, speech.ts).
import { findTelegramUser, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { buildPrompt } from '../prompt.ts';
import { phraseForToolEnd, phraseForToolStart } from '../reasoning.ts';
import { speechTranscriber, type Transcriber } from '../speech.ts';
import type {
  AbortOutcome,
  CommandsOutcome,
  CompactOutcome,
  ResetOutcome,
  SessionRegistry,
  StatsOutcome,
} from '../sessions/registry.ts';
import type { PiSession } from '../sessions/pi-session.ts';
import { collectIncoming, type Incoming, type IncomingVoice } from './attachments.ts';
import { describeTelegramError, TelegramApi, type TelegramMessage, type TelegramUpdate } from './api.ts';
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
  { command: 'new', description: 'начать разговор заново' },
  { command: 'skills', description: 'скиллы и шаблоны' },
];

/**
 * Команды, которые бот разбирает сам. Всё остальное с косой черты — реплика для pi:
 * у него свои команды (`/skill:имя`, промпт-шаблоны), и отбирать их у человека нельзя.
 */
export const BOT_COMMANDS = new Set(['start', 'help', 'compact', 'stop', 'stats', 'new', 'skills']);

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
  '/new — начать разговор с чистого листа (память остаётся при мне)',
  '/skills — что у меня есть сверх разговора: скиллы и шаблоны',
  '',
  'Ещё я понимаю фото и голосовые, помню прошлые разговоры и умею искать в интернете.',
  'Всё остальное — просто пиши словами.',
].join('\n');

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
 * Разговор в терминах сессий pi. В личке чат и есть человек: один разговор на чат,
 * и он переживает перезапуск сервиса. В группе людей может быть несколько, и у
 * каждого свой разговор — иначе они бы передрались за одну сессию (ход в ней один).
 */
export function conversationIdFor(message: TelegramMessage, userId: string): string {
  return message.chat.type === 'private'
    ? `telegram-${message.chat.id}`
    : `telegram-${message.chat.id}-${userId}`;
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

/** Что ответить на /new. */
export function newText(outcome: ResetOutcome): string {
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
  /** Очередь по чату: два сообщения подряд не должны спорить за одну сессию. */
  private queue = new KeyedQueue();

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
      log.info('телеграм-бот на связи', { username: me.username ?? '?', id: me.id });
      await this.api.setMyCommands(COMMANDS);
    } catch (error) {
      log.warn('телеграм: не поздоровался', { error: describeTelegramError(error) });
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
   * Ставит сообщение в очередь своего чата: разговоры разных людей не ждут друг друга.
   * `/stop` идёт мимо очереди: ход, который он отменяет, сейчас в работе, и ждать его
   * конца — значит не отменить ничего.
   */
  enqueue(update: TelegramUpdate): Promise<void> {
    const key = String(update.message?.chat.id ?? 'unknown');
    const text = update.message?.text ?? update.message?.caption ?? '';
    const task = (): Promise<void> => this.handleUpdate(update);
    const settled = parseCommand(text)?.name === 'stop' ? task() : this.queue.add(key, task);
    void settled.catch((error) => log.error('телеграм: сообщение сорвалось', { error: describeTelegramError(error) }));
    return settled;
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.from) return;

    const user = findTelegramUser(this.config, message.from.username);
    if (!user) {
      log.warn('телеграм: сообщение от незнакомца', { username: message.from.username ?? null });
      await this.say(message.chat.id, message.from.username ? unknownUser(message.from.username) : NO_USERNAME);
      return;
    }

    let incoming: Incoming;
    try {
      incoming = await collectIncoming(this.api, message, userPaths(this.config, user).incoming);
    } catch (error) {
      log.warn('телеграм: вложение не забралось', { user: user.id, error: describeTelegramError(error) });
      await this.say(message.chat.id, attachmentFailed(describeTelegramError(error)));
      return;
    }

    if (incoming.unsupported) {
      await this.say(message.chat.id, unsupportedText(incoming.unsupported));
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
        await this.say(message.chat.id, UNKNOWN_COMMAND);
        return;
      }
    }

    // Ни текста, ни вложения: остальное бот уже назвал бы отказом.
    if (incoming.text === '' && incoming.images.length === 0 && !incoming.voice) {
      await this.say(message.chat.id, NOTHING_TO_READ);
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

    switch (command.name) {
      case 'start':
        return this.say(chatId, GREETING);
      case 'help':
        return this.say(chatId, HELP);
      case 'compact':
        return this.say(chatId, compactText(await this.registry.compact(user, conversationId, command.args || undefined)));
      case 'stop':
        return this.say(chatId, stopText(await this.registry.abort(user, conversationId)));
      case 'stats':
        return this.say(chatId, statsText(await this.registry.stats(user, conversationId)));
      case 'new':
        return this.say(chatId, newText(await this.registry.reset(user, conversationId)));
      case 'skills':
        return this.say(chatId, skillsText(await this.registry.commands(user, conversationId)));
      default:
        return this.say(chatId, UNKNOWN_COMMAND);
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
    const reply = new TelegramReply(this.api, message.chat.id, { intervalMs: this.editIntervalMs });
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

  /** Короткое сообщение без потока: приветствие, отказ, ответ на команду. */
  private async say(chatId: number, text: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text);
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
