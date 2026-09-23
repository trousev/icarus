// Сборка docker-compose.yml: единственный владелец контейнеров — docker compose.
//
// Раньше сервис сам создавал контейнеры через `docker run` и сам же их реконсилировал.
// Это давало тёплый старт, но упиралось в сервис: упал он — контейнеры никто не пересоздаст,
// перезагрузилась машина — icarus не вернётся, а состояние на хосте зависело от того,
// дожил ли процесс до своей реконсиляции. Теперь файл собирает ./script/server из config.yaml,
// а жизненным циклом распоряжается docker: `restart: unless-stopped` поднимает контейнеры
// после падения и перезагрузки, `docker compose up` пересоздаёт их при смене образа, маунтов
// или окружения, а выбывшие люди уходят вместе с исчезнувшим сервисом (--remove-orphans).
// Смену кода сервиса в это сравнение добавляет отпечаток ICARUS_REVISION (см. revision.ts):
// исходники монтируются, и без него контейнер оставался бы жить со старым кодом.
//
// Здесь только чистая сборка YAML: никакого docker и никаких побочных эффектов — так её
// можно проверять тестами, а решения о запуске остаются в script/server.
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { userContainer, userPaths, type IcarusConfig, type UserConfig } from '../config.ts';
import { containerEnv, LABEL_MANAGED, LABEL_SPEC, LABEL_USER, specFor } from './spec.ts';

/** Имя compose-проекта: по этой метке compose отличает свои контейнеры от чужих. */
export const COMPOSE_PROJECT = 'icarus';
/** Имя сервиса и контейнера самого icarus. */
export const SERVICE_NAME = 'icarus';
/** Образ сервиса по умолчанию; собирается из docker/service/. */
export const DEFAULT_SERVICE_IMAGE = 'icarus-service:dev';
/** Контейнеры стенда LibreChat: имена не пересекаются с одиночным docker/librechat. */
export const LIBRECHAT_CONTAINER = 'icarus-librechat';
export const LIBRECHAT_MONGO_CONTAINER = 'icarus-librechat-mongo';

/**
 * Стендовая OIDC-заглушка (docker/librechat/oidc-stub). Management API LibreChat
 * принимает только OIDC machine-токены, а на стенде провайдера нет — его роль
 * играет заглушка. Она поднимается дважды с одним ключом подписи: внутри контейнера
 * LibreChat (тот видит её как http://localhost:9100 — по http LibreChat пускает
 * только localhost) и обычным сервисом `oidc` в сети compose (у него icarus берёт
 * токен). В бою здесь настоящий провайдер, а эти константы не используются.
 */
export const OIDC_STUB_PORT = 9100;
export const OIDC_ISSUER = `http://localhost:${OIDC_STUB_PORT}`;
export const OIDC_AUDIENCE = 'icarus-skills';
export const OIDC_CLIENT_ID = 'icarus-sync';
export const OIDC_CLIENT_SECRET = 'icarus-sync-dev-secret';

export type LibrechatOptions = {
  /** Каталог docker/librechat: оттуда берутся .env, librechat.yaml и данные стенда. */
  dir: string;
  port: number;
};

export type ComposeOptions = {
  /** Корень репозитория: монтируется в контейнер сервиса, чтобы код и расширения совпадали. */
  repoRoot: string;
  /** Путь к config.yaml — он же передаётся сервису аргументом. */
  configPath: string;
  /** uid:gid сервиса: под ним пишется dataDir, чтобы файлы не становились root-овыми. */
  runAs: string;
  /** Домашний каталог хоста: `~` в конфиге должен разворачиваться в тот же путь. */
  home: string;
  /** Путь к docker.sock на хосте; null — сокет не монтируем (хост задан через DOCKER_HOST). */
  dockerSocket: string | null;
  /** Значение DOCKER_HOST, если docker слушает не на локальном сокете. */
  dockerHost?: string | null;
  /** Дополнительные группы контейнера сервиса (доступ к docker.sock). */
  extraGroups?: string[];
  /** Образ сервиса. */
  serviceImage?: string;
  /** env-файл с ключами (.env в корне репозитория), если он есть: едет в сервис и людям. */
  envFile?: string;
  /** Секрет панели: из него выводятся личные ключи ссылок на память (см. ensurePanelSecret). */
  panelSecret: string;
  /**
   * Отпечаток кода сервиса (см. revision.ts). Исходники монтируются в контейнер, а не
   * запекаются в образ, поэтому без отпечатка `docker compose up` не считает смену кода
   * поводом пересоздать контейнер, и старый процесс живёт со старым кодом в памяти.
   */
  revision: string;
  /** Стенд LibreChat — по флагу --with-librechat. */
  librechat?: LibrechatOptions;
};

