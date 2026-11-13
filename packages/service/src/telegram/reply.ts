// A live reply in Telegram: a single message that is appended to by edits.
//
// Edits are dosed: Telegram doesn't like a message being changed more than once a second
// (429), while the model streams the answer in small chunks. So the text accumulates, and the
// message is updated no more often than `intervalMs`; the final edit always happens.
//
// We get around Telegram's 4096-character limit by cutting the answer into several messages:
// we bring the active one up to the boundary and start the next. Thus a long answer arrives
// whole instead of being cut off mid-word.
//
// There's no placeholder message with an ellipsis: while the answer isn't there yet, the chat is empty, and
// busyness is shown by the Telegram action (see chat-action.ts). The message is started by
// the very first portion of text — and then edited until the answer ends.
//
// We don't write in words in the message what the turn is doing right now: that was extra text
// that the person reads instead of the answer.
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

/** The limit of a single Telegram message. */
export const MESSAGE_LIMIT = 4096;
/** We cut earlier than the limit: a margin for the markup around the text. */
export const SAFE_LIMIT = 3800;

/**
 * Where to cut long text: at an empty line, then at a line, then at a space.
 * The boundary is looked for only in the second half of the chunk — otherwise a short paragraph at the start
 * would cut off almost the whole message.
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
  /** Minimum between edits of one message. */
  intervalMs?: number;
  /** Minimum between Telegram actions; in tests it's collapsed to zero. */
  actionGapMs?: number;
  /** After how long to repeat the action while the turn is running. */
  actionIntervalMs?: number;
  /** Clock: in tests it's swapped out so we don't wait for the throttle. */
  now?: () => number;
  /**
   * The topic in which the conversation goes: new messages and "typing…" go there.
   * Editing a message doesn't require the topic number — it's already in the message itself.
   */
  threadId?: number | null;
  /**
   * The person's message inside the same topic: by replying to it Telegram puts the reply
   * in the topic even if `message_thread_id` is rejected (see TelegramApi.sendMessage).
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

  /** Text of the active message; everything that didn't fit earlier has already been sent. */
  private tail = '';
  /** What we show busyness with; null — "doing nothing", the indicator goes out by itself. */
  private action: ChatAction | null = null;
  /** When the current action was set: by this time the sticker joke stops lying. */
  private actionAt = 0;
  /** When the action went to Telegram: we keep a pause between sends. */
  private actionSentAt = 0;
  private actionGapMs: number;
  private actionIntervalMs: number;
  private messageId: number | null = null;
  private lastEdit = 0;
  private timer: NodeJS.Timeout | null = null;
  private actionTimer: NodeJS.Timeout | null = null;
  /** Edits go one at a time: two simultaneous edits of one message fight each other. */
  private chain: Promise<void> = Promise.resolve();
  private finished = false;
  /** The last send failed: the answer didn't reach the person (see failed). */
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
   * The answer didn't arrive: the last send failed. By this flag the bot tells the person
   * in the chat root — in the topic they would have waited in silence.
   */
  get failed(): Error | null {
    return this.failure;
  }

  /**
   * The turn started. We don't start a message: the person will see the answer when it appears,
   * and until then busyness is shown by the action. It's set at the entrance — voice
   * transcription starts before the model enters the turn, and promising thought at that
   * moment would be dishonest.
   */
  start(action: ChatAction = THINKING_ACTION): void {
    this.setAction(action);
  }

  /** A piece of the model's visible answer. */
  push(delta: string): void {
    this.tail += delta;
    this.schedule();
  }

  /**
   * Transforms the not-yet-shown tail of the answer. Thus the bot removes links to files
   * from the text: it sends the files themselves as attachments, and the person doesn't
   * need the path in the message. We don't touch already-sent pieces — they can't be rewritten.
   */
  mapTail(transform: (tail: string) => string): void {
    this.tail = transform(this.tail);
    this.schedule();
  }

  /**
   * What to show busyness with right now. null — the turn is doing nothing: waiting for
   * the person (a question, MCP login, permission), and a silent indicator here is more honest
   * than any action — it will go out by itself in a few seconds.
   */
  setAction(action: ChatAction | null): void {
    if (this.finished || action === this.action) return;
    this.action = action;
    this.actionAt = this.now();
    if (action === null) {
      this.stopAction();
      return;
    }
    // We send immediately without waiting for the tick: otherwise the person sees for a few more seconds
    // the action of the previous phase, which is no longer true.
    this.keepAction();
    this.sendActionIfDue();
  }

  /**
   * The turn ended: the indicator has nothing more to repeat, we bring the text to the end.
   * An empty answer (only tools without words) we close with a short `fallback` — otherwise
   * the person would be left with a hanging ellipsis.
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
   * Brings the messages in line with what has already accumulated. While the tail doesn't
   * fit into one message, we cut it: we append the active one up to the boundary, the remainder
   * goes as the next message, and then we edit that one.
   */
  private async refresh(): Promise<void> {
    while (this.tail.length > SAFE_LIMIT) {
      const cut = splitPoint(this.tail, SAFE_LIMIT);
      if (cut <= 0) break;
      const head = this.tail.slice(0, cut);
      this.tail = this.tail.slice(cut);
      await this.write(this.messageId, head);
      // The active message has become finished: the next write will start a new one.
      this.messageId = null;
    }

    const body = this.render();
    if (!body.trim()) return;
    await this.write(this.messageId, body);
  }

  /**
   * Writes text into the active message, and if there isn't one yet — starts a new one.
   *
   * The model answers in markdown, and Telegram without `parse_mode` shows it as is:
   * asterisks, hashes, backticks. We build the markup ourselves (see format.ts).
   */
  private async write(messageId: number | null, text: string): Promise<void> {
    if (!text) return;
    const html = renderHtml(text);
    try {
      await this.deliver(messageId, html, { parseMode: 'HTML' });
    } catch (error) {
      // Telegram didn't like the markup: the answer is more important than italics, so we retry
      // with the same text without tags — that is always accepted.
      if (!isMarkupRejected(error)) throw error;
      log.warn('телеграм: разметка не принята — отправляю без неё', { error: describeTelegramError(error) });
      await this.deliver(messageId, htmlToPlain(html), {});
    }
    this.lastEdit = this.now();
    // It arrived: past failures no longer count — the person sees the answer.
    this.failure = null;
  }

  /** Send or edit — exactly one Bot API call. */
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

  /** Edit queue: the next starts after the previous, failures don't break the chain. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task).catch((error) => {
      // We remember the failure: by it the bot will tell the person in the root that the answer didn't arrive.
      this.failure = error instanceof Error ? error : new Error(String(error));
      log.warn('телеграм: ответ не обновился', { error: describeTelegramError(error) });
    });
    return this.chain;
  }

  /**
   * Keeps the action alive: the client forgets it after five seconds, while a turn can
   * go on for minutes. The action is read from the field on every tick, so a phase change is
   * just a new value, not a restart of the loop.
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

  /** We collapse too-frequent phase changes: the action that got through is fresh enough anyway. */
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

  /** A drawn-out joke stops being a joke: we replace the sticker with an honest "typing". */
  private currentAction(): ChatAction | null {
    if (this.action !== THINKING_ACTION) return this.action;
    return this.now() - this.actionAt >= STICKER_LIE_MS ? 'typing' : this.action;
  }
}

/**
 * Telegram rejected the markup, not the message: 400 and "can't parse entities" with
 * variants. That's what any of our HTML slip-ups looks like — it's cured by a retry without tags.
 */
function isMarkupRejected(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return false;
  return /can't parse entities|unsupported (?:start|end) tag|can't find end tag/i.test(error.message);
}
