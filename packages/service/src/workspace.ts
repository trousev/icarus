// Preparing the user's working environment on the host: directories, AGENTS.md,
// pi configs (auth.json, models.json, settings.json, mcp.json) and our extensions.
//
// All content is shared (models, keys, MCP, mounts from config.yaml); only where it is
// placed depends on the person: the directory in dataDir and the container name.
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
import {
  enabledSharedPaths,
  storePaths as skillStorePaths,
  syncShared,
} from './skills/registry.ts';
import { ensureWorkspaces } from './workspaces.ts';
import { migrateLegacyArtifacts, ensureArtifactsRoot } from './artifacts.ts';
import { renderSessionsMap } from './sessions/chats.ts';
import { DEFAULT_LANGUAGE, languageName, languageOf, type Language } from './profile.ts';

const EXTENSIONS_DIR = path.join(REPO_ROOT, 'packages', 'extensions');

export type PreparedUser = ReturnType<typeof prepareUser>;

/** The old household lay right in the person's directory: we move it into .icarus. */
function migrateLayout(paths: ReturnType<typeof userPaths>): void {
  const moves: Array<[string, string]> = [
    [path.join(paths.root, 'memory'), paths.memory],
    [path.join(paths.root, 'incoming'), paths.incoming],
    [path.join(paths.root, 'sessions'), paths.sessions],
    [path.join(paths.root, 'AGENTS.md'), paths.agentsMd],
    [path.join(paths.root, 'icarus.md'), paths.icarusMd],
  ];
  for (const [from, to] of moves) {
    // We move only when the old place still has something to move and the new one does not:
    // a repeated run touches nothing and the person's data is not lost.
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      // Another file already took the place — we leave the old one as is, there is nothing to crash over.
    }
  }
}

