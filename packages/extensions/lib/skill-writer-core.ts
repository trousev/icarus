// skill_writer: создание скилла файлами, а не «куда-нибудь».
//
// Скилл — это каталог с SKILL.md и, если нужно, файлами бандла. Модель умеет
// писать файлы обычным write, но у скилла есть правила раскладки (имя = каталог,
// описание обязательно, бандл лежит рядом) и два разных адреса: личный каталог
// Икара и проектный `.pi/skills` текущей папки. Здесь это собрано в одном месте,
// чтобы «создать скилл» не означало «положить SKILL.md куда попало».
//
// Ядро нарочно чистое: ни pi, ни окружения. Тесты зовут writeSkill напрямую, а
// расширение только выбирает корень и отдаёт результат модели.
import fs from 'node:fs';
import path from 'node:path';

/** Ограничения Agent Skills: те же числа, что у pi и у панели. */
export const SKILL_NAME_LIMIT = 64;
export const SKILL_DESCRIPTION_LIMIT = 1024;

/** Сколько файлов бандла и сколько весит один — чтобы скилл не стал свалкой. */
export const SKILL_FILES_LIMIT = 64;
export const SKILL_FILE_SIZE_LIMIT = 512 * 1024;

const SKILL_FILE = 'SKILL.md';

export type SkillFileInput = { path: string; content: string };

export type SkillWriterInput = {
  name: string;
  description: string;
  body: string;
  /** Полка внутри каталога скиллов: `sea` даст `sea/<name>/SKILL.md`. */
  folder?: string;
  /** Файлы бандла: `scripts/run.sh`, `references/notes.md`. */
  files?: SkillFileInput[];
  /** Переписать существующий скилл, а не отказать. */
  overwrite?: boolean;
};

export type SkillWriterResult = { ok: true; id: string; file: string } | { ok: false; error: string };

/** Имя скилла по правилам Agent Skills. Возвращает текст ошибки или null. */
export function validateSkillName(name: string): string | null {
  const value = name.trim();
  if (!value) return 'имя не может быть пустым';
  if (value.length > SKILL_NAME_LIMIT) return `имя длиннее ${SKILL_NAME_LIMIT} символов`;
  if (!/^[a-z0-9-]+$/.test(value)) return 'в имени — только строчные латинские буквы, цифры и дефис';
  if (value.startsWith('-') || value.endsWith('-')) return 'имя не начинается и не кончается дефисом';
  if (value.includes('--')) return 'в имени нет двух дефисов подряд';
  return null;
}

export function validateSkillDescription(description: string): string | null {
  const value = description.trim();
  if (!value) return 'без описания pi пропустит скилл: напиши, когда его применять';
  if (value.length > SKILL_DESCRIPTION_LIMIT) return `описание длиннее ${SKILL_DESCRIPTION_LIMIT} символов`;
  return null;
}

/**
 * Полка: относительный путь без пустых сегментов, `..` и служебных каталогов.
 * `null` — полка не годится, `''` — её нет.
 */
export function normalizeFolder(folder: string | undefined): string | null {
  const value = (folder ?? '').trim().replaceAll('\\', '/');
  if (!value) return '';
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null;
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  for (const part of parts) {
    // Служебные каталоги панели (`.disabled`, `.git`) и зависимости — не полки.
    if (part.startsWith('.') || part === 'node_modules') return null;
  }
  return parts.join('/');
}

/** Путь файла бандла: только относительный и только внутри каталога скилла. */
export function safeBundlePath(relative: string): string | null {
  const value = relative.trim().replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null;
  if (value === SKILL_FILE) return null;
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part === '.' || part === '..' || part === '.git' || part === 'node_modules' || part.startsWith('.tmp-')) {
      return null;
    }
  }
  return parts.join('/');
}

/**
 * Frontmatter без YAML-библиотеки: имя и описание — обычные строки, а JSON-
 * строка в двойных кавычках — валидный YAML. Переводы строк в описании
 * схлопываем: многострочный скаляр сломал бы разбор у pi.
 */
function frontmatter(name: string, description: string): string {
  const oneLine = (value: string): string => JSON.stringify(value.replace(/\s+/g, ' ').trim());
  return `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n`;
}

function ensureInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * Записывает скилл. Возвращает id от корня каталога (`sea/pirate-mode/SKILL.md`)
 * и абсолютный путь — модели полезно знать, куда именно легло.
 *
 * Существующий скилл без `overwrite` не трогаем: модель может повторно позвать
 * инструмент и не должна затирать чужую работу. С `overwrite` переписываем только
 * SKILL.md и перечисленные файлы; остальной бандл остаётся как был.
 */
export function writeSkill(root: string, input: SkillWriterInput): SkillWriterResult {
  const name = String(input.name ?? '').trim();
  const description = String(input.description ?? '').trim();
  const body = String(input.body ?? '').trim();

  const nameError = validateSkillName(name);
  if (nameError) return { ok: false, error: nameError };
  const descriptionError = validateSkillDescription(description);
  if (descriptionError) return { ok: false, error: descriptionError };
  if (!body) return { ok: false, error: 'без инструкции скилл пустой: напиши тело SKILL.md' };

  const folder = normalizeFolder(input.folder);
  if (folder === null) return { ok: false, error: 'полка должна быть относительным путём без «..»' };

  const skillDir = path.join(root, folder, name);
  const file = path.join(skillDir, SKILL_FILE);
  if (!ensureInside(root, file)) return { ok: false, error: 'скилл вышел за пределы каталога скиллов' };
  if (fs.existsSync(skillDir) && !input.overwrite) {
    return { ok: false, error: `скилл «${name}» уже есть — передай overwrite: true, если его надо переписать` };
  }
  if (fs.existsSync(skillDir) && !fs.statSync(skillDir).isDirectory()) {
    return { ok: false, error: `место «${name}» занято файлом, а не каталогом скилла` };
  }
  // Плоский скилл с тем же именем — тоже занятое имя: в панели было бы две
  // записи, а pi оставил бы только одну.
  if (folder === '' && fs.existsSync(path.join(root, `${name}.md`))) {
    return { ok: false, error: `скилл «${name}» уже есть плоским файлом — правь его в панели` };
  }
  // Выключенный скилл с тем же именем — тоже занятое имя: создать рядом
  // включённого значило бы получить в панели две записи с одним id.
  if (
    !fs.existsSync(skillDir) &&
    (fs.existsSync(path.join(root, '.disabled', folder, name)) ||
      fs.existsSync(path.join(root, '.disabled', folder, `${name}.md`)))
  ) {
    return { ok: false, error: `скилл «${name}» уже есть, но выключен — включи его в панели` };
  }

  const files: Array<{ target: string; content: string }> = [];
  for (const item of input.files ?? []) {
    const relative = safeBundlePath(String(item.path ?? ''));
    if (!relative) return { ok: false, error: `файл бандла «${item.path}»: нужен относительный путь внутри скилла` };
    const content = String(item.content ?? '');
    if (content.length > SKILL_FILE_SIZE_LIMIT) {
      return { ok: false, error: `файл «${relative}» больше ${SKILL_FILE_SIZE_LIMIT} символов` };
    }
    const target = path.join(skillDir, relative);
    if (!ensureInside(skillDir, target)) return { ok: false, error: `файл «${relative}» вышел за пределы скилла` };
    files.push({ target, content });
  }
  if (files.length > SKILL_FILES_LIMIT) {
    return { ok: false, error: `файлов бандла больше ${SKILL_FILES_LIMIT}` };
  }

  fs.mkdirSync(skillDir, { recursive: true });
  for (const item of files) {
    fs.mkdirSync(path.dirname(item.target), { recursive: true });
    fs.writeFileSync(item.target, item.content);
  }
  fs.writeFileSync(file, `${frontmatter(name, description)}\n${body}\n`);

  return { ok: true, id: path.relative(root, file).split(path.sep).join('/'), file };
}

/** Личный каталог скиллов Икара: тот же, который читает панель и pi. */
export function personalSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ICARUS_SKILLS_DIR?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME?.trim() || '/home/node', '.pi', 'agent', 'skills');
}

/** Проектный каталог скиллов: `.pi/skills` в текущей рабочей папке. */
export function workspaceSkillsRoot(cwd: string): string {
  return path.join(cwd, '.pi', 'skills');
}
