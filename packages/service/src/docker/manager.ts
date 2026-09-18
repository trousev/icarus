// Тонкая обёртка над docker CLI: контейнеры пользователей, exec, инспекция.
// Осознанно без dockerode — CLI уже проверен в M0 и не тянет зависимостей.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { log } from '../log.ts';
import { userContainer, type IcarusConfig, type UserConfig } from '../config.ts';
import { containerRunArgs } from '../workspace.ts';
import { LABEL_MANAGED, LABEL_SPEC, LABEL_USER, specFor } from './spec.ts';
import {
  describePlan,
  planReconciliation,
  type ManagedContainer,
  type ReconciliationPlan,
} from './reconcile.ts';

export type ContainerState = 'running' | 'stopped' | 'missing';

/**
 * Имя процесса pi внутри контейнера. Именно имя: pi переписывает себе cmdline
 * (в `/proc/<pid>/cmdline` остаётся одно слово), поэтому `pkill -f --mode rpc`
 * не находит ничего, а `pkill -x pi` — находит.
 */
const PI_PROCESS = 'pi';

function dockerEnv(config: IcarusConfig): NodeJS.ProcessEnv {
  // Если задан socket (например, docker-socket-proxy), CLI сам поймёт DOCKER_HOST.
  return config.docker.socket ? { ...process.env, DOCKER_HOST: config.docker.socket } : process.env;
}

