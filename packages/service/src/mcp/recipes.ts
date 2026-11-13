// MCP recipes: ready-made server presets that a person adds with one button.
//
// Why this is here. "Add MCP" requires knowing the command, arguments, transport and
// environment variable names. A person who just wants the weather in Dublin
// does not know this and should not have to. A recipe is a description of a server without secrets:
// command/address, non-secret settings and the names of the keys the form will ask for.
//
// The rules by which the catalog is assembled:
//   * a recipe contains no secret value at all — only names and hints where
//     to get it; the person enters values in the form and they go into credentials.json;
//   * if a server requires external infrastructure (Proton Bridge, rclone, Home
//     Assistant), this is written in requires and caveat, not hidden in "works out of
//     the box";
//   * each recipe has a verification date — so that half a year later it is visible that the package
//     and address were verified, not rewritten from memory.
import type { McpAuthType, McpTransport } from './registry.ts';

/** One key the form will ask for. There is no value here and there must not be. */
export type McpRecipeSecret = {
  /** Environment variable name (stdio) or header name (HTTP). */
  name: string;
  /** What this is and where to get it — for the person, not the model. */
  hint: string;
};

/**
 * A server recipe. This is not a saved server: the recipe id does not go into the registry,
 * but the command/address are substituted into the ordinary add form.
 */
export type McpRecipe = {
  id: string;
  name: string;
  /** Short category for the card: mail, calendar, files… */
  category: string;
  /** When the server is really needed — by the "once a week" criterion. */
  when: string;
  /** Description that will go into the server card and into AGENTS.md. */
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  auth: McpAuthType;
  /** Non-secret stdio settings: addresses, ports, modes. */
  env?: Record<string, string>;
  /** Non-secret permanent HTTP headers. */
  headers?: Record<string, string>;
  /** Keys the form will ask for: only names and hints. */
  secrets: McpRecipeSecret[];
  /**
   * The keys are optional: the server works without them. That is how OPDS is built — an open
   * catalog is read right away, and a login/password is needed only by a closed one. The panel then
   * does not hold the server in "waiting for access", but shows the "Set up access" button.
   */
  secretsOptional?: boolean;
  /** Where the key lives: in stdio environment variables or in an HTTP header. */
  secretKind: 'env' | 'header';
  /** What must be outside before pressing "Add". */
  requires: string[];
  /** What to do by hand, step by step. */
  steps: string[];
  /** If it did not come up — the most common causes. */
  trouble: string[];
  /** A limitation that must not be kept silent (localhost, plan, someone else's machine). */
  caveat?: string;
  docs: string;
  /** Date when the package, address and command were verified. */
  checkedAt: string;
};

/** Selection criterion from the idea: "once a week" is the line between a skill and a toy. */
export const RECIPE_RULE =
  'MCP стоит заводить, если ты пользуешься им хотя бы раз в неделю. Всё остальное — инструменты, которые висят в каждом разговоре и занимают контекст.';

/** What deliberately did not make it into the catalog — so it does not look like forgetfulness. */
export const RECIPE_SKIPPED =
  'Банки и биллинг сюда не попали: раз в неделю ими не пользуются, а цена ошибки выше, чем польза от инструмента.';

export const RECIPE_CHECKED_AT = '2026-11-09';

/**
 * The catalog. The order is as in the idea: mail, calendar, files, notes, news,
 * weather, home. Home Assistant can already be a shared server from config.yaml, but
 * a recipe for it is still needed: a person who has their own HA sets it up themselves.
 * Media — Kinozal (watches movies) and Video to blog post (reads talks): both
 * are about the same "media", so they stand next to each other.
 */
