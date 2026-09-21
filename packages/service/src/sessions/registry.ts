// Реестр сессий: (пользователь, разговор) → живой процесс pi.
// Держит контейнеры тёплыми, гасит простаивающие сессии, защищает от параллельных ходов.
import { ensureContainerRunning } from '../docker/manager.ts';
import { log } from '../log.ts';
import { PiSession } from './pi-session.ts';
import { runOneShot, type OneShotOptions } from './one-shot.ts';
import type { IcarusConfig, ModelConfig, UserConfig } from '../config.ts';

export class SessionRegistry {
  private sessions = new Map<string, PiSession>();
  private readyContainers = new Set<string>();
  /** Поднятие контейнера в полёте: два одновременных запроса не должны создавать его дважды. */
  private ensuring = new Map<string, Promise<string>>();
  /**
   * Поколение «медленных» ресурсов человека: скиллы, персону и расширения pi читает
   * один раз при старте процесса. Синхронизация скиллов увеличивает поколение, и
   * следующая сессия человека поднимается заново — с новым каталогом.
   */
  private generations = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private config: IcarusConfig;

  constructor(config: IcarusConfig) {
    this.config = config;
    const intervalMs = Math.max(60_000, Math.round((config.sessionIdleMinutes * 60_000) / 4));
    this.timer = setInterval(() => void this.reapIdle(), intervalMs);
    this.timer.unref?.();
  }

  /** Текущее поколение ресурсов человека. */
  generation(userId: string): number {
    return this.generations.get(userId) ?? 0;
  }

  /**
   * Отмечает, что ресурсы человека поменялись. Живые сессии не трогаем: идущий ход
   * нужно доиграть, а следующая сессия этого разговора поднимется уже заново (см.
   * acquire). История при этом не теряется — она лежит в /workspace/.sessions.
   */
  bumpResources(userId: string): number {
    const next = this.generation(userId) + 1;
    this.generations.set(userId, next);
    return next;
  }

  private fastModel(): ModelConfig {
    return this.config.models.find((model) => model.tier === 'fast') ?? this.config.models[0];
  }

  private ensureUserContainer(user: UserConfig): Promise<string> {
    const pending = this.ensuring.get(user.id);
    if (pending) return pending;
    const promise = this.startUserContainer(user).finally(() => this.ensuring.delete(user.id));
    this.ensuring.set(user.id, promise);
    return promise;
  }

  private async startUserContainer(user: UserConfig): Promise<string> {
    if (this.readyContainers.has(user.id)) {
      const existing = [...this.sessions.values()].find((session) => session.user.id === user.id);
      if (existing) return existing.container;
    }
    const name = await ensureContainerRunning(this.config, user);
    this.readyContainers.add(user.id);
    return name;
  }

  /**
   * Разовый вопрос дешёвой модели в контейнере человека: тулов, сессии и персоны
   * тут нет. Заголовки разговоров — первый потребитель, но не единственный.
   */
  async oneShot(user: UserConfig, prompt: string, options: OneShotOptions = {}): Promise<string> {
    const container = await this.ensureUserContainer(user);
    return runOneShot(this.config, container, this.fastModel(), prompt, options);
  }

  /** Находит или поднимает сессию разговора. */
  async acquire(user: UserConfig, conversationId: string): Promise<PiSession> {
    const key = `${user.id}:${conversationId}`;
    const generation = this.generation(user.id);
    const existing = this.sessions.get(key);
    if (existing && existing.alive) {
      // Ход идёт — не рвём его: пусть доиграет на старом каталоге, а перезапуск
      // случится при следующем обращении к этому разговору.
      if (existing.generation === generation || existing.busy) {
        existing.lastUsed = Date.now();
        return existing;
      }
      log.info('сессия перезапускается: ресурсы человека обновились', {
        user: user.id,
        conversation: conversationId.slice(0, 8),
        from: existing.generation,
        to: generation,
      });
      existing.dispose();
      this.sessions.delete(key);
    }
    if (existing) this.sessions.delete(key);

    const container = await this.ensureUserContainer(user);
    const session = new PiSession(this.config, user, conversationId, this.fastModel(), container, generation);
    this.sessions.set(key, session);
    return session;
  }

  get(userId: string, conversationId: string): PiSession | undefined {
    return this.sessions.get(`${userId}:${conversationId}`);
  }

  /** Гасит сессии, к которым давно не обращались. Контейнеры остаются поднятыми. */
  async reapIdle(): Promise<string[]> {
    const deadline = Date.now() - this.config.sessionIdleMinutes * 60_000;
    const closed: string[] = [];
    for (const [key, session] of this.sessions) {
      if (session.busy || session.lastUsed > deadline) continue;
      session.dispose();
      this.sessions.delete(key);
      closed.push(key);
    }
    if (closed.length > 0) log.info('простаивающие сессии закрыты', { count: closed.length });
    return closed;
  }

  list(): Array<{ key: string; busy: boolean; turns: number; lastUsed: number }> {
    return [...this.sessions.values()].map((session) => ({
      key: session.key,
      busy: session.busy,
      turns: session.turns,
      lastUsed: session.lastUsed,
    }));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
