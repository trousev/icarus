// Синхронизация скиллов: расписание, авторизация по людям и перезапуск сессий pi.
//
// Каталог скиллов читается pi один раз — на старте процесса. Сессии живые (до
// sessionIdleMinutes простоя), поэтому после изменения каталога их надо перезапустить,
// иначе новый скилл появится в промпте только к следующему разговору. Перезапуск
// безопасен: сессия pi лежит в /workspace/.sessions и поднимается по --session-id,
// то есть история разговора не теряется, а просто перечитывается новым процессом.
import { log } from '../log.ts';
import { userPaths, type IcarusConfig, type SkillsAuthConfig, type SkillsSyncConfig, type UserConfig } from '../config.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import { LibreChatSkillsClient, LibreChatApiError } from './librechat.ts';
import { syncSkillDirectory } from './sync.ts';

export type SkillsSyncHandle = { stop: () => void; runOnce: () => Promise<void> };

/**
 * Через сколько повторить неудавшийся проход. Сбой почти всегда временный (LibreChat
 * ещё не поднялся, перезапускается, сеть), а ждать полный интервал — это пять минут
 * без скиллов. Запросов это не размножает: проход — один запрос на человека.
 */
export const RETRY_AFTER_FAILURE_MS = 15_000;

/** `TypeError: fetch failed` без причины ничего не объясняет — достаём код из cause. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`;
  if (typeof cause === 'string' && cause) return `${error.message} (${cause})`;
  return error.message;
}

/** Личная привязка человека, если она есть; иначе общие ключи из skills.sync. */
export function authForUser(sync: SkillsSyncConfig, userId: string): SkillsAuthConfig | null {
  const account = sync.accounts.find((item) => item.user === userId);
  const source: SkillsAuthConfig = account ?? sync;
  const hasStatic = source.token !== undefined;
  const hasClient = source.tokenUrl !== undefined && source.clientId !== undefined && source.clientSecret !== undefined;
  return hasStatic || hasClient ? source : null;
}

export function startSkillsSync(config: IcarusConfig, registry: SessionRegistry): SkillsSyncHandle | null {
  const sync = config.skills.sync;
  if (!sync) return null;

  // Один клиент на человека: он держит кэш токена, поэтому переживает проходы опроса.
  // Идемпотентность — на стороне materializeSkills: она сравнивает набор с манифестом
  // и говорит, изменилось ли что-то на диске.
  const clients = new Map<string, LibreChatSkillsClient>();
  let inFlight = false;

  const clientFor = (user: UserConfig, auth: SkillsAuthConfig): LibreChatSkillsClient => {
    let client = clients.get(user.id);
    if (!client) {
      client = new LibreChatSkillsClient({
        url: sync.url,
        auth: { ...auth, ...(sync.audience === undefined ? {} : { audience: sync.audience }) },
      });
      clients.set(user.id, client);
      log.info('синхронизация скиллов подключена', {
        user: user.id,
        source: client.describe(),
        intervalSeconds: sync.intervalSeconds,
      });
    }
    return client;
  };

  const syncUser = async (user: UserConfig, auth: SkillsAuthConfig): Promise<void> => {
    const client = clientFor(user, auth);
    const paths = userPaths(config, user);
    // Обычный проход — один запрос за списком: тела перечитываются только у тех
    // скиллов, у которых поменялись version/updatedAt (см. needsFetch).
    const result = await syncSkillDirectory(paths.skills, client);

    if (!result.changed) {
      // Тела перечитали, а содержимое то же (правили только метаданные): на диск ничего
      // не пошло, сессии не трогаем. Пишем в debug — при разборе полезно видеть.
      if (result.fetched.length > 0) {
        log.debug('скиллы перечитаны, изменений нет', { user: user.id, fetched: result.fetched });
      }
      return;
    }
    log.info('скиллы обновлены', {
      user: user.id,
      skills: result.skills,
      fetched: result.fetched,
      written: result.written,
      removed: result.removed,
      skipped: result.skipped,
    });
    // Меняем поколение ресурсов: следующий acquire поднимет свежий pi, а идущий
    // сейчас ход не рвём — он доиграет на старом каталоге.
    registry.bumpResources(user.id);
  };

  /** Проход; `false` — у кого-то не получилось, повторим пораньше. */
  const runOnce = async (): Promise<boolean> => {
    if (inFlight) {
      log.debug('прошлый проход синхронизации ещё идёт — пропускаю');
      return false;
    }
    inFlight = true;
    let failures = 0;
    try {
      for (const user of config.users) {
        const auth = authForUser(sync, user.id);
        if (!auth) continue;
        try {
          await syncUser(user, auth);
        } catch (error) {
          failures += 1;
          if (error instanceof LibreChatApiError && error.status === 401) {
            log.warn('скиллы: LibreChat не принял машинный токен — проверь привязку Management API', {
              user: user.id,
              hint: 'на стенде привязка ставится ./script/librechat-skills-bind, в бою — clients в endpoints.agents.managementApi',
              error: error.message,
            });
          } else {
            log.warn('скиллы не синхронизировались', { user: user.id, error: describeError(error) });
          }
        }
      }
    } finally {
      inFlight = false;
    }
    return failures === 0;
  };

  // Свой таймер вместо setInterval: после сбоя повторяем пораньше. Иначе гонка на
  // старте стека (icarus поднялся раньше LibreChat) стоила бы целого интервала —
  // а он по умолчанию пять минут.
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce().then((ok) => schedule(ok ? sync.intervalSeconds * 1000 : RETRY_AFTER_FAILURE_MS));
    }, delayMs);
    timer.unref?.();
  };
  schedule(0);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runOnce: async () => {
      await runOnce();
    },
  };
}