export const MCP_RECIPES: McpRecipe[] = [
  {
    id: 'proton-mail',
    name: 'Proton Mail',
    category: 'почта',
    when: 'Письма в Proton: найти, прочитать, ответить или разложить по папкам. Раз в неделю — да, в каждом разговоре — нет.',
    description: 'Почта Proton через Proton Mail Bridge: поиск, чтение, черновики и отправка.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '--package=proton-mail-bridge-client', 'proton-mail-bridge-mcp'],
    auth: 'headers',
    // The drafts mode is safe by default: reading and writing drafts is allowed,
    // the model cannot send or delete until the person changes the env.
    env: {
      PROTONMAIL_IMAP_HOST: '127.0.0.1',
      PROTONMAIL_IMAP_PORT: '1143',
      PROTONMAIL_IMAP_SECURE: 'false',
      PROTONMAIL_SMTP_HOST: '127.0.0.1',
      PROTONMAIL_SMTP_PORT: '1025',
      PROTONMAIL_MODE: 'drafts',
    },
    secrets: [
      { name: 'PROTONMAIL_USERNAME', hint: 'адрес Proton — он же логин в Bridge' },
      { name: 'PROTONMAIL_PASSWORD', hint: 'пароль Bridge (Account → Copy password), не пароль аккаунта' },
    ],
    secretKind: 'env',
    requires: [
      'платный тариф Proton: Bridge входит в Mail Plus и выше',
      'Proton Mail Bridge установлен, запущен и в нём добавлен аккаунт',
      'контейнер Икара достаёт до машины с Bridge по сети: по умолчанию Bridge слушает только 127.0.0.1',
    ],
    steps: [
      'В Bridge открой Account → Copy password: это локальный пароль моста, а не пароль Proton.',
      'Если Bridge стоит на другой машине, поставь в форме её адрес в PROTONMAIL_IMAP_HOST и PROTONMAIL_SMTP_HOST (порты 1143 и 1025).',
      'Впиши адрес и пароль Bridge в «Переменные окружения» и сохрани.',
    ],
    trouble: [
      'ECONNREFUSED — контейнер не достаёт до Bridge: проверяй адрес и порт, а не пароль.',
      'LOGIN failed — взял пароль аккаунта Proton вместо пароля Bridge.',
      'npx не нашёл пакет — в контейнере нет сети до registry.npmjs.org.',
      'Первый запуск долгий: npx скачивает пакет, сервер ждёт, пока это кончится.',
    ],
    caveat:
      'Bridge живёт на твоей машине и по умолчанию слушает только localhost. В контейнере Икара 127.0.0.1 — это он сам, поэтому нужен адрес машины с Bridge и проброс портов; без этого сервер добавится, но письма не прочитает.',
    docs: 'https://github.com/googlarz/proton-mail-bridge-client',
    checkedAt: '2026-11-09',
  },
  {
    id: 'calendar-caldav',
    name: 'Календарь (CalDAV)',
    category: 'календарь',
    when: 'События и задачи из календаря: «что у меня на неделе», «поставь встречу в четверг».',
    description: 'CalDAV-календарь: события, задачи и свободные окна.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'caldav-mcp'],
    auth: 'headers',
    // The address is substituted as an example: everyone has their own server, so the person edits it
    // in the form rather than getting a non-working value "out of the box".
    env: { CALDAV_BASE_URL: 'https://caldav.example.com' },
    secrets: [
      { name: 'CALDAV_USERNAME', hint: 'логин CalDAV (обычно почта)' },
      { name: 'CALDAV_PASSWORD', hint: 'пароль приложения, а не основной пароль аккаунта' },
    ],
    secretKind: 'env',
    requires: [
      'CalDAV-сервер: Fastmail, Nextcloud, iCloud, Mailfence, Mailbox.org и похожие',
      'у большинства провайдеров нужен отдельный пароль приложения',
    ],
    steps: [
      'Возьми адрес CalDAV-сервера из настроек провайдера и подставь его в CALDAV_BASE_URL.',
      'Выпиши пароль приложения — основной пароль CalDAV обычно не принимает.',
      'Впиши логин и пароль в переменные окружения и сохрани.',
    ],
    trouble: [
      'Сервер упал при старте — CALDAV_BASE_URL недоступен: discovery делает PROPFIND сразу, проверь адрес и сеть.',
      '401 — логин или пароль приложения неверный: основной пароль часто не подходит.',
      '404 — адрес не тот: у Fastmail это https://caldav.fastmail.com, у Nextcloud — …/remote.php/dav.',
      'Пустой список календарей — на сервере нет ни одного календаря или доступ к нему не выдан.',
    ],
    caveat:
      'Proton Calendar CalDAV не поддерживает (проверено 09.11.2026): события шифруются на устройстве, и протокол, который читает календарь на сервере, к ним не пускают. С Proton этот рецепт не заработает — там только ICS-подписка внутри самого Proton.',
    docs: 'https://github.com/dominik1001/caldav-mcp',
    checkedAt: '2026-11-09',
  },
  {
    id: 'files-webdav',
    name: 'Файлы (Proton Drive через rclone)',
    category: 'файлы',
    when: 'Нужно, чтобы Икар видел файлы Proton Drive: найти документ, прочитать, положить новый.',
    description: 'Файлы на WebDAV: rclone отдаёт Proton Drive по HTTP, MCP читает и пишет.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'webdav-mcp-server'],
    auth: 'headers',
    env: {
      WEBDAV_ROOT_URL: 'http://127.0.0.1:4080',
      WEBDAV_ROOT_PATH: '/',
      WEBDAV_AUTH_ENABLED: 'true',
    },
    secrets: [
      { name: 'WEBDAV_USERNAME', hint: 'логин из rclone serve webdav (--user)' },
      { name: 'WEBDAV_PASSWORD', hint: 'пароль из rclone serve webdav (--pass)' },
    ],
    secretKind: 'env',
    requires: [
      'на машине с Proton Drive настроен rclone (rclone config → protondrive)',
      'rclone serve webdav слушает сеть, а не только localhost',
      'адрес этой машины доступен из контейнера Икара',
    ],
    steps: [
      'На машине с Proton Drive запусти: rclone serve webdav --addr 0.0.0.0:4080 --user icarus --pass «пароль» protondrive:',
      'В форме замени WEBDAV_ROOT_URL на http://<адрес машины>:4080 — 127.0.0.1 здесь означает сам контейнер.',
      'Впиши логин и пароль rclone в переменные окружения и сохрани.',
    ],
    trouble: [
      'ECONNREFUSED — rclone слушает localhost или адрес машины недоступен из контейнера.',
      '401 — логин и пароль не от rclone serve webdav.',
      'Пустой список — rclone смотрит не ту папку: проверь путь после двоеточия.',
      'Нет соединения с Proton — сначала авторизуй rclone на машине, где он запущен.',
    ],
    caveat:
      'Монтирование rclone (rclone mount) контейнер Икара не видит — нужен именно WebDAV по сети. Авторизация в Proton Drive живёт на машине с rclone, в контейнер ключи Proton не уезжают.',
    docs: 'https://rclone.org/protondrive/',
    checkedAt: '2026-11-09',
  },
  {
    id: 'obsidian',
    name: 'Заметки Obsidian',
    category: 'заметки',
    when: 'Заметки и вики в Obsidian: найти, прочитать, дописать. Раз в неделю полезно, в каждом разговоре — лишний контекст.',
    description: 'Заметки Obsidian из рабочей папки: поиск, чтение, создание и правка.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'obsidian-mcp@2', 'serve', '--vault', 'notes=/workspaces/notes'],
    auth: 'none',
    secrets: [],
    secretKind: 'env',
    requires: [
      'папка vault лежит внутри рабочей папки человека, например <dataDir>/users/<id>/workspaces/notes',
      'в папке есть .obsidian: это настоящий vault, а не просто каталог с markdown',
    ],
    steps: [
      'Скопируй или синхронизируй vault в рабочую папку «notes» — в контейнере это /workspaces/notes.',
      'Если папка называется иначе, поправь аргументы: --vault notes=/workspaces/имя.',
      'Добавь сервер: ключи не нужны.',
    ],
    trouble: [
      'ENOENT — путь в контейнере другой: /workspaces/<имя рабочей папки>, а не путь на хосте.',
      '«not a vault» — нет каталога .obsidian: Obsidian ни разу не открывал эту папку.',
      'Изменения не видны — Obsidian держит свой кеш; переоткрой vault в приложении.',
    ],
    caveat:
      'Контейнер видит только рабочие папки, shared и artifacts. Vault в Documents на хосте до Икара не доедет, пока не окажется внутри рабочей папки.',
    docs: 'https://github.com/StevenStavrakis/obsidian-mcp',
    checkedAt: '2026-11-09',
  },
  {
    id: 'opds',
    name: 'OPDS-каталог',
    category: 'книги',
    when: 'Книги из OPDS-каталога: найти, посмотреть карточку и скачать в папку вложений. Раз в неделю — да, в каждом разговоре — лишний контекст.',
    description: 'Универсальный книжный каталог по OPDS: поиск, разделы, карточка книги и скачивание файла в incoming.',
    transport: 'stdio',
    command: 'node',
    args: ['/opt/icarus/tools/opds-mcp/server.mjs'],
    auth: 'none',
    // The address is an example of a public catalog: it is visible in the form and can be replaced with
    // your own (Calibre, home library). The site is not hardcoded in the server code.
    env: { OPDS_URL: 'https://www.gutenberg.org/ebooks.opds/' },
    // The catalog may be closed with a password: then these keys are needed. They are personal and
    // optional — an open catalog works without them.
    secrets: [
      { name: 'OPDS_USER', hint: 'логин каталога (basic), если он закрыт паролем' },
      { name: 'OPDS_PASSWORD', hint: 'пароль каталога (basic)' },
      { name: 'OPDS_TOKEN', hint: 'Bearer-токен, если каталог пускает по токену' },
    ],
    secretsOptional: true,
    secretKind: 'env',
    requires: [
      'сеть из контейнера до OPDS-каталога',
      'адрес корня каталога: Project Gutenberg, Calibre или домашняя библиотека с OPDS',
    ],
    steps: [
      'Проверь OPDS_URL: у Project Gutenberg это https://www.gutenberg.org/ebooks.opds/, у Calibre — http://<адрес>:8080/opds/. Адрес самой страницы сайта не подходит: нужен именно OPDS-фид.',
      'Если каталог закрыт паролем, впиши OPDS_USER и OPDS_PASSWORD (basic) или OPDS_TOKEN (Bearer) в «Переменные окружения»: это секреты, они останутся только у тебя.',
      'Добавь сервер: открытый каталог готов сразу, ключей не нужно.',
    ],
    trouble: [
      '«ответ не Atom/OPDS» — в OPDS_URL вписан не каталог, а HTML-страница: нужен адрес с .opds/ или /opds/.',
      '401/403 — каталог требует авторизации: добавь OPDS_USER/OPDS_PASSWORD или OPDS_TOKEN.',
      'Ничего не найдено — каталог разобрался, но по запросу пусто: проверь написание или открой разделы через catalog_browse.',
      'ECONNREFUSED или таймаут — адрес недоступен из контейнера: 127.0.0.1 внутри контейнера — это он сам, нужен адрес машины с каталогом.',
    ],
    caveat:
      'Скачивание пишет файл в incoming/ и требует confirm: true; лимит размера — OPDS_MAX_DOWNLOAD_MB (по умолчанию 25 МБ). Рецепт — только транспорт: за легальность выбранного каталога отвечает тот, кто его добавил.',
    docs: 'https://specs.opds.io/',
    checkedAt: '2026-11-12',
  },
  {
    id: 'rss',
    name: 'RSS и новости',
    category: 'новости',
    when: 'Сводка по подпискам раз в неделю: что нового в блогах, релизах и местных новостях.',
    description: 'RSS/Atom и RSSHub: свежие записи по ссылке на ленту.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'rss-reader-mcp'],
    auth: 'none',
    secrets: [],
    secretKind: 'env',
    requires: ['сеть из контейнера до выбранных лент'],
    steps: [
      'Добавь сервер: ключи не нужны.',
      'В разговоре дай ссылку на ленту — fetch_feed_entries понимает RSS и Atom.',
      'Если нужен полный текст статьи, fetch_article_content скачает и переведёт его в markdown.',
    ],
    trouble: [
      'Пустой ответ — лента отдаёт 403/404 или это не RSS: проверь ссылку в браузере.',
      'Таймаут — сайт закрыт от ботов; попробуй другую ленту.',
      'npx не нашёл пакет — в контейнере нет сети до registry.npmjs.org.',
    ],
    caveat:
      'Пакет community: запуск, tools/list и разбор живой ленты проверены 09.11.2026. Заголовки и тексты лент уезжают модели — как и всё, что она читает.',
    docs: 'https://github.com/kwp-lab/rss-reader-mcp',
    checkedAt: '2026-11-09',
  },
  {
    id: 'weather-dublin',
    name: 'Погода в Дублине',
    category: 'погода',
    when: 'Погода на день и неделю в Дублине: брать ли зонт. Вопрос раз в неделю, а не раз в час.',
    description: 'Погода в Дублине: текущие условия, прогноз и предупреждения.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@dangahagan/weather-mcp@latest'],
    auth: 'none',
    // basic — six tools instead of seventeen: less context in each
    // conversation. For "weather in Dublin" nothing else is needed.
    env: { WEATHER_UNITS: 'metric', ENABLED_TOOLS: 'basic' },
    secrets: [],
    secretKind: 'env',
    requires: ['сеть из контейнера до Open-Meteo и NOAA'],
    steps: [
      'Добавь сервер: ключи не нужны.',
      'Спроси «погода в Дублине на неделю» — геокодер сам найдёт город.',
    ],
    trouble: [
      'Нет данных — upstream ответил 429: лимиты бесплатные, но не бесконечные, подожди.',
      'Первый запуск долгий — npx скачивает пакет.',
      'Погода в Фаренгейтах — в форме потерялся WEATHER_UNITS=metric.',
    ],
    caveat:
      'ENABLED_TOOLS=basic оставляет шесть инструментов; полный набор включается значением all, но он занимает заметно больше контекста.',
    docs: 'https://github.com/weather-mcp/weather-mcp',
    checkedAt: '2026-11-09',
  },
  {
    id: 'homeassistant',
    name: 'Home Assistant',
    category: 'дом',
    when: 'Свет, климат, сцены и датчики: «выключи свет в гостиной», «какая температура дома».',
    description: 'Умный дом: состояния устройств, сцены и сервисы Home Assistant.',
    transport: 'streamable-http',
    url: 'http://homeassistant.local:8123/api/mcp',
    auth: 'headers',
    secrets: [{ name: 'Authorization', hint: 'Bearer <долгоживущий ключ доступа HA>' }],
    secretKind: 'header',
    requires: [
      'Home Assistant с включённой интеграцией Model Context Protocol Server',
      'долгоживущий ключ: <адрес HA>/profile/security → Long-lived access tokens',
      'адрес HA доступен из контейнера Икара (homeassistant.local или IP)',
    ],
    steps: [
      'Создай токен в профиле HA: он показывается один раз, потом только перевыпуск.',
      'Замени адрес в форме на свой, если homeassistant.local не резолвится.',
      'Впиши «Authorization: Bearer …» в «Ключ доступа» и сохрани.',
    ],
    trouble: [
      '401 — токен неверный или отозван: выпиши новый.',
      '403 — интеграция требует администратора, а токен не админский.',
      'ECONNREFUSED — адрес HA недоступен из контейнера или порт другой.',
    ],
    caveat:
      'Если общий homeassistant уже заведён в config.yaml, второй такой же в панели не нужен: включи общий себе.',
    docs: 'https://www.home-assistant.io/integrations/mcp_server/',
    checkedAt: '2026-11-09',
  },
  {
    id: 'kinozal',
    name: 'Кинозал (Radarr/Sonarr)',
    category: 'медиа',
    when: 'Фильм или сериал: найти, посмотреть, что уже скачано и сколько места, и заказать загрузку после явного «да».',
    description: 'Кинозал: Radarr и Sonarr — поиск, коллекция, очередь, диски и профили качества; заказ файла отдельным инструментом с подтверждением.',
    transport: 'stdio',
    // The server comes into the container from the repository: the same path as compose mounts.
    // The recipe has no code of its own — it is a description of what already lies in the image.
    command: 'node',
    args: ['/opt/icarus/tools/arr-mcp/server.mjs'],
    auth: 'headers',
    // The person also enters the addresses: 127.0.0.1 in the container is the container itself,
    // not the machine with Radarr, so substituting an "example from memory" is harmful.
    secrets: [
      { name: 'ARR_RADARR_URL', hint: 'адрес Radarr, видимый из контейнера: http://<хост>:7878' },
      { name: 'ARR_RADARR_KEY', hint: 'Radarr → Settings → General → API Key' },
      { name: 'ARR_SONARR_URL', hint: 'адрес Sonarr, видимый из контейнера: http://<хост>:8989' },
      { name: 'ARR_SONARR_KEY', hint: 'Sonarr → Settings → General → API Key' },
    ],
    secretKind: 'env',
    requires: [
      'Radarr и/или Sonarr уже настроены и отдают API по сети',
      'адрес сервиса доступен из контейнера агента: IP или имя хоста, а не 127.0.0.1',
    ],
    steps: [
      'Выпиши API Key: в Radarr и Sonarr это Settings → General → API Key.',
      'Впиши адреса и ключи в переменные окружения: можно заполнить только пару Radarr или только пару Sonarr — второй сервис тогда честно скажет «не настроен».',
      'Спроси «что есть из фильмов Нолана» — arr_lookup только ищет. Заказ файла — отдельный arr_add, он сработает после явного «добавь».',
    ],
    trouble: [
      'ECONNREFUSED или таймаут — контейнер не достаёт до адреса: проверь IP и порт, а не ключ.',
      '401 — ключ не от того сервиса или скопирован с лишними пробелами.',
      '«не настроен» — не заполнена пара ARR_*_URL и ARR_*_KEY для этого сервиса.',
      'arr_add отказал — в вызове нет confirm: true; это защита от заказа по интонации, а не поломка.',
    ],
    caveat:
      'Поиск и заказ разведены намеренно: arr_add выполняется только с confirm: true, после явного «добавь/закажи». Профиль качества и корневую папку сервер читает с самого Radarr/Sonarr, а если их несколько — просит выбрать, а не угадывает.',
    docs: 'https://github.com/trousev/icarus/tree/main/tools/arr-mcp',
    checkedAt: '2026-11-09',
  },
  {
    id: 'video-blog',
    name: 'Видео в блог-пост',
    category: 'медиа',
    when: 'Ролик, доклад или подкаст нужно прочитать, а не смотреть: расшифровка и готовый пост. Раз в неделю — да, в каждом разговоре — лишний контекст.',
    description: 'Видео в блог-пост: yt-dlp скачивает звук, Whisper расшифровывает, DeepSeek переписывает транскрипт в Markdown-пост с заголовком и разделами.',
    transport: 'stdio',
    // The server comes into the container from the repository: the recipe has no code of its own, only a description.
    command: 'node',
    args: ['/opt/icarus/tools/video-blog-mcp/server.mjs'],
    auth: 'none',
    // The settings are non-secret and deliberately visible: they can be changed in the form without touching the code.
    env: {
      VIDEO_BLOG_ASR_MODEL: 'openai/whisper-large-v3-turbo',
      VIDEO_BLOG_LLM_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash',
    },
    secrets: [],
    secretKind: 'env',
    requires: [
      'ключ DeepInfra в окружении контейнера — тот же DEEPINFRA_API_KEY, на котором работает сам Икар',
      'сеть из контейнера до сайта с видео (YouTube и всё, что понимает yt-dlp) и до api.deepinfra.com',
    ],
    steps: [
      'Добавь сервер: своих ключей он не спрашивает — работает на ключе Икара.',
      'Скажи «сделай блог-пост из <ссылка>» — модель позовёт video_to_blog и вернёт путь к файлу.',
      'Нужна только расшифровка — попроси «расшифруй это видео»: сработает video_transcribe, без переписывания в пост.',
      'Прогреться заранее: blog_status с install: true скачает yt-dlp (39 МБ) и ffmpeg (76 МБ) до первого ролика.',
    ],
    trouble: [
      '«нет ключа» — в контейнере нет DEEPINFRA_API_KEY: без него не работают ни расшифровка, ни пост.',
      '«yt-dlp не смог прочитать видео» — ссылка недоступна из контейнера, это плейлист или сайт закрылся от ботов.',
      '«транскрипт пустой» — в записи нет речи: это не поломка сервера, а ответ.',
      'Первый вызов долгий — скачиваются бинарники; дальше они живут в кэше и переживают пересоздание контейнера.',
      '«больше лимита 240 мин» — подними VIDEO_BLOG_MAX_MINUTES в форме, если часовой ролик нужен осознанно.',
    ],
    caveat:
      'Сервер сам скачивает себе yt-dlp и ffmpeg в /workspaces/.icarus/tools/video-blog — из образа их нет, и это сделано нарочно: бинарники не запекаются в контейнер. ffmpeg нужен только для нарезки аудио длиннее 24 МБ, короткие видео обходятся без него. Пост — пересказ, а не цитата: для цитат рядом всегда лежит .transcript.txt со словами говорящего.',
    docs: 'https://github.com/trousev/icarus/tree/main/tools/video-blog-mcp',
    checkedAt: '2026-11-13',
  },
];

