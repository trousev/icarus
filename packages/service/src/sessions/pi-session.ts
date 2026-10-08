// Одна живая сессия pi = один разговор в LibreChat.
// Процесс живёт внутри контейнера пользователя, общение — JSONL по stdio.
import { createHash } from 'node:crypto';
import { RpcClient, type RpcEvent } from './rpc-client.ts';
import { log } from '../log.ts';
import type { IcarusConfig, ModelConfig, UserConfig } from '../config.ts';

/** Детерминированный UUID из ключа разговора: pi ждёт валидный id сессии. */
export function sessionIdFor(userId: string, conversationId: string): string {
  const hex = createHash('sha1').update(`${userId}:${conversationId}`).digest('hex').slice(0, 32);
  const parts = [hex.slice(0, 8), hex.slice(8, 12), `5${hex.slice(13, 16)}`, `a${hex.slice(17, 20)}`, hex.slice(20, 32)];
  return parts.join('-');
}

export function piArgsFor(model: ModelConfig, sessionId: string): string[] {
  return [
    '--mode',
    'rpc',
    '--session-dir',
    '/workspace/.sessions',
    '--session-id',
    sessionId,
    '--model',
    `${model.provider}/${model.id}`,
    '--thinking',
    model.thinking ?? 'off',
  ];
}

/**
 * Сколько ждём сжатие. Это обычный вызов модели, но промпт у него — весь разговор,
 * поэтому таймаут щедрый: уборка памяти ходит в модель с тем же запасом в 10 минут.
 */
export const COMPACT_TIMEOUT_MS = 600_000;

/**
 * Итог сжатия. «Нечего сжимать» — не ошибка: у короткого разговора и у уже
 * сжатого контекста pi отвечает именно так.
 */
export type CompactResult =
  | { status: 'compacted'; tokensBefore: number; tokensAfter: number }
  | { status: 'nothing' };

/**
 * Что можно позвать в разговоре, кроме обычной реплики: скилл человека, промпт-шаблон
 * или команда расширения. Собирает их pi — свой список мы бы неизбежно разошёлся с ним.
 */
export type PiCommand = {
  name: string;
  description?: string;
  /** Откуда команда: extension, prompt или skill. */
  source?: string;
  /** Где лежит: user, project или path (у расширений не бывает). */
  location?: string;
};

export class PiSession {
  readonly key: string;
  readonly sessionId: string;
  readonly container: string;
  /**
   * Поколение ресурсов человека на момент запуска процесса (скиллы и всё остальное,
   * что pi читает один раз при старте). Реестр сверяет его со свежим: не совпало —
   * сессия пересоздаётся, иначе старый процесс о новом скилле просто не знает.
   */
  readonly generation: number;
  busy = false;
  lastUsed = Date.now();
  turns = 0;

  readonly user: UserConfig;
  readonly conversationId: string;
  private client: RpcClient;
  private listeners = new Set<(event: RpcEvent) => void>();
  private detach: () => void;
  /** Сжатие в полёте: пока оно идёт, ход в эту сессию пускать нельзя. */
  private compactingTask: Promise<void> | null = null;

  constructor(
    config: IcarusConfig,
    user: UserConfig,
    conversationId: string,
    model: ModelConfig,
    container: string,
    generation = 0,
  ) {
    this.user = user;
    this.conversationId = conversationId;
    this.key = `${user.id}:${conversationId}`;
    this.container = container;
    this.generation = generation;
    this.sessionId = sessionIdFor(user.id, conversationId);

    this.client = new RpcClient(config, container, piArgsFor(model, this.sessionId));
    this.detach = this.client.onEvent((event) => {
      // Во время сжатия сессия занята не ходом: `agent_settled` тут ни при чём,
      // иначе ход влез бы в сессию посреди переписывания контекста.
      if (event.type === 'agent_settled' && !this.compactingTask) this.busy = false;
      if (event.type === 'agent_end') this.turns += 1;
      this.lastUsed = Date.now();
      for (const listener of this.listeners) listener(event);
    });

    log.info('сессия создана', {
      user: user.id,
      conversation: conversationId.slice(0, 8),
      model: `${model.provider}/${model.id}`,
    });
  }

