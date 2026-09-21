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
      if (event.type === 'agent_settled') this.busy = false;
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

  /** Прерывание: соединение с LibreChat оборвалось. */
  async abort(): Promise<void> {
    if (!this.client.alive) return;
    try {
      await this.client.request({ type: 'abort' }, 20_000);
      log.info('ход прерван', { user: this.user.id, conversation: this.conversationId.slice(0, 8) });
    } catch (error) {
      log.warn('прерывание не подтвердилось', { error: String(error) });
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

  dispose(): void {
    this.detach();
    this.listeners.clear();
    this.client.dispose();
    log.info('сессия закрыта', { user: this.user.id, conversation: this.conversationId.slice(0, 8) });
  }
}
