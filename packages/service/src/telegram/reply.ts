// Живой ответ в Telegram: одно сообщение, которое дописывается правками.
//
// Правки дозированы: Telegram не любит, когда сообщение меняют чаще раза в секунду
// (429), а модель отдаёт ответ кусками по паре знаков. Поэтому текст копится, а
// сообщение обновляется не чаще `intervalMs`; финальная правка — всегда.
//
// Предел Telegram в 4096 знаков обходим, разрезая ответ на несколько сообщений:
// активное доводим до границы и заводим следующее. Так длинный ответ доезжает
// целиком, а не обрывается на полуслове.
import { log } from '../log.ts';
import { describeTelegramError, type TelegramApi } from './api.ts';

/** Предел одного сообщения Telegram. */
export const MESSAGE_LIMIT = 4096;
/** Режем раньше предела: запас на служебную строку и на разметку вокруг текста. */
export const SAFE_LIMIT = 3800;
/** «Печатает…» живёт около пяти секунд — обновляем чуть раньше. */
export const TYPING_INTERVAL_MS = 4500;
/** Служебная строка: длинные команды в неё не влезают. */
const STATUS_LIMIT = 200;
/** Что видно в сообщении, пока ответа ещё нет. */
export const PLACEHOLDER = '…';

/**
 * Где разрезать длинный текст: по пустой строке, потом по строке, потом по пробелу.
 * Граница ищется только во второй половине куска — иначе короткий абзац в начале
 * отрезал бы почти всё сообщение.
 */
export function splitPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);
  for (const boundary of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(boundary);
    if (at > limit / 2) return at + boundary.length;
  }
  return limit;
}

export type ReplyOptions = {
  /** Минимум между правками одного сообщения. */
  intervalMs?: number;
  /** Часы: в тестах подменяются, чтобы не ждать throttle. */
  now?: () => number;
  /**
   * Топик, в котором идёт разговор: новые сообщения и «печатает…» уезжают туда.
   * Правка сообщения номера топика не требует — он уже в самом сообщении.
   */
  threadId?: number | null;
};

export class TelegramReply {
  private api: TelegramApi;
  private chatId: number;
  private intervalMs: number;
  private now: () => number;
  private threadId: number | null;

  /** Текст активного сообщения; всё, что не влезло раньше, уже разослано. */
  private tail = '';
  /** Строка «что делаю»: живёт до конца хода и в готовый ответ не попадает. */
  private status = '';
  private messageId: number | null = null;
  private lastEdit = 0;
  private timer: NodeJS.Timeout | null = null;
  private typing: NodeJS.Timeout | null = null;
  /** Правки идут по очереди: две одновременные правки одного сообщения дерутся. */
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(api: TelegramApi, chatId: number, options: ReplyOptions = {}) {
    this.api = api;
    this.chatId = chatId;
    this.intervalMs = options.intervalMs ?? 1200;
    this.now = options.now ?? Date.now;
    this.threadId = options.threadId ?? null;
  }

  /** Заводит сообщение-заготовку: человек видит, что его услышали, ещё до ответа. */
  async start(): Promise<void> {
    this.keepTyping();
    try {
      const sent = await this.api.sendMessage(this.chatId, PLACEHOLDER, this.threadId);
      this.messageId = sent.message_id;
      this.lastEdit = this.now();
    } catch (error) {
      // Не вышло — не повод бросать ход: первая же правка заведёт сообщение заново.
      log.warn('телеграм: заготовка ответа не отправилась', { error: describeTelegramError(error) });
    }
  }

  /** Кусок видимого ответа модели. */
  push(delta: string): void {
    this.tail += delta;
    this.schedule();
  }

  /** Чем Икар занят прямо сейчас (фраза про тул). В ответ не попадает. */
  setStatus(text: string): void {
    this.status = text.replace(/\s+/g, ' ').trim().slice(0, STATUS_LIMIT);
    this.schedule();
  }

  /**
   * Ход закончился: убираем служебную строку, доводим текст до конца. Пустой ответ
   * (одни тулы без слов) показываем последней фразой о том, чем закончили, — иначе
   * человек остался бы с висящим многоточием.
   */
  async finish(fallback = 'Готово.'): Promise<void> {
    this.finished = true;
    this.stopTyping();
    this.clearTimer();

    const status = this.status;
    this.status = '';
    await this.enqueue(async () => {
      if (!this.tail.trim() && status) this.tail = status;
      if (!this.tail.trim()) this.tail = fallback;
      await this.refresh();
    });
  }

  private statusText(): string {
    return this.status ? `\n\n${this.status}` : '';
  }

  private render(): string {
    return `${this.tail}${this.statusText()}`;
  }

  /**
   * Приводит сообщения в соответствие с тем, что уже накопилось. Пока хвост не
   * влезает в одно сообщение, режем его: активное дописываем до границы, остаток
   * уезжает следующим сообщением, и дальше правим уже его.
   */
  private async refresh(): Promise<void> {
    while (this.tail.length + this.statusText().length > SAFE_LIMIT) {
      const cut = splitPoint(this.tail, SAFE_LIMIT);
      if (cut <= 0) break;
      const head = this.tail.slice(0, cut);
      this.tail = this.tail.slice(cut);
      await this.write(this.messageId, head);
      // Активное сообщение стало законченным: следующая запись заведёт новое.
      this.messageId = null;
    }

    const body = this.render();
    if (!body.trim()) return;
    await this.write(this.messageId, body);
  }

  /** Пишет текст в активное сообщение, а если его ещё нет — заводит новое. */
  private async write(messageId: number | null, text: string): Promise<void> {
    if (!text) return;
    if (messageId === null) {
      const sent = await this.api.sendMessage(this.chatId, text, this.threadId);
      this.messageId = sent.message_id;
    } else {
      await this.api.editMessageText(this.chatId, messageId, text);
    }
    this.lastEdit = this.now();
  }

  private schedule(): void {
    if (this.finished || this.timer) return;
    const wait = Math.max(0, this.intervalMs - (this.now() - this.lastEdit));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(() => this.refresh());
    }, wait);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Очередь правок: следующая начинается после предыдущей, сбои не рвут цепочку. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task).catch((error) => {
      log.warn('телеграм: ответ не обновился', { error: describeTelegramError(error) });
    });
    return this.chain;
  }

  private keepTyping(): void {
    const tick = () => {
      void this.api.sendChatAction(this.chatId, 'typing', this.threadId).catch((error) => {
        log.debug('телеграм: «печатает» не отправилось', { error: describeTelegramError(error) });
      });
    };
    tick();
    this.typing = setInterval(tick, TYPING_INTERVAL_MS);
    this.typing.unref?.();
  }

  private stopTyping(): void {
    if (!this.typing) return;
    clearInterval(this.typing);
    this.typing = null;
  }
}
