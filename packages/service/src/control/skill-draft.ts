// "Write it for me": the person describes an idea in one phrase, the model builds
// a ready skill out of it — name, description and instruction.
//
// The panel here only shows the draft: the person saves it, and only then
// does the file and the commit appear. That is why parsing the model's answer is deliberately lenient —
// pulling JSON out of chatter and normalizing the name to the rules is cheaper than running the model
// a second time for the same thing.
//
// The checks are the same as for saving (control/skills.ts): the draft must pass
// them, otherwise the "Save" button would hit a refusal for no reason.
import {
  SKILL_DESCRIPTION_LIMIT,
  splitSkillFile,
  validateSkillDescription,
  validateSkillName,
} from './skills.ts';

/** How many characters of the idea it even makes sense to send to the model. */
export const SKILL_IDEA_LIMIT = 4000;

/**
 * How long we wait for the model. A one-off question usually answers in seconds, but here the output
 * is a whole instruction, and on a "strong" reasoning model at that — a margin is needed.
 */
export const SKILL_DRAFT_TIMEOUT_MS = 90_000;

/**
 * The model role. It replaces the usual one-off question role ("answer exactly what
 * is asked"): here what is needed is not an answer but a breakdown.
 */
export const SKILL_DRAFT_SYSTEM =
  'Ты пишешь скиллы для агента. Отвечай одним JSON-объектом и ничем больше.';

/**
 * The task for the model.
 *
 * The field requirements are the same as in the Agent Skills spec, but said in
 * plain language: the model always sees the description and decides from it whether to
 * call the skill, and reads the body only once it has decided to call. Hence "don't invent
 * tools": a skill with non-existent means is worse than no skill at all.
 */
export function skillDraftPrompt(idea: string): string {
  return [
    'Человек хочет скилл для агента Икара. Он описал идею так:',
    '',
    '"""',
    idea.trim(),
    '"""',
    '',
    'Собери из этого скилл и ответь одним JSON-объектом:',
    '{"name": "...", "description": "...", "body": "..."}',
    '',
    'Требования:',
    '- name — строчными латинскими буквами, цифрами и дефисом (например, pirate-mode).',
    '  Русское название — транслитом: это имя каталога и команды /skill:имя.',
    '- description — одна-две фразы: что скилл делает и в какой момент его звать.',
    '  Пиши на языке человека. Это единственное, что модель видит всегда, поэтому',
    '  вместо «помогает с разными задачами» назови конкретный повод.',
    '- body — инструкция в Markdown: шаги по порядку, на что смотреть, чего не делать.',
    '  Коротко и по делу, 10–40 строк. Не выдумывай инструменты и файлы, которых у',
    '  агента нет: он читает и пишет файлы, запускает команды, ищет в интернете.',
    '- Никаких пояснений вокруг JSON.',
  ].join('\n');
}

export type SkillDraft = {
  name: string;
  description: string;
  body: string;
  /** What the panel corrected in the model's answer: the person sees this in the status line. */
  note?: string;
};

export type SkillDraftResult = { ok: true; draft: SkillDraft } | { ok: false; message: string };

/**
 * Skill name from what the model proposed: lowercase latin letters, digits and
 * hyphen. Everything else (spaces, underscores, diacritics, emoji) is stripped —
 * otherwise the name would fail validation, and the person would learn about it only after generation.
 */
export function slugifySkillName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** A name that does not exist yet: append a number to a taken one instead of overwriting someone's skill. */
export function uniqueSkillName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base.slice(0, 60).replace(/-+$/g, '')}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50).replace(/-+$/g, '')}-${Date.now().toString(36)}`;
}

/** JSON from the answer: models like to wrap it in ``` and greet before it. */
function extractJson(answer: string): Record<string, unknown> | null {
  const text = answer
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next variant */
    }
  }
  return null;
}

/**
 * The answer as a file instead of JSON: the model returned a ready `SKILL.md` with frontmatter.
 *
 * We asked for JSON, but this is ordinary model drift, not a reason to run it a second time:
 * we read the frontmatter with the same parser as files on disk, and the body is whatever is left.
 */
function extractSkillFile(answer: string): Record<string, unknown> | null {
  const text = answer
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  if (!text.startsWith('---')) return null;

  const { frontmatter, body } = splitSkillFile(text);
  if (!frontmatter.name && !frontmatter.description) return null;
  return { ...frontmatter, body };
}

/** Answer field: we asked the model for one name, but accept synonyms just in case. */
function pick(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Body without an accidental frontmatter and without backtick fences: this is already our file. */
function cleanBody(value: string): string {
  return value
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .trim();
}

/** Trim a description longer than the limit at the end of a sentence: losing the beginning hurts more. */
function trimDescription(value: string): { description: string; trimmed: boolean } {
  if (value.length <= SKILL_DESCRIPTION_LIMIT) return { description: value, trimmed: false };
  const cut = value.slice(0, SKILL_DESCRIPTION_LIMIT);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return { description: (stop > 200 ? cut.slice(0, stop + 1) : cut).trim(), trimmed: true };
}

/**
 * Parsing the model's answer into a skill draft.
 *
 * Returns a failure only when there is nothing to fix: the JSON did not parse or
 * the instruction is missing. The panel tidies up the name and description itself, and if
 * the name did not come out in latin letters — returns it empty with a note: the person will type it by hand,
 * and the generated instruction is not lost in the process.
 */
export function parseSkillDraft(answer: string, taken: ReadonlySet<string> = new Set()): SkillDraftResult {
  const parsed = extractJson(answer) ?? extractSkillFile(answer);
  if (!parsed) return { ok: false, message: 'модель ответила не по-нашему: в ответе нет JSON' };

  const rawName = pick(parsed, ['name', 'title', 'slug']);
  const description = pick(parsed, ['description', 'when_to_use', 'when']);
  const body = cleanBody(pick(parsed, ['body', 'instructions', 'content']));

  if (!body) return { ok: false, message: 'модель не написала инструкцию — попробуй ещё раз' };
  if (!description) return { ok: false, message: 'модель не написала описание — попробуй ещё раз' };

  const notes: string[] = [];
  const slug = slugifySkillName(rawName);
  let name = slug;
  if (!slug) {
    notes.push('имя придумай сам: модель предложила не латиницей');
  } else {
    name = uniqueSkillName(slug, taken);
    if (name !== slug) notes.push(`имя «${slug}» занято — предложил «${name}»`);
    const nameProblem = validateSkillName(name);
    if (nameProblem) {
      name = '';
      notes.push(`имя придумай сам: ${nameProblem}`);
    }
  }

  const { description: trimmedDescription, trimmed } = trimDescription(description);
  if (trimmed) notes.push('описание было длинновато — укоротил по концу фразы');
  const descriptionProblem = validateSkillDescription(trimmedDescription);
  if (descriptionProblem) return { ok: false, message: `модель написала негодное описание: ${descriptionProblem}` };

  return {
    ok: true,
    draft: { name, description: trimmedDescription, body, ...(notes.length ? { note: notes.join('; ') } : {}) },
  };
}
