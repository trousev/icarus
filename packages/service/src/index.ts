// Точка входа icarus.
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';
import { reconcileContainers } from './docker/manager.ts';
import { SessionRegistry } from './sessions/registry.ts';
import { createServer } from './http/server.ts';

const configPath = process.argv[2] ?? process.env.ICARUS_CONFIG ?? DEFAULT_CONFIG_PATH;

const config = loadConfig(configPath);
log.info('конфиг загружен', { path: configPath, users: config.users.map((user) => user.id) });

for (const user of config.users) {
  prepareUser(config, user);
}

// Контейнеры принадлежат нам: приводим их в соответствие с конфигом до первых запросов —
// выбывших людей останавливаем, устаревшие (сменился образ, маунты или окружение) удаляем.
try {
  await reconcileContainers(config, config.users);
} catch (error) {
  log.error('реконсиляция контейнеров не удалась — продолжаю без неё', { error: String(error) });
}

const registry = new SessionRegistry(config);
const server = createServer(config, registry);

server.listen(config.port, config.host, () => {
  log.info('icarus слушает', { url: `http://${config.host}:${config.port}`, users: config.users.length });
});

function shutdown(signal: string): void {
  log.info('останавливаюсь', { signal });
  registry.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
