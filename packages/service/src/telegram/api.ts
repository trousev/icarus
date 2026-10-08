// Клиент Telegram Bot API: длинный опрос апдейтов, отправка и правка сообщений.
//
// Bot API — обычный JSON по https, поэтому клиент маленький и без зависимостей.
// Всё, что нужно боту, — четыре метода; остальное (вебхук, TLS, очередь) Telegram
// берёт на себя: сервису не нужен ни домен, ни сертификат.
import { redact } from '../log.ts';

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  /**
   * Топики в личке: два флага из getMe. Первый — режим включён владельцем бота
   * (BotFather → Bot Settings → Threads Settings → Threaded Mode), второй — можно ли
   * заводить топики человеку. Без первого createForumTopic отвечает «the chat is not
   * a forum», поэтому спрашиваем до, а не после.
   */
  has_topics_enabled?: boolean;
  allows_users_to_create_topics?: boolean;
};
export type TelegramChat = { id: number; type: string };

/** Топик: то, что нужно знать боту, — номер и имя. Цвет и эмодзи необязательны. */
export type ForumTopic = {
  message_thread_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
};

/** Служебное сообщение о созданном топике: по нему узнаём топики, заведённые человеком. */
export type TelegramForumTopicCreated = {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
  /**
   * Имя не задавали руками: Telegram подставил «New Topic», и его стоит переписать
   * осмысленным (так и написано в описании поля).
   */
  is_name_implicit?: boolean;
};

/** Цвета иконок топика: список из шести — исчерпывающий, других Bot API не принимает. */
export const TOPIC_ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047] as const;

/** Предел имени топика по документации Bot API. */
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
export type SentMessage = { message_id: number };

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Сколько ждём ответ Bot API, если вызов не сказал иного. */
export const TELEGRAM_TIMEOUT_MS = 30_000;
/** Предел Bot API на скачивание: файл больше 20 МБ он не отдаёт вовсе. */
export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;

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

type CallOptions = { signal?: AbortSignal; timeoutMs?: number };

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
      try {
        const response = await this.request(`${this.baseUrl}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal,
        });
        payload = (await response.json()) as typeof payload;
      } catch (error) {
        // Сеть и таймауты — не ответ Bot API: пусть решает вызывающий (опрос повторит).
        throw error instanceof Error ? error : new Error(String(error));
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
   */
  sendMessage(chatId: number, text: string, threadId?: number | null): Promise<SentMessage> {
    return this.call<SentMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }

  /** Правка сообщения. «Не изменилось» — не ошибка: значит, показывать нечего. */
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text });
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

  /**
   * Заводит топик в личке (для супергруппы нужны права админа с can_manage_topics).
   * Без включённого Threaded Mode отвечает 400 «the chat is not a forum» — поэтому
   * перед вызовом смотрим has_topics_enabled из getMe.
   */
  createForumTopic(chatId: number, name: string, iconColor?: number): Promise<ForumTopic> {
    return this.call<ForumTopic>('createForumTopic', {
      chat_id: chatId,
      name: name.slice(0, TOPIC_NAME_LIMIT),
      icon_color: iconColor ?? topicIconColor(name),
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

  /** Меню команд: сжать разговор и завести новый топик. */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  getMe(): Promise<TelegramUser & { is_bot?: boolean }> {
    return this.call('getMe', {});
  }
}

/**
 * Цвет иконки топика по имени: Telegram принимает ровно шесть значений, а выбор
 * делаем детерминированным — один и тот же разговор всегда одного цвета.
 */
export function topicIconColor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  return TOPIC_ICON_COLORS[hash % TOPIC_ICON_COLORS.length];
}

/** Короткий человеческий текст ошибки для логов: без токена в пути запроса. */
export function describeTelegramError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
