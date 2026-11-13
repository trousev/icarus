// CLI for ./script/server: builds docker-compose.yml and exposes a stack summary.
//
// Runs on the host as a regular user (not in a container): that's the only way to
// learn uid/gid, look at docker.sock and prepare people's directories before docker
// creates them as root. There are no launch decisions here — script/server makes them,
// while this file honestly writes the YAML and the summary file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG_PATH, ENV_FILE, loadConfig, publicHost, REPO_ROOT, userContainer } from '../config.ts';
import { syncEnvFile } from '../keys.ts';
import { loadRuntimeEnv } from '../runtime.ts';
import { prepareUser } from '../workspace.ts';
import { COMPOSE_PROJECT, DEFAULT_SERVICE_IMAGE, renderCompose, type ComposeOptions } from './compose.ts';
import { sourceRevision } from './revision.ts';

type CliArgs = {
  config: string;
  out: string;
  summary: string | null;
  serviceImage: string;
};

function usage(): string {
  return `compose-write [--config <путь>] [--out <путь>] [--summary <путь>]
               [--service-image <образ>]`;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    config: process.env.ICARUS_CONFIG ?? DEFAULT_CONFIG_PATH,
    out: path.join(REPO_ROOT, 'docker-compose.yml'),
    summary: null,
    serviceImage: DEFAULT_SERVICE_IMAGE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`для ${flag} нужен аргумент`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--config':
        args.config = value();
        break;
      case '--out':
        args.out = value();
        break;
      case '--summary':
        args.summary = value();
        break;
      case '--service-image':
        args.serviceImage = value();
        break;
      case '-h':
      case '--help':
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`неизвестный аргумент: ${flag}`);
    }
  }
  return args;
}

/** How the service gets into docker: we mount the local socket, a remote host — via DOCKER_HOST. */
function resolveDocker(config: ReturnType<typeof loadConfig>): {
  socketPath: string | null;
  dockerHost: string | null;
} {
  const socket = config.docker.socket;
  if (!socket) {
    const fallback = '/var/run/docker.sock';
    return { socketPath: fs.existsSync(fallback) ? fallback : null, dockerHost: null };
  }
  if (socket.startsWith('unix://')) return { socketPath: socket.slice('unix://'.length), dockerHost: null };
  return { socketPath: null, dockerHost: socket };
}

/** Group gid by name — from the same /etc/group that docker itself takes it from. */
export function groupGid(name: string, groupFile = '/etc/group'): number | null {
  let text: string;
  try {
    text = fs.readFileSync(groupFile, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const [entry, , gid] = line.split(':');
    if (entry !== name) continue;
    const value = Number(gid);
    if (Number.isInteger(value)) return value;
  }
  return null;
}

/**
 * Extra groups for the service — because of the docker socket it reaches into people's containers.
 *
 * The socket gid alone is not enough. With Docker Desktop and rootless docker the socket
 * belongs to a user from a foreign user namespace: the host sees it as `nobody:nogroup` (65534),
 * while inside the container it's `root:docker` (125). Adding 65534 gives the service nothing —
 * `docker inspect` from the container answers `permission denied`, and every turn fails with
 * «container not found» even though everything works on the host. So to the socket gid we add the
 * gid of the `docker` group: it's the same on both sides (verified: `--group-add 125` grants
 * access, `--group-add 65534` doesn't). At worst an extra harmless group simply opens nothing.
 */
export function socketGroups(socketGid: number, ownGid: number, groupFile = '/etc/group'): string[] {
  const groups: number[] = [];
  const add = (gid: number | null): void => {
    if (gid === null || gid === 0 || gid === ownGid || groups.includes(gid)) return;
    groups.push(gid);
  };
  add(socketGid);
  add(groupGid('docker', groupFile));
  return groups.map(String);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // We read keys before the config: provider ones are picked up in auth.json (written by
  // prepareUser below), the rest compose hands to containers via env_file. Panel settings
  // (keys.json) are stronger than .env, so here too we go through the common loader.
  const runtimeEnv = loadRuntimeEnv();
  // Panel settings are stronger than .env, and deploy pours GitHub secrets into .env.
  // Before the build we bring the file in line with what will go to containers: otherwise
  // a new container would get the old value while the service inside gets the new one from keys.json.
  syncEnvFile(runtimeEnv.store, ENV_FILE);
  const config = loadConfig(args.config, runtimeEnv.env);
  config.secretEnv = runtimeEnv.secrets;
  const docker = resolveDocker(config);

  // We prepare people's directories and files on the host and before docker: otherwise
  // docker would create the missing mounts as root, and the agent inside the container
  // wouldn't be able to write to memory.
  for (const user of config.users) prepareUser(config, user);

  let extraGroups: string[] = [];
  if (docker.socketPath) {
    extraGroups = socketGroups(fs.statSync(docker.socketPath).gid, process.getgid?.() ?? 0);
  }

  const options: ComposeOptions = {
    repoRoot: REPO_ROOT,
    configPath: path.resolve(args.config),
    runAs: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    home: os.homedir(),
    dockerSocket: docker.socketPath,
    dockerHost: docker.dockerHost,
    extraGroups,
    serviceImage: args.serviceImage,
    // We compute the code fingerprint here, on the host, and put it into the service
    // environment: otherwise `docker compose up` wouldn't notice the code in the
    // bind-mount changed and would leave the old process running (see revision.ts).
    revision: sourceRevision(REPO_ROOT),
    ...(fs.existsSync(ENV_FILE) ? { envFile: ENV_FILE } : {}),
  };

  const yaml = renderCompose(config, options);
  // We keep the file at 600, like config.yaml and .env: there are no secrets in it (keys go
  // via env_file), but extra eyes don't need it, and only whoever launches compose reads it.
  fs.writeFileSync(args.out, yaml, { mode: 0o600 });
  fs.chmodSync(args.out, 0o600);

  const panelHost = publicHost(config.host);
  const lines = [
    ['project', COMPOSE_PROJECT],
    ['compose', args.out],
    ['service-image', args.serviceImage],
    ['user-image', config.docker.image],
    ['host', panelHost],
    ['port', String(config.port)],
    ...config.users.map((user) => ['user', user.id, userContainer(config, user)]),
  ];
  const summary = lines.map((fields) => fields.join('\t')).join('\n') + '\n';
  if (args.summary) fs.writeFileSync(args.summary, summary);
  else process.stdout.write(summary);

  process.stderr.write(`собрал ${args.out}: сервис, людей ${config.users.length}\n`);
}

// Tests import socketGroups from this file, so we run the CLI only when the file is the
// entry point: otherwise an import would write docker-compose.yml and require config.yaml.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
