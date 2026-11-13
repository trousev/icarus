// Entry point of icarus.
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.ts';
import { loadRuntimeEnv } from './runtime.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';
import { ensureArtifactRepos } from './artifacts-git.ts';
import { backfillChats } from './sessions/chats.ts';
import { reapStalePi, waitForContainers } from './docker/manager.ts';
import { SessionRegistry } from './sessions/registry.ts';
import { ScheduledTasks } from './sessions/scheduled.ts';
import { taskLauncher } from './sessions/task-launch.ts';
import { startTelegramBot } from './telegram/bot.ts';
import { createServer } from './http/server.ts';

const configPath = process.argv[2] ?? process.env.ICARUS_CONFIG ?? DEFAULT_CONFIG_PATH;

// We read the keys before the config: provider keys are inserted from .env and keys.json into
// auth.json. The values travel to the containers separately: compose mounts .env as
// env_file, and the panel passes fresh values into the pi process itself (see runtime.ts).
const runtimeEnv = loadRuntimeEnv();
const config = loadConfig(configPath, runtimeEnv.env);
config.secretEnv = runtimeEnv.secrets;
log.info('конфиг загружен', {
  path: configPath,
  users: config.users.map((user) => user.id),
  admins: config.users.filter((user) => user.admin === true).map((user) => user.id),
});

if (Object.keys(config.auth).length === 0) {
  log.warn('ни одного ключа провайдера: положи их в .env (образец .env.example) или в auth: config.yaml');
}

// The panel's persona is set by the proxy (Remote-User). If a person is listed in the config directly,
// the panel lets anyone who reaches the port into their memory — in prod that's a hole.
if (config.panel.devUser !== undefined) {
  log.warn('panel.devUser задан: панель пускает без SSO — так делают только локально', {
    user: config.panel.devUser,
  });
}

for (const user of config.users) {
  prepareUser(config, user);
  // A single pass over the session files: everything already started gets into chats.json.
  // After that the panel reads only the small registry, not the whole history.
  backfillChats(config, user);
}

// Artifact version history: each folder has its own git repository. We create it
// before the first request, so old artifacts have a snapshot "as it was".
try {
  const initialized = await ensureArtifactRepos(config);
  if (initialized > 0) log.info('артефакты: история версий заведена', { artifacts: initialized });
} catch (error) {
  log.warn('артефакты: история версий не завелась', { error: String(error) });
}

// Docker compose owns the containers (see docker/compose.ts): the service doesn't create them
// but waits for them ready — in exchange, the restart policy and recovery after a machine reboot are on docker.
// We kill orphaned pi (the service was killed, the container remained) before the first request, while there are
// no sessions in this process yet, otherwise the next turn would raise a second pi for the same session.
const { ready, missing } = await waitForContainers(config, config.users);
for (const name of ready) {
  await reapStalePi(config, name);
}
if (missing.length > 0) {
  log.error('контейнеры не подняты — подними стек: ./script/server', { containers: missing });
}

const registry = new SessionRegistry(config);
// Telegram is the main entrance to the same Icarus: the same session registry, the same memory.
// Not configured (no token or mapping) — the bot simply doesn't start.
const telegram = startTelegramBot(config, registry);
// Scheduled tasks: at the appointed time they start a new conversation and send a prompt into it.
// The agent works in it like in an ordinary chat, and the person sees the result in the list.
const scheduled = new ScheduledTasks(config, { launch: taskLauncher(config, registry) });
scheduled.start();
// Archiving a Telegram conversation from the panel must also remove it from Telegram:
// the topic is deleted together with the messages, so the panel needs a live bot (see archiveChat).
const server = createServer(config, registry, {
  ...(telegram ? { archiveTelegram: (user, chat) => telegram.removeTopic(user, chat) } : {}),
});

server.listen(config.port, config.host, () => {
  log.info('icarus слушает', { url: `http://${config.host}:${config.port}`, users: config.users.length });
});

function shutdown(signal: string): void {
  log.info('останавливаюсь', { signal });
  scheduled.stop();
  telegram?.stop();
  registry.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
