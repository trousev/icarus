// Клиент Telegram Bot API: длинный опрос апдейтов, отправка и правка сообщений.
//
// Bot API — обычный JSON по https, поэтому клиент маленький и без зависимостей.
// Всё, что нужно боту, — четыре метода; остальное (вебхук, TLS, очередь) Telegram
// берёт на себя: сервису не нужен ни домен, ни сертификат.
//
// Файлы — единственное исключение из «JSON по https»: их Bot API принимает только
// multipart-формой, полем `photo` или `document`. Поэтому здесь два отдельных метода
// и общий `upload`, а не строковый параметр: строкой картинку в Telegram не отправишь.
import { log, redact } from '../log.ts';

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};
export type TelegramChat = { id: number; type: string };

/** Служебное сообщение о созданном или переименованном топике. */
export type TelegramForumTopicCreated = {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
};

/** Предел имени топика по документации Bot API: им же режем имя разговора. */
export const TOPIC_NAME_LIMIT = 128;

/** Фото: один и тот же кадр лестницей размеров, до последнего — сжатый JPEG. */
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

/** Голосовое: у Telegram это всегда OGG/Opus, поэтому mime можно и не спрашивать. */
export type TelegramVoice = {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
};

/**
 * Сообщение: текст и то, чем его заменяют (фото, голосовое, документ). У вложения
 * текст лежит не в `text`, а в подписи — `caption`.
 */
export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  /**
   * Топик, в котором сообщение. В личке с включённым Threaded Mode приходит у всего,
   * что написано внутри топика; у корня чата и у General-топика его может не быть
   * вовсе или он равен 1 — и то и другое значит «корень» (см. topicThreadId).
   */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** Служебное: человек (или бот) завёл топик — запоминаем имя и номер. */
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

/** Файл в хранилище Telegram: качать его — отдельным запросом по `file_path`. */
export type TelegramFile = { file_id: string; file_path?: string; file_size?: number };

export type TelegramUpdate = { update_id: number; message?: TelegramMessage };

/**
 * Отправленное сообщение: Telegram возвращает его же объектом, поэтому в ответе видно,
 * куда сообщение легло на самом деле. Проверять это нужно: в личке с топиками Telegram
 * умеет молча положить сообщение в общую ленту, подтвердив отправку (`ok: true`).
 */
export type SentMessage = {
  message_id: number;
  message_thread_id?: number | null;
  is_topic_message?: boolean;
};

/** Легло ли сообщение в тот топик, который просили (см. sendMessage). */
export function landedInThread(sent: SentMessage, asked: number): boolean {
  // Номер топика Telegram возвращает у сообщений в топике — он и есть ответ.
  if (typeof sent.message_thread_id === 'number') return sent.message_thread_id === asked;
  // Номера нет, но флаг топика есть: считаем, что доехало.
  return sent.is_topic_message === true;
}

/**
 * Режим разметки. Telegram сам markdown не разбирает: без `parse_mode` человек видит
 * звёздочки и решётки как есть. Нам нужен только HTML — разметку под него собирает
 * format.ts, а MarkdownV2 требует экранировать полтора десятка знаков.
 */
export type ParseMode = 'HTML';

/** Как отправлять текст: с разметкой или как есть. */
export type SendOptions = { parseMode?: ParseMode };

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Сколько ждём ответ Bot API, если вызов не сказал иного. */
export const TELEGRAM_TIMEOUT_MS = 30_000;
/** Предел Bot API на скачивание: файл больше 20 МБ он не отдаёт вовсе. */
export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;
/** Предел Bot API на отправку фотографии: больше — только документом. */
export const TELEGRAM_PHOTO_LIMIT = 10 * 1024 * 1024;
/** Предел Bot API на отправку документа (файла) любого вида. */
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;
/** Подпись под фото/файлом короче сообщения: больше Telegram не примет. */
export const CAPTION_LIMIT = 1024;
/** Отправка файла дольше текста: запас на то, чтобы 10 МБ уехали по сети. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** Файл, который едет в Telegram: байты плюс человеческое имя и тип. */
export type UploadFile = {
  bytes: Buffer;
  /** Имя для человека: по нему Telegram различает тип документа. */
  name: string;
  mimeType: string;
};

/** Подпись и место для файла: у вложения текст лежит в `caption`, а не в `text`. */
export type UploadOptions = {
  caption?: string;
  threadId?: number | null;
  parseMode?: ParseMode;
};

/** Файл не влезает в предел Bot API: отправлять не пробуем, говорим человеку. */
export class UploadTooBigError extends Error {
  /** Сколько мегабайт Telegram согласен принять этим методом. */
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

/** Ошибка Bot API: `{ok: false, error_code, description}`. */
export class TelegramError extends Error {
  readonly code: number;
  /** Через сколько секунд повторять (429): Telegram присылает это в parameters. */
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
  /** Подменяется в тестах: сеть там ни к чему. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Пауза перед повтором после 429: в тестах подменяется, чтобы не ждать. */
  sleep?: (ms: number) => Promise<void>;
};

type CallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Готовое тело multipart. Параметры в `params` тогда не уезжают: файл и поля
   * лежат в самой форме, а `content-type` с boundary fetch ставит сам.
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

