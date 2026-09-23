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
  // Каталог математики заводим только при настроенном Maple: пустая папка в
  // /workspace без сервера только сбивала бы агента с толку.
  if (config.mcp?.maple) fs.mkdirSync(paths.maple, { recursive: true });
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
    ...(config.mcp?.maple
      ? [
          '| `/workspace/maple/` | **математика**: журналы и файлы расчётов Maple | читай и считай через Maple, руками файлы не правь |',
        ]
      : []),
    ...config.mounts.map(
      (mount) =>
        `| \`${mount.container}\` | репозиторий или каталог с кодом | ${
          mount.mode === 'ro' ? 'только чтение' : 'можно менять, если попросят'
        } |`,
    ),
  ];

  // Детали про Maple живут в отдельном MAPLE.md и читаются по требованию.
  // В основную память кладём только указатель: иначе инструкция про символьный
  // счёт висит в каждом разговоре, включая те, где математики нет вовсе.
  //
  // Бюджет попыток — наоборот, здесь. Замер на 400 задачах ASyMOB показал, что
  // агент дочитывает MAPLE.md в 10 сессиях из 453, а на невычислимом Maple
  // зацикливается всё равно: до 33 вызовов на задачу и 17 обрывов по таймауту.
  // То, что должно останавливать цикл, обязано быть в системном промпте, а не в
  // файле «прочитай, когда понадобится».
  const maple = config.mcp?.maple
    ? `
## Если нужна математика

Математика, аналитика, Maple — читай \`MAPLE.md\`: там что умеет, как вести
расчёты в сессиях и что говорить человеку.

**Не зацикливайся.** На задачу — не больше ~6 вызовов Maple. Если два вызова
подряд вернули одно и то же, или Maple вернул ввод без изменений, или вызов упал
по времени — это и есть ответ «не взял». Скажи это честно и остановись: перебор
формулировок (\`evalf\`, \`value\`, \`simplify\` по кругу) не помогает, а человек всё
это время ждёт.
`
    : '';

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
${maple}`;
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

/**
 * Переносит старые расчёты Maple из pi-agent в постоянный каталог математики.
 *
 * До появления `/workspace/maple` сервер по умолчанию писал журналы в
 * `<pi-agent>/maple-mcp`, а каталог pi-agent при пересборке окружения не чистится —
 * то есть чужого там не бывает, и перенести его безопасно. Копируем, а не
 * перемещаем: если в постоянном каталоге уже есть свежая версия файла, побеждает
 * она, а старый остаётся на месте — терять чужие расчёты из-за уборки нельзя.
 * Функция идемпотентна: после первого переноса копировать уже нечего.
 */
export function migrateLegacyMaple(legacy: string, maple: string): number {
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(legacy)) return 0;
    entries = fs.readdirSync(legacy, { withFileTypes: true });
  } catch {
    return 0;
  }

  fs.mkdirSync(maple, { recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(legacy, entry.name);
    const target = path.join(maple, entry.name);
    if (entry.isDirectory()) {
      copied += migrateLegacyMaple(source, target);
      continue;
    }
    if (!entry.isFile() || fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(source, target);
      copied += 1;
    } catch {
      // отдельный файл не скопировался — переживём, остальные важнее
    }
  }
  return copied;
}

export function prepareUser(config: IcarusConfig, user: UserConfig) {
  ensureDirs(config, user);
  const paths = userPaths(config, user);

  if (config.mcp?.maple) {
    const moved = migrateLegacyMaple(path.join(paths.piAgent, 'maple-mcp'), paths.maple);
    if (moved > 0) log.info('расчёты Maple перенесены в постоянный каталог', { user: user.id, files: moved });
  }

  writeFileSafe(paths.agentsMd, renderAgentsMd(config));

  const authPath = path.join(paths.piAgent, 'auth.json');
  writeFileSafe(authPath, renderAuthJson(config), 0o600);
  fs.chmodSync(authPath, 0o600);

  writeFileSafe(path.join(paths.piAgent, 'settings.json'), renderSettingsJson(config));
  writeFileSafe(path.join(paths.piAgent, 'mcp.json'), renderMcpJson(config));

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

  // Инструкция по Maple — отдельным файлом, читается по требованию. Нет сервера —
  // файла быть не должно: иначе агент обещает то, чего у него нет.
  if (config.mcp?.maple) {
    const mapleSource = path.join(REPO_ROOT, 'MAPLE.md');
    if (fs.existsSync(mapleSource)) {
      writeFileSafe(paths.mapleMd, fs.readFileSync(mapleSource, 'utf8'));
    } else {
      log.warn('MAPLE.md не найден — агент не узнает, как работать с Maple', { source: mapleSource });
    }
  } else if (fs.existsSync(paths.mapleMd)) {
    fs.rmSync(paths.mapleMd, { force: true });
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
