// Building docker-compose.yml: docker compose is the sole owner of containers.
//
// Previously the service created containers itself via `docker run` and reconciled them
// itself too. That gave a warm start, but it all rested on the service: if it crashed, no
// one would recreate the containers; if the machine rebooted, icarus wouldn't come back;
// and the state on the host depended on whether the process survived to its reconciliation.
// Now ./script/server builds the file from config.yaml, and docker manages the lifecycle:
// `restart: unless-stopped` brings containers up after a crash and a reboot,
// `docker compose up` recreates them when the image, mounts, or environment change, and
// departed people leave along with the vanished service (--remove-orphans). The
// ICARUS_REVISION fingerprint adds a service code change to that comparison (see
// revision.ts): sources are mounted, and without it the container would keep living with
// the old code.
//
// Here it's purely YAML building: no docker and no side effects — that way it can be
// checked by tests, and launch decisions stay in script/server.
import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  CONTAINER_PATHS,
  containerWorkspace,
  PRIVATE_WORKSPACE,
  REPO_ROOT,
  userContainer,
  userPaths,
  type IcarusConfig,
  type UserConfig,
} from '../config.ts';
import { containerEnv, LABEL_MANAGED, LABEL_SPEC, LABEL_USER, specFor } from './spec.ts';
import { storePaths as skillStorePaths } from '../skills/registry.ts';

/** Compose project name: by this label compose tells its containers from foreign ones. */
export const COMPOSE_PROJECT = 'icarus';
/** The service and container name of icarus itself. */
export const SERVICE_NAME = 'icarus';
/** Default service image; built from docker/service/. */
export const DEFAULT_SERVICE_IMAGE = 'icarus-service:dev';

export type ComposeOptions = {
  /** Repository root: mounted into the service container so code and extensions match. */
  repoRoot: string;
  /** Path to config.yaml — it's also passed to the service as an argument. */
  configPath: string;
  /** uid:gid of the service: dataDir is written under it so files don't become root-owned. */
  runAs: string;
  /** Host home directory: `~` in the config must expand to the same path. */
  home: string;
  /** Path to docker.sock on the host; null means we don't mount the socket (host is set via DOCKER_HOST). */
  dockerSocket: string | null;
  /** DOCKER_HOST value if docker listens on something other than the local socket. */
  dockerHost?: string | null;
  /** Extra groups for the service container (access to docker.sock). */
  extraGroups?: string[];
  /** Service image. */
  serviceImage?: string;
  /** env file with keys (.env in the repository root), if present: it goes to the service and to people. */
  envFile?: string;
  /**
   * Service code fingerprint (see revision.ts). Sources are mounted into the container
   * rather than baked into the image, so without the fingerprint `docker compose up`
   * doesn't consider a code change a reason to recreate the container, and the old
   * process lives with the old code in memory.
   */
  revision: string;
};

type ComposeService = Record<string, unknown>;

function bind(source: string, target: string, mode?: 'ro'): string {
  // The path wasn't substituted — docker will parse "::ro" and fail with "invalid spec"
  // in the middle of the build. We fail earlier and more clearly: a config with an empty
  // mount doesn't reach docker (see parseMounts in config.ts — the same check there
  // catches an unsubstituted ${VAR}).
  if (source === '' || target === '') {
    throw new Error(`маунт с пустым путём: «${source}:${target}» — проверь переменные окружения в config.yaml`);
  }
  return `${source}:${target}${mode === 'ro' ? ':ro' : ''}`;
}

/**
 * The person's container volumes: the workspaces root, service data, and shared mounts.
 *
 * A single root `/workspaces` is mounted, holding both the workspace folders and the
 * service `.icarus`. So a new workspace is a `mkdir`, not a new mount: the container
 * isn't recreated, live sessions aren't broken.
 */
