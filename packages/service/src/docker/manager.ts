// A thin wrapper over the docker CLI: user containers, exec, inspection.
// Deliberately without dockerode — the CLI was already proven in M0 and pulls no dependencies.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { log } from '../log.ts';
import { userContainer, type IcarusConfig, type UserConfig } from '../config.ts';
import { LABEL_MANAGED, LABEL_SPEC, LABEL_USER } from './spec.ts';
import type { ManagedContainer } from './reconcile.ts';

export type ContainerState = 'running' | 'stopped' | 'missing';

/**
 * The name of the pi process inside the container. The name exactly: pi rewrites its own cmdline
 * (in `/proc/<pid>/cmdline` a single word remains), so `pkill -f --mode rpc`
 * finds nothing, while `pkill -x pi` does.
 */
const PI_PROCESS = 'pi';

function dockerEnv(config: IcarusConfig): NodeJS.ProcessEnv {
  // If a socket is set (e.g. docker-socket-proxy), the CLI itself understands DOCKER_HOST.
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

/** All containers icarus created: by label and by name (for old ones without labels). */
export async function listManaged(config: IcarusConfig): Promise<ManagedContainer[]> {
  const format = [
    '{{.Names}}',
    `{{.Label "${LABEL_USER}"}}`,
    `{{.Label "${LABEL_SPEC}"}}`,
    '{{.State}}',
  ].join('\t');

  const [byLabel, byName] = await Promise.all([
    runDocker(config, ['ps', '-a', '--filter', `label=${LABEL_MANAGED}=1`, '--format', format]),
    // Containers created before labels appeared, otherwise they'd stay invisible
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
    // We identify a container without a user label by name: otherwise we'd take a live
    // person for a departed one. It has no fingerprint — so it will be recreated.
    const prefix = `${config.docker.prefix}-`;
    const derivedUser = user || (name.startsWith(prefix) ? name.slice(prefix.length) : null);
    return { name, user: derivedUser, spec: spec || null, running: state === 'running' };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for compose to bring up people's containers. The service no longer creates them: the owner is
 * docker compose (see compose.ts), otherwise there would be two masters and no one responsible.
 * A missing container is not "we'll create it now", but a clear error to the operator.
 */
export async function waitForContainers(
  config: IcarusConfig,
  users: UserConfig[],
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ ready: string[]; missing: string[] }> {
  const { timeoutMs = 20_000, intervalMs = 500 } = options;
  const pending = new Set(users.map((user) => user.id));
  const ready: string[] = [];
  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const user of users) {
      if (!pending.has(user.id)) continue;
      if ((await containerState(config, user)) === 'running') {
        pending.delete(user.id);
        ready.push(userContainer(config, user));
      }
    }
    if (pending.size > 0) await sleep(intervalMs);
  }

  const missing = users.filter((user) => pending.has(user.id)).map((user) => userContainer(config, user));
  return { ready, missing };
}

/**
 * Kills pi processes that survived the previous run of the service.
 *
 * If icarus was killed with SIGKILL (OOM, crash, `docker kill`), the `docker exec` client dies,
 * while pi inside the container keeps living — verified: processes hang for minutes, each with
 * its own MCP child. The next turn would bring up a second pi on the same `--session-id` and the same
 * sessions folder. We call this only at startup, while there are no sessions in this process yet.
 *
 * We catch by process name, not by arguments: pi rewrites its own cmdline, and in
 * `/proc/<pid>/cmdline` a single word `pi` remains.
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

  // pkill returns 1 when it found no one — that's a normal case, not an error.
  if (result.code === 0) {
    log.warn('погасил pi, пережившие прошлый запуск сервиса', { container });
    return true;
  }
  if (result.code !== 1) {
    log.warn('не удалось погасить осиротевшие pi', { container, code: result.code, error: result.stderr.trim() });
  }
  return false;
}

/**
 * A person's container by the time of the request. Compose owns creation, so here there are only
 * two things: nudge a stopped container (docker won't bring it up by itself if it was
 * stopped by hand), and name a missing one out loud. A silent `docker run` would bring us back
 * to two masters: a container without compose labels that the next `up` would recreate.
 */
export async function ensureContainerRunning(config: IcarusConfig, user: UserConfig): Promise<string> {
  const name = userContainer(config, user);
  const state = await containerState(config, user);

  if (state === 'running') return name;

  if (state === 'stopped') {
    const started = await runDocker(config, ['start', name]);
    if (started.code !== 0) throw new Error(`не удалось запустить ${name}: ${started.stderr.trim()}`);
    log.warn('контейнер был остановлен — поднял', { container: name });
    return name;
  }

  throw new Error(`контейнер ${name} не найден — подними стек: ./script/server`);
}

/**
 * Starts `docker exec -i` with piped stdio — the RPC bridge rests on this.
 * `workdir` is the process working directory: this way the session lands in its own workspace, not
 * requiring a separate mount and container recreation.
 */
export function spawnDockerExec(
  config: IcarusConfig,
  container: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  workdir?: string,
): ChildProcess {
  const envArgs = Object.entries(extraEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const dirArgs = workdir ? ['-w', workdir] : [];
  return spawn('docker', ['exec', '-i', ...envArgs, ...dirArgs, container, ...args], {
    env: dockerEnv(config),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * A one-off command in the container: stdin closed, working folder — /workspaces,
 * only stdout goes out. For calls that need neither a dialog nor a session.
 */
export function spawnDockerOnce(
  config: IcarusConfig,
  container: string,
  args: string[],
  workdir = '/workspaces',
): ChildProcess {
  return spawn('docker', ['exec', '-w', workdir, container, ...args], {
    env: dockerEnv(config),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
