// Telegram-бот Икара: длинный опрос Bot API и живая сессия pi на разговор.
//
// Бот не заводит людей сам: человека он узнаёт по username из сообщения и берёт его
// id из `telegram.mapping` в config.yaml. Незнакомцу отвечаем подсказкой, а не
// разговором: без карты непонятно, чья это память и чей контейнер.
//
// Разговоры у бота свои, отдельные от LibreChat: Telegram — другой канал и другой
// контекст. Память при этом одна и та же — она живёт у человека, а не у канала.
import { findTelegramUser, type IcarusConfig, type UserConfig } from '../config.ts';
import { log, redact } from '../log.ts';
import { phraseForToolEnd, phraseForToolStart } from '../reasoning.ts';
import type { CompactOutcome, SessionRegistry } from '../sessions/registry.ts';
import type { PiSession } from '../sessions/pi-session.ts';
import { describeTelegramError, TelegramApi, type TelegramMessage, type TelegramUpdate } from './api.ts';
import { TelegramReply } from './reply.ts';

/** Длинный опрос: Telegram держит запрос, пока не появится сообщение. */
export const POLL_TIMEOUT_SECONDS = 50;
/** Минимум между правками одного сообщения: чаще — 429. */
export const EDIT_INTERVAL_MS = 1200;
/** Пауза после сбойного опроса: сеть моргнула — не долбим Telegram в цикле. */
const RETRY_AFTER_FAILURE_MS = 3000;

/** Единственная команда бота: она же в меню Telegram. */
export const COMMANDS = [{ command: 'compact', description: 'подвести итог разговора' }];

export const GREETING = [
  'Привет! Я Икар.',
  '',
  'Пиши как есть — я помню наши разговоры и умею много чего руками: искать в интернете, считать, читать файлы.',
  '',
  '/compact — подвести итог разговора, если он разросся.',
].join('\n');

export const NO_USERNAME =
  'Не могу тебя узнать: в Telegram у тебя не задан username, а я различаю людей по нему. ' +
  'Заведи username в настройках Telegram и напиши ещё раз.';

export const TEXT_ONLY = 'Пока понимаю только текст: пришли то же самое словами.';

export const UNKNOWN_COMMAND = 'Пока умею только /compact.';

export const BUSY = 'Ещё думаю над прошлым сообщением — секунду.';

export function unknownUser(username: string): string {
  return (
    `Не знаю тебя: @${username} не привязан ни к кому в конфиге. ` +
    'Попроси добавить твой telegram-username в telegram.mapping.'
  );
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

/** `/compact` или `/compact@the_icarus_bot` — команда, а не реплика. */
export function isCommand(text: string): boolean {
  return /^\/[a-zA-Z0-9_]+(@[a-zA-Z0-9_]+)?$/.test(text.trim());
}

function commandOf(text: string): string {
  return text.trim().replace(/@[a-zA-Z0-9_]+$/, '').toLowerCase();
}

function tokens(value: number): string {
  return Math.round(value).toLocaleString('ru-RU');
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

export type TelegramBotOptions = {
  api?: TelegramApi;
  pollTimeoutSeconds?: number;
  editIntervalMs?: number;
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
          this.enqueue(update);
        }
      } catch (error) {
        if (this.stopped) return;
        log.warn('телеграм: опрос не удался', { error: describeTelegramError(error) });
        await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_FAILURE_MS));
      }
    }
  }

  /** Ставит сообщение в очередь своего чата: разговоры разных людей не ждут друг друга. */
  private enqueue(update: TelegramUpdate): void {
    const key = String(update.message?.chat.id ?? 'unknown');
    void this.queue
      .add(key, () => this.handleUpdate(update))
      .catch((error) => log.error('телеграм: сообщение сорвалось', { error: describeTelegramError(error) }));
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

    const text = message.text?.trim() ?? '';
    if (text === '') {
      // Фото, голосовые и документы бот пока не разбирает: честнее сказать словами.
      await this.say(message.chat.id, TEXT_ONLY);
      return;
    }

    if (isCommand(text)) {
      const command = commandOf(text);
      if (command === '/start') {
        await this.say(message.chat.id, GREETING);
        return;
      }
      if (command === '/compact') {
        const outcome = await this.registry.compact(user, conversationIdFor(message, user.id));
        await this.say(message.chat.id, compactText(outcome));
        return;
      }
      await this.say(message.chat.id, UNKNOWN_COMMAND);
      return;
    }

    await this.runTurn(message, user, text);
  }

  /** Ход: заготовка ответа, реплика в pi, поток событий — в правки сообщения. */
  private async runTurn(message: TelegramMessage, user: UserConfig, text: string): Promise<void> {
    const conversationId = conversationIdFor(message, user.id);
    const reply = new TelegramReply(this.api, message.chat.id, { intervalMs: this.editIntervalMs });
    // Заготовку показываем до поднятия сессии: контейнер и pi стартуют секунды,
    // и человек должен видеть, что его услышали.
    await reply.start();

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
      await session.prompt(text);
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
