// Telegram Bot API client: long polling for updates, sending and editing messages.
//
// The Bot API is ordinary JSON over https, so the client is small and dependency-free.
// Everything the bot needs is four methods; the rest (webhook, TLS, queue) Telegram
// takes care of: the service needs neither a domain nor a certificate.
//
// Files are the only exception to "JSON over https": the Bot API accepts them only as a
// multipart form, with the `photo` or `document` field. So here there are two separate methods
// and a shared `upload`, rather than a string parameter: you can't send an image to Telegram as a string.
import { log, redact } from '../log.ts';

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};
export type TelegramChat = { id: number; type: string };

/** Service message about a created or renamed topic. */
export type TelegramForumTopicCreated = {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
};

/** Topic name limit per the Bot API docs: we trim the conversation name by it too. */
export const TOPIC_NAME_LIMIT = 128;

/** Photo: the same frame as a ladder of sizes, down to a compressed JPEG at the end. */
export type TelegramPhotoSize = {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
};

export type TelegramDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

/** Voice: on Telegram this is always OGG/Opus, so mime needn't even be asked for. */
export type TelegramVoice = {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
};

/**
 * A message: the text and what replaces it (photo, voice, document). For an attachment
 * the text isn't in `text` but in the caption — `caption`.
 */
export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  /**
   * The topic the message is in. In a private chat with Threaded Mode enabled it arrives for everything
   * written inside a topic; at the chat root and in the General topic it may be absent
   * entirely or equal to 1 — both mean "root" (see topicThreadId).
   */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** Service: a person (or the bot) started a topic — we remember the name and number. */
  forum_topic_created?: TelegramForumTopicCreated;
  forum_topic_edited?: { name?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  video?: unknown;
  video_note?: unknown;
  audio?: unknown;
  sticker?: unknown;
};

/** A file in Telegram storage: downloading it is a separate request by `file_path`. */
export type TelegramFile = { file_id: string; file_path?: string; file_size?: number };

export type TelegramUpdate = { update_id: number; message?: TelegramMessage };

/**
 * A sent message: Telegram returns it as the same object, so the response shows
 * where the message actually landed. This needs checking: in a private chat with topics Telegram
 * can silently put the message into the shared feed while confirming the send (`ok: true`).
 */
export type SentMessage = {
  message_id: number;
  message_thread_id?: number | null;
  is_topic_message?: boolean;
};

/** Whether the message landed in the requested topic (see sendMessage). */
export function landedInThread(sent: SentMessage, asked: number): boolean {
  // Telegram returns the topic number for messages in a topic — that is the answer.
  if (typeof sent.message_thread_id === 'number') return sent.message_thread_id === asked;
  // No number, but the topic flag is set: we assume it got there.
  return sent.is_topic_message === true;
}

/**
 * Parse mode. Telegram doesn't parse markdown itself: without `parse_mode` a person sees
 * asterisks and hashes as-is. We need only HTML — format.ts builds markup for it,
 * while MarkdownV2 requires escaping a dozen-plus characters.
 */
export type ParseMode = 'HTML';

/** How to send the text: with markup or as-is. */
export type SendOptions = { parseMode?: ParseMode };

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** How long we wait for the Bot API response if the call didn't say otherwise. */
export const TELEGRAM_TIMEOUT_MS = 30_000;
/** Bot API download limit: it doesn't return a file larger than 20 MB at all. */
export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;
/** Bot API limit for sending a photo: anything larger goes only as a document. */
export const TELEGRAM_PHOTO_LIMIT = 10 * 1024 * 1024;
/** Bot API limit for sending a document (file) of any kind. */
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;
/** The caption under a photo/file is shorter than a message: Telegram won't accept more. */
export const CAPTION_LIMIT = 1024;
/** Sending a file takes longer than text: headroom for 10 MB to travel over the network. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** A file going to Telegram: bytes plus a human name and type. */
export type UploadFile = {
  bytes: Buffer;
  /** A name for a person: Telegram distinguishes the document type by it. */
  name: string;
  mimeType: string;
};

/** Caption and place for the file: an attachment's text is in `caption`, not `text`. */
export type UploadOptions = {
  caption?: string;
  threadId?: number | null;
  parseMode?: ParseMode;
};

/** The file doesn't fit the Bot API limit: we don't try to send it, we tell the person. */
export class UploadTooBigError extends Error {
  /** How many megabytes Telegram agrees to accept with this method. */
  readonly limit: number;

  constructor(name: string, bytes: number, limit: number) {
    super(`«${name}» весит ${megabytes(bytes)} МБ — Telegram принимает не больше ${megabytes(limit)} МБ`);
    this.name = 'UploadTooBigError';
    this.limit = limit;
  }
}

function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

