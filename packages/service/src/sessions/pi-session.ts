// One live pi session = one conversation in the chat.
// The process lives inside the user's container, communication is JSONL over stdio.
import { RpcClient, type RpcEvent, type Spawner } from './rpc-client.ts';
import { channelForConversation, sessionIdFor } from './identity.ts';
import { appendChatSession, findChatRecord, refreshChatTitle, sessionIdOf } from './chats.ts';
import { log } from '../log.ts';
import { SERVICE_NAME } from '../docker/compose.ts';
import { modelTierEnv } from '../docker/spec.ts';
import {
  CONTAINER_PATHS,
  containerWorkspace,
  DEFAULT_WORKSPACE,
  PRIVATE_WORKSPACE,
  type IcarusConfig,
  type ModelConfig,
  type UserConfig,
} from '../config.ts';

/** Re-export for those who still look for the session id next to PiSession. */
export { sessionIdFor };

/**
 * What remains of the extensions in private mode: the persona and everything that only reads.
 * The memory extractor and sweeper are not here — they write to memory in the background.
 */
const PRIVATE_EXTENSIONS = [
  'persona.ts',
  'clock.ts',
  'memory-index.ts',
  'control-panel.ts',
  'web-search.ts',
  'escalation.ts',
  'private-guard.ts',
];

/** Tools that can write. In a private workspace we do not expose them at all. */
const WRITE_TOOLS = 'write,edit,bash';

/**
 * The artifact that the conversation edits. A conversation about an artifact is a pi session not in a
 * workspace, but in the folder `/artifacts/<slug>`: only this way the model works in the
 * artifact's repository, and not somewhere nearby.
 */
export type ArtifactSession = {
  slug: string;
  title: string;
  entry: string;
  type: string;
};

export function piArgsFor(model: ModelConfig, sessionId: string, workspace: string = DEFAULT_WORKSPACE): string[] {
  const isPrivate = workspace === PRIVATE_WORKSPACE;
  return [
    '--mode',
    'rpc',
    '--session-dir',
    CONTAINER_PATHS.sessions,
    '--session-id',
    sessionId,
    '--model',
    `${model.provider}/${model.id}`,
    '--thinking',
    model.thinking ?? 'low',
    ...(isPrivate
      ? [
          '--no-extensions',
          ...PRIVATE_EXTENSIONS.flatMap((name) => ['-e', `${CONTAINER_PATHS.piAgent}/extensions/${name}`]),
          // Even if the extension fails to load, the model simply will not see the write tools.
          '--exclude-tools',
          WRITE_TOOLS,
        ]
      : []),
  ];
}

/**
 * How long we wait for compaction. This is a normal model call, but its prompt is the whole conversation,
 * so the timeout is generous: the memory sweeper goes to the model with the same 10-minute allowance.
 */
export const COMPACT_TIMEOUT_MS = 600_000;

/**
 * The result of compaction. "Nothing to compact" is not an error: for a short conversation and for
 * an already compacted context pi answers exactly that.
 */
export type CompactResult =
  | { status: 'compacted'; tokensBefore: number; tokensAfter: number }
  | { status: 'nothing' };

/**
 * What can be called in a conversation besides a normal utterance: the person's skill, a prompt template
 * or an extension command. pi collects them — our own list would inevitably diverge from it.
 */
export type PiCommand = {
  name: string;
  description?: string;
  /** Where the command comes from: extension, prompt or skill. */
  source?: string;
  /** Where it lies: user, project or path (extensions never have it). */
  location?: string;
};

export class PiSession {
  readonly key: string;
  /**
   * pi session id. Usually derived from the conversation, but after `/clear` pi starts a
   * new session with its own id — then it comes from `get_state` and is remembered
   * in chats.json, so the history and the next launch look for the right file.
   */
  sessionId: string;
  readonly container: string;
  /**
   * The generation of the person's resources at the time the process was launched (skills and everything else
   * that pi reads once at startup). The registry compares it with the fresh one: if they do not match —
   * the session is recreated, otherwise the old process simply does not know about the new skill.
   */
  readonly generation: number;
  busy = false;
  lastUsed = Date.now();
  turns = 0;

  readonly user: UserConfig;
  readonly conversationId: string;
  /** In which workspace the conversation runs: it is also the working directory of the pi process. */
  readonly workspace: string;
  /** The artifact, if the conversation is opened from the "Artifacts" section: it is the directory. */
  readonly artifact?: ArtifactSession;
  private config: IcarusConfig;
  private client: RpcClient;
  private listeners = new Set<(event: RpcEvent) => void>();
  private detach: () => void;
  /** Compaction in flight: while it runs, a turn must not be allowed into this session. */
  private compactingTask: Promise<void> | null = null;

