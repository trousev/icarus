// Точка входа icarus.
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.ts';
import { loadRuntimeEnv } from './runtime.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';
import { ensureArtifactRepos } from './artifacts-git.ts';
import { backfillChats } from './sessions/chats.ts';
import { reapStalePi, waitForContainers } from './docker/manager.ts';
import { SessionRegistry } from './sessions/registry.ts';
import { startTelegramBot } from './telegram/bot.ts';
import { createServer } from './http/server.ts';

const configPath = process.argv[2] ?? process.env.ICARUS_CONFIG ?? DEFAULT_CONFIG_PATH;

// Ключи читаем до конфига: из .env и keys.json подставляются ключи провайдеров в
// auth.json. В контейнеры значения едут отдельно: compose подключает .env как
// env_file, а панель передаёт свежие значения в процесс pi сама (см. runtime.ts).
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

// Персону панели задаёт прокси (Remote-User). Если человек прописан в конфиге напрямую,
// панель пускает к его памяти любого, кто дотянется до порта, — на проде это дыра.
if (config.panel.devUser !== undefined) {
  log.warn('panel.devUser задан: панель пускает без SSO — так делают только локально', {
    user: config.panel.devUser,
  });
}

for (const user of config.users) {
  prepareUser(config, user);
  // Один проход по файлам сессий: всё, что уже начато, попадает в chats.json.
  // Дальше панель читает только маленький реестр, а не всю историю.
  backfillChats(config, user);
}

// История версий артефактов: у каждой папки свой git-репозиторий. Заводим его
// до первого запроса, чтобы старые артефакты имели снимок «как было».
try {
  const initialized = await ensureArtifactRepos(config);
  if (initialized > 0) log.info('артефакты: история версий заведена', { artifacts: initialized });
} catch (error) {
  log.warn('артефакты: история версий не завелась', { error: String(error) });
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
// Telegram — основной вход к тому же Икару: тот же реестр сессий, та же память.
// Не настроен (нет токена или маппинга) — бот просто не поднимается.
const telegram = startTelegramBot(config, registry);
const server = createServer(config, registry);

server.listen(config.port, config.host, () => {
  log.info('icarus слушает', { url: `http://${config.host}:${config.port}`, users: config.users.length });
});

function shutdown(signal: string): void {
  log.info('останавливаюсь', { signal });
  telegram?.stop();
  registry.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
