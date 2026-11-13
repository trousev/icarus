// skill_writer: creating a skill as files, not "somewhere".
//
// A skill is a directory with SKILL.md and, if needed, bundle files. The model can
// write files with ordinary write, but a skill has layout rules (name = directory,
// description mandatory, the bundle sits next to it) and two different locations: Icarus's
// personal directory and the project `.pi/skills` of the current folder. This is gathered in one place here,
// so that "create a skill" doesn't mean "put SKILL.md anywhere".
//
// The core is deliberately pure: no pi, no environment. Tests call writeSkill directly, and
// the extension only chooses the root and gives the result to the model.
import fs from 'node:fs';
import path from 'node:path';

/** Agent Skills limits: the same numbers as in pi and the panel. */
export const SKILL_NAME_LIMIT = 64;
export const SKILL_DESCRIPTION_LIMIT = 1024;

/** How many bundle files and how much one weighs — so a skill doesn't become a dump. */
export const SKILL_FILES_LIMIT = 64;
export const SKILL_FILE_SIZE_LIMIT = 512 * 1024;

const SKILL_FILE = 'SKILL.md';

export type SkillFileInput = { path: string; content: string };

export type SkillWriterInput = {
  name: string;
  description: string;
  body: string;
  /** Shelf inside the skills directory: `sea` will give `sea/<name>/SKILL.md`. */
  folder?: string;
  /** Bundle files: `scripts/run.sh`, `references/notes.md`. */
  files?: SkillFileInput[];
  /** Overwrite an existing skill instead of refusing. */
  overwrite?: boolean;
};

export type SkillWriterResult = { ok: true; id: string; file: string } | { ok: false; error: string };

/** Skill name per Agent Skills rules. Returns an error text or null. */
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
 * Shelf: a relative path without empty segments, `..`, and service directories.
 * `null` — the shelf is invalid, `''` — there's none.
 */
export function normalizeFolder(folder: string | undefined): string | null {
  const value = (folder ?? '').trim().replaceAll('\\', '/');
  if (!value) return '';
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null;
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  for (const part of parts) {
    // The panel's service directories (`.disabled`, `.git`) and dependencies aren't shelves.
    if (part.startsWith('.') || part === 'node_modules') return null;
  }
  return parts.join('/');
}

/** Bundle file path: only relative and only inside the skill directory. */
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
 * Frontmatter without a YAML library: the name and description are ordinary strings, and a JSON
 * string in double quotes is valid YAML. We collapse newlines in the description:
 * a multiline scalar would break pi's parsing.
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
 * Writes a skill. Returns the id from the directory root (`sea/pirate-mode/SKILL.md`)
 * and the absolute path — it's useful for the model to know exactly where it landed.
 *
 * We don't touch an existing skill without `overwrite`: the model may call the
 * tool again and must not wipe out someone else's work. With `overwrite` we rewrite only
 * SKILL.md and the listed files; the rest of the bundle stays as it was.
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
  // A flat skill with the same name is also a taken name: the panel would have two
  // entries, and pi would keep only one.
  if (folder === '' && fs.existsSync(path.join(root, `${name}.md`))) {
    return { ok: false, error: `скилл «${name}» уже есть плоским файлом — правь его в панели` };
  }
  // A disabled skill with the same name is also a taken name: creating one next to
  // an enabled one would mean two entries with one id in the panel.
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

/** Icarus's personal skills directory: the same one the panel and pi read. */
export function personalSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ICARUS_SKILLS_DIR?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME?.trim() || '/home/node', '.pi', 'agent', 'skills');
}

/** Project skills directory: `.pi/skills` in the current working folder. */
export function workspaceSkillsRoot(cwd: string): string {
  return path.join(cwd, '.pi', 'skills');
}
