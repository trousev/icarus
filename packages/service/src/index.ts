// Точка входа icarus.
import { DEFAULT_CONFIG_PATH, ensurePanelSecret, loadConfig, loadEnvFile } from './config.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';
import { reapStalePi, waitForContainers } from './docker/manager.ts';
import { SessionRegistry } from './sessions/registry.ts';
import { createServer } from './http/server.ts';

const configPath = process.argv[2] ?? process.env.ICARUS_CONFIG ?? DEFAULT_CONFIG_PATH;

// Ключи читаем до конфига: из .env подставляются ключи провайдеров в auth.json.
// В контейнеры значения едут отдельно — compose подключает .env как env_file; а этот
// вызов нужен, когда сервис запущен прямо на хосте, без compose.
loadEnvFile();
const config = loadConfig(configPath);
log.info('конфиг загружен', { path: configPath, users: config.users.map((user) => user.id) });

if (Object.keys(config.auth).length === 0) {
  log.warn('ни одного ключа провайдера: положи их в .env (образец .env.example) или в auth: config.yaml');
}

for (const user of config.users) {
  prepareUser(config, user);
}

// Контейнерами владеет docker compose (см. docker/compose.ts): сервис их не создаёт,
// а ждёт готовыми — зато restart-политика и возврат после перезагрузки машины на докере.
// Осиротевшие pi (сервис убили, контейнер остался) гасим до первого запроса, пока сессий
// в этом процессе ещё нет, иначе следующий ход поднял бы второй pi на ту же сессию.
const { ready, missing } = await waitForContainers(config, config.users);
for (const name of ready) {
  await reapStalePi(config, name);
}
if (missing.length > 0) {
  log.error('контейнеры не подняты — подними стек: ./script/server', { containers: missing });
}

const registry = new SessionRegistry(config);
// Панель памяти пускает только по личным ссылкам: проверять их подпись нечем без секрета.
const server = createServer(config, registry, ensurePanelSecret(config.dataDir));

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
