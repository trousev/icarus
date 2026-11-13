// Session registry: (user, conversation) → a live pi process.
// Keeps containers warm, shuts down idle sessions, protects against parallel turns.
import { randomUUID } from 'node:crypto';
import { ensureContainerRunning } from '../docker/manager.ts';
import { log, redact } from '../log.ts';
import {
  COMPACT_TIMEOUT_MS,
  PiSession,
  type ArtifactSession,
  type CompactResult,
  type PiCommand,
} from './pi-session.ts';
import {
  appendChatSession,
  artifactForConversation,
  ensureChat,
  findChatRecord,
  renameChat,
  sessionIdOf,
  workspaceForConversation,
} from './chats.ts';
import { sessionFileForId } from './files.ts';
import { channelForConversation } from './identity.ts';
import { runOneShot, type OneShotOptions } from './one-shot.ts';
import { inspectArtifact } from '../artifacts.ts';
import {
  DEFAULT_WORKSPACE,
  userPaths,
  type IcarusConfig,
  type ModelConfig,
  type UserConfig,
} from '../config.ts';
import { refreshUserMcpTokens } from '../mcp/refresh.ts';
import { prepareUser } from '../workspace.ts';

/** How the registry creates sessions and raises containers: in tests these are stubs. */
export type SessionFactory = (
  config: IcarusConfig,
  user: UserConfig,
  conversationId: string,
  model: ModelConfig,
  container: string,
  generation: number,
  workspace: string,
  artifact?: ArtifactSession,
) => PiSession;

export type RegistryDeps = {
  createSession?: SessionFactory;
  ensureContainer?: (config: IcarusConfig, user: UserConfig) => Promise<string>;
};

/** How compaction requested by the person ended (the /compact command). */
export type CompactOutcome =
  | CompactResult
  | { status: 'no-session' }
  | { status: 'busy' }
  | { status: 'failed'; error: string };

/** How the attempt to stop a turn ended (the /stop command). */
export type AbortOutcome =
  | { status: 'stopped' }
  | { status: 'idle' }
  | { status: 'no-session' }
  | { status: 'failed'; error: string };

/** How the new conversation ended (the /clear command). */
export type ClearOutcome =
  | { status: 'started' }
  | { status: 'empty' }
  | { status: 'busy' }
  | { status: 'failed'; error: string };

/** How renaming the conversation ended (the /rename command). */
export type RenameOutcome =
  | { status: 'renamed'; title: string }
  | { status: 'empty' }
  | { status: 'failed'; error: string };

/** What to tell the person about the conversation (the /stats command). */
export type StatsOutcome =
  | { status: 'ok'; stats: Record<string, unknown> }
  | { status: 'failed'; error: string };

/** What can be called in the conversation at all (the /skills command). */
export type CommandsOutcome =
  | { status: 'ok'; commands: PiCommand[] }
  | { status: 'failed'; error: string };

/** Waits for a promise no longer than the timeout: longer — let the one who asked decide. */
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

export class SessionRegistry {
  private sessions = new Map<string, PiSession>();
  private readyContainers = new Set<string>();
  /** Container raise in flight: two simultaneous requests must not create it twice. */
  private ensuring = new Map<string, Promise<string>>();
  /**
   * Generation of the person's "slow" resources: pi reads skills, the persona and extensions
   * once at process start. Skill synchronization increases the generation, and
   * the person's next session is raised anew — with the new catalog.
   */
  private generations = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  /** Cleanup in flight: compaction lasts minutes, and a second pass over the same sessions isn't needed. */
  private reaping = false;
  /**
   * Conversations that cleanup is currently compacting and closing. A turn that arrives at this
   * moment must wait for the end: otherwise it would get a session that is about to
   * be shut down — and the person would be left without an answer.
   */
  private closing = new Map<string, Promise<void>>();
  private config: IcarusConfig;
  private createSession: SessionFactory;
  private ensureContainer: (config: IcarusConfig, user: UserConfig) => Promise<string>;

