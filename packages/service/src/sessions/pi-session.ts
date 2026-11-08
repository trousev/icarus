// Одна живая сессия pi = один разговор в чате.
// Процесс живёт внутри контейнера пользователя, общение — JSONL по stdio.
import { RpcClient, type RpcEvent, type Spawner } from './rpc-client.ts';
import { channelForConversation, sessionIdFor } from './identity.ts';
import { refreshChatTitle } from './chats.ts';
import { log } from '../log.ts';
import { SERVICE_NAME } from '../docker/compose.ts';
import {
  CONTAINER_PATHS,
  containerWorkspace,
  DEFAULT_WORKSPACE,
  PRIVATE_WORKSPACE,
  type IcarusConfig,
  type ModelConfig,
  type UserConfig,
} from '../config.ts';

/** Реэкспорт для тех, кто по-прежнему ищет id сессии рядом с PiSession. */
export { sessionIdFor };

/**
 * Что остаётся от расширений в приватном режиме: персона и всё, что только читает.
 * Экстрактор и уборщик памяти сюда не входят — они пишут в память фоном.
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

/** Инструменты, которыми можно писать. В приватном workspace их не выдаём вовсе. */
const WRITE_TOOLS = 'write,edit,bash';

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
    model.thinking ?? 'off',
    ...(isPrivate
      ? [
          '--no-extensions',
          ...PRIVATE_EXTENSIONS.flatMap((name) => ['-e', `${CONTAINER_PATHS.piAgent}/extensions/${name}`]),
          // Даже если расширение не загрузится, тулы записи модель просто не увидит.
          '--exclude-tools',
          WRITE_TOOLS,
        ]
      : []),
  ];
}

/**
 * Модели по уровням — в окружение контейнера: расширение субагентов берёт оттуда
 * подсказку, какой моделью вести ребёнка. Уровни живут в конфиге, и дублировать их
 * в env вручную незачем: здесь они всегда совпадают с тем, что раздаёт эскалация.
 */
export function modelEnv(config: IcarusConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const pick = (tier: 'fast' | 'strong'): string | null => {
    const model = config.models.find((item) => item.tier === tier);
    return model ? `${model.provider}/${model.id}` : null;
  };
  const fast = pick('fast');
  if (fast) env.ICARUS_MODEL_FAST = fast;
  const strong = pick('strong');
  if (strong) env.ICARUS_MODEL_STRONG = strong;
  return env;
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
  /** В каком workspace'е идёт разговор: он же рабочий каталог процесса pi. */
  readonly workspace: string;
  private config: IcarusConfig;
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
    /** Чем запускать pi: в тестах — заглушкой, в бою — docker exec (см. RpcClient). */
    spawner?: Spawner,
    workspace: string = DEFAULT_WORKSPACE,
  ) {
    this.user = user;
    this.conversationId = conversationId;
    this.config = config;
    this.workspace = workspace;
    this.key = `${user.id}:${conversationId}`;
    this.container = container;
    this.generation = generation;
    this.sessionId = sessionIdFor(user.id, conversationId);

    // Канал нужен расширению-персоне: в веб-чате можно показать картинку
    // markdown-ом, в Telegram — нельзя, и учить модель лишнему незачем.
    const channel = channelForConversation(conversationId);
    this.client = new RpcClient(
      config,
      container,
      piArgsFor(model, this.sessionId, workspace),
      spawner,
      {
        ICARUS_CHANNEL: channel,
        // Поисковый роутер живёт в сервисе, а pi — в контейнере на той же
        // docker-сети: имя compose-сервиса резолвится, токен не нужен.
        ICARUS_SEARCH_URL: `http://${SERVICE_NAME}:${config.port}`,
        ...modelEnv(config),
        // Ключи из .env и настроек панели: контейнер получил их при создании, но
        // сохранённый в панели ключ должен доехать до следующего разговора без
        // пересоздания контейнера. Здесь они перекрывают окружение контейнера.
        ...(config.secretEnv ?? {}),
        ICARUS_WORKSPACE: workspace,
        ...(workspace === PRIVATE_WORKSPACE ? { ICARUS_PRIVATE: '1' } : {}),
      },
      containerWorkspace(workspace),
    );
    this.detach = this.client.onEvent((event) => {
      // Во время сжатия сессия занята не ходом: `agent_settled` тут ни при чём,
      // иначе ход влез бы в сессию посреди переписывания контекста.
      if (event.type === 'agent_settled' && !this.compactingTask) {
        this.busy = false;
        // У веб-чата заголовок ставит finishChat по тексту реплики. У Telegram
        // и API такого места нет — берём кусок первой реплики из файла сессии,
        // когда ход уже дописан, и не задерживаем ответ человеку.
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
   * Прерывание хода: соединение с клиентом оборвалось или человек попросил `/stop`.
   * Отвечает, подтвердил ли pi прерывание: молчаливое «наверное, остановился» тут
   * хуже ошибки — человек ждёт ответа и не знает, ждать ли ещё.
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
   * Прерывание хода вместе с очередью: человек написал новое, пока Икар работал.
   *
   * `abort` в pi не выбрасывает отложенные сообщения — он их доигрывает, поэтому
   * очередь чистим до прерывания. И ждём `agent_settled`, а не просто ответ на
   * команду: только к этому моменту ход действительно встал, инструменты (и дети
   * субагентов) погашены, и в сессию можно писать следующую реплику.
   */
  async interrupt(timeoutMs = 20_000): Promise<boolean> {
    if (!this.client.alive) return false;
    try {
      await this.client.request({ type: 'clear_queue' }, 5_000);
    } catch {
      // Старый pi такой команды не знает: обойдёмся тем, что есть.
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
    log.info('сессия закрыта', { user: this.user.id, conversation: this.conversationId });
  }
}