  constructor(
    config: IcarusConfig,
    user: UserConfig,
    conversationId: string,
    model: ModelConfig,
    container: string,
    generation = 0,
    /** What to launch pi with: a stub in tests, docker exec in production (see RpcClient). */
    spawner?: Spawner,
    workspace: string = DEFAULT_WORKSPACE,
    artifact?: ArtifactSession,
  ) {
    this.user = user;
    this.conversationId = conversationId;
    this.config = config;
    this.workspace = workspace;
    this.artifact = artifact;
    this.key = `${user.id}:${conversationId}`;
    this.container = container;
    this.generation = generation;
    // The conversation may have already started over (`/clear`): then pi waits for the id of the last
    // session in the chain, not the one derived from conversationId.
    const record = findChatRecord(config, user, conversationId);
    this.sessionId = record ? sessionIdOf(record, user) : sessionIdFor(user.id, conversationId);

    // The channel is needed by the persona extension: in the web chat an image can be shown
    // with markdown, in Telegram it cannot, and there is no reason to teach the model extra things.
    const channel = channelForConversation(conversationId);
    this.client = new RpcClient(
      config,
      container,
      piArgsFor(model, this.sessionId, workspace),
      spawner,
      {
        ICARUS_CHANNEL: channel,
        // The search router lives in the service, and pi — in the container on the same
        // docker network: the compose service name resolves, no token needed.
        ICARUS_SEARCH_URL: `http://${SERVICE_NAME}:${config.port}`,
        ...modelTierEnv(config),
        // Keys from .env and panel settings: the container got them at creation, but
        // a key saved in the panel must reach the next conversation without
        // recreating the container. Here they override the container environment.
        ...(config.secretEnv ?? {}),
        ICARUS_WORKSPACE: workspace,
        // Artifact edit mode: the persona builds a separate prompt from these variables,
        // and the process works directly in the artifact folder, not in the workspace.
        ...(artifact
          ? {
              ICARUS_ARTIFACT: artifact.slug,
              ICARUS_ARTIFACT_TITLE: artifact.title,
              ICARUS_ARTIFACT_ENTRY: artifact.entry,
              ICARUS_ARTIFACT_TYPE: artifact.type,
            }
          : {}),
        ...(workspace === PRIVATE_WORKSPACE ? { ICARUS_PRIVATE: '1' } : {}),
      },
      artifact ? `${CONTAINER_PATHS.artifacts}/${artifact.slug}` : containerWorkspace(workspace),
    );
    this.detach = this.client.onEvent((event) => {
      // During compaction the session is busy not with a turn: `agent_settled` has nothing
      // to do with it, otherwise the turn would wedge into the session in the middle of rewriting the context.
      if (event.type === 'agent_settled' && !this.compactingTask) {
        this.busy = false;
        // For the web chat the title is set by finishChat from the text of the utterance. Telegram
        // and the API have no such place — we take a piece of the first utterance from the session file,
        // when the turn is already written, and do not delay the answer to the person.
        if (!this.conversationId.startsWith('web-')) {
          queueMicrotask(() => refreshChatTitle(this.config, this.user, this.conversationId));
        }
      }
      if (event.type === 'agent_end') this.turns += 1;
      this.lastUsed = Date.now();
      for (const listener of this.listeners) listener(event);
    });

    log.info('сессия создана', {
      user: user.id,
      conversation: conversationId,
      model: `${model.provider}/${model.id}`,
      ...(artifact ? { artifact: artifact.slug } : {}),
    });
  }