/** Bot API error: `{ok: false, error_code, description}`. */
export class TelegramError extends Error {
  readonly code: number;
  /** After how many seconds to retry (429): Telegram sends this in parameters. */
  readonly retryAfter: number | null;

  constructor(description: string, code: number, retryAfter: number | null = null) {
    super(`telegram: ${description} (код ${code})`);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type TelegramApiOptions = {
  baseUrl?: string;
  /** Overridden in tests: no need for the network there. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Pause before retrying after a 429: overridden in tests so they don't wait. */
  sleep?: (ms: number) => Promise<void>;
};

type CallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * A ready multipart body. Parameters in `params` then don't go out: the file and fields
   * lie in the form itself, and fetch sets the `content-type` with boundary itself.
   */
  multipart?: FormData;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramApi {
  private baseUrl: string;
  private request: typeof fetch;
  private timeoutMs: number;
  private token: string;
  private pause: (ms: number) => Promise<void>;

  constructor(token: string, options: TelegramApiOptions = {}) {
    this.token = token;
    this.baseUrl = (options.baseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
    this.request = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
    this.pause = options.sleep ?? sleep;
  }

  private async call<T>(method: string, params: Record<string, unknown>, options: CallOptions = {}): Promise<T> {
    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);

    // 429 is "too often", not a breakdown: Telegram itself says how long to wait.
    // One retry saves the final edit of the answer, which we'd otherwise lose.
    for (let attempt = 0; ; attempt += 1) {
      let payload: {
        ok?: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      let response: Response;
      try {
        response = await this.request(`${this.baseUrl}/bot${this.token}/${method}`, {
          method: 'POST',
          // The form itself carries the boundary in content-type: our own header would break it.
          ...(options.multipart
            ? { body: options.multipart }
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
          signal,
        });
      } catch (error) {
        // The network and timeouts are not a Bot API response: let the caller decide (polling will retry).
        throw error instanceof Error ? error : new Error(String(error));
      }
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        // Not JSON: this is how a proxy or balancer replies (HTML on 413), not the Bot API.
        // The status is still meaningful — we return it rather than "couldn't parse the response".
        throw new TelegramError(`ответ не разобрался (HTTP ${response.status})`, response.status);
      }

      if (payload.ok === true) return payload.result as T;

      const code = Number(payload.error_code ?? 0);
      const retryAfter = Number(payload.parameters?.retry_after ?? 0);
      const description = String(payload.description ?? 'неизвестная ошибка');
      if (code === 429 && attempt === 0) {
        await this.pause(Math.min(retryAfter > 0 ? retryAfter * 1000 : 1000, 10_000));
        continue;
      }
      throw new TelegramError(description, code, retryAfter > 0 ? retryAfter : null);
    }
  }

  /** `offset` confirms everything that arrived earlier: those updates won't come again. */
  getUpdates(
    params: { offset?: number; timeoutSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<TelegramUpdate[]> {
    const timeoutSeconds = params.timeoutSeconds ?? 0;
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        timeout: timeoutSeconds,
        limit: 100,
        // The bot needs only messages: the other updates aren't about the conversation.
        allowed_updates: ['message'],
      },
      {
        signal: params.signal,
        // Long polling lives `timeout` seconds; the margin is for travel and the response.
        timeoutMs: (timeoutSeconds + 15) * 1000,
      },
    );
  }

  /**
   * The path to an attachment in Telegram storage. The file link lives for an hour, so
   * we download right away rather than postpone.
   */
  getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId });
  }