  constructor(config: IcarusConfig, deps: RegistryDeps = {}) {
    this.config = config;
    this.createSession =
      deps.createSession ??
      ((userConfig, user, conversationId, model, container, generation, workspace, artifact) =>
        new PiSession(userConfig, user, conversationId, model, container, generation, undefined, workspace, artifact));
    this.ensureContainer = deps.ensureContainer ?? ensureContainerRunning;
    // We check for silence more often than it occurs: compaction should happen "after an hour",
    // not "some time later". Five minutes is the check ceiling, otherwise with an hour
    // of idleness the summary would be made a quarter of an hour late.
    const intervalMs = Math.max(60_000, Math.min(5 * 60_000, Math.round((config.sessionIdleMinutes * 60_000) / 4)));
    this.timer = setInterval(() => void this.reapIdle(), intervalMs);
    this.timer.unref?.();
  }

  /** The person's current resource generation. */
  generation(userId: string): number {
    return this.generations.get(userId) ?? 0;
  }

  /**
   * Marks that the person's resources changed. We don't touch live sessions: the current turn
   * must be played out, and the next session of this conversation will be raised anew (see
   * acquire). History isn't lost — it lies in /workspace/.icarus/sessions.
   */
  bumpResources(userId: string): number {
    const next = this.generation(userId) + 1;
    this.generations.set(userId, next);
    return next;
  }

  private fastModel(): ModelConfig {
    return this.config.models.find((model) => model.tier === 'fast') ?? this.config.models[0];
  }