  get alive(): boolean {
    return this.client.alive;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Отправляет реплику. Ответ приходит событиями; ход завершает `agent_settled`. */
  async prompt(text: string, images: Array<{ data: string; mimeType: string }> = []): Promise<void> {
    this.busy = true;
    this.lastUsed = Date.now();
    const command: Record<string, unknown> = { type: 'prompt', message: text };
    if (images.length > 0) {
      command.images = images.map((image) => ({
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      }));
    }
    const response = await this.client.request(command, 60_000);
    if (response.success !== true) {
      this.busy = false;
      throw new Error(`pi отказался принять реплику: ${String(response.error ?? 'без причины')}`);
    }
  }

  /**
   * Идёт ли сжатие: реестр по этому обещанию решает, подождать или пустить ход.
   * Пока оно не завершилось, `busy` держится поднятым — вклиниться нельзя.
   */
  get compacting(): Promise<void> | null {
    return this.compactingTask;
  }

  /**
   * Сжатие контекста: pi пересказывает моделью старую часть разговора и дописывает
   * в сессию запись-пересказ — дальше в промпт едет пересказ и недавние реплики, а
   * не вся история. История при этом не теряется, файл сессии append-only.
   *
   * Долго: это обычный вызов модели, но промпт у него — весь разговор. Поэтому на
   * время сжатия сессия занята, и второй раз сжать её же нельзя.
   */
  async compact(customInstructions?: string): Promise<CompactResult> {
    if (this.compactingTask) throw new Error('сжатие уже идёт');
    const task = this.runCompact(customInstructions);
    // Хвост для ожидающих: своё падение они увидят сами, а `compacting` не должен
    // превращаться в необработанный reject, если на него никто не подписался.
    this.compactingTask = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      this.compactingTask = null;
    }
  }

  private async runCompact(customInstructions?: string): Promise<CompactResult> {
    this.busy = true;
    const command: Record<string, unknown> = { type: 'compact' };
    if (customInstructions) command.customInstructions = customInstructions;

    try {
      const response = await this.client.request(command, COMPACT_TIMEOUT_MS);
      if (response.success !== true) {
        const reason = String(response.error ?? '');
        // Короткий разговор и уже сжатый контекст — это не поломка.
        if (/nothing to compact|already compacted/i.test(reason)) return { status: 'nothing' };
        throw new Error(`pi отказался сжимать: ${reason || 'без причины'}`);
      }

      const data = (response.data ?? {}) as Record<string, unknown>;
      const tokensBefore = Number(data.tokensBefore ?? 0);
      const tokensAfter = Number(data.estimatedTokensAfter ?? 0);
      log.info('сессия сжата', {
        user: this.user.id,
        conversation: this.conversationId.slice(0, 8),
        tokensBefore,
        tokensAfter,
      });
      return { status: 'compacted', tokensBefore, tokensAfter };
    } finally {
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }

  /**
   * Прерывание хода: соединение с LibreChat оборвалось или человек попросил `/stop`.
   * Отвечает, подтвердил ли pi прерывание: молчаливое «наверное, остановился» тут
   * хуже ошибки — человек ждёт ответа и не знает, ждать ли ещё.
   */
  async abort(): Promise<boolean> {
    if (!this.client.alive) return false;
    try {
      await this.client.request({ type: 'abort' }, 20_000);
      log.info('ход прерван', { user: this.user.id, conversation: this.conversationId.slice(0, 8) });
      return true;
    } catch (error) {
      log.warn('прерывание не подтвердилось', { error: String(error) });
      return false;
    } finally {
      this.busy = false;
    }
  }

  async getMessages(): Promise<Array<Record<string, unknown>>> {
    const response = await this.client.request({ type: 'get_messages' }, 20_000);
    const data = response.data as { messages?: Array<Record<string, unknown>> } | undefined;
    return data?.messages ?? [];
  }

  async getStats(): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.client.request({ type: 'get_session_stats' }, 20_000);
      return (response.data as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Список команд разговора — скиллы, промпт-шаблоны, команды расширений. Спрашиваем
   * у pi, а не читаем каталоги сами: он один знает и про пакеты, и про доверие к проекту.
   */
  async getCommands(): Promise<PiCommand[]> {
    const response = await this.client.request({ type: 'get_commands' }, 20_000);
    const data = response.data as { commands?: PiCommand[] } | undefined;
    return (data?.commands ?? []).map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.source ? { source: command.source } : {}),
      ...(command.location ? { location: command.location } : {}),
    }));
  }

  dispose(): void {
    this.detach();
    this.listeners.clear();
    this.client.dispose();
    log.info('сессия закрыта', { user: this.user.id, conversation: this.conversationId.slice(0, 8) });
  }
}