export function userVolumes(config: IcarusConfig, user: UserConfig): string[] {
  const paths = userPaths(config, user);
  return [
    bind(paths.workspaces, CONTAINER_PATHS.workspaces),
    // "Private" is the only workspace mounted read-only. It lies inside the already
    // mounted root, so docker overlays it on top; the order in the list puts the parent
    // before the child.
    bind(path.join(paths.workspaces, PRIVATE_WORKSPACE), containerWorkspace(PRIVATE_WORKSPACE), 'ro'),
    // shared-memory is the only memory directory that doesn't belong to the person:
    // it's shared across the whole instance and lies outside their tree.
    bind(paths.sharedMemory, CONTAINER_PATHS.sharedMemory),
    // Snapshots of shared skills: instance-wide and read-only. The person's own
    // `pi-agent/skills` directory stays private, so someone else's skill can't be
    // overwritten or deleted from the recipient's container.
    bind(skillStorePaths(config).shared, CONTAINER_PATHS.sharedSkills, 'ro'),
    // Global artifact library: one for everyone, it lives in dataDir and is visible
    // to every container as /artifacts. Permissions inside the folders are enforced by
    // the panel, MCP, and folder-guard, not by docker.
    bind(path.join(config.dataDir, 'artifacts'), CONTAINER_PATHS.artifacts),
    // Chat registry — read-only: by the panel id the agent finds the session file, but
    // mustn't write to it (the registry is maintained by the service, see sessions/chats.ts).
    ...(fs.existsSync(paths.chats) ? [bind(paths.chats, CONTAINER_PATHS.chats, 'ro')] : []),
    // Chat map — the same read-only: the service renders it before starting the container.
    ...(fs.existsSync(paths.sessionsMap) ? [bind(paths.sessionsMap, CONTAINER_PATHS.sessionsMap, 'ro')] : []),
    bind(paths.piAgent, CONTAINER_PATHS.piAgent),
    // Maple is the only external tree the container sees. The install path must match
    // the host's: the launcher looks for its libraries by the path recorded inside.
    // There's no separate config field for this anymore — the service knows on its own.
    ...(config.mapleDir !== undefined ? [bind(config.mapleDir, config.mapleDir, 'ro')] : []),
    // The code of built-in MCPs lives in the repository, but only the servers themselves
    // travel into the container: the `tools` directory as a whole contains test benches
    // and logs that have no business there. Artifacts, OPDS, and Kinozal are always
    // needed, Maple only when it's enabled.
    bind(path.join(REPO_ROOT, 'tools', 'artifacts-mcp'), '/opt/icarus/tools/artifacts-mcp', 'ro'),
    bind(path.join(REPO_ROOT, 'tools', 'opds-mcp'), '/opt/icarus/tools/opds-mcp', 'ro'),
    // Kinozal: the server is small, keys come from the panel, not from a mount. We always
    // mount it: the "Kinozal" recipe is added in the panel even after the config is built,
    // and the path /opt/icarus/tools/arr-mcp must exist by then.
    bind(path.join(REPO_ROOT, 'tools', 'arr-mcp'), '/opt/icarus/tools/arr-mcp', 'ro'),
    // Video to blog post: the same case — the recipe is added in the panel after the
    // config is built, and the path from the command must exist by then. There are no
    // binaries (yt-dlp, ffmpeg) here: the server downloads them into its service
    // directory on first call, so the mount stays read-only and light.
    ...(config.mapleDir !== undefined
      ? [bind(path.join(REPO_ROOT, 'tools', 'maple-mcp'), '/opt/icarus/tools/maple-mcp', 'ro')]
      : []),
    bind(path.join(REPO_ROOT, 'tools', 'video-blog-mcp'), '/opt/icarus/tools/video-blog-mcp', 'ro'),
  ];
}

/** Ownership labels: by them /healthz knows whose container it is and whether it's stale. */
export function userLabels(config: IcarusConfig, user: UserConfig): Record<string, string> {
  return {
    [LABEL_MANAGED]: '1',
    [LABEL_USER]: user.id,
    [LABEL_SPEC]: specFor(config, user),
  };
}

/**
 * Where to publish the port. `0.0.0.0` in the config means "listen everywhere", and then
 * it must be published everywhere too; a specific address (e.g. 127.0.0.1) limits the
 * publication as well. docker doesn't understand `localhost` in a publish address — we
 * translate it to 127.0.0.1.
 */
export function publishAddress(host: string, port: number): string {
  if (host === '0.0.0.0' || host === '' || host === '::') return `${port}:${port}`;
  return `${host === 'localhost' ? '127.0.0.1' : host}:${port}:${port}`;
}

function serviceEnvironment(config: IcarusConfig, options: ComposeOptions): Record<string, string> {
  return {
    // Without this, `~` in the config would expand to /root inside the container and all mounts would be off.
    HOME: options.home,
    ICARUS_CONFIG: options.configPath,
    // Code fingerprint: code changes — environment changes — compose recreates the service.
    ICARUS_REVISION: options.revision,
    ...(options.dockerHost ? { DOCKER_HOST: options.dockerHost } : {}),
  };
}