  get alive(): boolean {
    return this.client.alive;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends an utterance. The answer comes as events; the turn is completed by `agent_settled`. */
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
   * Is compaction running: the registry uses this promise to decide whether to wait or let a turn in.
   * While it has not finished, `busy` is kept raised — you cannot wedge in.
   */
  get compacting(): Promise<void> | null {
    return this.compactingTask;
  }

  /**
   * Context compaction: pi retells the old part of the conversation with the model and appends
   * a retelling record to the session — after that the prompt carries the retelling and recent utterances,
   * not the whole history. The history is not lost, the session file is append-only.
   *
   * It takes long: this is a normal model call, but its prompt is the whole conversation. Therefore during
   * compaction the session is busy, and it cannot be compacted a second time.
   */
  async compact(customInstructions?: string): Promise<CompactResult> {
    if (this.compactingTask) throw new Error('сжатие уже идёт');
    const task = this.runCompact(customInstructions);
    // Tail for the waiters: they will see their own failure themselves, and `compacting` must not
    // turn into an unhandled reject if nobody subscribed to it.
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

  /**
   * A new conversation inside the same session: pi starts a new session (`new_session`)
   * and begins with a clean context. The old file remains on disk, but the conversation
   * moves to a new id — that is what we remember in chats.json.
   */
  async newSession(): Promise<string> {
    const response = await this.client.request({ type: 'new_session' }, 30_000);
    if (response.success !== true) {
      throw new Error(`pi не начал разговор заново: ${String(response.error ?? 'без причины')}`);
    }
    // An extension may cancel the session switch (before_switch): then the id stayed
    // the same, and writing it as new would be a lie.
    if ((response.data as { cancelled?: unknown } | undefined)?.cancelled === true) {
      throw new Error('pi отменил начало нового разговора');
    }
    const state = await this.client.request({ type: 'get_state' }, 20_000);
    const data = (state.data ?? {}) as { sessionId?: unknown };
    const next = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (!next) throw new Error('pi не назвал id новой сессии');
    this.sessionId = next;
    try {
      appendChatSession(this.config, this.user, this.conversationId, next);
    } catch (error) {
      // The conversation has already been started over; not writing the id means losing the history on
      // the next launch. This is more important than "the command did not work", so we write to the log.
      log.warn('новая сессия не записалась', {
        user: this.user.id,
        conversation: this.conversationId,
        error: String(error),
      });
    }
    log.info('разговор начат заново через pi', {
      user: this.user.id,
      conversation: this.conversationId,
      session: next,
    });
    return next;
  }

  private async runCompact(customInstructions?: string): Promise<CompactResult> {
    this.busy = true;
    const command: Record<string, unknown> = { type: 'compact' };
    if (customInstructions) command.customInstructions = customInstructions;

    try {
      const response = await this.client.request(command, COMPACT_TIMEOUT_MS);
      if (response.success !== true) {
        const reason = String(response.error ?? '');
        // A short conversation and an already compacted context are not a breakage.
        if (/nothing to compact|already compacted/i.test(reason)) return { status: 'nothing' };
        throw new Error(`pi отказался сжимать: ${reason || 'без причины'}`);
      }

      const data = (response.data ?? {}) as Record<string, unknown>;
      const tokensBefore = Number(data.tokensBefore ?? 0);
      const tokensAfter = Number(data.estimatedTokensAfter ?? 0);
      log.info('сессия сжата', {
        user: this.user.id,
        conversation: this.conversationId,
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
   * Interrupting a turn: the connection to the client broke or the person asked for `/stop`.
   * It answers whether pi confirmed the interruption: a silent "probably stopped" is
   * worse than an error here — the person waits for an answer and does not know whether to wait more.
   */
  async abort(): Promise<boolean> {
    if (!this.client.alive) return false;
    try {
      await this.client.request({ type: 'abort' }, 20_000);
      log.info('ход прерван', { user: this.user.id, conversation: this.conversationId });
      return true;
    } catch (error) {
      log.warn('прерывание не подтвердилось', { error: String(error) });
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Interrupting a turn together with the queue: the person wrote something new while Icarus was working.
   *
   * `abort` in pi does not discard queued messages — it plays them out, so we clear
   * the queue before the interruption. And we wait for `agent_settled`, not just the answer to the
   * command: only by that moment has the turn really stopped, the tools (and subagent
   * children) are shut down, and the next utterance can be written to the session.
   */
  async interrupt(timeoutMs = 20_000): Promise<boolean> {
    if (!this.client.alive) return false;
    try {
      await this.client.request({ type: 'clear_queue' }, 5_000);
    } catch {
      // An old pi does not know such a command: we make do with what we have.
    }

    let off = (): void => {};
    const settled = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
      timer.unref?.();
      off = this.onEvent((event) => {
        if (event.type !== 'agent_settled') return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });

    try {
      await this.client.request({ type: 'abort' }, 20_000);
      this.busy = false;
      log.info('ход прерван новым сообщением', { user: this.user.id, conversation: this.conversationId });
      await settled;
      return true;
    } catch (error) {
      log.warn('прерывание не подтвердилось', { error: String(error) });
      this.busy = false;
      return false;
    } finally {
      off();
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
   * The list of conversation commands — skills, prompt templates, extension commands. We ask
   * pi, rather than reading the directories ourselves: it alone knows about packages and about project trust.
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
    log.info('сессия закрыта', { user: this.user.id, conversation: this.conversationId });
  }
}