  /**
   * The file itself. The address differs from Bot API methods (`/file/bot<token>/<path>`),
   * and the response has bytes, not JSON, so it bypasses `call`. The token in the path is a secret:
   * it doesn't get into the log (see redact), and we describe errors without the address.
   */
  async downloadFile(filePath: string): Promise<Buffer> {
    const response = await this.request(`${this.baseUrl}/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new TelegramError('файл не скачался', response.status);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * A message to a chat or topic. We pass `message_thread_id` only when it's present:
   * in a chat without topics Telegram answers that field with an error.
   *
   * About topics in private chats, Telegram can lie silently: it answers `ok: true` while the message
   * lies in the shared feed (see landedInThread) — so we check the response and write to the log.
   * And if the topic is rejected with a "message thread not found" error, we retry as a reply to
   * a message from the topic (`anchorMessageId`): the anchor pulls the reply into the same topic.
   */
  async sendMessage(
    chatId: number,
    text: string,
    threadId?: number | null,
    anchorMessageId?: number,
    options: SendOptions = {},
  ): Promise<SentMessage> {
    const params: Record<string, unknown> = { chat_id: chatId, text, ...parseModeParam(options) };
    if (threadId) params.message_thread_id = threadId;

    try {
      const sent = await this.call<SentMessage>('sendMessage', params);
      if (threadId && !landedInThread(sent, threadId)) {
        log.warn('телеграм: сообщение легло не в топик', {
          chatId,
          threadId,
          landed: sent.message_thread_id ?? null,
        });
      }
      return sent;
    } catch (error) {
      const reason = describeTelegramError(error);
      if (!threadId || !anchorMessageId || !/message thread not found/i.test(reason)) throw error;
      log.warn('телеграм: топик не принял сообщение — повторяю ответом-якорем', { chatId, threadId, error: reason });
      return this.call<SentMessage>('sendMessage', {
        chat_id: chatId,
        text,
        ...parseModeParam(options),
        reply_parameters: { message_id: anchorMessageId },
      });
    }
  }

  /**
   * A photo to the chat: Telegram shows the image in a bubble and compresses it itself.
   * The limit is 10 MB; anything larger is more honest to send as a document (see outgoing.ts).
   */
  sendPhoto(chatId: number, file: UploadFile, options: UploadOptions = {}): Promise<SentMessage> {
    return this.upload('sendPhoto', 'photo', chatId, file, TELEGRAM_PHOTO_LIMIT, options);
  }

  /**
   * A document to the chat: a file as a file, with a human name in the header. This is how
   * PDFs, archives, long images and animated GIFs travel — Telegram doesn't recompress them.
   */
  sendDocument(chatId: number, file: UploadFile, options: UploadOptions = {}): Promise<SentMessage> {
    return this.upload('sendDocument', 'document', chatId, file, TELEGRAM_UPLOAD_LIMIT, options);
  }

  /**
   * Sending a file: the form is assembled here, not by the caller — otherwise every
   * caller would repeat the limits, the caption and the topic check.
   */
  private async upload(
    method: 'sendPhoto' | 'sendDocument',
    field: 'photo' | 'document',
    chatId: number,
    file: UploadFile,
    limit: number,
    options: UploadOptions,
  ): Promise<SentMessage> {
    // We check before the network: 10 MB over HTTP takes a while, and the refusal would come anyway.
    if (!file.name.trim()) throw new Error('у файла нет имени: Telegram не поймёт, что это');
    if (file.bytes.length === 0) throw new Error(`файл «${file.name}» пустой`);
    if (file.bytes.length > limit) throw new UploadTooBigError(file.name, file.bytes.length, limit);

    const form = new FormData();
    form.append('chat_id', String(chatId));
    // Buffer is a Uint8Array, but Blob types expect ArrayBuffer, and Buffer's may
    // be Shared: in practice the bytes land in the request body as-is, without a copy.
    form.append(field, new Blob([file.bytes as unknown as Uint8Array<ArrayBuffer>], { type: file.mimeType }), file.name);
    if (options.caption) form.append('caption', options.caption.slice(0, CAPTION_LIMIT));
    if (options.parseMode) form.append('parse_mode', options.parseMode);
    if (options.threadId) form.append('message_thread_id', String(options.threadId));

    const sent = await this.call<SentMessage>(method, {}, { multipart: form, timeoutMs: UPLOAD_TIMEOUT_MS });
    if (options.threadId && !landedInThread(sent, options.threadId)) {
      log.warn('телеграм: файл лег не в топик', {
        chatId,
        threadId: options.threadId,
        method,
        name: file.name,
      });
    }
    return sent;
  }

  /** Editing a message. "Not modified" isn't an error: it means there's nothing to show. */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: SendOptions = {},
  ): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...parseModeParam(options),
      });
    } catch (error) {
      if (error instanceof TelegramError && /message is not modified/i.test(error.message)) return;
      throw error;
    }
  }

  async sendChatAction(chatId: number, action = 'typing', threadId?: number | null): Promise<void> {
    await this.call('sendChatAction', {
      chat_id: chatId,
      action,
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }

  /** Renaming a topic: the number is taken from the message, the name is human. */
  async editForumTopic(chatId: number, threadId: number, name: string): Promise<void> {
    await this.call('editForumTopic', {
      chat_id: chatId,
      message_thread_id: threadId,
      name: name.slice(0, TOPIC_NAME_LIMIT),
    });
  }

  /**
   * Deleting a topic together with its messages. Irreversible: Telegram can't restore
   * a topic. This is how the conversation is removed from Telegram on archiving.
   */
  async deleteForumTopic(chatId: number, threadId: number): Promise<void> {
    await this.call('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId });
  }

  /** Command menu: what the bot can do, without a trip to the model. */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  getMe(): Promise<TelegramUser & { is_bot?: boolean }> {
    return this.call('getMe', {});
  }
}

/** The `parse_mode` field for the Bot API: without a mode Telegram shows markup as text. */
function parseModeParam(options: SendOptions): Record<string, unknown> {
  return options.parseMode ? { parse_mode: options.parseMode } : {};
}

/** A short human error text for logs: without the token in the request path. */
export function describeTelegramError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
