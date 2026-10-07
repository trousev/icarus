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
import type { CompactOutcome, SessionRegistry } from '../sessions/registry.ts';
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

/** Единственная команда бота: она же в меню Telegram. */
export const COMMANDS = [{ command: 'compact', description: 'подвести итог разговора' }];

export const GREETING = [
  'Привет! Я Икар.',
  '',
  'Пиши как есть — я помню наши разговоры и умею много чего руками: искать в интернете, считать, читать файлы.',
  'Присылай фото и голосовые: посмотрю и послушаю.',
  '',
  '/compact — подвести итог разговора, если он разросся.',
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

export const UNKNOWN_COMMAND = 'Пока умею только /compact.';

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
    if (isCommand(incoming.text)) {
      const command = commandOf(incoming.text);
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

    // Ни текста, ни вложения: остальное бот уже назвал бы отказом.
    if (incoming.text === '' && incoming.images.length === 0 && !incoming.voice) {
      await this.say(message.chat.id, NOTHING_TO_READ);
      return;
    }

    await this.runTurn(message, user, incoming);
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