type ComposeService = Record<string, unknown>;

function bind(source: string, target: string, mode?: 'ro'): string {
  // Путь не подставился — docker разберёт «::ro» и упадёт «invalid spec» уже посреди
  // сборки. Падаем раньше и внятнее: конфиг с пустым маунтом до docker не доезжает
  // (см. parseMounts в config.ts — там эта же проверка ловит неподставившуюся ${VAR}).
  if (source === '' || target === '') {
    throw new Error(`маунт с пустым путём: «${source}:${target}» — проверь переменные окружения в config.yaml`);
  }
  return `${source}:${target}${mode === 'ro' ? ':ro' : ''}`;
}

/** Тома контейнера человека: личные каталоги, персона и общие маунты из конфига. */
export function userVolumes(config: IcarusConfig, user: UserConfig): string[] {
  const paths = userPaths(config, user);
  return [
    bind(paths.memory, '/workspace/memory'),
    // Математика — персистентно и рядом с памятью: журналы сессий Maple и графики
    // не должны умирать вместе с MCP-мостом pi или пересозданием контейнера.
    ...(config.mcp?.maple ? [bind(paths.maple, '/workspace/maple')] : []),
    bind(paths.incoming, '/workspace/incoming'),
    bind(paths.sessions, '/workspace/.sessions'),
    bind(paths.sharedMemory, '/workspace/shared-memory'),
    bind(paths.piAgent, '/home/node/.pi/agent'),
    bind(paths.agentsMd, '/workspace/AGENTS.md', 'ro'),
    bind(paths.icarusMd, '/workspace/icarus.md', 'ro'),
    // Инструкция по Maple монтируется только когда сервер настроен: пустой файл
    // или каталог на его месте только путали бы агента.
    ...(config.mcp?.maple ? [bind(paths.mapleMd, '/workspace/MAPLE.md', 'ro')] : []),
    ...config.mounts.map((mount) => bind(mount.host, mount.container, mount.mode === 'ro' ? 'ro' : undefined)),
  ];
}

/** Метки владения: по ним /healthz понимает, чей контейнер и не устарел ли он. */
export function userLabels(
  config: IcarusConfig,
  user: UserConfig,
  panelSecret: string,
): Record<string, string> {
  return {
    [LABEL_MANAGED]: '1',
    [LABEL_USER]: user.id,
    [LABEL_SPEC]: specFor(config, user, panelSecret),
  };
}

/**
 * Куда публиковать порт. `0.0.0.0` в конфиге — это «слушать везде», и публиковать
 * тогда нужно тоже везде; конкретный адрес (например, 127.0.0.1) ограничивает и публикацию.
 * `localhost` docker в адресе публикации не понимает — переводим в 127.0.0.1.
 */
export function publishAddress(host: string, port: number): string {
  if (host === '0.0.0.0' || host === '' || host === '::') return `${port}:${port}`;
  return `${host === 'localhost' ? '127.0.0.1' : host}:${port}:${port}`;
}

