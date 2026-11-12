// Панель управления, раздел скиллов: каталог `~/.pi/agent/skills` человека.
//
// Это тот самый каталог, который pi читает при старте сессии (`core/skills.ts`,
// user scope), поэтому «сохранил в панели» и «Икар знает» — одно и то же действие:
// писать скиллы в стороне и синхронизировать их сюда больше не нужно.
//
// Раскладку панель держит канонической: скилл — это каталог с `SKILL.md` внутри
// (`pirate-mode/SKILL.md`), рядом лежат его файлы бандла. Плоские `*.md` в корне
// каталога pi тоже считает скиллами, но только если у них есть описание во
// frontmatter, — такие панель показывает и правит. Файл без описания она тоже
// покажет, но помеченным: pi его пропустит, и человеку об этом лучше узнать здесь,
// а не из молчания модели. Новые скиллы панель заводит каталогом: в каталоге
// помещаются скрипты и справки, на которые скилл ссылается.
//
// Сам каталог — git-репозиторий (его заводит панель): у скиллов та же история и
// тот же откат, что у памяти. Служебные каталоги вроде `.git` pi пропускает, так
// что соседство с репозиторием скиллу не мешает.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveInside } from './memory.ts';

/** Имя файла, который делает каталог скиллом: так велит Agent Skills. */
const SKILL_FILE = 'SKILL.md';

/**
 * Куда панель убирает выключенный скилл: pi не обходит скрытые каталоги, поэтому
 * файл остаётся под git и на виду у панели, но в разговор не попадает.
 *
 * Это именно переезд, а не флаг в настройках: каталог скиллов — единственный
 * источник правды для pi, и «выключен» в нём значит «здесь его нет».
 */
export const SKILLS_DISABLED_DIR = '.disabled';

/** Ограничения спецификации: те же числа, что у pi в core/skills.ts. */
export const SKILL_NAME_LIMIT = 64;
export const SKILL_DESCRIPTION_LIMIT = 1024;

/** В каталоге скиллов правим только markdown; всё прочее — файлы бандла. */
export const skillExtensions = new Set(['.md']);

export type SkillFile = { path: string; size: number };

export type SkillSummary = {
  /** Путь файла скилла от корня каталога: `pirate-mode/SKILL.md` или `notes.md`. */
  id: string;
  /** Как скилл зовётся: имя из frontmatter, иначе имя каталога. */
  name: string;
  description: string;
  /** Скрыт от модели: pi зовёт такой скилл только командой `/skill:имя`. */
  hidden: boolean;
  /** Включён: файл лежит там, где pi его читает. Выключенный — в `.disabled/`. */
  enabled: boolean;
  /** Сколько файлов в бандле, включая сам SKILL.md. */
  files: number;
  size: number;
  modified: string;
  /** Почему pi этот скилл не возьмёт или возьмёт с оговоркой. Пусто — всё хорошо. */
  problem?: string;
};

export type SkillDetail = SkillSummary & {
  body: string;
  /** Frontmatter целиком: чужие ключи панель при сохранении не теряет. */
  frontmatter: Record<string, unknown>;
  bundle: SkillFile[];
};

/** Что панель собирает в редакторе. */
export type SkillDraft = {
  /** Что правим: путь от корня каталога. Пусто — заводим новый скилл. */
  id?: string;
  name: string;
  description: string;
  body: string;
  hidden?: boolean;
};

export type SkillResult = { ok: true; id: string; message: string } | { ok: false; message: string };

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

/** Описание — то, по чему модель решает, когда скилл звать. Пустое нельзя. */
export function validateSkillDescription(description: string): string | null {
  const value = description.trim();
  if (!value) return 'без описания pi пропустит скилл: напиши, когда его применять';
  if (value.length > SKILL_DESCRIPTION_LIMIT) {
    return `описание длиннее ${SKILL_DESCRIPTION_LIMIT} символов — модели столько не нужно`;
  }
  return null;
}