/** Recipe by id. An unknown id is not a panel error but a 404 in the handler. */
export function recipeById(id: string): McpRecipe | undefined {
  return MCP_RECIPES.find((recipe) => recipe.id === id);
}

/**
 * What the form gets from the recipe. The form already knows how to open with the "editor"
 * of a saved server (server + key names), so the recipe arrives in the same
 * shape: command and settings filled in, only key values remain empty.
 */
export type McpRecipeEditor = {
  recipe: McpRecipe;
  server: {
    name: string;
    description: string;
    transport: McpTransport;
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    env?: Record<string, string>;
    auth: McpAuthType;
  };
  credentialHeaders: string[];
  credentialEnv: string[];
  /** What the server will expect from the person: key names, values empty. */
  expectsHeaders: string[];
  expectsEnv: string[];
  oauth: null;
  global: false;
};

export function recipeEditor(recipe: McpRecipe): McpRecipeEditor {
  const secrets = recipe.secrets.map((secret) => secret.name);
  return {
    recipe,
    server: {
      name: recipe.name,
      description: recipe.description,
      transport: recipe.transport,
      ...(recipe.url === undefined ? {} : { url: recipe.url }),
      ...(recipe.command === undefined ? {} : { command: recipe.command }),
      ...(recipe.args === undefined ? {} : { args: [...recipe.args] }),
      ...(recipe.headers === undefined ? {} : { headers: { ...recipe.headers } }),
      ...(recipe.env === undefined ? {} : { env: { ...recipe.env } }),
      auth: recipe.auth,
    },
    credentialHeaders: recipe.secretKind === 'header' ? secrets : [],
    credentialEnv: recipe.secretKind === 'env' ? secrets : [],
    expectsHeaders: recipe.secretKind === 'header' ? secrets : [],
    expectsEnv: recipe.secretKind === 'env' ? secrets : [],
    oauth: null,
    global: false,
  };
}
