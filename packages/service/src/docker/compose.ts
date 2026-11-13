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
import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  CONTAINER_PATHS,
  containerWorkspace,
  PRIVATE_WORKSPACE,
  REPO_ROOT,
  userContainer,
  userPaths,
  type IcarusConfig,
  type UserConfig,
} from '../config.ts';
import { containerEnv, LABEL_MANAGED, LABEL_SPEC, LABEL_USER, specFor } from './spec.ts';
import { storePaths as skillStorePaths } from '../skills/registry.ts';

/** Имя compose-проекта: по этой метке compose отличает свои контейнеры от чужих. */
export const COMPOSE_PROJECT = 'icarus';
/** Имя сервиса и контейнера самого icarus. */
export const SERVICE_NAME = 'icarus';
/** Образ сервиса по умолчанию; собирается из docker/service/. */
export const DEFAULT_SERVICE_IMAGE = 'icarus-service:dev';

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
  /**
   * Отпечаток кода сервиса (см. revision.ts). Исходники монтируются в контейнер, а не
   * запекаются в образ, поэтому без отпечатка `docker compose up` не считает смену кода
   * поводом пересоздать контейнер, и старый процесс живёт со старым кодом в памяти.
   */
  revision: string;
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

/**
 * Тома контейнера человека: корень рабочих пространств, служебное и общие маунты.
 *
 * Монтируется один корень `/workspaces`, внутри которого лежат и папки workspace'ов,
 * и служебный `.icarus`. Поэтому новый workspace — это `mkdir`, а не новый маунт:
 * контейнер не пересоздаётся, живые сессии не рвутся.
 */
export function userVolumes(config: IcarusConfig, user: UserConfig): string[] {
  const paths = userPaths(config, user);
  return [
    bind(paths.workspaces, CONTAINER_PATHS.workspaces),
    // «Приватный» — единственный workspace, смонтированный только для чтения.
    // Он лежит внутри уже смонтированного корня, поэтому docker накладывает его
    // поверх; порядок в списке задаёт родителя раньше ребёнка.
    bind(path.join(paths.workspaces, PRIVATE_WORKSPACE), containerWorkspace(PRIVATE_WORKSPACE), 'ro'),
    // shared-memory — единственный каталог памяти, который не принадлежит человеку:
    // он общий на весь инстанс и лежит вне его дерева.
    bind(paths.sharedMemory, CONTAINER_PATHS.sharedMemory),
    // Снимки расшаренных скиллов: общие на инстанс и только для чтения. Свой
    // каталог `pi-agent/skills` остаётся личным, поэтому чужой скилл нельзя
    // переписать или удалить из контейнера получателя.
    bind(skillStorePaths(config).shared, CONTAINER_PATHS.sharedSkills, 'ro'),
    // Глобальная библиотека артефактов: одна на всех, лежит в dataDir и видна
    // каждому контейнеру как /artifacts. Права внутри папок проверяют панель,
    // MCP и folder-guard, а не docker.
    bind(path.join(config.dataDir, 'artifacts'), CONTAINER_PATHS.artifacts),
    // Реестр разговоров — только для чтения: агент по id панели находит файл сессии,
    // но писать в него не должен (реестр ведёт сервис, см. sessions/chats.ts).
    ...(fs.existsSync(paths.chats) ? [bind(paths.chats, CONTAINER_PATHS.chats, 'ro')] : []),
    // Карта разговоров — тот же read-only: её рендерит сервис перед стартом контейнера.
    ...(fs.existsSync(paths.sessionsMap) ? [bind(paths.sessionsMap, CONTAINER_PATHS.sessionsMap, 'ro')] : []),
    bind(paths.piAgent, CONTAINER_PATHS.piAgent),
    // Maple — единственное внешнее дерево, которое контейнер видит. Путь установки
    // обязан совпадать с хостовым: launcher ищет свои библиотеки по записанному
    // внутри пути. Отдельного поля в конфиге для этого больше нет — сервис знает сам.
    ...(config.mapleDir !== undefined ? [bind(config.mapleDir, config.mapleDir, 'ro')] : []),
    // Код встроенных MCP живёт в репозитории, но в контейнер едут только сами
    // серверы: каталог `tools` целиком содержит стенды и логи, которым там нечего
    // делать. Артефакты, OPDS и Кинозал нужны всегда, Maple — только когда он включён.
    bind(path.join(REPO_ROOT, 'tools', 'artifacts-mcp'), '/opt/icarus/tools/artifacts-mcp', 'ro'),
    bind(path.join(REPO_ROOT, 'tools', 'opds-mcp'), '/opt/icarus/tools/opds-mcp', 'ro'),
    // Кинозал: сервер маленький, ключи приходят из панели, а не из маунта. Монтируем
    // всегда: рецепт «Кинозал» добавляется в панели и после сборки конфига, а путь
    // /opt/icarus/tools/arr-mcp должен существовать к тому моменту.
    bind(path.join(REPO_ROOT, 'tools', 'arr-mcp'), '/opt/icarus/tools/arr-mcp', 'ro'),
    // Видео в блог-пост: тот же случай — рецепт добавляется в панели после сборки
    // конфига, а путь из команды должен существовать уже тогда. Бинарников (yt-dlp,
    // ffmpeg) здесь нет: сервер скачивает их себе в служебный каталог при первом
    // вызове, поэтому маунт остаётся только для чтения и лёгкий.
    ...(config.mapleDir !== undefined
      ? [bind(path.join(REPO_ROOT, 'tools', 'maple-mcp'), '/opt/icarus/tools/maple-mcp', 'ro')]
      : []),
    bind(path.join(REPO_ROOT, 'tools', 'video-blog-mcp'), '/opt/icarus/tools/video-blog-mcp', 'ro'),
  ];
}

/** Метки владения: по ним /healthz понимает, чей контейнер и не устарел ли он. */
export function userLabels(config: IcarusConfig, user: UserConfig): Record<string, string> {
  return {
    [LABEL_MANAGED]: '1',
    [LABEL_USER]: user.id,
    [LABEL_SPEC]: specFor(config, user),
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
    '#',
    '# Пересобрать после правки config.yaml: ./script/server',
    '# Погасить стек:                        ./script/server --down',
    '',
  ].join('\n');
}

/**
 * Собирает docker-compose.yml целиком: сервис и по контейнеру на человека.
 * Юзер-контейнеры получают те же имена, маунты, окружение и метки, что раньше
 * давал `docker run`, — сервис продолжает находить их по имени и отпечатку.
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
      labels: userLabels(config, user),
      environment: containerEnv(config, user),
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

  const document = {
    name: COMPOSE_PROJECT,
    services: { [SERVICE_NAME]: service, ...userServices },
    // Сеть из конфига сервис не создаёт: она должна существовать, как и при `docker run --network`.
    ...(network ? { networks: { [network]: { external: true } } } : {}),
  };

  const body = stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false, sortMapEntries: false });
  return `${composeHeader(config, options)}${body}`;
}
