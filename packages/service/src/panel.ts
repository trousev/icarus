// Локальная панель: сервис без докера.
//
// Панель управления живёт на хосте и работает с файлами и git — ни контейнеры, ни pi
// ей для этого не нужны. Этот вход поднимает только её: посмотреть панель на своих
// данных можно, не собирая стек и не дожидаясь контейнеров.
//
// Отличия от боевого входа (index.ts) намеренные и все — про безопасность чужой работы:
//   - человека называет panel.devUser: локально SSO-прокси нет, и вход решать некому;
//   - слушаем только 127.0.0.1: панель без прокси наружу не выставляется;
//   - Telegram не поднимается: у бота один опросчик апдейтов, и второй сломал бы
//     ответы тому, кто уже работает;
//   - контейнеры не поднимаются и осиротевшие pi не гасятся: посмотреть панель —
//     не повод трогать работающий стек.
//
// Отсюда и цена: разговора тут нет — Икар отвечает только в настоящем сервисе.
import { DEFAULT_CONFIG_PATH, findUser, loadConfig, loadEnvFile, type IcarusConfig } from './config.ts';
import { log } from './log.ts';
import { prepareUser } from './workspace.ts';
import { SessionRegistry } from './sessions/registry.ts';
import { createServer } from './http/server.ts';

/** Порт по умолчанию: 8081 занят настоящим сервисом, и путать их не надо. */
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
    // Позиционный аргумент — путь к конфигу: так же зовётся и настоящий сервис.
    if (arg.startsWith('-')) throw new Error(`не понимаю «${arg}»: жду --user, --port, --config или --with-model`);
    args.configPath = arg;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.port !== undefined && !Number.isInteger(args.port)) throw new Error('порт должен быть числом');

loadEnvFile();
const config: IcarusConfig = loadConfig(args.configPath);
const user = findUser(config, args.user ?? process.env.ICARUS_PANEL_USER ?? config.users[0]?.id);
if (!user) {
  throw new Error(`человека «${args.user ?? ''}» нет в ${args.configPath}: в конфиге — ${config.users.map((item) => item.id).join(', ')}`);
}

// Прокси локально нет — значит, человека называем сами. Слушаем при этом только
// петлю: панель без входа наружу не выставляется.
config.panel.devUser = user.id;
config.host = '127.0.0.1';
config.port = args.port ?? DEFAULT_PORT;

for (const person of config.users) prepareUser(config, person);
log.info('локальная панель: данные и git готовы', { dataDir: config.dataDir, user: user.id });

// Разговор в локальной панели не поднимается: контейнеры — дело боевого сервиса.
// Реестр тут настоящий (он же считает поколение скиллов), а вот поднять контейнер
// ему нечем — и это честная ошибка, а не тихая поломка.
//
// С `--with-model` реестр берёт контейнер как обычно: тогда работает «напиши за
// меня» — вопрос уходит в контейнер человека, как в настоящем сервисе. Контейнеры
// панель при этом не создаёт: нет стека — скажет об этом прямо
// (см. ensureContainerRunning). Разговора тут всё равно нет: только разовый вопрос.
const registry = args.withModel
  ? new SessionRegistry(config)
  : new SessionRegistry(config, {
      ensureContainer: async (_config, person) => {
        throw new Error(`локальная панель: контейнер ${person.id} не поднимается — разговор живёт в настоящем сервисе`);
      },
    });

const server = createServer(config, registry, {
  // Без модели писать скилл за человека некому: кнопки в редакторе не будет вовсе.
  draftSkills: args.withModel,
});
server.listen(config.port, config.host, () => {
  log.info('локальная панель открыта', { url: `http://${config.host}:${config.port}/panel`, user: user.id });
});

function shutdown(signal: string): void {
  log.info('останавливаюсь', { signal });
  registry.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
