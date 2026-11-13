// Живой ответ в Telegram: одно сообщение, которое дописывается правками.
//
// Правки дозированы: Telegram не любит, когда сообщение меняют чаще раза в секунду
// (429), а модель отдаёт ответ кусками по паре знаков. Поэтому текст копится, а
// сообщение обновляется не чаще `intervalMs`; финальная правка — всегда.
//
// Предел Telegram в 4096 знаков обходим, разрезая ответ на несколько сообщений:
// активное доводим до границы и заводим следующее. Так длинный ответ доезжает
// целиком, а не обрывается на полуслове.
//
// Сообщения-заготовки с многоточием нет: пока ответа ещё нет, в чате пусто, а
// занятость показывает действие Telegram (см. chat-action.ts). Сообщение заводит
// первая же порция текста — и дальше правится, пока ответ не кончится.
//
// Что ход делает прямо сейчас, словами в сообщении не пишем: это был лишний текст,
// который человек читает вместо ответа.
import { log } from '../log.ts';
import {
  ACTION_GAP_MS,
  ACTION_INTERVAL_MS,
  STICKER_LIE_MS,
  THINKING_ACTION,
  type ChatAction,
} from './chat-action.ts';
import { describeTelegramError, TelegramError, type SendOptions, type TelegramApi } from './api.ts';
import { htmlToPlain, renderHtml } from './format.ts';

/** Предел одного сообщения Telegram. */
export const MESSAGE_LIMIT = 4096;
/** Режем раньше предела: запас на разметку вокруг текста. */
export const SAFE_LIMIT = 3800;

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
  /** Минимум между действиями Telegram; в тестах схлопывают в ноль. */
  actionGapMs?: number;
  /** Через сколько повторять действие, пока ход идёт. */
  actionIntervalMs?: number;
  /** Часы: в тестах подменяются, чтобы не ждать throttle. */
  now?: () => number;
  /**
   * Топик, в котором идёт разговор: новые сообщения и «печатает…» уезжают туда.
   * Правка сообщения номера топика не требует — он уже в самом сообщении.
   */
  threadId?: number | null;
  /**
   * Сообщение человека внутри того же топика: ответом на него Telegram кладёт ответ
   * в топик, даже если `message_thread_id` отобьёт (см. TelegramApi.sendMessage).
   */
  anchorMessageId?: number;
};

export class TelegramReply {
  private api: TelegramApi;
  private chatId: number;
  private intervalMs: number;
  private now: () => number;
  private threadId: number | null;
  private anchorMessageId: number | undefined;

  /** Текст активного сообщения; всё, что не влезло раньше, уже разослано. */
  private tail = '';
  /** Чем показываем занятость; null — «ничего не делаем», индикатор гаснет сам. */
  private action: ChatAction | null = null;
  /** Когда поставили текущее действие: по этому времени стикер-шутка перестаёт врать. */
  private actionAt = 0;
  /** Когда действие уехало в Telegram: между отправками держим паузу. */
  private actionSentAt = 0;
  private actionGapMs: number;
  private actionIntervalMs: number;
  private messageId: number | null = null;
  private lastEdit = 0;
  private timer: NodeJS.Timeout | null = null;
  private actionTimer: NodeJS.Timeout | null = null;
  /** Правки идут по очереди: две одновременные правки одного сообщения дерутся. */
  private chain: Promise<void> = Promise.resolve();
  private finished = false;
  /** Последняя отправка не удалась: ответ человеку не доехал (см. failed). */
  private failure: Error | null = null;

  constructor(api: TelegramApi, chatId: number, options: ReplyOptions = {}) {
    this.api = api;
    this.chatId = chatId;
    this.intervalMs = options.intervalMs ?? 1200;
    this.actionGapMs = options.actionGapMs ?? ACTION_GAP_MS;
    this.actionIntervalMs = options.actionIntervalMs ?? ACTION_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.threadId = options.threadId ?? null;
    this.anchorMessageId = options.anchorMessageId;
  }

  /**
   * Ответ не доехал: последняя отправка сорвалась. По этому флагу бот говорит
   * человеку в корне чата — в топике он ждал бы молча.
   */
  get failed(): Error | null {
    return this.failure;
  }

  /**
   * Ход начался. Сообщение не заводим: человек увидит ответ, когда тот появится,
   * а до тех пор занятость показывает действие. Оно задаётся на входе — расшифровка
   * голосового начинается раньше, чем в ход вступит модель, и обещать мысль в этот
   * момент нечестно.
   */
  start(action: ChatAction = THINKING_ACTION): void {
    this.setAction(action);
  }

  /** Кусок видимого ответа модели. */
  push(delta: string): void {
    this.tail += delta;
    this.schedule();
  }

  /**
   * Преобразует ещё не показанный хвост ответа. Так бот убирает из текста ссылки
   * на файлы: сами файлы он отправляет вложением, а путь в сообщении человеку
   * не нужен. Уже разосланные куски не трогаем — их не переписать.
   */
  mapTail(transform: (tail: string) => string): void {
    this.tail = transform(this.tail);
    this.schedule();
  }