export function runDocker(
  config: IcarusConfig,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { timeoutMs = 60_000 } = options;
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { env: dockerEnv(config), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: number }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

export async function containerState(
  config: IcarusConfig,
  user: UserConfig,
): Promise<ContainerState> {
  const name = userContainer(config, user);
  const inspect = await runDocker(config, ['inspect', '-f', '{{.State.Running}}', name]);
  if (inspect.code !== 0) return 'missing';
  return inspect.stdout.trim() === 'true' ? 'running' : 'stopped';
}

/** Метки контейнера: по ним видно, наш ли он и не устарел ли. */
export async function containerLabels(
  config: IcarusConfig,
  name: string,
): Promise<Record<string, string> | null> {
  const result = await runDocker(config, ['inspect', '-f', '{{json .Config.Labels}}', name]);
  if (result.code !== 0) return null;
  try {
    return (JSON.parse(result.stdout.trim() || '{}') ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Все контейнеры, которые создавал icarus: по метке и по имени (для старых, без меток). */
export async function listManaged(config: IcarusConfig): Promise<ManagedContainer[]> {
  const format = [
    '{{.Names}}',
    `{{.Label "${LABEL_USER}"}}`,
    `{{.Label "${LABEL_SPEC}"}}`,
    '{{.State}}',
  ].join('\t');

  const [byLabel, byName] = await Promise.all([
    runDocker(config, ['ps', '-a', '--filter', `label=${LABEL_MANAGED}=1`, '--format', format]),
    // Контейнеры, созданные до появления меток, иначе остались бы невидимыми
    runDocker(config, ['ps', '-a', '--filter', `name=^${config.docker.prefix}-`, '--format', format]),
  ]);

  if (byLabel.code !== 0) {
    log.warn('не удалось получить список управляемых контейнеров', { error: byLabel.stderr.trim() });
    return [];
  }

  const lines = new Set(
    [...byLabel.stdout.split('\n'), ...byName.stdout.split('\n')].filter((line) => line.trim() !== ''),
  );

  return [...lines].map((line) => {
    const [name = '', user = '', spec = '', state = ''] = line.split('\t');
    // Контейнер без метки пользователя опознаём по имени: иначе мы приняли бы живого
    // человека за выбывшего. Отпечатка у него нет — значит, он будет пересоздан.
    const prefix = `${config.docker.prefix}-`;
    const derivedUser = user || (name.startsWith(prefix) ? name.slice(prefix.length) : null);
    return { name, user: derivedUser, spec: spec || null, running: state === 'running' };
  });
}

export async function stopContainer(config: IcarusConfig, name: string): Promise<boolean> {
  const result = await runDocker(config, ['stop', name]);
  return result.code === 0;
}

export async function removeContainer(config: IcarusConfig, name: string): Promise<boolean> {
  const result = await runDocker(config, ['rm', '-f', name]);
  return result.code === 0;
}

/**
 * Приводит контейнеры в соответствие с конфигом: выбывших людей останавливает,
 * устаревшие удаляет, остальных поднимает — контейнеры должны быть тёплыми.
 */
export async function reconcileContainers(
  config: IcarusConfig,
  users: UserConfig[],
): Promise<ReconciliationPlan> {
  const containers = await listManaged(config);
  const plan = planReconciliation({ config, users, containers });

  for (const name of plan.stop) {
    await stopContainer(config, name);
    log.warn('контейнер выбывшего человека остановлен', { container: name });
  }
  for (const name of plan.recreate) {
    await removeContainer(config, name);
    log.info('контейнер устарел — пересоздаю', { container: name });
  }

  // Поднимаем всех, кто есть в конфиге: и остановленных, и только что удалённых.
  // Ради этого тёплого состояния мы и держим контейнеры постоянно запущенными.
  for (const user of users) {
    try {
      const { name } = await ensureContainer(config, user);
      // Сессий в этом процессе ещё нет, значит всё живое внутри контейнера — чужое.
      await reapStalePi(config, name);
    } catch (error) {
      log.error('контейнер не поднялся', { user: user.id, error: String(error) });
    }
  }

  log.info('реконсиляция контейнеров', { план: describePlan(plan) || 'всё на месте' });
  return plan;
}

/**
 * Гасит pi, пережившие прошлый запуск сервиса.
 *
 * Если icarus убили SIGKILL'ом (OOM, крэш, `docker kill`), клиент `docker exec` умирает,
 * а pi внутри контейнера продолжает жить — проверено: процессы висят минутами, каждый со
 * своим MCP-ребёнком. Следующий ход поднял бы второй pi на тот же `--session-id` и ту же
 * папку сессий. Зовём это только на старте, пока сессий в этом процессе ещё нет.
 *
 * Ловим по имени процесса, а не по аргументам: pi переписывает себе cmdline, и в
 * `/proc/<pid>/cmdline` остаётся одно слово `pi`.
 */
export async function reapStalePi(
  config: IcarusConfig,
  container: string,
  runner: typeof runDocker = runDocker,
): Promise<boolean> {
  let result: { code: number; stderr: string };
  try {
    result = await runner(config, ['exec', container, 'pkill', '-x', PI_PROCESS]);
  } catch (error) {
    log.warn('не удалось погасить осиротевшие pi', { container, error: String(error) });
    return false;
  }

  // pkill возвращает 1, когда никого не нашёл, — это обычный случай, а не ошибка.
  if (result.code === 0) {
    log.warn('погасил pi, пережившие прошлый запуск сервиса', { container });
    return true;
  }
  if (result.code !== 1) {
    log.warn('не удалось погасить осиротевшие pi', { container, code: result.code, error: result.stderr.trim() });
  }
  return false;
}

/** Контейнер пользователя: поднять, если его нет, он остановлен или устарел. */
export async function ensureContainer(
  config: IcarusConfig,
  user: UserConfig,
): Promise<{ name: string; state: ContainerState; started: boolean }> {
  const name = userContainer(config, user);
  const expected = specFor(config);
  let state = await containerState(config, user);

  if (state !== 'missing') {
    const labels = await containerLabels(config, name);
    const actual = labels?.[LABEL_SPEC] ?? null;
    if (actual !== expected) {
      // Образ пересобрали или поменялись маунты с окружением — иначе старый контейнер
      // молча продолжал бы работать на старом образе.
      log.info('контейнер устарел — пересоздаю', { container: name, было: actual, стало: expected });
      await removeContainer(config, name);
      state = 'missing';
    }
  }

  if (state === 'running') return { name, state, started: false };

  if (state === 'stopped') {
    const started = await runDocker(config, ['start', name]);
    if (started.code !== 0) throw new Error(`не удалось запустить ${name}: ${started.stderr.trim()}`);
    log.info('контейнер запущен', { container: name });
    return { name, state: 'running', started: true };
  }

  const created = await runDocker(config, containerRunArgs(config, user));
  if (created.code !== 0) throw new Error(`не удалось создать ${name}: ${created.stderr.trim()}`);
  log.info('контейнер создан', {
    container: name,
    image: config.docker.image,
    mounts: config.mounts.length,
    spec: expected,
  });
  return { name, state: 'running', started: true };
}

/** Запускает `docker exec -i` с проброшенным stdio — на этом стоит RPC-мост. */
export function spawnDockerExec(
  config: IcarusConfig,
  container: string,
  args: string[],
): ChildProcess {
  return spawn('docker', ['exec', '-i', container, ...args], {
    env: dockerEnv(config),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Разовая команда в контейнере: stdin закрыт, рабочая папка — /workspace,
 * наружу идёт только stdout. Для вызовов, которым не нужен ни диалог, ни сессия.
 */
export function spawnDockerOnce(
  config: IcarusConfig,
  container: string,
  args: string[],
  workdir = '/workspace',
): ChildProcess {
  return spawn('docker', ['exec', '-w', workdir, container, ...args], {
    env: dockerEnv(config),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
