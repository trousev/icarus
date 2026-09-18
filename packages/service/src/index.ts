// Точка входа icarus.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';
import { SessionRegistry } from './sessions/registry.ts';
import { createServer } from './http/server.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const configPath =
  process.argv[2] ?? process.env.ICARUS_CONFIG ?? path.resolve(HERE, '..', 'icarus.config.json');

const config = loadConfig(configPath);
log.info('конфиг загружен', { path: configPath, users: config.users.map((user) => user.id) });

for (const user of config.users) {
  prepareUser(config, user);
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
