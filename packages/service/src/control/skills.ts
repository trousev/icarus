// Control panel, skills section: the person's `~/.pi/agent/skills` directory.
//
// This is the very directory that pi reads at session start (`core/skills.ts`,
// user scope), so "saved in the panel" and "Icarus knows it" are the same action:
// there's no longer any need to write skills elsewhere and sync them here.
//
// The panel keeps the layout canonical: a skill is a directory with `SKILL.md` inside
// (`pirate-mode/SKILL.md`), with its bundle files alongside. pi also counts flat `*.md`
// files in the root as skills, but only if they have a description in frontmatter —
// the panel shows and edits those too. A file without a description is also shown, but
// marked: pi will skip it, and the person had better learn that here rather than from
// the model's silence. New skills are created by the panel as a directory: a directory
// can hold the scripts and docs the skill references.
//
// The directory itself is a git repository (the panel sets it up): skills have the
// same history and the same rollback as memory. pi skips service directories like
// `.git`, so being next to a repository doesn't bother the skill.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveInside } from './memory.ts';

/** The file name that makes a directory a skill: that's what Agent Skills says. */
const SKILL_FILE = 'SKILL.md';

/**
 * Where the panel moves a disabled skill: pi doesn't traverse hidden directories, so
 * the file stays under git and visible to the panel, but doesn't get into the conversation.
 *
 * It's a move, not a flag in settings: the skills directory is the only source of truth
 * for pi, and "disabled" in it means "it isn't here".
 */
export const SKILLS_DISABLED_DIR = '.disabled';

/** Spec limits: the same numbers as in pi's core/skills.ts. */
export const SKILL_NAME_LIMIT = 64;
export const SKILL_DESCRIPTION_LIMIT = 1024;

/** In the skills directory we only edit markdown; everything else is bundle files. */
export const skillExtensions = new Set(['.md']);

export type SkillFile = { path: string; size: number };

export type SkillSummary = {
  /** Skill file path from the directory root: `pirate-mode/SKILL.md` or `notes.md`. */
  id: string;
  /** What the skill is called: the name from frontmatter, otherwise the directory name. */
  name: string;
  description: string;
  /** Hidden from the model: pi only invokes such a skill via the `/skill:имя` command. */
  hidden: boolean;
  /** Enabled: the file is where pi reads it. A disabled one is in `.disabled/`. */
  enabled: boolean;
  /** How many files are in the bundle, including SKILL.md itself. */
  files: number;
  size: number;
  modified: string;
  /** Why pi won't take this skill or will take it with a caveat. Empty means all is well. */
  problem?: string;
};

export type SkillDetail = SkillSummary & {
  body: string;
  /** The whole frontmatter: the panel doesn't lose other keys when saving. */
  frontmatter: Record<string, unknown>;
  bundle: SkillFile[];
};

/** What the panel collects in the editor. */
export type SkillDraft = {
  /** What we're editing: path from the directory root. Empty means we're creating a new skill. */
  id?: string;
  name: string;
  description: string;
  body: string;
  hidden?: boolean;
};

export type SkillResult = { ok: true; id: string; message: string } | { ok: false; message: string };

/** Skill name per Agent Skills rules. Returns an error message or null. */
export function validateSkillName(name: string): string | null {
  const value = name.trim();
  if (!value) return 'имя не может быть пустым';
  if (value.length > SKILL_NAME_LIMIT) return `имя длиннее ${SKILL_NAME_LIMIT} символов`;
  if (!/^[a-z0-9-]+$/.test(value)) return 'в имени — только строчные латинские буквы, цифры и дефис';
  if (value.startsWith('-') || value.endsWith('-')) return 'имя не начинается и не кончается дефисом';
  if (value.includes('--')) return 'в имени нет двух дефисов подряд';
  return null;
}

/** The description is what the model uses to decide when to call the skill. It can't be empty. */
export function validateSkillDescription(description: string): string | null {
  const value = description.trim();
  if (!value) return 'без описания pi пропустит скилл: напиши, когда его применять';
  if (value.length > SKILL_DESCRIPTION_LIMIT) {
    return `описание длиннее ${SKILL_DESCRIPTION_LIMIT} символов — модели столько не нужно`;
  }
  return null;
}

