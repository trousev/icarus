// Клиент Telegram Bot API: длинный опрос апдейтов, отправка и правка сообщений.
//
// Bot API — обычный JSON по https, поэтому клиент маленький и без зависимостей.
// Всё, что нужно боту, — четыре метода; остальное (вебхук, TLS, очередь) Telegram
// берёт на себя: сервису не нужен ни домен, ни сертификат.
import { redact } from '../log.ts';

export type TelegramUser = { id: number; username?: string; first_name?: string };
export type TelegramChat = { id: number; type: string };

/** Сообщение: текст и то, чем его заменяют (фото, голосовое, документ). */
export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  photo?: unknown;
  document?: unknown;
  voice?: unknown;
  video?: unknown;
  audio?: unknown;
  sticker?: unknown;
};

export type TelegramUpdate = { update_id: number; message?: TelegramMessage };
export type SentMessage = { message_id: number };

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Сколько ждём ответ Bot API, если вызов не сказал иного. */
export const TELEGRAM_TIMEOUT_MS = 30_000;

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

  sendMessage(chatId: number, text: string): Promise<SentMessage> {
    return this.call<SentMessage>('sendMessage', { chat_id: chatId, text });
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

  async sendChatAction(chatId: number, action = 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action });
  }

  /** Меню команд: единственная команда бота — сжать разговор. */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  getMe(): Promise<TelegramUser & { is_bot?: boolean }> {
    return this.call('getMe', {});
  }
}

/** Короткий человеческий текст ошибки для логов: без токена в пути запроса. */
export function describeTelegramError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