export function ensureDirs(config: IcarusConfig, user: UserConfig): void {
  const paths = userPaths(config, user);
  migrateLayout(paths);
  // The global artifact library lives in dataDir and is mounted for everyone as
  // /artifacts. We create it before the containers: otherwise docker would create the mount point as root.
  ensureArtifactsRoot(config);
  // Shared skills too before the containers: the directory is mounted read-only,
  // and if docker creates it itself, the permissions will be root's and the panel will not be able to write.
  fs.mkdirSync(skillStorePaths(config).shared, { recursive: true });
  for (const dir of [
    paths.workspaces,
    paths.icarus,
    paths.memory,
    paths.incoming,
    paths.sessions,
    paths.piAgent,
    // We create the skills directory in advance and empty: that is how pi sees it. prepareUser does
    // not clean it — this is not a managed extensions directory but a place for the person's skills,
    // where the panel writes (and creates a git repository inside it, see control/skills.ts).
    paths.skills,
    paths.sharedMemory,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // We do not create the math directory: Maple computation files now live in the working
  // folder of the conversation, next to the rest of the person's work.
  for (const sub of ['people', 'projects', 'journal']) {
    fs.mkdirSync(path.join(paths.memory, sub), { recursive: true });
  }
  // shared-memory and shared-skills are mounted nested inside /workspaces/.icarus:
  // we create the mount points in advance, otherwise docker will create them as root inside the mount.
  fs.mkdirSync(path.join(paths.icarus, 'shared-memory'), { recursive: true });
  fs.mkdirSync(path.join(paths.icarus, 'shared-skills'), { recursive: true });
  // The conversation registry is mounted into the container as a file, not a directory: if the file is absent,
  // docker will create a directory in its place and the mount will stay empty. An empty registry is a
  // valid state (there are no conversations yet), so we create it ourselves.
  if (!fs.existsSync(paths.chats)) {
    fs.writeFileSync(paths.chats, `${JSON.stringify({ chats: [] }, null, 2)}\n`, { mode: 0o600 });
  }
  // The same for the conversation map: it is recreated before every start (see prepareUser),
  // but by the time compose is generated the file must already exist.
  if (!fs.existsSync(paths.sessionsMap)) {
    fs.writeFileSync(paths.sessionsMap, `${JSON.stringify({ sessions: [] }, null, 2)}\n`, { mode: 0o600 });
  }
  // "Conversation" and "Private" always exist — together with their AGENTS.md.
  ensureWorkspaces(config, user);
}

/**
 * A hint about MCP servers that connect on demand. Without it the model
 * does not know that the server exists at all: with lifecycle: lazy its tools are not in the prompt,
 * and nobody will call mcp_connect on their own. The server description tells when it is
 * needed — that is the cheap trigger instead of a separate skill.
 *
 * Here also is the permission policy, and it is deliberately strict: "connect" and
 * "do" are different things, and a model without an explicit rule over-insures and
 * starts every conversation with "may I connect the MCP?". Connecting is idempotent,
 * changes nothing outside (it is the same initialize as any client's), and
 * asking for it is asking for nothing: a person pays attention for what they have already
 * allowed by enabling the server. Permission stays where there is an action —
 * writing, changing, sending. OAuth login is not a permission but access to someone else's
 * account: only a person grants it and only in the browser, so this case
 * is described separately so that the model does not try to "connect harder".
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
Включил и настроил их человек, поэтому сервер без готового доступа сюда не попадает.

**Подключение — не действие.** \`mcp_connect\` идемпотентен и наружу ничего не меняет,
так что разрешения на него не спрашивай — ни у человека, ни у себя. Тема разговора
про сервер из списка — сразу вызывай \`mcp_connect\` с \`name: "<имя>"\` и работай его
инструментами. Разрешение нужно на действия (запись, изменение, отправка) — вот там
спрашивай как обычно. Состояние серверов — \`mcp_status\`.

- Поднялся — одна короткая строка в ответе («поднял homeassistant»). Это отбивка
  постфактум, а не просьба и не отчёт о процессе.
- Не поднялся — скажи честно, что сервер недоступен, назови причину из ошибки и иди
  другим маршрутом (поиск, файлы, память). Не выдумывай, что сервер ответил, и не
  делай вид, что подключился.
- Просит вход (OAuth) — это отдельный шаг, и делает его человек в браузере, в панели,
  в разделе MCP. Скажи ему одной строкой. Доступ к чужому аккаунту разрешением на
  подключение не выдаётся, поэтому «войти» вместо человека ты не можешь.

${bullets.join('\n')}
`;
}

/**
 * Environment map: what the agent reads as AGENTS.md.
 *
 * Servers come from outside: each person has their own set — the shared ones from config.yaml
 * plus their enabled user ones. Disabled ones do not get here at all, otherwise
 * the model would call `mcp_connect` for a server it does not have.
 */
export function renderAgentsMd(
  config: IcarusConfig,
  servers: Record<string, McpServerConfig> = config.mcp,
  /** The reply language of this person: it changes only the "Language" section, everything else is shared. */
  language: Language = config.userLanguage ?? DEFAULT_LANGUAGE,
): string {
  const home = CONTAINER_PATHS.home;
  const workspaces = CONTAINER_PATHS.workspaces;
  const rows = [
    `| \`${workspaces}/<workspace>/\` | **рабочая папка**: та, в которой ты сейчас | работай и твори здесь |`,
    `| \`${CONTAINER_PATHS.artifacts}/\` | **общие артефакты** для людей: страницы, документы, картинки | права папки решают, что можно читать и писать; историю версий ведёт система |`,
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
 * Reply language is a person's setting, not a property of the conversation.
 *
 * What remains here is only what the rule at the turn (language.ts) does NOT carry: there a short
 * line "your language is X, do not mirror", and it handles the usual case better than any paragraph
 * in the prompt (136 characters gave 10/10 where 894 gave 9/10; see PR #114). And this section
 * holds the exceptions — a one-off request and a mode — which the turn does not have and cannot have:
 * the request is phrased in the person's own words for a specific turn.
 * We keep it short: the section travels into every conversation, and its scenario is rare.
 *
 * Language changes ONLY the language of the turns. Character, jokes, length and "first your own, then
 * the funny one" stay as they are: otherwise an English-speaking Icarus would be a different
 * person, and that is no longer localization but a second personality (see icarus.md).
 *
 * Exported for the test bench (tools/persona-flywheel/probe-language.mjs): it assembles
 * the system message like the service and must take the rule from here rather than keep a copy.
 * A copy would one day diverge from the production text — and the bench would test something other than what is in production.
 */
export function languageRule(language: Language): string {
  // The language name is full and in that language itself, without a code: the prompt gets "English", not "en".
  const name = languageName(language);
  return `
## ЯЗЫК КОММУНИКАЦИИ

Отвечай на языке: **${name}** — это настройка человека, а не язык его реплики:
пишет по-русски, цитирует лог, вставляет чужую фразу — отвечаешь всё равно на ${name}.
Характер, шутки и краткость те же, только на ${name}; про язык не переспрашиваешь.
Термин, имя и кусок кода, которые не переводятся, оставляешь как есть — но китайское
имя пишешь буквами: иероглифов в ответе нет, даже в цитате. Это сбой языка, а не
«как в источнике».

**Прямая просьба человека важнее настройки** — выполни её и не спорь с ней:

- **Разово** («ответь на грузинском», «вот это переведи») — отвечаешь на нём
  ровно один раз и возвращаешься к ${name}.
- **Режим** («с этого момента ты переводчик», «дальше пиши по-испански», «переводи всё,
  что я пишу») — держишь, пока человек его не снимет («хватит», «дальше как обычно»).

Сомневаешься, разово или режим, — считай разовым: лишний режим труднее отменить.
`;
}

/** Provider keys in the pi format: ~/.pi/agent/auth.json. */
export function renderAuthJson(config: IcarusConfig): string {
  const entries = Object.entries(config.auth).map(([provider, key]) => [provider, { type: 'api_key', key }]);
  return JSON.stringify(Object.fromEntries(entries), null, 2) + '\n';
}

/**
 * pi packages and additional paths to skills.
 *
 * We connect the MCP bridge only if the person has at least one server. The shared skills
 * that the person enabled arrive here as paths: the directory `~/.pi/agent/skills`
 * stays their personal one, and pi reads snapshots from `shared-skills` as additional
 * sources. A disabled skill does not get here at all — neither into the prompt nor into the context.
 */
export function renderSettingsJson(
  config: IcarusConfig,
  mcpServers: Record<string, McpServerConfig> = config.mcp,
  skillPaths: string[] = [],
): string {
  const servers = Object.keys(mcpServers);
  const settings: Record<string, unknown> = {};
  // 1.8.0 is the first version with mcp_connect/mcp_status. Without them lifecycle: lazy
  // turns into a trap: the server's tools are inactive, and there is nothing to connect it
  // from the conversation with (1.5.0 had only the manual /mcp:start).
  if (servers.length > 0) settings.packages = ['npm:pi-mcp-extension@1.8.0'];
  if (skillPaths.length > 0) settings.skills = skillPaths;
  return JSON.stringify(settings, null, 2) + '\n';
}

/**
 * ~/.pi/agent/mcp.json — what pi-mcp-extension reads.
 *
 * The HTTP server headers travel here as is, together with the access key: the file lies
 * next to auth.json, so it is written read-closed (see prepareUser).
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
 * Writes a file, removing a directory with the same name.
 * When mounting a nonexistent path, Docker creates a directory — after that a normal
 * file write fails with EISDIR, so we guard against it.
 */
function writeFileSafe(target: string, content: string, mode?: number): void {
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.writeFileSync(target, content, mode ? { mode } : undefined);
}

function copyDirFiles(from: string, to: string, depth = 0): string[] {
  if (!fs.existsSync(from)) {
    // Copying nothing silently is the worst option: the agent would be left without a persona and memory,
    // and we would think the extensions are in place.
    throw new Error(`каталог расширений не найден: ${from}`);
  }
  fs.mkdirSync(to, { recursive: true });
  const copied: string[] = [];

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      // subdirectories like lib/ are shared modules, pi does not count them as extensions
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
  try {
    const moved = migrateLegacyArtifacts(config, user);
    if (moved.length > 0) log.info('артефакты: старые папки перенесены в общую библиотеку', { user: user.id, artifacts: moved });
  } catch (error) {
    log.warn('артефакты: старые папки не перенеслись', { user: user.id, error: String(error) });
  }
  const paths = userPaths(config, user);

  // User MCP: enabled and ready servers are added to the shared ones.
  // The store may be broken (edited by hand, out of space) — then
  // the person is left with the servers from config.yaml rather than without a conversation at all.
  let mcpServers: Record<string, McpServerConfig> = config.mcp;
  try {
    fs.mkdirSync(storePaths(config).dir, { recursive: true, mode: 0o700 });
    // Old OAuth records need the proxy key: without it the token would go into
    // mcp.json again and expire right in a live conversation.
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

  // Language comes from the person's profile: it changes only the "Language" section in the environment map,
  // so it is read here rather than living in the shared config.yaml.
  writeFileSafe(paths.agentsMd, renderAgentsMd(config, mcpServers, languageOf(config, user)));

  // Conversation map for the agent: from a panel link it finds the session file in the same
  // answer, instead of guessing from file names. We redraw it on every start —
  // during the container's lifetime conversations manage to appear, be renamed and move
  // to another workspace (see sessions/chats.ts).
  try {
    writeFileSafe(paths.sessionsMap, renderSessionsMap(config, user));
  } catch (error) {
    // A broken registry is no reason to keep a person out of the conversation: the agent simply
    // stays without the map (and AGENTS.md says it is read-only).
    log.warn('карта разговоров не собралась', { user: user.id, error: String(error) });
  }

  const authPath = path.join(paths.piAgent, 'auth.json');
  writeFileSafe(authPath, renderAuthJson(config), 0o600);
  fs.chmodSync(authPath, 0o600);

  // Shared skills: first we catch the snapshots up to the owners' files (they could have been edited
  // by hand or rolled back by a commit), then we give pi only the enabled paths.
  let sharedSkillPaths: string[] = [];
  try {
    syncShared(config);
    sharedSkillPaths = enabledSharedPaths(config, user.id);
  } catch (error) {
    // A broken shared skills store must not deprive a person of a conversation:
    // they simply stay with their own skills.
    log.warn('скиллы: общие не собрались', { user: user.id, error: String(error) });
  }

  writeFileSafe(
    path.join(paths.piAgent, 'settings.json'),
    renderSettingsJson(config, mcpServers, sharedSkillPaths),
  );

  // mcp.json may carry an access key to an MCP server, so the permissions are the same as for
  // auth.json: a model key and a key to someone else's service are equally not for prying eyes.
  const mcpPath = path.join(paths.piAgent, 'mcp.json');
  writeFileSafe(mcpPath, renderMcpJson(config, mcpServers), 0o600);
  fs.chmodSync(mcpPath, 0o600);

  // models.json is the description of custom providers (DeepInfra): without it pi will find
  // neither the model itself nor its address. We write it always, even empty: the file is managed, and
  // a provider left from a previous configuration must not outlive its config.yaml.
  writeFileSafe(path.join(paths.piAgent, 'models.json'), renderModelsJson(config.models));

  // The persona is shared by everyone, the source of truth is the repository: on start we overwrite the copy
  // in the user's directory, otherwise edits in icarus.md would not reach existing people.
  const personaSource = path.join(REPO_ROOT, 'icarus.md');
  if (fs.existsSync(personaSource)) {
    writeFileSafe(paths.icarusMd, fs.readFileSync(personaSource, 'utf8'));
  } else {
    log.warn('icarus.md не найден — агент останется на дефолтном промпте', { source: personaSource });
  }

  // The old Maple instruction lived in a separate file; now the rules are in the tool
  // descriptions, and the leftover file would only confuse the agent. This is our managed
  // file, so we remove it without questions (there are no computations in it).
  const legacyMapleMd = path.join(paths.icarus, 'MAPLE.md');
  if (fs.existsSync(legacyMapleMd)) fs.rmSync(legacyMapleMd, { force: true });

  // The extensions directory is managed: we clean it, otherwise after renames there
  // remain old copies that pi would keep loading as extensions.
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
