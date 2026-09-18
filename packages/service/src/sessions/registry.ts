// Реестр сессий: (пользователь, разговор) → живой процесс pi.
// Держит контейнеры поднятыми, гасит простаивающие сессии, защищает от параллельных ходов.
import { ensureContainer } from '../docker/manager.ts';
import { log } from '../log.ts';
import { PiSession } from './pi-session.ts';
import type { IcarusConfig, ModelConfig, UserConfig } from '../config.ts';

export class SessionRegistry {
  private sessions = new Map<string, PiSession>();
  private readyContainers = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private config: IcarusConfig;

  constructor(config: IcarusConfig) {
    this.config = config;
    const intervalMs = Math.max(60_000, Math.round((config.sessionIdleMinutes * 60_000) / 4));
    this.timer = setInterval(() => void this.reapIdle(), intervalMs);
    this.timer.unref?.();
  }

  private fastModel(user: UserConfig): ModelConfig {
    return user.models.find((model) => model.tier === 'fast') ?? user.models[0];
  }

  private async ensureUserContainer(user: UserConfig): Promise<string> {
    if (this.readyContainers.has(user.id)) {
      const existing = [...this.sessions.values()].find((session) => session.user.id === user.id);
      if (existing) return existing.container;
    }
    const { name } = await ensureContainer(this.config, user);
    this.readyContainers.add(user.id);
    return name;
  }

  /** Находит или поднимает сессию разговора. */
  async acquire(user: UserConfig, conversationId: string): Promise<PiSession> {
    const key = `${user.id}:${conversationId}`;
    const existing = this.sessions.get(key);
    if (existing && existing.alive) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) this.sessions.delete(key);

    const container = await this.ensureUserContainer(user);
    const session = new PiSession(this.config, user, conversationId, this.fastModel(user), container);
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