/**
 * Разбор файла скилла: frontmatter и тело.
 *
 * Формат тот же, что читает pi (`utils/frontmatter.ts`): YAML между двумя `---`.
 * Битый frontmatter — не повод прятать скилл: человек должен видеть, что лежит в
 * файле, и починить это руками, поэтому отдаём и `problem`.
 *
 * Наружу отдаётся ещё и затем, чтобы «напиши за меня» умело прочитать ответ
 * модели, если она прислала готовый файл вместо JSON (control/skill-draft.ts).
 */
export function splitSkillFile(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  problem?: string;
} {
  const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: normalized.trim() };

  const body = normalized.slice(end + 4).trim();
  try {
    const parsed = parseYaml(normalized.slice(4, end));
    const frontmatter = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { frontmatter, body };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { frontmatter: {}, body, problem: `frontmatter не разбирается: ${reason}` };
  }
}

/**
 * Файл скилла из того, что собрал редактор.
 *
 * Тело всегда отделяем пустой строкой, а YAML отдаём сериализатору: описание с
 * двоеточием или кавычкой иначе превратилось бы в другой YAML, и pi прочитал бы
 * не то, что человек написал.
 */
export function renderSkillFile(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** Путь от корня в том виде, в каком его понимает и панель, и git. */
function relativeId(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** Каталог выключенных скиллов: лежит внутри репозитория, но pi его не видит. */
export function disabledSkillsRoot(root: string): string {
  return path.join(root, SKILLS_DISABLED_DIR);
}

/** Файл скилла лежит в `.disabled/`: значит, он выключен. */
function isDisabledFile(root: string, file: string): boolean {
  const disabled = `${path.resolve(disabledSkillsRoot(root))}${path.sep}`;
  return path.resolve(file).startsWith(disabled);
}

/** База, относительно которой скилл лежит: корень каталога или `.disabled/`. */
function baseRootOf(root: string, file: string): string {
  return isDisabledFile(root, file) ? disabledSkillsRoot(root) : root;
}

/**
 * id, который видит панель и человек: у выключенного скилла служебный префикс
 * `.disabled/` не показываем — статус и так стоит отдельным полем.
 */
function effectiveId(root: string, file: string): string {
  const id = relativeId(root, file);
  const prefix = `${SKILLS_DISABLED_DIR}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * Человеческое имя скилла по адресу его файла: `pirate-mode/SKILL.md` → `pirate-mode`.
 * Им подписаны коммиты и подтверждения, поэтому оно короткое, а не путь целиком.
 */
export function skillLabel(id: string): string {
  if (id.endsWith(`/${SKILL_FILE}`)) return id.slice(0, -(SKILL_FILE.length + 1));
  if (id === SKILL_FILE) return id;
  return id.endsWith('.md') ? id.slice(0, -3) : id;
}

/**
 * Что считать «всем скиллом» в git: у канонического скилла это каталог с бандлом,
 * у плоского — сам файл. По этому пути и спрашивают про незакоммиченное.
 */
export function skillScope(id: string): string {
  if (id !== SKILL_FILE && id.endsWith(`/${SKILL_FILE}`)) return id.slice(0, -(SKILL_FILE.length + 1));
  return id;
}

/**
 * Какие скиллы лежат в каталоге — обход ровно как у pi.
 *
 * Каталог с `SKILL.md` — скилл, и глубже в него не смотрим; остальные каталоги
 * обходим рекурсивно; плоские `.md` в корне тоже скиллы (но только в корне —
 * вложенные файлы в чужих каталогах pi скиллами не считает). Скрытое и
 * `node_modules` пропускаем: в `.git` живёт история, и скиллом она быть не может.
 */
function discover(root: string): Array<{ id: string; file: string }> {
  const found: Array<{ id: string; file: string }> = [];

  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === SKILL_FILE && entry.isFile())) {
      const file = path.join(dir, SKILL_FILE);
      found.push({ id: relativeId(root, file), file });
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (depth === 0 && entry.isFile() && entry.name.endsWith('.md')) {
        found.push({ id: entry.name, file: full });
      }
    }
  };

  visit(root, 0);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** Скиллы из `.disabled/`: те же правила обхода, но пометка «выключен». */
function discoverDisabled(root: string): Array<{ id: string; file: string }> {
  return discover(disabledSkillsRoot(root));
}

/**
 * Где лежит скилл с таким id: сначала включённый, потом выключенный.
 *
 * Наружу отдаётся абсолютный путь, но id остаётся публичным (`pirate-mode/SKILL.md`),
 * поэтому панели и человеку не нужно знать про `.disabled/`.
 */
export function resolveSkillFile(root: string, id: string): string | null {
  if (!id || id === '/' || id.startsWith(`${SKILLS_DISABLED_DIR}/`)) return null;
  if (id.split('/').includes('.git')) return null;
  for (const base of [root, disabledSkillsRoot(root)]) {
    const full = resolveInside(base, id, skillExtensions);
    if (full && fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

/** Файлы бандла: всё, что лежит рядом со скиллом, — и есть его бандл. */
function bundleOf(root: string, file: string): SkillFile[] {
  const dir = path.dirname(file);
  const isCanonical = path.basename(file) === SKILL_FILE;
  if (!isCanonical) return [{ path: relativeId(root, file), size: fs.statSync(file).size }];

  const files: SkillFile[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files.push({ path: relativeId(root, full), size: fs.statSync(full).size });
    }
  };
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Сводка по файлу скилла.
 *
 * `base` — каталог, относительно которого считаются пути бандла: у выключенного
 * скилла это `.disabled/`, поэтому человек и панель не видят служебный префикс.
 */
function summaryOf(base: string, id: string, file: string, enabled: boolean): SkillSummary {
  const stat = fs.statSync(file);
  const raw = fs.readFileSync(file, 'utf8');
  const { frontmatter, problem } = splitSkillFile(raw);

  const dirName = path.basename(path.dirname(file));
  const fallbackName = path.basename(file) === SKILL_FILE ? dirName : path.basename(file, '.md');
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';

  // Порядок проверок — по тяжести: не разобранный frontmatter важнее пропавшего
  // описания, а то, в свою очередь, важнее имени не по правилам: с таким именем
  // pi скилл всё равно загрузит, только поругается в диагностику.
  let trouble = problem;
  if (!trouble && !description) trouble = 'нет описания — pi пропустит этот скилл';
  if (!trouble) trouble = validateSkillName(name) ?? undefined;

  return {
    id,
    name,
    description,
    hidden: frontmatter['disable-model-invocation'] === true,
    enabled,
    files: bundleOf(base, file).length,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    ...(trouble ? { problem: trouble } : {}),
  };
}

/**
 * Все скиллы человека: то, что панель показывает списком слева.
 *
 * Включённые и выключенные лежат в одном репозитории, но в разных каталогах:
 * выключенный скилл виден в панели и правится, а pi его просто не находит.
 */
export function listSkills(root: string): SkillSummary[] {
  const summaries: SkillSummary[] = [];
  const collect = (base: string, enabled: boolean, entries: Array<{ id: string; file: string }>): void => {
    for (const entry of entries) {
      try {
        summaries.push(summaryOf(base, entry.id, entry.file, enabled));
      } catch {
        // Файл пропал между обходом и чтением — не повод ронять раздел.
      }
    }
  };

  collect(root, true, discover(root));
  collect(disabledSkillsRoot(root), false, discoverDisabled(root));
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

/** Один скилл целиком: frontmatter, тело и файлы бандла. */
export function readSkill(root: string, id: string): SkillDetail | null {
  const full = resolveSkillFile(root, id);
  if (!full) return null;

  const base = baseRootOf(root, full);
  const enabled = !isDisabledFile(root, full);
  const raw = fs.readFileSync(full, 'utf8');
  const { frontmatter, body } = splitSkillFile(raw);
  const summary = summaryOf(base, effectiveId(root, full), full, enabled);
  return { ...summary, body, frontmatter, bundle: bundleOf(base, full) };
}

/** Ключи, которые панель пишет сама: остальное во frontmatter — чужое, не трогаем. */
function frontmatterFor(
  existing: Record<string, unknown>,
  name: string,
  description: string,
  hidden: boolean,
): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = { ...existing, name, description };
  if (hidden) frontmatter['disable-model-invocation'] = true;
  else delete frontmatter['disable-model-invocation'];
  return frontmatter;
}

/**
 * Новый путь файла после переименования.
 *
 * Имя скилла — это его каталог (или файл у плоского скилла), поэтому переименование
 * в панели — это `git mv` по смыслу: содержимое остаётся, меняется адрес. Переезжает
 * скилл рядом с прежним местом: скиллы можно раскладывать по полкам
 * (`группа/скилл/SKILL.md`), и переименование не должно вытаскивать скилл наверх,
 * ломая чужую раскладку.
 */
function renamedPath(current: string, base: string, name: string): { id: string; file: string } | string {
  const isCanonical = path.basename(current) === SKILL_FILE;
  const currentDir = path.dirname(current);
  // У корневого SKILL.md каталога скилла нет — его собственный каталог и есть корень,
  // поэтому «рядом» для него значит «в корне»: скилл становится обычным каталогом.
  const parent = currentDir === base ? base : path.dirname(currentDir);
  const targetDir = isCanonical ? path.join(parent, name) : currentDir;
  const target = isCanonical ? path.join(targetDir, SKILL_FILE) : path.join(currentDir, `${name}.md`);

  if (target !== current && fs.existsSync(target)) return `скилл «${name}» уже есть — выбери другое имя`;
  // Такое же имя могло остаться у выключенного скилла: две записи с одним id
  // панель бы показала, а pi оставил бы только одну.
  const otherBase = path.basename(base) === SKILLS_DISABLED_DIR ? path.dirname(base) : disabledSkillsRoot(base);
  if (target !== current && fs.existsSync(path.join(otherBase, relativeId(base, target)))) {
    return `скилл «${name}» уже есть — выбери другое имя`;
  }
  if (isCanonical && targetDir !== currentDir && fs.existsSync(targetDir)) {
    return `каталог «${name}» уже занят — выбери другое имя`;
  }
  return { id: relativeId(base, target), file: target };
}

/** Заводит или переписывает скилл. Коммит и перезапуск сессий — на стороне маршрута. */
export function writeSkill(root: string, draft: SkillDraft): SkillResult {
  const name = draft.name.trim();
  const description = draft.description.trim();

  const nameError = validateSkillName(name);
  if (nameError) return { ok: false, message: nameError };
  const descriptionError = validateSkillDescription(description);
  if (descriptionError) return { ok: false, message: descriptionError };

  let file: string;
  let existing: Record<string, unknown> = {};

  if (!draft.id) {
    file = path.join(root, name, SKILL_FILE);
    // Выключенный скилл с тем же именем — тоже занятое имя: иначе в панели
    // появились бы две записи с одним id, а pi видел бы только включённую.
    if (
      fs.existsSync(file) ||
      fs.existsSync(path.join(root, name)) ||
      fs.existsSync(path.join(root, `${name}.md`)) ||
      fs.existsSync(path.join(disabledSkillsRoot(root), name)) ||
      fs.existsSync(path.join(disabledSkillsRoot(root), `${name}.md`))
    ) {
      return { ok: false, message: `скилл «${name}» уже есть — открой его в списке` };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } else {
    const current = resolveSkillFile(root, draft.id);
    if (!current) return { ok: false, message: 'такой скилл трогать нельзя' };

    const base = baseRootOf(root, current);
    const renamed = renamedPath(current, base, name);
    if (typeof renamed === 'string') return { ok: false, message: renamed };
    file = renamed.file;
    existing = splitSkillFile(fs.readFileSync(current, 'utf8')).frontmatter;

    if (file !== current) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Канонический скилл — это каталог: переезжает он целиком, вместе с файлами
      // бандла. Плоский файл переезжает сам. Выключенный скилл переезжает внутри
      // `.disabled/` — включённым он от переименования не становится.
      if (path.basename(file) === SKILL_FILE && path.dirname(current) !== base) {
        fs.renameSync(path.dirname(current), path.dirname(file));
      } else {
        // Корневой SKILL.md — не каталог: его «каталог» и есть весь каталог скиллов,
        // и переносить его целиком значило бы унести все скиллы в подпапку.
        fs.renameSync(current, file);
      }
    }
  }

  fs.writeFileSync(file, renderSkillFile(frontmatterFor(existing, name, description, draft.hidden === true), draft.body));
  const id = effectiveId(root, file);
  return { ok: true, id, message: `скилл «${name}» сохранён` };
}

/**
 * Включает или выключает скилл: это переезд между корнем каталога и `.disabled/`.
 *
 * Для pi «выключен» значит «файла нет»: каталог скиллов он читает один раз при
 * старте, а флага «пропусти этот» в Agent Skills нет. Зато переезд остаётся
 * видимым в git — в истории скилла будет и выключение, и включение.
 */
export function setSkillEnabled(root: string, id: string, enabled: boolean): SkillResult {
  if (id === SKILL_FILE) {
    return { ok: false, message: 'корневой SKILL.md не выключается: переименуй его в каталог' };
  }
  if (!id || id.startsWith(`${SKILLS_DISABLED_DIR}/`) || id.split('/').includes('.git')) {
    return { ok: false, message: 'такой скилл трогать нельзя' };
  }

  // При включении смотрим сначала в `.disabled/`: если в корне уже лежит скилл с
  // тем же id, это не «уже включён», а занятое место, и перетирать его нельзя.
  const bases = enabled ? [disabledSkillsRoot(root), root] : [root, disabledSkillsRoot(root)];
  let current: string | null = null;
  for (const base of bases) {
    const candidate = resolveInside(base, id, skillExtensions);
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      current = candidate;
      break;
    }
  }
  if (!current) return { ok: false, message: 'скилла уже нет: обнови страницу' };

  const isEnabled = !isDisabledFile(root, current);
  if (isEnabled === enabled) {
    return { ok: true, id, message: enabled ? 'скилл уже включён' : 'скилл уже выключен' };
  }

  const targetBase = enabled ? root : disabledSkillsRoot(root);
  const target = path.join(targetBase, id);
  if (fs.existsSync(target)) {
    return { ok: false, message: `место «${id}» уже занято — включи или выключи его руками` };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (path.basename(current) === SKILL_FILE) fs.renameSync(path.dirname(current), path.dirname(target));
  else fs.renameSync(current, target);

  return { ok: true, id, message: enabled ? `скилл «${skillLabel(id)}» включён` : `скилл «${skillLabel(id)}» выключен` };
}

/**
 * Удаляет скилл вместе с бандлом — это и есть «удалить» в панели.
 *
 * Корневой `SKILL.md` — особый случай: его каталог и есть каталог скиллов, и
 * снести его целиком значило бы унести все скиллы разом. Такой файл удаляем
 * поштучно, а бандл рядом оставляем человеку.
 */
export function removeSkill(root: string, id: string): { ok: boolean; message: string } {
  const full = resolveSkillFile(root, id);
  if (!full) return { ok: false, message: 'скилла уже нет: обнови страницу' };

  if (id === SKILL_FILE) {
    fs.rmSync(full);
    return { ok: true, message: 'удалил корневой SKILL.md' };
  }
  if (path.dirname(id) === '.') {
    fs.rmSync(full);
    return { ok: true, message: `удалил ${id}` };
  }

  fs.rmSync(path.dirname(full), { recursive: true, force: true });
  return { ok: true, message: `удалил скилл ${id}` };
}

export type SkillHit = { id: string; name: string; line: number; text: string };

/** Поиск по скиллам: та же строка поиска в панели, что ищет по памяти. */
export function searchSkills(root: string, query: string, limit = 50): SkillHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const hits: SkillHit[] = [];
  for (const skill of listSkills(root)) {
    const full = resolveSkillFile(root, skill.id);
    if (!full) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (hits.length < limit && text.toLowerCase().includes(needle)) {
        hits.push({ id: skill.id, name: skill.name, line: index + 1, text: text.trim() });
      }
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
