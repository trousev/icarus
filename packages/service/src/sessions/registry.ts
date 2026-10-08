// Реестр сессий: (пользователь, разговор) → живой процесс pi.
// Держит контейнеры тёплыми, гасит простаивающие сессии, защищает от параллельных ходов.
import fs from 'node:fs';
import path from 'node:path';
import { ensureContainerRunning } from '../docker/manager.ts';
import { log, redact } from '../log.ts';
import { COMPACT_TIMEOUT_MS, PiSession, sessionIdFor, type CompactResult, type PiCommand } from './pi-session.ts';
import { runOneShot, type OneShotOptions } from './one-shot.ts';
import { userPaths, type IcarusConfig, type ModelConfig, type UserConfig } from '../config.ts';

/** Как реестр создаёт сессии и поднимает контейнеры: в тестах это заглушки. */
export type SessionFactory = (
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  model: ModelConfig,
  container: string,
  generation: number,
) => PiSession;

export type RegistryDeps = {
  createSession?: SessionFactory;
  ensureContainer?: (config: IcarusConfig, user: UserConfig) => Promise<string>;
};

/** Чем кончилось сжатие по просьбе человека (команда /compact). */
export type CompactOutcome =
  | CompactResult
  | { status: 'no-session' }
  | { status: 'busy' }
  | { status: 'failed'; error: string };

/** Чем кончилась попытка остановить ход (команда /stop). */
export type AbortOutcome =
  | { status: 'stopped' }
  | { status: 'idle' }
  | { status: 'no-session' }
  | { status: 'failed'; error: string };

/** Чем кончился новый разговор (команда /clear). */
export type ClearOutcome =
  | { status: 'started' }
  | { status: 'empty' }
  | { status: 'busy' }
  | { status: 'failed'; error: string };

/** Что рассказать человеку про разговор (команда /stats). */
export type StatsOutcome =
  | { status: 'ok'; stats: Record<string, unknown> }
  | { status: 'failed'; error: string };

/** Что вообще можно позвать в разговоре (команда /skills). */
export type CommandsOutcome =
  | { status: 'ok'; commands: PiCommand[] }
  | { status: 'failed'; error: string };

/** Ждёт обещание не дольше таймаута: дольше — пусть решает тот, кто просил. */
async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Убирает файлы разговора в `archive/` рядом. pi ищет сессию по id среди файлов
 * каталога (`<когда создан>_<id>.jsonl`), поэтому переименование в подкаталог для
 * него значит «такого разговора нет» — и следующий ход начинается с чистого листа.
 * Историю не удаляем: человек всегда может попросить поднять её из архива.
 */