  /** A model for work where quality matters: writing a skill, analyzing a conversation. */
  private strongModel(): ModelConfig {
    return this.config.models.find((model) => model.tier === 'strong') ?? this.fastModel();
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
   * A one-off question to a cheap model in the person's container: no tools, session or persona
   * here. Conversation titles are the first consumer, but not the only one:
   * the panel thus asks to write a skill, and there a higher tier is needed.
   */
  async oneShot(user: UserConfig, prompt: string, options: OneShotOptions & { tier?: 'fast' | 'strong' } = {}): Promise<string> {
    const container = await this.ensureUserContainer(user);
    const { tier, ...rest } = options;
    return runOneShot(this.config, container, tier === 'strong' ? this.strongModel() : this.fastModel(), prompt, rest);
  }

  /**
   * Artifact for a session: checks that it exists and that the person is allowed to change it.
   * Rights may have changed after the chat was created, so the check stands
   * on every session raise, not only on the "Chat" button.
   */
  private artifactSession(user: UserConfig, slug: string | undefined): ArtifactSession | undefined {
    if (!slug) return undefined;
    const artifact = inspectArtifact(this.config, slug, user.id);
    if (!artifact) throw new Error(`артефакт «${slug}» не найден`);
    if (!artifact.canWrite) throw new Error(`нет права менять артефакт «${slug}»`);
    return { slug: artifact.name, title: artifact.title, entry: artifact.entry, type: artifact.type };
  }

  /** Finds or raises a conversation session. */
  async acquire(
    user: UserConfig,
    conversationId: string,
    workspace?: string,
    artifact?: string,
  ): Promise<PiSession> {
    // The conversation remembers its workspace; the explicit argument is needed where the record isn't
    // created yet (a new panel chat) or is only about to be created.
    const target = workspace ?? workspaceForConversation(this.config, user, conversationId) ?? DEFAULT_WORKSPACE;
    // An artifact conversation works not in a workspace but in the artifact folder. We take the name
    // from the argument, and if it wasn't passed (a second entry into the same conversation) —
    // from the registry: otherwise a repeated turn would open pi in the wrong place.
    const artifactName =
      artifact ?? (workspace === undefined ? artifactForConversation(this.config, user, conversationId) : undefined);
    const artifactSession = this.artifactSession(user, artifactName);
    const key = `${user.id}:${conversationId}`;
    const generation = this.generation(user.id);

    // The conversation is being compacted and closed right now: we wait for the end (no longer than the
    // compaction call itself lives) and raise the session anew — now from the compacted history.
    const closing = this.closing.get(key);
    if (closing) await waitFor(closing, COMPACT_TIMEOUT_MS + 5_000);

    const existing = this.sessions.get(key);
    if (existing && existing.alive) {
      // The conversation moved to another workspace or another artifact — the old
      // process looked in the wrong place, it can't be continued in the new folder.
      if (existing.workspace !== target || existing.artifact?.slug !== artifactSession?.slug) {
        existing.dispose();
        this.sessions.delete(key);
      } else if (existing.generation === generation || existing.busy) {
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
    // OAuth tokens live an hour, while a session lives longer. We refresh them before pi
    // reads mcp.json: otherwise the very first server call would hit a 401, and the person
    // would have to fix it in the panel. A refresh error doesn't cancel the conversation:
    // the server simply won't get into the environment, and the panel will show the reason.
    try {
      await refreshUserMcpTokens(this.config, user);
      prepareUser(this.config, user);
    } catch (error) {
      log.warn('MCP: окружение перед сессией не обновилось', { user: user.id, error: String(error) });
    }
    const session = this.createSession(
      this.config,
      user,
      conversationId,
      this.fastModel(),
      container,
      generation,
      target,
      artifactSession,
    );
    this.sessions.set(key, session);
    // The conversation was raised — so it exists. The registry tracks all channels at once:
    // the panel shows Telegram and API next to web chats without scanning anything.
    try {
      ensureChat(
        this.config,
        user,
        conversationId,
        channelForConversation(conversationId),
        target,
        new Date(),
        artifactSession?.slug,
      );
    } catch (error) {
      // The registry is a panel convenience, not a condition of the conversation: its failure must not
      // leave the person without an answer.
      log.warn('не записался реестр разговоров', { user: user.id, error: String(error) });
    }
    return session;
  }

  get(userId: string, conversationId: string): PiSession | undefined {
    return this.sessions.get(`${userId}:${conversationId}`);
  }

  /**
   * Compaction requested by the person: the `/compact` command. pi does it via the `compact` RPC.
   * If the conversation went quiet and there's no process, we raise it: pi will open the same history and
   * compact it the same way as in a live conversation.
   */
  async compact(user: UserConfig, conversationId: string, customInstructions?: string): Promise<CompactOutcome> {
    const live = this.sessions.get(`${user.id}:${conversationId}`);
    if (live && (live.busy || live.compacting)) return { status: 'busy' };
    try {
      const session = await this.acquire(user, conversationId);
      if (session.busy || session.compacting) return { status: 'busy' };
      return await session.compact(customInstructions);
    } catch (error) {
      log.warn('сжатие по команде не вышло', { user: user.id, error: redact(String(error)) });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Interrupting a turn at the person's request: the `/stop` command. Works only with a live
   * busy session — if pi is already silent, there's nothing to interrupt, and that's not an error.
   */
  async abort(user: UserConfig, conversationId: string): Promise<AbortOutcome> {
    const session = this.sessions.get(`${user.id}:${conversationId}`);
    if (!session || !session.alive) return { status: 'no-session' };
    if (!session.busy && !session.compacting) return { status: 'idle' };
    const stopped = await session.abort();
    return stopped ? { status: 'stopped' } : { status: 'failed', error: 'pi не подтвердил прерывание' };
  }

  /**
   * Interrupt for a new message: the person wrote while Icarus was still working (in Telegram
   * nobody stops them from doing so). The difference from `/stop` is only who asked:
   * here it's the next message, and the interrupt waits until the turn actually stops,
   * so the new message doesn't squeeze into a busy session.
   */
  async interrupt(user: UserConfig, conversationId: string): Promise<AbortOutcome> {
    const session = this.sessions.get(`${user.id}:${conversationId}`);
    if (!session || !session.alive) return { status: 'no-session' };
    if (!session.busy && !session.compacting) return { status: 'idle' };
    const stopped = await session.interrupt();
    return stopped ? { status: 'stopped' } : { status: 'failed', error: 'pi не подтвердил прерывание' };
  }

  /**
   * Conversation numbers: tokens, money, used context. If needed we raise the session:
   * the conversation file is in place, pi will continue it — and the numbers will be the same
   * as the person saw before the quiet period.
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

  /** What can be called in the conversation: the person's skills, prompt templates, extension commands. */
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
   * A new conversation at the person's request: the `/clear` command. pi itself clears the context —
   * the `new_session` RPC starts a new session, and the conversation moves to its id. The file
   * of the previous session stays on disk, but the conversation no longer references it:
   * the history opens empty, and the next launch continues the new session.
   *
   * Memory has nothing to do with this: it lies in /workspace/.icarus/memory and `/clear` doesn't touch it.
   */
  async clear(user: UserConfig, conversationId: string): Promise<ClearOutcome> {
    const key = `${user.id}:${conversationId}`;
    const busy = (): boolean => {
      const live = this.sessions.get(key);
      return Boolean(live && (live.busy || live.compacting));
    };
    if (busy()) return { status: 'busy' };

    // Cleanup may have caught this conversation: it is compacting and closing it right now.
    const closing = this.closing.get(key);
    if (closing) await waitFor(closing, COMPACT_TIMEOUT_MS + 5_000);
    if (busy()) return { status: 'busy' };

    const session = this.sessions.get(key);
    if (session && session.alive) {
      try {
        await session.newSession();
        return { status: 'started' };
      } catch (error) {
        log.warn('pi не начал разговор заново', { user: user.id, error: redact(String(error)) });
        return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    }

    // There's no process — so there's nothing to clear in memory either. We move the conversation to a new
    // session: the next turn will raise pi from a clean slate. If there's no history anyway,
    // we don't invent anything.
    try {
      const chat = findChatRecord(this.config, user, conversationId);
      if (!chat) return { status: 'empty' };
      const file = sessionFileForId(userPaths(this.config, user).sessions, sessionIdOf(chat, user));
      if (!file) return { status: 'empty' };
      const sessionId = randomUUID();
      appendChatSession(this.config, user, conversationId, sessionId);
      log.info('разговор переведён на новую сессию', {
        user: user.id,
        conversation: conversationId.slice(0, 8),
        session: sessionId,
      });
      return { status: 'started' };
    } catch (error) {
      log.warn('не удалось начать разговор заново', { user: user.id, error: redact(String(error)) });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Renaming a conversation: the name lives in chats.json, so both the panel and
   * Telegram see it. After that the automatic title doesn't overwrite the conversation
   * (`isGenericTitle` no longer triggers) — the person chose the name.
   */
  async rename(user: UserConfig, conversationId: string, name: string): Promise<RenameOutcome> {
    // The name is shown in the list and in the header, and in Telegram the topic is limited to 128
    // characters: line breaks and trailing bits only get in the way there.
    const title = name.replace(/\s+/g, ' ').trim().slice(0, 128);
    if (!title) return { status: 'empty' };
    try {
      const workspace = workspaceForConversation(this.config, user, conversationId);
      ensureChat(this.config, user, conversationId, channelForConversation(conversationId), workspace);
      const chat = renameChat(this.config, user, conversationId, title);
      if (!chat) return { status: 'failed', error: 'разговор не найден' };
      return { status: 'renamed', title: chat.title };
    } catch (error) {
      log.warn('не удалось переименовать разговор', { user: user.id, error: redact(String(error)) });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Cleanup of quiet sessions: a conversation not returned to for `sessionIdleMinutes` is
   * considered finished — we make a summary (`compact`, the retelling stays in the session file)
   * and close the process. The next message will raise pi anew, now from the compacted history.
   *
   * While the person is talking, compaction is not allowed: we skip busy sessions.
   */
  async reapIdle(): Promise<string[]> {
    if (this.reaping) return [];
    this.reaping = true;
    const deadline = Date.now() - this.config.sessionIdleMinutes * 60_000;
    const closed: string[] = [];
    try {
      // A copy of the list: during session compaction the map may change (the person came back).
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

  /** Compacting and closing one quiet session: if compaction failed, we close it as is. */
  private async closeIdle(key: string, session: PiSession): Promise<void> {
    const closing = (async () => {
      try {
        const result = await session.compact();
        log.debug('итог разговора подведён', { key, status: result.status });
      } catch (error) {
        // History isn't lost: the session file is append-only, and pi will open it as is.
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

  /**
   * The person's conversations where a turn is going right now. The panel takes this as a snapshot on
   * load: the summary tells about changes, but only the registry knows what's already running.
   */
  busyConversations(userId: string): string[] {
    const busy: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.user.id !== userId) continue;
      if (session.busy || session.compacting) busy.push(session.conversationId);
    }
    return busy;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