  /**
   * Чем показывать занятость прямо сейчас. null — ход ничего не делает: ждёт
   * человека (вопрос, вход в MCP, разрешение), и молчащий индикатор тут честнее
   * любого действия — оно погаснет само через несколько секунд.
   */
  setAction(action: ChatAction | null): void {
    if (this.finished || action === this.action) return;
    this.action = action;
    this.actionAt = this.now();
    if (action === null) {
      this.stopAction();
      return;
    }
    // Отправляем сразу, не дожидаясь тика: иначе человек ещё несколько секунд
    // видит действие прошлой фазы, которое уже неправда.
    this.keepAction();
    this.sendActionIfDue();
  }

  /**
   * Ход закончился: индикатору больше нечего повторять, доводим текст до конца.
   * Пустой ответ (одни тулы без слов) закрываем коротким `fallback` — иначе
   * человек остался бы с висящим многоточием.
   */
  async finish(fallback = 'Готово.'): Promise<void> {
    this.finished = true;
    this.stopAction();
    this.clearTimer();

    await this.enqueue(async () => {
      if (!this.tail.trim()) this.tail = fallback;
      await this.refresh();
    });
  }

  private render(): string {
    return this.tail;
  }

  /**
   * Приводит сообщения в соответствие с тем, что уже накопилось. Пока хвост не
   * влезает в одно сообщение, режем его: активное дописываем до границы, остаток
   * уезжает следующим сообщением, и дальше правим уже его.
   */
  private async refresh(): Promise<void> {
    while (this.tail.length > SAFE_LIMIT) {
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

  /**
   * Пишет текст в активное сообщение, а если его ещё нет — заводит новое.
   *
   * Модель отвечает markdown, а Telegram без `parse_mode` показывает его как есть:
   * звёздочки, решётки, обратные кавычки. Разметку собираем сами (см. format.ts).
   */
  private async write(messageId: number | null, text: string): Promise<void> {
    if (!text) return;
    const html = renderHtml(text);
    try {
      await this.deliver(messageId, html, { parseMode: 'HTML' });
    } catch (error) {
      // Разметка не понравилась Telegram: ответ важнее курсива, поэтому повторяем
      // тем же текстом без тегов — такой принимается всегда.
      if (!isMarkupRejected(error)) throw error;
      log.warn('телеграм: разметка не принята — отправляю без неё', { error: describeTelegramError(error) });
      await this.deliver(messageId, htmlToPlain(html), {});
    }
    this.lastEdit = this.now();
    // Доехало: прошлые сбои больше не в счёт — человек видит ответ.
    this.failure = null;
  }

  /** Отправка или правка — ровно один вызов Bot API. */
  private async deliver(messageId: number | null, text: string, options: SendOptions): Promise<void> {
    if (messageId === null) {
      const sent = await this.api.sendMessage(this.chatId, text, this.threadId, this.anchorMessageId, options);
      this.messageId = sent.message_id;
      return;
    }
    await this.api.editMessageText(this.chatId, messageId, text, options);
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
      // Сбой запоминаем: по нему бот скажет человеку в корне, что ответ не доехал.
      this.failure = error instanceof Error ? error : new Error(String(error));
      log.warn('телеграм: ответ не обновился', { error: describeTelegramError(error) });
    });
    return this.chain;
  }

  /**
   * Держит действие живым: клиент забывает его через пять секунд, а ход может
   * идти минутами. Действие читается из поля на каждом тике, поэтому смена фазы —
   * просто новое значение, а не перезапуск цикла.
   */
  private keepAction(): void {
    if (this.actionTimer) return;
    this.actionTimer = setInterval(() => this.sendAction(), this.actionIntervalMs);
    this.actionTimer.unref?.();
  }

  private stopAction(): void {
    if (!this.actionTimer) return;
    clearInterval(this.actionTimer);
    this.actionTimer = null;
  }

  /** Слишком частые смены фаз схлопываем: успевшее действие и так свежее. */
  private sendActionIfDue(): void {
    if (this.now() - this.actionSentAt < this.actionGapMs) return;
    this.sendAction();
  }

  private sendAction(): void {
    const action = this.currentAction();
    if (!action) return;
    this.actionSentAt = this.now();
    void this.api.sendChatAction(this.chatId, action, this.threadId).catch((error) => {
      log.debug('телеграм: действие не отправилось', { action, error: describeTelegramError(error) });
    });
  }

  /** Затянувшаяся шутка перестаёт быть шуткой: стикер заменяем на честное «печатает». */
  private currentAction(): ChatAction | null {
    if (this.action !== THINKING_ACTION) return this.action;
    return this.now() - this.actionAt >= STICKER_LIE_MS ? 'typing' : this.action;
  }
}

/**
 * Telegram отверг разметку, а не сообщение: 400 и «can't parse entities» с
 * вариантами. Так выглядит любой наш промах в HTML — лечится повтором без тегов.
 */
function isMarkupRejected(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return false;
  return /can't parse entities|unsupported (?:start|end) tag|can't find end tag/i.test(error.message);
}