function serviceEnvironment(config: IcarusConfig, options: ComposeOptions): Record<string, string> {
  return {
    // Без этого `~` в конфиге развернулся бы в /root внутри контейнера и все маунты уехали бы.
    HOME: options.home,
    ICARUS_CONFIG: options.configPath,
    // Отпечаток кода: меняется код — меняется окружение — compose пересоздаёт сервис.
    ICARUS_REVISION: options.revision,
    ...(options.dockerHost ? { DOCKER_HOST: options.dockerHost } : {}),
    // Синхронизация скиллов со стендом: адрес LibreChat и доступ к его OIDC-заглушке.
    // Адреса стенда знает только compose — в config.yaml они приходят переменными.
    ...(options.librechat
      ? {
          ICARUS_LIBRECHAT_URL: `http://${LIBRECHAT_CONTAINER}:${options.librechat.port}`,
          // Токен берём у обычного сервиса `oidc` в сети compose: ограничение «http
          // только к localhost» — это правило LibreChat, icarus им не связан.
          ICARUS_SKILLS_TOKEN_URL: `http://oidc:${OIDC_STUB_PORT}/token`,
          ICARUS_SKILLS_CLIENT_ID: OIDC_CLIENT_ID,
          ICARUS_SKILLS_CLIENT_SECRET: OIDC_CLIENT_SECRET,
        }
      : {}),
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
    `# Стенд:    ${options.librechat ? `LibreChat на :${options.librechat.port}` : 'без LibreChat'}`,
    '#',
    '# Пересобрать после правки config.yaml: ./script/server',
    '# Погасить стек:                        ./script/server --down',
    '',
  ].join('\n');
}

function librechatServices(
  options: LibrechatOptions,
  network: string | null,
  runAs: string,
): { services: Record<string, ComposeService>; volumes: Record<string, unknown> } {
  const dir = options.dir;
  const attach = network ? { networks: [network] } : {};
  const stubEnv = {
    OIDC_ISSUER,
    OIDC_AUDIENCE,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    OIDC_PORT: String(OIDC_STUB_PORT),
  };
  const stubVolumes = [
    bind(path.join(dir, 'oidc-stub'), '/opt/oidc-stub', 'ro'),
    bind(path.join(dir, 'oidc-data'), '/data'),
  ];
  return {
    services: {
      librechat: {
        image: 'registry.librechat.ai/danny-avila/librechat-dev:latest',
        container_name: LIBRECHAT_CONTAINER,
        restart: 'unless-stopped',
        depends_on: [LIBRECHAT_MONGO_CONTAINER],
        // icarus живёт в соседнем контейнере, а LibreChat ходит в него по host.docker.internal.
        extra_hosts: ['host.docker.internal:host-gateway'],
        // Внутри своего же контейнера поднимаем OIDC-заглушку: Management API принимает
        // только её токены, а по http обращаться разрешено лишь к localhost — значит,
        // провайдер обязан жить в том же сетевом namespace, что LibreChat. Живёт он
        // ровно столько же, сколько LibreChat, и не отваливается при его пересоздании.
        // Штатная команда образа — npm run backend; entrypoint делает exec "$@".
        command: ['sh', '-c', `node /opt/oidc-stub/server.mjs & exec npm run backend`],
        environment: {
          HOST: '0.0.0.0',
          MONGO_URI: `mongodb://${LIBRECHAT_MONGO_CONTAINER}:27017/LibreChat`,
          ...stubEnv,
        },
        ports: [`${options.port}:${options.port}`],
        volumes: [
          bind(path.join(dir, '.env'), '/app/.env'),
          // Монтируем не шаблон, а рабочую копию: в неё ./script/server подставляет
          // привязку Management API (ObjectId пользователя стенда), которой в git нет.
          bind(path.join(dir, 'librechat.local.yaml'), '/app/librechat.yaml'),
          bind(path.join(dir, 'logs'), '/app/logs'),
          bind(path.join(dir, 'uploads'), '/app/uploads'),
          bind(path.join(dir, 'images'), '/app/client/public/images'),
          'librechat-data:/app/data',
          ...stubVolumes,
        ],
        ...attach,
      },
      [LIBRECHAT_MONGO_CONTAINER]: {
        image: 'mongo:8.0.20',
        container_name: LIBRECHAT_MONGO_CONTAINER,
        restart: 'unless-stopped',
        command: ['mongod', '--noauth'],
        volumes: ['mongo-data:/data/db'],
        ...attach,
      },
      // Та же заглушка обычным сервисом в сети compose: icarus ходит сюда за токеном
      // (ему адрес localhost не нужен — это ограничение только у LibreChat). Ключ
      // подписи общий, каталог docker/librechat/oidc-data монтируется в оба места.
      oidc: {
        image: 'node:24-bookworm-slim',
        container_name: 'icarus-oidc',
        restart: 'unless-stopped',
        // Ключ подписи пишется на хост: пусть он принадлежит человеку, а не root-у.
        user: runAs,
        command: ['node', '/opt/oidc-stub/server.mjs'],
        environment: stubEnv,
        volumes: stubVolumes,
        ...attach,
      },
    },
    volumes: { 'librechat-data': {}, 'mongo-data': {} },
  };
}