function composeHeader(config: IcarusConfig, options: ComposeOptions): string {
  const users = config.users.map((user) => user.id).join(', ');
  return [
    '# Сгенерировано ./script/server из config.yaml — не редактировать руками.',
    '#',
    `# Сервис:   ${options.serviceImage ?? DEFAULT_SERVICE_IMAGE}`,
    `# Люди:     ${users}`,
    `# dataDir:  ${config.dataDir}`,
    '#',
    '# Пересобрать после правки config.yaml: ./script/server',
    '# Погасить стек:                        ./script/server --down',
    '',
  ].join('\n');
}

/**
 * Builds docker-compose.yml in full: the service and one container per person.
 * User containers get the same names, mounts, environment, and labels that `docker run`
 * used to give them — the service keeps finding them by name and fingerprint.
 */
export function renderCompose(config: IcarusConfig, options: ComposeOptions): string {
  const network = config.docker.network ?? null;
  const attach = network ? { networks: [network] } : {};
  const serviceImage = options.serviceImage ?? DEFAULT_SERVICE_IMAGE;
  // We attach keys via a file rather than values in YAML: docker-compose.yml stays free
  // of secrets, and compose itself recreates containers when .env is edited.
  const envFile = options.envFile ? { env_file: [options.envFile] } : {};
  // Custom DNS only if the person asked: by default containers get the host's resolver
  // and with it the names of other containers (see docker.dns in the config).
  const dns = config.docker.dns ?? [];
  const dnsServers = dns.length > 0 ? { dns } : {};

  const userServices: Record<string, ComposeService> = {};
  for (const user of config.users) {
    const name = userContainer(config, user);
    userServices[name] = {
      image: config.docker.image,
      container_name: name,
      restart: 'unless-stopped',
      // In a person's container PID 1 is the image's `sleep infinity`, and it doesn't
      // reap orphans: any process that outlives its parent stays a zombie forever after
      // dying. That's how `[mserver] <defunct>` piled up: Maple's cmaple wrapper was
      // killed, the kernel was orphaned and, having exited, hung as a zombie. init (tini)
      // as PID 1 cleans up such orphans — exactly as in the service container below.
      init: true,
      labels: userLabels(config, user),
      environment: containerEnv(config, user),
      volumes: userVolumes(config, user),
      ...dnsServers,
      ...envFile,
      ...attach,
    };
  }

  const service: ComposeService = {
    image: serviceImage,
    // compose builds the service image itself (docker/service — node, git, docker client).
    // The build context is here rather than in script/server: that way `docker compose build`
    // builds the service along with the whole stack, and the build becomes a separate phase
    // before recreation. People's containers have no build on purpose: their image is shared,
    // and compose would rebuild it per service, swapping the tag between different results.
    build: { context: path.join(options.repoRoot, 'docker', 'service') },
    container_name: SERVICE_NAME,
    restart: 'unless-stopped',
    // init cleans up zombies from docker exec, and user — so that memory on the host belongs
    // to the person rather than root: dataDir is mounted both into the service and into
    // people's containers.
    init: true,
    user: options.runAs,
    ...(options.extraGroups && options.extraGroups.length > 0 ? { group_add: options.extraGroups } : {}),
    working_dir: options.repoRoot,
    command: ['node', 'packages/service/src/index.ts', options.configPath],
    environment: serviceEnvironment(config, options),
    ...dnsServers,
    ...envFile,
    ports: [publishAddress(config.host, config.port)],
    volumes: [
      ...(options.dockerSocket ? [bind(options.dockerSocket, options.dockerSocket)] : []),
      // The repository is mounted at the same path: REPO_ROOT and mount paths inside the
      // container must match the host's, otherwise docker will create foreign directories.
      bind(options.repoRoot, options.repoRoot),
      // The config may also lie outside the repository (--config): without an explicit mount the service won't see it.
      bind(options.configPath, options.configPath, 'ro'),
      bind(config.dataDir, config.dataDir),
    ],
    ...(Object.keys(userServices).length > 0
      ? {
          depends_on: Object.fromEntries(
            Object.keys(userServices).map((name) => [name, { condition: 'service_started' }]),
          ),
        }
      : {}),
    ...attach,
  };

  const document = {
    name: COMPOSE_PROJECT,
    services: { [SERVICE_NAME]: service, ...userServices },
    // The service doesn't create the network from the config: it must already exist, as with `docker run --network`.
    ...(network ? { networks: { [network]: { external: true } } } : {}),
  };

  const body = stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false, sortMapEntries: false });
  return `${composeHeader(config, options)}${body}`;
}
