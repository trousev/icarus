// Подготовка рабочего окружения пользователя на хосте: каталоги, AGENTS.md,
// auth.json для pi и наши расширения.
//
// Всё содержимое — общее (модели, ключи, MCP, маунты из config.yaml); от человека
// зависит только то, куда это кладётся: каталог в dataDir и имя контейнера.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.ts';
import {
  REPO_ROOT,
  userPaths,
  userContainer,
  type IcarusConfig,
  type UserConfig,
} from './config.ts';

const EXTENSIONS_DIR = path.join(REPO_ROOT, 'packages', 'extensions');

export type PreparedUser = ReturnType<typeof prepareUser>;

export function ensureDirs(config: IcarusConfig, user: UserConfig): void {
  const paths = userPaths(config, user);
  for (const dir of [paths.memory, paths.incoming, paths.sessions, paths.piAgent, paths.sharedMemory]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const sub of ['people', 'projects', 'journal']) {
    fs.mkdirSync(path.join(paths.memory, sub), { recursive: true });
  }
}

/** Карта окружения: то, что агент читает как AGENTS.md. */
export function renderAgentsMd(config: IcarusConfig): string {
  const rows = [
    '| `/workspace/memory/` | **личная память** этого человека | читай смело, пиши когда просят запомнить |',
    '| `/workspace/shared-memory/` | **семейная память**, общая для всех | писать **только по явной просьбе** |',
    '| `/workspace/incoming/` | вложения из чата | разбирай сам: прочитай, посмотри, разложи |',
    '| `/workspace/icarus.md` | твой системный промпт | не редактируй |',
    ...config.mounts.map(
      (mount) =>
        `| \`${mount.container}\` | репозиторий или каталог с кодом | ${
          mount.mode === 'ro' ? 'только чтение' : 'можно менять, если попросят'
        } |`,
    ),
  ];

  return `# Где ты находишься

Ты работаешь в контейнере. Всё, что тебе нужно, лежит в \`/workspace\`:

| Путь | Что это | Как обращаться |
|---|---|---|
${rows.join('\n')}

## Как устроена память

- \`memory/identity.md\` — кто этот человек: имя, привычки, устойчивые предпочтения.
- \`memory/preferences.md\` — вкусы, табу, как с ним разговаривать. Здесь и в identity — только устойчивое.
- \`memory/people/\` — люди вокруг: по файлу на человека.
- \`memory/projects/\` — длящиеся дела и временные состояния: здоровье, бумаги, работа, переезд, ремонт.
  Датированной строкой состояния: «по состоянию на 21.09.2026 — …».
- \`memory/journal/YYYY-MM.md\` — журнал: события по датам, построчно.

Правила простые: не дублируй то, что уже написано; противоречия не копи, а правь старую запись;
в журнал пиши коротко и с датой. Что может измениться — держи в \`projects/\` с датой, а не в
\`identity.md\`. Структуру можно расширять, если смысла не хватает.

## Границы

- \`shared-memory/\` — только по явной просьбе. Сомневаешься — пиши в личное.
- Не удаляй чужие файлы и не трогай ничего за пределами \`/workspace\`.
`;
}

/** Ключи провайдеров в формате pi: ~/.pi/agent/auth.json. */
export function renderAuthJson(config: IcarusConfig): string {
  const entries = Object.entries(config.auth).map(([provider, key]) => [provider, { type: 'api_key', key }]);
  return JSON.stringify(Object.fromEntries(entries), null, 2) + '\n';
}

/** Пакеты pi: подключаем MCP-мост только если в конфиге есть MCP-серверы. */
export function renderSettingsJson(config: IcarusConfig): string {
  const servers = Object.keys(config.mcp);
  const settings: Record<string, unknown> = {};
  if (servers.length > 0) settings.packages = ['npm:pi-mcp-extension@1.5.0'];
  return JSON.stringify(settings, null, 2) + '\n';
}

/** ~/.pi/agent/mcp.json — то, что читает pi-mcp-extension. */
export function renderMcpJson(config: IcarusConfig): string {
  const servers = Object.fromEntries(
    Object.entries(config.mcp).map(([name, server]) => [
      name,
      {
        transport: server.transport ?? (server.url ? 'streamable-http' : 'stdio'),
        ...(server.command ? { command: server.command } : {}),
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        ...(server.url ? { url: server.url } : {}),
        lifecycle: server.lifecycle ?? 'eager',
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

  writeFileSafe(paths.agentsMd, renderAgentsMd(config));

  const authPath = path.join(paths.piAgent, 'auth.json');
  writeFileSafe(authPath, renderAuthJson(config), 0o600);
  fs.chmodSync(authPath, 0o600);

  writeFileSafe(path.join(paths.piAgent, 'settings.json'), renderSettingsJson(config));
  writeFileSafe(path.join(paths.piAgent, 'mcp.json'), renderMcpJson(config));

  // Персона одна на всех, источник истины — репозиторий: при старте перезаписываем копию
  // в каталоге пользователя, иначе правки в icarus.md не доедут до существующих людей.
  const personaSource = path.join(REPO_ROOT, 'icarus.md');
  if (fs.existsSync(personaSource)) {
    writeFileSafe(paths.icarusMd, fs.readFileSync(personaSource, 'utf8'));
  } else {
    log.warn('icarus.md не найден — агент останется на дефолтном промпте', { source: personaSource });
  }

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
