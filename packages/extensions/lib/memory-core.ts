// Ядро памяти: то, что Икар должен знать про человека сразу, без похода в файлы.
// Работает вторым обработчиком before_agent_start и дописывает блок к промпту,
// который уже собрала персона.
//
// Каждый пункт несёт метку месяца, когда он появился в памяти: `- [2026-03] текст`
// из git blame по времени автора строки. По метке видно, что устарело, а что свежее.
// Метка не меняется, пока не изменится сама память, поэтому промпт стабилен для кэша
// модели. git нет, память не репозиторий, строка не закоммичена — тихо отдаём текст
// без метки: ядро памяти важнее украшения.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MEMORY = process.env.ICARUS_MEMORY_DIR ?? "/workspace/memory";
const LIMIT_PER_FILE = 1200;
const LIMIT_TOTAL = 6000;

/** Кэш возрастов по mtime и размеру файла: иначе git звался бы каждый ход. */
type AgeEntry = { key: string; ages: Map<number, string> };
const AGE_CACHE = new Map<string, AgeEntry>();

/** Месяц из времени автора строки: `2026-03`. */
function monthOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 7);
}

/** Разбор `git blame --line-porcelain`: номер строки файла → месяц её изменения. */
function parseBlame(output: string): Map<number, string> {
  const ages = new Map<number, string>();
  let sha = '';
  let lineNumber = 0;
  let authorTime: number | null = null;
  for (const row of output.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(row);
    if (header) {
      sha = header[1];
      lineNumber = Number(header[2]);
      authorTime = null;
      continue;
    }
    const time = /^author-time (\d+)$/.exec(row);
    if (time) {
      authorTime = Number(time[1]);
      continue;
    }
    if (!row.startsWith('\t')) continue;
    // Нулевой sha — строка ещё не закоммичена: даты у неё нет, метку не выдумываем.
    if (authorTime !== null && !/^0+$/.test(sha)) ages.set(lineNumber - 1, monthOf(authorTime));
  }
  return ages;
}

/** Спрашивает git о строках файла. Нет git, нет репозитория — пусто и без шума. */
function blameAges(file: string): Map<number, string> {
  const result = spawnSync(
    'git',
    ['-C', path.dirname(file), 'blame', '--line-porcelain', '--', path.basename(file)],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0 || !result.stdout) return new Map();
  return parseBlame(result.stdout);
}

/**
 * Возрасты строк файла с кэшем по mtime и размеру. Пустой результат не кэшируем:
 * строки могли закоммитить уже после первого чтения, а mtime файла при коммите
 * не меняется — иначе метка не появилась бы никогда.
 */
export function memoryAges(file: string): Map<number, string> {
  let stat: ReturnType<typeof fs.statSync>;
  try {
    stat = fs.statSync(file);
  } catch {
    return new Map();
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = AGE_CACHE.get(file);
  if (cached && cached.key === key) return cached.ages;

  const ages = blameAges(file);
  if (ages.size > 0) AGE_CACHE.set(file, { key, ages });
  else AGE_CACHE.delete(file);
  return ages;
}

/** Сбрасывает кэш возрастов: нужен тестам, чтобы не зависеть от порядка прогонов. */
export function clearMemoryAges(): void {
  AGE_CACHE.clear();
}

/** Проставляет `- [2026-03] текст`. Сам текст пункта не меняем. */
export function annotateAges(file: string, text: string): string {
  const ages = memoryAges(file);
  if (ages.size === 0) return text;
  return text
    .split('\n')
    .map((line, index) => {
      const age = ages.get(index);
      if (!age) return line;
      const bullet = /^(\s*[-*]\s+)(.*)$/.exec(line);
      if (!bullet) return line;
      return `${bullet[1]}[${age}] ${bullet[2]}`;
    })
    .join('\n');
}

function readAnnotated(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  return annotateAges(file, raw).trim();
}

function clip(text: string, limit = LIMIT_PER_FILE): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n… (дальше сам, файл целиком по пути)`;
}

/** Первые содержательные строки файла: для списков людей и проектов хватает шапки. */
function headings(dir: string, perFile = 240): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
  return entries.sort().map((name) => {
    const body = clip(readAnnotated(path.join(dir, name)), perFile);
    return `### ${name.replace(/\.md$/, '')}\n${body}`;
  });
}

export function buildMemoryCore(root = MEMORY): string {
  const parts: string[] = [];
  const identity = readAnnotated(path.join(root, 'identity.md'));
  const preferences = readAnnotated(path.join(root, 'preferences.md'));

  if (identity) parts.push(`## Кто это\n${clip(identity)}`);
  if (preferences) parts.push(`## Предпочтения\n${clip(preferences)}`);

  const people = headings(path.join(root, 'people'));
  if (people.length > 0) parts.push(`## Люди\n${people.join('\n\n')}`);

  const projects = headings(path.join(root, 'projects'), 200);
  if (projects.length > 0) parts.push(`## Темы и дела\n${projects.join('\n\n')}`);

  const total = parts.join('\n\n');
  if (!total) return '';
  return clip(total, LIMIT_TOTAL);
}

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => {
    const core = buildMemoryCore();
    if (!core) return;

    const block = [
      '# Ядро памяти',
      'Это ты уже знаешь про собеседника. Не переспрашивай и не перечитывай эти файлы без нужды:',
      'если ответ есть здесь — отвечай сразу. За деталями (журнал, полные файлы) иди в память сам.',
      '',
      core,
      '',
      `Полная память лежит в ${MEMORY}/, семейная — в /workspace/shared-memory/.`,
    ].join('\n');

    return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${block}` };
  });
}
