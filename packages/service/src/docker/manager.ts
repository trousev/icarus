// Тонкая обёртка над docker CLI: контейнеры пользователей, exec, инспекция.
// Осознанно без dockerode — CLI уже проверен в M0 и не тянет зависимостей.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { log } from '../log.ts';
import { userContainer, type IcarusConfig, type UserConfig } from '../config.ts';
import { containerRunArgs } from '../workspace.ts';

export type ContainerState = 'running' | 'stopped' | 'missing';

function dockerEnv(config: IcarusConfig): NodeJS.ProcessEnv {
  // Если задан socket (например, docker-socket-proxy), CLI сам поймёт DOCKER_HOST.
  return config.docker.socket ? { ...process.env, DOCKER_HOST: config.docker.socket } : process.env;
}

export function runDocker(
  args: string[],
  options: { config: IcarusConfig; input?: string; timeoutMs?: number } = {} as never,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { config, input, timeoutMs = 60_000 } = options;
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      args,
      { env: dockerEnv(config), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof (error as { code?: number }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export async function containerState(config: IcarusConfig, user: UserConfig): Promise<ContainerState> {
  const name = userContainer(config, user);
  const inspect = await runDocker(['inspect', '-f', '{{.State.Running}}', name], { config });
  if (inspect.code !== 0) return 'missing';
  return inspect.stdout.trim() === 'true' ? 'running' : 'stopped';
}

/** Контейнер пользователя: поднять, если его нет или он остановлен. */
export async function ensureContainer(
  config: IcarusConfig,
  user: UserConfig,
): Promise<{ name: string; state: ContainerState; started: boolean }> {
  const name = userContainer(config, user);
  const before = await containerState(config, user);

  if (before === 'running') return { name, state: before, started: false };

  if (before === 'stopped') {
    const started = await runDocker(['start', name], { config });
    if (started.code !== 0) throw new Error(`не удалось запустить ${name}: ${started.stderr.trim()}`);
    log.info('контейнер запущен', { container: name });
    return { name, state: 'running', started: true };
  }

  const args = containerRunArgs(config, user);
  const created = await runDocker(args, { config });
  if (created.code !== 0) throw new Error(`не удалось создать ${name}: ${created.stderr.trim()}`);
  log.info('контейнер создан', { container: name, image: config.docker.image, mounts: (user.mounts ?? []).length });
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
