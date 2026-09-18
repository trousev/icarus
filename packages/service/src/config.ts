// Конфигурация сервиса: разбор файла, подстановка ~ и переменных окружения.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ModelConfig = {
  provider: string;
  id: string;
  thinking?: string;
  tier?: 'fast' | 'strong' | 'vision';
};

export type MountConfig = { host: string; container: string; mode?: 'ro' | 'rw' };

/** Описание MCP-сервера: формат тот же, что читает pi-mcp-extension. */
export type McpServerConfig = {
  transport?: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  lifecycle?: 'eager' | 'lazy';
};

export type UserConfig = {
  id: string;
  name?: string;
  email?: string;
  models: ModelConfig[];
  auth?: Record<string, string>;
  mounts?: MountConfig[];
  /** Переменные окружения контейнера: ими настраиваются наши расширения. */
  env?: Record<string, string>;
  /** MCP-серверы пользователя: то, чем Икар обрастает без правки кода. */
  mcp?: Record<string, McpServerConfig>;
};

export type DockerConfig = {
  image: string;
  network?: string;
  prefix?: string;
  socket?: string | null;
};

export type IcarusConfig = {
  host: string;
  port: number;
  apiKey: string;
  /** Ключ панели памяти; по умолчанию совпадает с apiKey. */
  panelKey: string;
  dataDir: string;
  sessionIdleMinutes: number;
  docker: DockerConfig;
  users: UserConfig[];
};

/** Подставляет ~ и значения вида env:VAR_NAME / ${VAR_NAME}. */
export function expandValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const withHome = value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
  return withHome.replace(/\$\{([A-Z0-9_]+)\}|^env:([A-Z0-9_]+)$/g, (_m, braced, prefixed) => {
    const name = braced ?? prefixed;
    return env[name] ?? '';
  });
}

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): IcarusConfig {
  const raw = JSON.parse(fs.readFileSync(expandValue(file, env), 'utf8'));

  const config: IcarusConfig = {
    host: raw.host ?? '0.0.0.0',
    port: Number(raw.port ?? 8080),
    apiKey: expandValue(String(raw.apiKey ?? ''), env),
    panelKey: expandValue(String(raw.panelKey ?? raw.apiKey ?? ''), env),
    dataDir: expandValue(String(raw.dataDir ?? '~/icarus'), env),
    sessionIdleMinutes: Number(raw.sessionIdleMinutes ?? 30),
    docker: {
      image: raw.docker?.image ?? 'icarus-user:dev',
      network: raw.docker?.network,
      prefix: raw.docker?.prefix ?? 'icarus-user',
      socket: raw.docker?.socket ?? null,
    },
    users: (raw.users ?? []).map((user: UserConfig) => ({
      ...user,
      mounts: (user.mounts ?? []).map((mount) => ({
        host: expandValue(mount.host, env),
        container: mount.container,
        mode: mount.mode ?? 'rw',
      })),
      auth: Object.fromEntries(
        Object.entries(user.auth ?? {}).map(([provider, value]) => [
          provider,
          expandValue(String(value), env),
        ]),
      ),
    })),
  };

  if (!config.apiKey) throw new Error('в конфиге не задан apiKey');
  if (config.users.length === 0) throw new Error('в конфиге нет ни одного пользователя');

  return config;
}

export function findUser(config: IcarusConfig, userId: string | undefined): UserConfig | undefined {
  return config.users.find((user) => user.id === userId);
}

/** Пути на хосте, которые сервис готовит и монтирует пользователю. */
export function userPaths(config: IcarusConfig, user: UserConfig) {
  const root = path.join(config.dataDir, 'users', user.id);
  return {
    root,
    memory: path.join(root, 'memory'),
    incoming: path.join(root, 'incoming'),
    sessions: path.join(root, 'sessions'),
    piAgent: path.join(root, 'pi-agent'),
    agentsMd: path.join(root, 'AGENTS.md'),
    icarusMd: path.join(root, 'icarus.md'),
    sharedMemory: path.join(config.dataDir, 'shared'),
  };
}

/** Контейнеры: один на пользователя, живёт постоянно. */
export function userContainer(config: IcarusConfig, user: UserConfig): string {
  return `${config.docker.prefix}-${user.id}`;
}