    // 429 — это «слишком часто», а не поломка: Telegram сам говорит, сколько ждать.
    // Одна повторная попытка спасает финальную правку ответа, которую иначе потеряем.
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
          // Форма сама несёт boundary в content-type: свой заголовок её бы сломал.
          ...(options.multipart
            ? { body: options.multipart }
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
          signal,
        });
      } catch (error) {
        // Сеть и таймауты — не ответ Bot API: пусть решает вызывающий (опрос повторит).
        throw error instanceof Error ? error : new Error(String(error));
      }
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        // Не JSON: так отвечает прокси или балансировщик (HTML на 413), а не Bot API.
        // Статус при этом содержательный — отдаём его, а не «не разобрался ответ».
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

  /** `offset` подтверждает всё, что пришло раньше: повторно эти апдейты не приедут. */
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
        // Боту нужны только сообщения: остальные апдейты — не про разговор.
        allowed_updates: ['message'],
      },
      {
        signal: params.signal,
        // Длинный опрос живёт `timeout` секунд; запас — на дорогу и ответ.
        timeoutMs: (timeoutSeconds + 15) * 1000,
      },
    );
  }

  /**
   * Путь к вложению в хранилище Telegram. Ссылка на файл живёт час, поэтому
   * качаем сразу, а не откладываем.
   */
  getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId });
  }

  /**
   * Сам файл. Адрес другой, чем у методов Bot API (`/file/bot<токен>/<путь>`),
   * и в ответе байты, а не JSON, поэтому мимо `call`. Токен в пути — секрет:
   * в лог он не попадает (см. redact), а ошибки описываем без адреса.
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
   * Сообщение в чат или в топик. `message_thread_id` передаём только когда он есть:
   * в чате без топиков Telegram на это поле отвечает ошибкой.
   *
   * Про топики в личке Telegram умеет врать молча: отвечает `ok: true`, а сообщение
   * лежит в общей ленте (см. landedInThread) — поэтому сверяем ответ и пишем в лог.
   * А если топик отбит ошибкой «message thread not found», повторяем ответом на
   * сообщение из топика (`anchorMessageId`): якорь уводит ответ в тот же топик.
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
   * Фотография в чат: картинку Telegram показывает в пузыре и сжимает сам.
   * Предел — 10 МБ; всё, что больше, честнее отправить документом (см. outgoing.ts).
   */
  sendPhoto(chatId: number, file: UploadFile, options: UploadOptions = {}): Promise<SentMessage> {
    return this.upload('sendPhoto', 'photo', chatId, file, TELEGRAM_PHOTO_LIMIT, options);
  }

  /**
   * Документ в чат: файл как файл, с человеческим именем в шапке. Так уезжают
   * PDF, архивы, длинные картинки и анимированные GIF — Telegram их не пережимает.
   */
  sendDocument(chatId: number, file: UploadFile, options: UploadOptions = {}): Promise<SentMessage> {
    return this.upload('sendDocument', 'document', chatId, file, TELEGRAM_UPLOAD_LIMIT, options);
  }

  /**
   * Отправка файла: форма собирается здесь, а не у вызывающего, — иначе каждый
   * вызывающий повторял бы лимиты, подпись и проверку топика.
   */
  private async upload(
    method: 'sendPhoto' | 'sendDocument',
    field: 'photo' | 'document',
    chatId: number,
    file: UploadFile,
    limit: number,
    options: UploadOptions,
  ): Promise<SentMessage> {
    // Проверяем до сети: 10 МБ по HTTP — это долго, а отказ всё равно придёт.
    if (!file.name.trim()) throw new Error('у файла нет имени: Telegram не поймёт, что это');
    if (file.bytes.length === 0) throw new Error(`файл «${file.name}» пустой`);
    if (file.bytes.length > limit) throw new UploadTooBigError(file.name, file.bytes.length, limit);

    const form = new FormData();
    form.append('chat_id', String(chatId));
    // Buffer — это Uint8Array, но типы Blob ждут ArrayBuffer, а у Buffer он может
    // быть Shared: на деле байты ложатся в тело запроса как есть, без копии.
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

  /** Правка сообщения. «Не изменилось» — не ошибка: значит, показывать нечего. */
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

  /** Переименование топика: номер берётся из сообщения, имя — человеческое. */
  async editForumTopic(chatId: number, threadId: number, name: string): Promise<void> {
    await this.call('editForumTopic', {
      chat_id: chatId,
      message_thread_id: threadId,
      name: name.slice(0, TOPIC_NAME_LIMIT),
    });
  }

  /** Меню команд: что бот умеет, без похода в модель. */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  getMe(): Promise<TelegramUser & { is_bot?: boolean }> {
    return this.call('getMe', {});
  }
}

/** Поле `parse_mode` для Bot API: без режима Telegram покажет разметку как текст. */
function parseModeParam(options: SendOptions): Record<string, unknown> {
  return options.parseMode ? { parse_mode: options.parseMode } : {};
}

/** Короткий человеческий текст ошибки для логов: без токена в пути запроса. */
export function describeTelegramError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