async function archiveSessionFiles(dir: string, sessionId: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    // Разговора ещё не было — каталога сессий может не быть вовсе.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  const mine = names.filter((name) => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`));
  if (mine.length === 0) return 0;

  const archive = path.join(dir, 'archive');
  await fs.promises.mkdir(archive, { recursive: true });
  for (const name of mine) {
    await fs.promises.rename(path.join(dir, name), path.join(archive, name));
  }
  return mine.length;
}

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
  /** Уборка в полёте: сжатие длится минутами, и второй проход по тем же сессиям не нужен. */
  private reaping = false;
  /**
   * Разговоры, которые уборка сейчас сжимает и закрывает. Ход, пришедший в этот
   * момент, обязан дождаться конца: иначе он получил бы сессию, которую вот-вот
   * погасят, — и человек остался бы без ответа.
   */
  private closing = new Map<string, Promise<void>>();
  private config: IcarusConfig;
  private createSession: SessionFactory;
  private ensureContainer: (config: IcarusConfig, user: UserConfig) => Promise<string>;

  constructor(config: IcarusConfig, deps: RegistryDeps = {}) {
    this.config = config;
    this.createSession =
      deps.createSession ??
      ((userConfig, user, conversationId, model, container, generation) =>
        new PiSession(userConfig, user, conversationId, model, container, generation));
    this.ensureContainer = deps.ensureContainer ?? ensureContainerRunning;
    // Тишину проверяем чаще, чем она наступает: сжатие должно случиться «после часа»,
    // а не «когда-нибудь потом». Пять минут — потолок проверки, иначе при часе
    // простоя итог подводился бы с опозданием на четверть часа.
    const intervalMs = Math.max(60_000, Math.min(5 * 60_000, Math.round((config.sessionIdleMinutes * 60_000) / 4)));
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
    const name = await this.ensureContainer(this.config, user);
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

    // Разговор как раз сжимают и закрывают: ждём конца (не дольше, чем живёт сам
    // вызов сжатия) и поднимаем сессию заново — уже по сжатой истории.
    const closing = this.closing.get(key);
    if (closing) await waitFor(closing, COMPACT_TIMEOUT_MS + 5_000);

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
        conversation: conversationId,
        from: existing.generation,
        to: generation,
      });
      existing.dispose();
      this.sessions.delete(key);
    }
    if (existing) this.sessions.delete(key);

    const container = await this.ensureUserContainer(user);
    const session = this.createSession(this.config, user, conversationId, this.fastModel(), container, generation);
    this.sessions.set(key, session);
    return session;
  }

  get(userId: string, conversationId: string): PiSession | undefined {
    return this.sessions.get(`${userId}:${conversationId}`);
  }

  /**
   * Сжатие по просьбе человека: команда `/compact`. Работает только с живой сессией —
   * если разговор уже затих и был сжат уборкой, сжимать нечего, и следующая реплика
   * просто поднимет pi по сжатой истории.
   */
  async compact(user: UserConfig, conversationId: string, customInstructions?: string): Promise<CompactOutcome> {
    const session = this.sessions.get(`${user.id}:${conversationId}`);
    if (!session || !session.alive) return { status: 'no-session' };
    if (session.busy || session.compacting) return { status: 'busy' };
    try {
      return await session.compact(customInstructions);
    } catch (error) {
      log.warn('сжатие по команде не вышло', { user: user.id, error: redact(String(error)) });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Прерывание хода по просьбе человека: команда `/stop`. Работает только с живой
   * занятой сессией — если pi уже молчит, прерывать нечего, и это не ошибка.
   */
  async abort(user: UserConfig, conversationId: string): Promise<AbortOutcome> {
    const session = this.sessions.get(`${user.id}:${conversationId}`);
    if (!session || !session.alive) return { status: 'no-session' };
    if (!session.busy && !session.compacting) return { status: 'idle' };
    const stopped = await session.abort();
    return stopped ? { status: 'stopped' } : { status: 'failed', error: 'pi не подтвердил прерывание' };
  }

  /**
   * Цифры разговора: токены, деньги, занятый контекст. Сессию при необходимости
   * поднимаем: файл разговора на месте, pi продолжит его — и цифры будут те же,
   * что человек видел до затишья.
   */
  async stats(user: UserConfig, conversationId: string): Promise<StatsOutcome> {
    try {
      const session = await this.acquire(user, conversationId);
      const stats = await session.getStats();
      if (!stats) return { status: 'failed', error: 'pi не рассказал про разговор' };
      return { status: 'ok', stats };
    } catch (error) {
      log.warn('не удалось спросить у pi статистику', { user: user.id, error: redact(String(error)) });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Что можно позвать в разговоре: скиллы человека, промпт-шаблоны, команды расширений. */
  async commands(user: UserConfig, conversationId: string): Promise<CommandsOutcome> {
    try {
      const session = await this.acquire(user, conversationId);
      return { status: 'ok', commands: await session.getCommands() };
    } catch (error) {
      log.warn('не удалось спросить у pi список команд', { user: user.id, error: redact(String(error)) });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Новый разговор по просьбе человека: команда `/clear`. Идентификатор разговора
   * выводится из человека и чата и не меняется, поэтому «начать заново» — это убрать
   * файл сессии в архив: без этого pi открыл бы прошлую историю. Живой процесс гасим:
   * он держит разговор в памяти и всё равно дописывал бы старый файл.
   *
   * Память тут ни при чём: она лежит в /workspace/memory и `/clear` её не трогает.
   */
  async clear(user: UserConfig, conversationId: string): Promise<ClearOutcome> {
    const key = `${user.id}:${conversationId}`;
    const busy = (): boolean => {
      const live = this.sessions.get(key);
      return Boolean(live && (live.busy || live.compacting));
    };
    if (busy()) return { status: 'busy' };

    // Уборка могла застать этот разговор: она сжимает и закрывает его прямо сейчас.
    const closing = this.closing.get(key);
    if (closing) await waitFor(closing, COMPACT_TIMEOUT_MS + 5_000);
    if (busy()) return { status: 'busy' };

    const session = this.sessions.get(key);
    if (session) {
      session.dispose();
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    }

    try {
      const archived = await archiveSessionFiles(userPaths(this.config, user).sessions, sessionIdFor(user.id, conversationId));
      log.info('разговор начат заново', {
        user: user.id,
        conversation: conversationId.slice(0, 8),
        archived,
      });
      return archived > 0 ? { status: 'started' } : { status: 'empty' };
    } catch (error) {
      log.warn('не удалось убрать прошлый разговор в архив', { user: user.id, error: redact(String(error)) });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Уборка затихших сессий: разговор, к которому не возвращались `sessionIdleMinutes`,
   * считаем законченным — подводим итог (`compact`, пересказ остаётся в файле сессии)
   * и закрываем процесс. Следующая реплика поднимет pi заново, уже по сжатой истории.
   *
   * Пока человек говорит, сжимать нельзя: занятые сессии пропускаем.
   */
  async reapIdle(): Promise<string[]> {
    if (this.reaping) return [];
    this.reaping = true;
    const deadline = Date.now() - this.config.sessionIdleMinutes * 60_000;
    const closed: string[] = [];
    try {
      // Копия списка: во время сжатия сессий карта может поменяться (человек вернулся).
      for (const [key, session] of [...this.sessions]) {
        if (this.sessions.get(key) !== session) continue;
        if (session.busy || session.compacting || session.lastUsed > deadline) continue;
        await this.closeIdle(key, session);
        closed.push(key);
      }
    } finally {
      this.reaping = false;
    }
    if (closed.length > 0) log.info('затихшие сессии сжаты и закрыты', { count: closed.length });
    return closed;
  }

  /** Сжатие и закрытие одной затихшей сессии: не вышло сжатие — закрываем как есть. */
  private async closeIdle(key: string, session: PiSession): Promise<void> {
    const closing = (async () => {
      try {
        const result = await session.compact();
        log.debug('итог разговора подведён', { key, status: result.status });
      } catch (error) {
        // История не теряется: файл сессии append-only, и pi откроет её как есть.
        log.warn('не удалось сжать затихшую сессию — закрываю без пересказа', {
          key,
          error: redact(String(error)),
        });
      }
      session.dispose();
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    })();

    this.closing.set(key, closing);
    try {
      await closing;
    } finally {
      if (this.closing.get(key) === closing) this.closing.delete(key);
    }
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