/**
 * Собирает docker-compose.yml целиком: сервис, по контейнеру на человека и, если просили,
 * стенд LibreChat. Юзер-контейнеры получают те же имена, маунты, окружение и метки, что
 * раньше давал `docker run`, — сервис продолжает находить их по имени и отпечатку.
 */
export function renderCompose(config: IcarusConfig, options: ComposeOptions): string {
  const network = config.docker.network ?? null;
  const attach = network ? { networks: [network] } : {};
  const serviceImage = options.serviceImage ?? DEFAULT_SERVICE_IMAGE;
  // Ключи подключаем файлом, а не значениями в YAML: docker-compose.yml остаётся без
  // секретов, а compose сам пересоздаёт контейнеры при правке .env.
  const envFile = options.envFile ? { env_file: [options.envFile] } : {};
  // Свой DNS — только если человек попросил: по умолчанию контейнеры получают резолвер
  // хоста, а вместе с ним имена других контейнеров (см. docker.dns в конфиге).
  const dns = config.docker.dns ?? [];
  const dnsServers = dns.length > 0 ? { dns } : {};

  const userServices: Record<string, ComposeService> = {};
  for (const user of config.users) {
    const name = userContainer(config, user);
    userServices[name] = {
      image: config.docker.image,
      container_name: name,
      restart: 'unless-stopped',
      // У человека PID 1 — `sleep infinity` из образа, а он сирот не подбирает: любой
      // процесс, переживший своего родителя, после смерти остаётся зомби навсегда.
      // Так и копились `[mserver] <defunct>`: у Maple убили обёртку cmaple, ядро
      // осиротело и, завершившись, висело зомби. init (tini) в роли PID 1 подчищает
      // такие сироты — ровно как в контейнере сервиса ниже.
      init: true,
      labels: userLabels(config, user, options.panelSecret),
      environment: containerEnv(config, user, options.panelSecret),
      volumes: userVolumes(config, user),
      ...dnsServers,
      ...envFile,
      ...attach,
    };
  }

  const service: ComposeService = {
    image: serviceImage,
    // Образ сервиса compose собирает сам (docker/service — node, git, клиент docker).
    // Контекст сборки здесь, а не в script/server: так `docker compose build` собирает
    // сервис вместе со всем стеком, и сборка уходит в отдельную фазу до пересоздания.
    // У контейнеров людей build нет намеренно: образ у них общий, и на каждый сервис
    // compose собирал бы его заново, подменяя тег то одним, то другим результатом.
    build: { context: path.join(options.repoRoot, 'docker', 'service') },
    container_name: SERVICE_NAME,
    restart: 'unless-stopped',
    // init подчищает зомби от docker exec, а user — чтобы память на хосте принадлежала
    // человеку, а не root-у: dataDir монтируется и в сервис, и в контейнеры людей.
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
      // Репозиторий монтируется по тому же пути: REPO_ROOT и пути маунтов внутри
      // контейнера обязаны совпадать с хостовыми, иначе docker создаст чужие каталоги.
      bind(options.repoRoot, options.repoRoot),
      // Конфиг может лежать и вне репозитория (--config): без явного маунта сервис его не увидит.
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

  const librechat = options.librechat
    ? librechatServices(options.librechat, network, options.runAs)
    : { services: {}, volumes: {} };

  const document = {
    name: COMPOSE_PROJECT,
    services: { [SERVICE_NAME]: service, ...userServices, ...librechat.services },
    ...(Object.keys(librechat.volumes).length > 0 ? { volumes: librechat.volumes } : {}),
    // Сеть из конфига сервис не создаёт: она должна существовать, как и при `docker run --network`.
    ...(network ? { networks: { [network]: { external: true } } } : {}),
  };

  const body = stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false, sortMapEntries: false });
  return `${composeHeader(config, options)}${body}`;
}
