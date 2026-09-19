// CLI для ./script/server: собирает docker-compose.yml и отдаёт наружу сводку о стеке.
//
// Запускается на хосте под обычным пользователем (не в контейнере): только так можно
// узнать uid/gid, посмотреть на docker.sock и подготовить каталоги людей до того, как
// docker их создаст root-овыми. Никаких решений о запуске здесь нет — их принимает
// script/server, а этот файл честно пишет YAML и summary-файл.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { DEFAULT_CONFIG_PATH, ENV_FILE, ensurePanelSecret, loadConfig, loadEnvFile, publicHost, REPO_ROOT, userContainer } from '../config.ts';
import { prepareUser } from '../workspace.ts';
import { COMPOSE_PROJECT, DEFAULT_SERVICE_IMAGE, renderCompose, type ComposeOptions } from './compose.ts';

const DEFAULT_LIBRECHAT_PORT = 3090;

type CliArgs = {
  config: string;
  out: string;
  summary: string | null;
  serviceImage: string;
  withLibrechat: boolean;
};

function usage(): string {
  return `compose-write [--config <путь>] [--out <путь>] [--summary <путь>]
               [--service-image <образ>] [--with-librechat]`;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    config: process.env.ICARUS_CONFIG ?? DEFAULT_CONFIG_PATH,
    out: path.join(REPO_ROOT, 'docker-compose.yml'),
    summary: null,
    serviceImage: DEFAULT_SERVICE_IMAGE,
    withLibrechat: false,
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
      case '--with-librechat':
        args.withLibrechat = true;
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

/** Как сервис попадёт в docker: локальный сокет монтируем, удалённый хост — через DOCKER_HOST. */
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

/** Порт стенда берём из его .env, чтобы он не разъезжался с librechat.yaml. */
function librechatPort(dir: string): number {
  try {
    const parsed = parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8'));
    const port = Number(parsed.PORT);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_LIBRECHAT_PORT;
  } catch {
    return DEFAULT_LIBRECHAT_PORT;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // Ключи читаем до конфига: провайдерские подхватываются в auth.json (его пишет
  // prepareUser ниже), остальные compose отдаёт контейнерам через env_file.
  loadEnvFile();
  const config = loadConfig(args.config);
  const docker = resolveDocker(config);

  // Каталоги и файлы людей готовим на хосте и до docker: иначе docker создаст
  // недостающие маунты root-овыми, и агент внутри контейнера не сможет писать в память.
  for (const user of config.users) prepareUser(config, user);

  // Секрет панели — до сборки compose: из него выводятся личные ключи ссылок,
  // которые уезжают в окружение контейнеров.
  const panelSecret = ensurePanelSecret(config.dataDir);

  let extraGroups: string[] = [];
  if (docker.socketPath) {
    const gid = fs.statSync(docker.socketPath).gid;
    const ownGid = process.getgid?.() ?? 0;
    if (gid !== 0 && gid !== ownGid) extraGroups = [String(gid)];
  }

  const librechatDir = path.join(REPO_ROOT, 'docker', 'librechat');
  const options: ComposeOptions = {
    repoRoot: REPO_ROOT,
    configPath: path.resolve(args.config),
    runAs: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    home: os.homedir(),
    dockerSocket: docker.socketPath,
    dockerHost: docker.dockerHost,
    extraGroups,
    serviceImage: args.serviceImage,
    panelSecret,
    ...(fs.existsSync(ENV_FILE) ? { envFile: ENV_FILE } : {}),
    ...(args.withLibrechat ? { librechat: { dir: librechatDir, port: librechatPort(librechatDir) } } : {}),
  };

  const yaml = renderCompose(config, options);
  // В окружении людей теперь есть личные ключи ссылок на память — файл держим 600,
  // как config.yaml и .env: читает его только тот, кто запускает docker compose.
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
    ...(options.librechat ? [['librechat', `http://localhost:${options.librechat.port}`]] : []),
  ];
  const summary = lines.map((fields) => fields.join('\t')).join('\n') + '\n';
  if (args.summary) fs.writeFileSync(args.summary, summary);
  else process.stdout.write(summary);

  process.stderr.write(`собрал ${args.out}: сервис, людей ${config.users.length}${options.librechat ? ', стенд LibreChat' : ''}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
