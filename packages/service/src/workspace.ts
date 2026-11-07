// Подготовка рабочего окружения пользователя на хосте: каталоги, AGENTS.md,
// конфиги pi (auth.json, models.json, settings.json, mcp.json) и наши расширения.
//
// Всё содержимое — общее (модели, ключи, MCP, маунты из config.yaml); от человека
// зависит только то, куда это кладётся: каталог в dataDir и имя контейнера.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.ts';
import { renderModelsJson } from './providers.ts';
import {
  CONTAINER_PATHS,
  mcpLifecycle,
  REPO_ROOT,
  userPaths,
  userContainer,
  type IcarusConfig,
  type McpServerConfig,
  type UserConfig,
} from './config.ts';
import { effectiveServers, ensureOAuthProxyKeys, readStore, storePaths } from './mcp/registry.ts';
import { ensureWorkspaces } from './workspaces.ts';
import { renderSessionsMap } from './sessions/chats.ts';
import { DEFAULT_LANGUAGE, languageName, languageOf, type Language } from './profile.ts';

const EXTENSIONS_DIR = path.join(REPO_ROOT, 'packages', 'extensions');

export type PreparedUser = ReturnType<typeof prepareUser>;

/** Старое хозяйство лежало прямо в каталоге человека: переносим его в .icarus. */
function migrateLayout(paths: ReturnType<typeof userPaths>): void {
  const moves: Array<[string, string]> = [
    [path.join(paths.root, 'memory'), paths.memory],
    [path.join(paths.root, 'incoming'), paths.incoming],
    [path.join(paths.root, 'sessions'), paths.sessions],
    [path.join(paths.root, 'AGENTS.md'), paths.agentsMd],
    [path.join(paths.root, 'icarus.md'), paths.icarusMd],
  ];
  for (const [from, to] of moves) {
    // Переносим только когда старого места ещё есть что переносить, а нового нет:
    // повторный запуск ничего не трогает, а данные человека не теряются.
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      // Другой файл уже занял место — старый оставляем как есть, падать не за что.
    }
  }
}