/**
 * Parse a skill file: frontmatter and body.
 *
 * The format is the same one pi reads (`utils/frontmatter.ts`): YAML between two `---`.
 * A broken frontmatter isn't a reason to hide the skill: the person should see what's
 * in the file and fix it by hand, so we also return `problem`.
 *
 * It's exposed too so that "write it for me" can parse the model's answer if it sent a
 * ready file instead of JSON (control/skill-draft.ts).
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
 * A skill file from what the editor collected.
 *
 * We always separate the body with a blank line, and hand the YAML to the serializer:
 * a description with a colon or quote would otherwise turn into different YAML, and pi
 * would read something other than what the person wrote.
 */
export function renderSkillFile(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** A path from the root in the form that both the panel and git understand. */
function relativeId(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** The disabled-skills directory: it's inside the repository, but pi doesn't see it. */
export function disabledSkillsRoot(root: string): string {
  return path.join(root, SKILLS_DISABLED_DIR);
}

/** The skill file is in `.disabled/`: that means it's disabled. */
function isDisabledFile(root: string, file: string): boolean {
  const disabled = `${path.resolve(disabledSkillsRoot(root))}${path.sep}`;
  return path.resolve(file).startsWith(disabled);
}

/** The base the skill is under: the directory root or `.disabled/`. */
function baseRootOf(root: string, file: string): string {
  return isDisabledFile(root, file) ? disabledSkillsRoot(root) : root;
}

/**
 * The id that the panel and the person see: for a disabled skill we don't show the
 * service prefix `.disabled/` — the status is already a separate field.
 */
function effectiveId(root: string, file: string): string {
  const id = relativeId(root, file);
  const prefix = `${SKILLS_DISABLED_DIR}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * A human name of the skill from its file path: `pirate-mode/SKILL.md` → `pirate-mode`.
 * It labels commits and confirmations, so it's short rather than the whole path.
 */
export function skillLabel(id: string): string {
  if (id.endsWith(`/${SKILL_FILE}`)) return id.slice(0, -(SKILL_FILE.length + 1));
  if (id === SKILL_FILE) return id;
  return id.endsWith('.md') ? id.slice(0, -3) : id;
}

/**
 * What counts as "the whole skill" in git: for a canonical skill it's the directory
 * with the bundle, for a flat one it's the file itself. This is the path asked about
 * for uncommitted changes.
 */
export function skillScope(id: string): string {
  if (id !== SKILL_FILE && id.endsWith(`/${SKILL_FILE}`)) return id.slice(0, -(SKILL_FILE.length + 1));
  return id;
}

/**
 * Which skills are in the directory — traversal exactly like pi's.
 *
 * A directory with `SKILL.md` is a skill, and we don't look deeper into it; other
 * directories are traversed recursively; flat `.md` files in the root are also skills
 * (but only in the root — pi doesn't count nested files in other directories as skills).
 * We skip hidden entries and `node_modules`: history lives in `.git`, and it can't be a skill.
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

/** Skills from `.disabled/`: the same traversal rules, but marked "disabled". */
function discoverDisabled(root: string): Array<{ id: string; file: string }> {
  return discover(disabledSkillsRoot(root));
}

/**
 * Where the skill with this id lives: first the enabled one, then the disabled one.
 *
 * An absolute path is returned, but the id stays public (`pirate-mode/SKILL.md`),
 * so neither the panel nor the person needs to know about `.disabled/`.
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

/** Bundle files: everything lying next to the skill is its bundle. */
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
 * A summary of a skill file.
 *
 * `base` is the directory relative to which bundle paths are computed: for a disabled
 * skill it's `.disabled/`, so neither the person nor the panel sees the service prefix.
 */
function summaryOf(base: string, id: string, file: string, enabled: boolean): SkillSummary {
  const stat = fs.statSync(file);
  const raw = fs.readFileSync(file, 'utf8');
  const { frontmatter, problem } = splitSkillFile(raw);

  const dirName = path.basename(path.dirname(file));
  const fallbackName = path.basename(file) === SKILL_FILE ? dirName : path.basename(file, '.md');
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';

  // The order of checks is by severity: an unparsed frontmatter matters more than a
  // missing description, which in turn matters more than a non-conforming name: pi
  // will load the skill with such a name anyway, just grumbling into diagnostics.
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
 * All of the person's skills: what the panel shows in the list on the left.
 *
 * Enabled and disabled ones live in the same repository but in different directories:
 * a disabled skill is visible in the panel and editable, but pi simply doesn't find it.
 */
export function listSkills(root: string): SkillSummary[] {
  const summaries: SkillSummary[] = [];
  const collect = (base: string, enabled: boolean, entries: Array<{ id: string; file: string }>): void => {
    for (const entry of entries) {
      try {
        summaries.push(summaryOf(base, entry.id, entry.file, enabled));
      } catch {
        // The file vanished between traversal and reading — no reason to bring down the section.
      }
    }
  };

  collect(root, true, discover(root));
  collect(disabledSkillsRoot(root), false, discoverDisabled(root));
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

/** One skill in full: frontmatter, body, and bundle files. */
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

/** Keys the panel writes itself: the rest of the frontmatter is foreign, we don't touch it. */
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
 * The new file path after a rename.
 *
 * A skill's name is its directory (or file, for a flat skill), so renaming in the panel
 * is `git mv` in spirit: the content stays, the address changes. The skill moves next to
 * its former location: skills can be arranged on shelves (`group/skill/SKILL.md`), and a
 * rename must not pull the skill up top and break someone's layout.
 */
function renamedPath(current: string, base: string, name: string): { id: string; file: string } | string {
  const isCanonical = path.basename(current) === SKILL_FILE;
  const currentDir = path.dirname(current);
  // A root SKILL.md has no skill directory — its own directory is the root itself,
  // so "next to" for it means "in the root": the skill becomes a regular directory.
  const parent = currentDir === base ? base : path.dirname(currentDir);
  const targetDir = isCanonical ? path.join(parent, name) : currentDir;
  const target = isCanonical ? path.join(targetDir, SKILL_FILE) : path.join(currentDir, `${name}.md`);

  if (target !== current && fs.existsSync(target)) return `скилл «${name}» уже есть — выбери другое имя`;
  // The same name could remain on a disabled skill: the panel would show two entries
  // with the same id, while pi would keep only one.
  const otherBase = path.basename(base) === SKILLS_DISABLED_DIR ? path.dirname(base) : disabledSkillsRoot(base);
  if (target !== current && fs.existsSync(path.join(otherBase, relativeId(base, target)))) {
    return `скилл «${name}» уже есть — выбери другое имя`;
  }
  if (isCanonical && targetDir !== currentDir && fs.existsSync(targetDir)) {
    return `каталог «${name}» уже занят — выбери другое имя`;
  }
  return { id: relativeId(base, target), file: target };
}

/** Creates or rewrites a skill. Committing and restarting sessions is the route's job. */
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
    // A disabled skill with the same name is also a taken name: otherwise two entries
    // with the same id would appear in the panel, while pi would see only the enabled one.
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
      // A canonical skill is a directory: it moves whole, along with its bundle files.
      // A flat file moves by itself. A disabled skill moves within `.disabled/` —
      // a rename doesn't make it enabled.
      if (path.basename(file) === SKILL_FILE && path.dirname(current) !== base) {
        fs.renameSync(path.dirname(current), path.dirname(file));
      } else {
        // A root SKILL.md isn't a directory: its "directory" is the whole skills
        // directory, and moving it whole would carry all skills into a subfolder.
        fs.renameSync(current, file);
      }
    }
  }

  fs.writeFileSync(file, renderSkillFile(frontmatterFor(existing, name, description, draft.hidden === true), draft.body));
  const id = effectiveId(root, file);
  return { ok: true, id, message: `скилл «${name}» сохранён` };
}

/**
 * Enables or disables a skill: it's a move between the directory root and `.disabled/`.
 *
 * For pi, "disabled" means "the file isn't there": it reads the skills directory once at
 * startup, and Agent Skills has no "skip this one" flag. But the move stays visible in
 * git — the skill's history will contain both the disabling and the enabling.
 */
export function setSkillEnabled(root: string, id: string, enabled: boolean): SkillResult {
  if (id === SKILL_FILE) {
    return { ok: false, message: 'корневой SKILL.md не выключается: переименуй его в каталог' };
  }
  if (!id || id.startsWith(`${SKILLS_DISABLED_DIR}/`) || id.split('/').includes('.git')) {
    return { ok: false, message: 'такой скилл трогать нельзя' };
  }

  // When enabling, we look in `.disabled/` first: if a skill with the same id already
  // lies in the root, that's not "already enabled" but a taken spot, and it can't be overwritten.
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
 * Deletes a skill along with its bundle — that's what "delete" in the panel means.
 *
 * A root `SKILL.md` is a special case: its directory is the skills directory, and
 * wiping it whole would carry off all skills at once. We delete such a file on its
 * own, leaving the bundle next to it to the person.
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

/** Skill search: the same search box in the panel that searches memory. */
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
