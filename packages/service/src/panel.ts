// Local panel: the service without docker.
//
// The control panel lives on the host and works with files and git — it needs neither containers nor pi
// for that. This entry point brings up only it: you can look at the panel on your own
// data without building the stack or waiting for containers.
//
// The differences from the production entry point (index.ts) are intentional and all about the safety of
// someone else's work:
//   - the person is named by panel.devUser: locally there is no SSO proxy, and there is no one to decide the login;
//   - we listen only on 127.0.0.1: the panel without a proxy is not exposed outward;
//   - Telegram is not started: the bot has one update poller, and a second one would break
//     replies for the one already working;
//   - containers are not started and orphaned pi processes are not killed: looking at the panel is
//     not a reason to touch a running stack.
//
// Hence the price: there is no conversation here — Icarus answers only in the real service.
import { DEFAULT_CONFIG_PATH, findUser, loadConfig, type IcarusConfig } from './config.ts';
import { loadRuntimeEnv } from './runtime.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';
import { ensureArtifactRepos } from './artifacts-git.ts';
import { backfillChats } from './sessions/chats.ts';
import { SessionRegistry } from './sessions/registry.ts';
import { ScheduledTasks } from './sessions/scheduled.ts';
import { taskLauncher } from './sessions/task-launch.ts';
import { createServer } from './http/server.ts';

/** Default port: 8081 is taken by the real service, and they must not be confused. */
const DEFAULT_PORT = 8099;

type Args = { configPath: string; user?: string; port?: number; withModel: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { configPath: process.env.ICARUS_CONFIG ?? DEFAULT_CONFIG_PATH, withModel: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--with-model') {
      args.withModel = true;
      continue;
    }
    if (arg === '--user' || arg === '--port' || arg === '--config') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} без значения`);
      if (arg === '--user') args.user = value;
      if (arg === '--port') args.port = Number(value);
      if (arg === '--config') args.configPath = value;
      index += 1;
      continue;
    }
    // Positional argument — path to the config: the real service is called the same way.
    if (arg.startsWith('-')) throw new Error(`не понимаю «${arg}»: жду --user, --port, --config или --with-model`);
    args.configPath = arg;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.port !== undefined && !Number.isInteger(args.port)) throw new Error('порт должен быть числом');

const runtimeEnv = loadRuntimeEnv();
const config: IcarusConfig = loadConfig(args.configPath, runtimeEnv.env);
config.secretEnv = runtimeEnv.secrets;
const user = findUser(config, args.user ?? process.env.ICARUS_PANEL_USER ?? config.users[0]?.id);
if (!user) {
  throw new Error(`человека «${args.user ?? ''}» нет в ${args.configPath}: в конфиге — ${config.users.map((item) => item.id).join(', ')}`);
}

// There is no proxy locally — so we name the person ourselves. At the same time we listen only on the
// loopback: the panel is not exposed outward without a login.
config.panel.devUser = user.id;
config.host = '127.0.0.1';
config.port = args.port ?? DEFAULT_PORT;
// The local panel lives on a different port than the production service. The OAuth callback and
// CIMD are built from url, so here it must point to this port, otherwise
// after login the browser would go to 8081 — to someone else's (or no) service.
config.url = `http://${config.host}:${config.port}`;

for (const person of config.users) {
  prepareUser(config, person);
  backfillChats(config, person);
}
try {
  await ensureArtifactRepos(config);
} catch (error) {
  log.warn('локальная панель: история артефактов не завелась', { error: String(error) });
}
log.info('локальная панель: данные и git готовы', { dataDir: config.dataDir, user: user.id });

// The chat is brought up by the real session registry: if the stack is already running, the panel talks
// to the same containers and the same pi sessions as the service. The panel does not create
// containers — if there is no stack, the chat will honestly answer with an error (ensureContainerRunning).
// With `--with-model`, "write it for me" in the skill editor is additionally enabled.
const registry = new SessionRegistry(config);
// Schedules tick here too: a task starts a new conversation the same way as the panel.
// There may be no container around — then the task honestly records that the launch failed.
const scheduled = new ScheduledTasks(config, { launch: taskLauncher(config, registry) });
scheduled.start();

const server = createServer(config, registry, {
  // Without a model there is no one to write a skill for the person: the button in the editor won't exist at all.
  draftSkills: args.withModel,
});
server.listen(config.port, config.host, () => {
  log.info('локальная панель открыта', { url: `http://${config.host}:${config.port}/panel`, user: user.id });
});

function shutdown(signal: string): void {
  log.info('останавливаюсь', { signal });
  scheduled.stop();
  registry.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