export function ensureDirs(config: IcarusConfig, user: UserConfig): void {
  const paths = userPaths(config, user);
  migrateLayout(paths);
  for (const dir of [
    paths.workspaces,
    paths.icarus,
    paths.memory,
    paths.incoming,
    paths.sessions,
    paths.piAgent,
    // Каталог скиллов заводим заранее и пустым: так его видит pi. prepareUser его
    // не чистит — это не управляемый каталог расширений, а место для скиллов человека,
    // куда пишет панель (и заводит внутри него git-репозиторий, см. control/skills.ts).
    paths.skills,
    paths.sharedMemory,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Каталог математики не заводим: файлы расчётов Maple теперь живут в рабочей
  // папке разговора, рядом с остальной работой человека.
  for (const sub of ['people', 'projects', 'journal']) {
    fs.mkdirSync(path.join(paths.memory, sub), { recursive: true });
  }
  // shared-memory монтируется вложенно внутрь /workspaces/.icarus: точку монтирования
  // заводим заранее, иначе docker создаст её root-овой внутри маунта.
  fs.mkdirSync(path.join(paths.icarus, 'shared-memory'), { recursive: true });
  // Реестр разговоров монтируется в контейнер файлом, а не каталогом: если файла нет,
  // docker создаст на его месте каталог и маунт останется пустым. Пустой реестр — это
  // валидное состояние (разговоров ещё нет), поэтому заводим его сами.
  if (!fs.existsSync(paths.chats)) {
    fs.writeFileSync(paths.chats, `${JSON.stringify({ chats: [] }, null, 2)}\n`, { mode: 0o600 });
  }
  // То же и для карты разговоров: она пересоздаётся перед каждым стартом (см. prepareUser),
  // но к моменту генерации compose файл уже должен существовать.
  if (!fs.existsSync(paths.sessionsMap)) {
    fs.writeFileSync(paths.sessionsMap, `${JSON.stringify({ sessions: [] }, null, 2)}\n`, { mode: 0o600 });
  }
  // «Разговор» и «Приватный» существуют всегда — вместе с их AGENTS.md.
  ensureWorkspaces(config, user);
}

/**
 * Подсказка про MCP-серверы, которые подключаются по требованию. Без неё модель
 * не знает, что сервер вообще есть: при lifecycle: lazy его инструментов в промпте
 * нет, а mcp_connect сам по себе никто не позовёт. Описание сервера (description)
 * говорит, когда он нужен, — это и есть дешёвый триггер вместо отдельного скилла.
 */
function renderMcpOnDemand(servers: Record<string, McpServerConfig>): string {
  const lazy = Object.entries(servers).filter(([, server]) => mcpLifecycle(server) === 'lazy');
  if (lazy.length === 0) return '';

  const bullets = lazy.map(([name, server]) => {
    const description = (server.description ?? '').replace(/\s+/g, ' ').trim();
    return `- \`${name}\`${description ? ` — ${description}` : ''}`;
  });

  return `
## MCP-инструменты по требованию

Эти серверы не подключены заранее: их инструменты не висят в каждом разговоре.
Перед первым использованием вызови \`mcp_connect\` с \`name: "<имя>"\`, дождись
подключения и работай появившимися инструментами. Посмотреть состояние — \`mcp_status\`.

${bullets.join('\n')}
`;
}

/**
 * Карта окружения: то, что агент читает как AGENTS.md.
 *
 * Серверы приходят снаружи: у каждого человека свой набор — общие из config.yaml
 * плюс его включённые пользовательские. Выключенные сюда не попадают вовсе, иначе
 * модель звала бы `mcp_connect` на сервер, которого у неё нет.
 */
export function renderAgentsMd(
  config: IcarusConfig,
  servers: Record<string, McpServerConfig> = config.mcp,
  /** Язык ответов этого человека: он меняет только раздел «Язык», всё остальное — общее. */
  language: Language = config.userLanguage ?? DEFAULT_LANGUAGE,
): string {
  const home = CONTAINER_PATHS.home;
  const workspaces = CONTAINER_PATHS.workspaces;
  const rows = [
    `| \`${workspaces}/<workspace>/\` | **рабочая папка**: та, в которой ты сейчас | работай и твори здесь |`,
    `| \`${home}/memory/\` | **личная память** этого человека | читай смело, пиши когда просят запомнить |`,
    `| \`${home}/shared-memory/\` | **семейная память**, общая для всех | писать **только по явной просьбе** |`,
    `| \`${home}/incoming/\` | вложения из чата | разбирай сам: прочитай, посмотри, разложи |`,
    `| \`${home}/chats.json\` | **реестр разговоров** (только чтение): id, канал, workspace | сам агент в него не пишет |`,
    `| \`${home}/sessions.json\` | **карта разговоров** (только чтение): conversationId → sessionId и файл | по ссылке из панели найдёшь сессию |`,
    `| \`${home}/icarus.md\` | твой системный промпт | не редактируй |`,
  ];

  const mcp = renderMcpOnDemand(servers);

  return `# Где ты находишься

Ты работаешь в контейнере. Рабочих пространств (workspace) несколько: каждое — своя
папка в \`${workspaces}\`, и одна из них сейчас твоя — она названа в подсказке к
разговору. Служебное — память, вложения, сессии и твои промпты — лежит рядом, в
\`${home}\`, и **не входит ни в один workspace**: это внутреннее хозяйство Икара.

| Путь | Что это | Как обращаться |
|---|---|---|
${rows.join('\n')}
${mcp}
## Как устроены workspace'ы

- Каждый workspace — отдельная папка \`${workspaces}/<имя>\` со своим \`AGENTS.md\`:
  правила этой папки читай там же.
- Служебное лежит вне рабочих папок — в \`${home}\`. Память одна на все workspace'ы:
  что узнал в одном, помнишь и в другом.
- В «Приватном» workspace всё только для чтения: писать в память и в файлы нельзя.

## Как устроена память

Память лежит в \`${home}/memory\`:

- \`identity.md\` — кто этот человек: имя, привычки, устойчивые предпочтения.
- \`preferences.md\` — вкусы, табу, как с ним разговаривать. Здесь и в identity — только устойчивое.
- \`people/\` — люди вокруг: по файлу на человека.
- \`projects/\` — длящиеся дела и временные состояния: здоровье, бумаги, работа, переезд, ремонт.
  Датированной строкой состояния: «по состоянию на 21.09.2026 — …».
- \`journal/YYYY-MM.md\` — журнал: события по датам, построчно. В подсказку он не
  подмешивается: что было раньше — читай файлом, когда это и правда нужно.

Правила простые: не дублируй то, что уже написано; противоречия не копи, а правь старую запись;
в журнал пиши коротко и с датой. Что может измениться — держи в \`projects/\` с датой, а не в
\`identity.md\`. Структуру можно расширять, если смысла не хватает.

## Как связать разговор с сессией pi

Ссылка на разговор в панели выглядит как \`.../panel/chat?chat=<conversationId>\`:
\`web-…\` — веб-чат, \`telegram-…\` — разговор в Telegram.

Сам файл истории по одному \`conversationId\` не найти: имя файла — \`<время создания>_<sessionId>.jsonl\`,
а \`sessionId\` — это хеш от человека и разговора, и человека ты не знаешь. Поэтому не считай
хеш сам, а возьми готовую карту:

1. Возьми \`conversationId\` из ссылки.
2. Найди его в \`${home}/sessions.json\` — там \`conversationId\` и готовый \`sessionId\` и путь к файлу.
3. Открой файл истории и проверь первые реплики: это точно тот разговор?

Одинаковые куски текста (id вложений, цитаты) встречаются у разных чатов — совпадение
подстроки ничего не доказывает. Особенно осторожно с \`grep\` по всем сессиям сразу.

## Границы

- \`${home}/shared-memory/\` — только по явной просьбе. Сомневаешься — пиши в личное.
- Не удаляй чужие файлы и не трогай ничего за пределами \`${workspaces}\`.
${languageRule(language)}`;
}

/**
 * Язык ответов — настройка человека, а не свойство разговора.
 *
 * Здесь остаётся только то, чего НЕ несёт правило у реплики (language.ts): там короткая
 * строка «твой язык — X, не зеркаль», и она держит обычный случай лучше любого абзаца
 * в промпте (136 символов давали 10/10 там, где 894 — 9/10; см. PR #114). А этот раздел
 * держит исключения — разовую просьбу и режим, — которых у реплики нет и быть не может:
 * просьба сформулирована словами самого человека в конкретный ход.
 * Держим коротким: раздел едет в каждый разговор, а его сценарий — редкий.
 *
 * Язык меняет ТОЛЬКО язык реплик. Характер, шутки, объём и «сначала свой, потом
 * смешной» остаются как есть: иначе англоязычный Икар оказался бы другим
 * человеком, а это уже не локализация, а вторая личность (см. icarus.md).
 *
 * Экспортируется ради стенда (tools/persona-flywheel/probe-language.mjs): он собирает
 * системное сообщение как сервис и должен брать правило отсюда, а не держать копию.
 * Копия однажды разъедется с боевым текстом — и стенд будет проверять не то, что в бою.
 */
export function languageRule(language: Language): string {
  // Имя языка — полное и на нём самом, без кода: в промпт идёт «English», а не «en».
  const name = languageName(language);
  return `
## ЯЗЫК КОММУНИКАЦИИ

Отвечай на языке: **${name}** — это настройка человека, а не язык его реплики:
пишет по-русски, цитирует лог, вставляет чужую фразу — отвечаешь всё равно на ${name}.
Характер, шутки и краткость те же, только на ${name}; слова, которые не переводятся
(термин, имя, кусок кода), оставляешь как есть; про язык не переспрашиваешь.

**Прямая просьба человека важнее настройки** — выполни её и не спорь с ней:

- **Разово** («ответь на грузинском», «вот это переведи») — отвечаешь на нём
  ровно один раз и возвращаешься к ${name}.
- **Режим** («с этого момента ты переводчик», «дальше пиши по-испански», «переводи всё,
  что я пишу») — держишь, пока человек его не снимет («хватит», «дальше как обычно»).

Сомневаешься, разово или режим, — считай разовым: лишний режим труднее отменить.
`;
}

/** Ключи провайдеров в формате pi: ~/.pi/agent/auth.json. */
export function renderAuthJson(config: IcarusConfig): string {
  const entries = Object.entries(config.auth).map(([provider, key]) => [provider, { type: 'api_key', key }]);
  return JSON.stringify(Object.fromEntries(entries), null, 2) + '\n';
}

/** Пакеты pi: подключаем MCP-мост только если у человека есть хоть один сервер. */
export function renderSettingsJson(
  config: IcarusConfig,
  mcpServers: Record<string, McpServerConfig> = config.mcp,
): string {
  const servers = Object.keys(mcpServers);
  const settings: Record<string, unknown> = {};
  // 1.8.0 — первая версия с mcp_connect/mcp_status. Без них lifecycle: lazy
  // превращается в ловушку: инструменты сервера не активны, а подключить его
  // из разговора нечем (в 1.5.0 был только ручной /mcp:start).
  if (servers.length > 0) settings.packages = ['npm:pi-mcp-extension@1.8.0'];
  return JSON.stringify(settings, null, 2) + '\n';
}

/**
 * ~/.pi/agent/mcp.json — то, что читает pi-mcp-extension.
 *
 * Заголовки HTTP-серверов едут сюда как есть, вместе с ключом доступа: файл лежит
 * рядом с auth.json, поэтому пишется закрытым на чтение (см. prepareUser).
 */
export function renderMcpJson(
  config: IcarusConfig,
  mcpServers: Record<string, McpServerConfig> = config.mcp,
): string {
  const servers = Object.fromEntries(
    Object.entries(mcpServers).map(([name, server]) => [
      name,
      {
        transport: server.transport ?? (server.url ? 'streamable-http' : 'stdio'),
        ...(server.command ? { command: server.command } : {}),
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        ...(server.url ? { url: server.url } : {}),
        ...(server.headers ? { headers: server.headers } : {}),
        lifecycle: mcpLifecycle(server),
      },
    ]),
  );
  return JSON.stringify({ settings: { toolPrefix: 'mcp', requestTimeoutMs: 30000 }, mcpServers: servers }, null, 2) + '\n';
}

/**
 * Записывает файл, снося каталог с тем же именем.
 * Docker при монтировании несуществующего пути создаёт каталог — после этого обычная
 * запись файла падает с EISDIR, поэтому подстраховываемся.
 */
function writeFileSafe(target: string, content: string, mode?: number): void {
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.writeFileSync(target, content, mode ? { mode } : undefined);
}

function copyDirFiles(from: string, to: string, depth = 0): string[] {
  if (!fs.existsSync(from)) {
    // Молча ничего не скопировать — худший вариант: агент останется без персоны и памяти,
    // а мы будем думать, что расширения на месте.
    throw new Error(`каталог расширений не найден: ${from}`);
  }
  fs.mkdirSync(to, { recursive: true });
  const copied: string[] = [];

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      // подкаталоги вроде lib/ — это общие модули, pi их расширениями не считает
      copied.push(...copyDirFiles(source, target, depth + 1).map((name) => `${entry.name}/${name}`));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    fs.copyFileSync(source, target);
    copied.push(entry.name);
  }

  if (depth === 0 && copied.length === 0) throw new Error(`в ${from} нет ни одного .ts расширения`);
  return copied;
}

export function prepareUser(config: IcarusConfig, user: UserConfig) {
  ensureDirs(config, user);
  const paths = userPaths(config, user);

  // Пользовательские MCP: включённые и готовые серверы добавляются к общим.
  // Хранилище может быть сломано (правили руками, кончилось место) — тогда
  // человек остаётся с серверами из config.yaml, а не без разговора вовсе.
  let mcpServers: Record<string, McpServerConfig> = config.mcp;
  try {
    fs.mkdirSync(storePaths(config).dir, { recursive: true, mode: 0o700 });
    // Старым OAuth-записям нужен ключ прокси: без него токен снова уедет в
    // mcp.json и протухнет прямо в живом разговоре.
    const keys = ensureOAuthProxyKeys(config, user.id);
    if (keys.length > 0) log.info('MCP: OAuth-серверы переведены на локальный прокси', { user: user.id, servers: keys });
    const merged = effectiveServers(config, readStore(config), user.id);
    mcpServers = merged.servers;
    if (merged.skipped.length > 0) {
      log.debug('MCP: серверы пропущены при сборке окружения', { user: user.id, servers: merged.skipped });
    }
  } catch (error) {
    log.warn('MCP: хранилище не прочиталось — остаются только общие серверы', {
      user: user.id,
      error: String(error),
    });
  }

  // Язык — из профиля человека: он меняет только раздел «Язык» в карте окружения,
  // поэтому читается здесь, а не живёт в общем config.yaml.
  writeFileSafe(paths.agentsMd, renderAgentsMd(config, mcpServers, languageOf(config, user)));

  // Карта разговоров для агента: по ссылке из панели он находит файл сессии в этом
  // же ответе, а не гадает по именам файлов. Перерисовываем при каждом старте —
  // за время жизни контейнера разговоры успевают появиться, переименоваться и уехать
  // в другой workspace (см. sessions/chats.ts).
  try {
    writeFileSafe(paths.sessionsMap, renderSessionsMap(config, user));
  } catch (error) {
    // Сломанный реестр — не повод не пускать человека в разговор: агент просто
    // останется без карты (и в AGENTS.md написано, что она read-only).
    log.warn('карта разговоров не собралась', { user: user.id, error: String(error) });
  }

  const authPath = path.join(paths.piAgent, 'auth.json');
  writeFileSafe(authPath, renderAuthJson(config), 0o600);
  fs.chmodSync(authPath, 0o600);

  writeFileSafe(path.join(paths.piAgent, 'settings.json'), renderSettingsJson(config, mcpServers));

  // mcp.json может везти ключ доступа к MCP-серверу, поэтому права те же, что у
  // auth.json: ключ модели и ключ к чужому сервису одинаково не для чужих глаз.
  const mcpPath = path.join(paths.piAgent, 'mcp.json');
  writeFileSafe(mcpPath, renderMcpJson(config, mcpServers), 0o600);
  fs.chmodSync(mcpPath, 0o600);

  // models.json — описание кастомных провайдеров (DeepInfra): без него pi не найдёт
  // ни самой модели, ни её адреса. Пишем всегда, даже пустым: файл управляемый, и
  // оставшийся от прежней конфигурации провайдер не должен пережить свой config.yaml.
  writeFileSafe(path.join(paths.piAgent, 'models.json'), renderModelsJson(config.models));

  // Персона одна на всех, источник истины — репозиторий: при старте перезаписываем копию
  // в каталоге пользователя, иначе правки в icarus.md не доедут до существующих людей.
  const personaSource = path.join(REPO_ROOT, 'icarus.md');
  if (fs.existsSync(personaSource)) {
    writeFileSafe(paths.icarusMd, fs.readFileSync(personaSource, 'utf8'));
  } else {
    log.warn('icarus.md не найден — агент останется на дефолтном промпте', { source: personaSource });
  }

  // Старая инструкция по Maple жила отдельным файлом; теперь правила в описаниях
  // инструментов, и оставленный файл только путал бы агента. Это наш управляемый
  // файл, поэтому убираем его без вопросов (расчётов в нём нет).
  const legacyMapleMd = path.join(paths.icarus, 'MAPLE.md');
  if (fs.existsSync(legacyMapleMd)) fs.rmSync(legacyMapleMd, { force: true });

  // Каталог расширений — управляемый: чистим его, иначе после переименований там
  // остаются старые копии, которые pi продолжит загружать как расширения.
  const extensionsDir = path.join(paths.piAgent, 'extensions');
  fs.rmSync(extensionsDir, { recursive: true, force: true });
  const extensions = copyDirFiles(EXTENSIONS_DIR, extensionsDir);
  log.debug('окружение пользователя готово', {
    user: user.id,
    extensions: extensions.length,
    container: userContainer(config, user),
  });

  return { paths, extensions };
}
