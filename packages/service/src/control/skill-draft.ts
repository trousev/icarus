// «Напиши за меня»: человек описывает идею одной фразой, модель собирает из неё
// готовый скилл — имя, описание и инструкцию.
//
// Панель тут только показывает черновик: сохраняет его человек, и только тогда
// появляется файл и коммит. Поэтому разбор ответа модели нарочно снисходительный —
// вытащить из болтовни JSON и привести имя к правилам дешевле, чем гонять модель
// второй раз за тем же.
//
// Проверки те же, что у сохранения (control/skills.ts): черновик обязан проходить
// их, иначе кнопка «Сохранить» упёрлась бы в отказ на ровном месте.
import {
  SKILL_DESCRIPTION_LIMIT,
  splitSkillFile,
  validateSkillDescription,
  validateSkillName,
} from './skills.ts';

/** Сколько символов идеи вообще имеет смысл отправлять модели. */
export const SKILL_IDEA_LIMIT = 4000;

/**
 * Сколько ждём модель. Разовый вопрос обычно отвечает за секунды, но тут на выходе
 * целая инструкция, да ещё и на «сильной» модели с размышлением — запас нужен.
 */
export const SKILL_DRAFT_TIMEOUT_MS = 90_000;

/**
 * Роль модели. Она заменяет обычную роль разового вопроса («отвечай ровно тем,
 * о чём просят»): тут нужен не ответ, а разбор.
 */
export const SKILL_DRAFT_SYSTEM =
  'Ты пишешь скиллы для агента. Отвечай одним JSON-объектом и ничем больше.';

/**
 * Задание модели.
 *
 * Требования к полям — те же, что у спецификации Agent Skills, но сказанные
 * человеческим языком: описание модель видит всегда и решает по нему, звать ли
 * скилл, а тело читает только когда решила звать. Отсюда и «не выдумывай
 * инструменты»: скилл с несуществующими средствами хуже, чем его отсутствие.
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
  /** Что панель поправила в ответе модели: человеку это видно в строке состояния. */
  note?: string;
};

export type SkillDraftResult = { ok: true; draft: SkillDraft } | { ok: false; message: string };

/**
 * Имя скилла из того, что предложила модель: строчные латинские буквы, цифры и
 * дефис. Всё остальное (пробелы, подчёркивания, диакритика, эмодзи) вычищаем —
 * иначе имя не пройдёт проверку, а человек об этом узнает уже после генерации.
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

/** Имя, которого ещё нет: к занятому добавляем номер, а не переписываем чужой скилл. */
export function uniqueSkillName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base.slice(0, 60).replace(/-+$/g, '')}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50).replace(/-+$/g, '')}-${Date.now().toString(36)}`;
}

/** JSON из ответа: модели любят заворачивать его в ``` и здороваться до него. */
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
      /* пробуем следующий вариант */
    }
  }
  return null;
}

/**
 * Ответ файлом вместо JSON: модель выдала готовый `SKILL.md` со frontmatter.
 *
 * Просили JSON, но это обычный дрейф модели, а не повод гонять её второй раз:
 * frontmatter читаем тем же разбором, что и файлы на диске, тело — что осталось.
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

/** Поле ответа: у модели спрашивали одно имя, но на всякий случай принимаем синонимы. */
function pick(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Тело без случайного frontmatter и без забора из бэктиков: это уже наш файл. */
function cleanBody(value: string): string {
  return value
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .trim();
}

/** Описание длиннее лимита подрезаем по концу фразы: терять начало обиднее. */
function trimDescription(value: string): { description: string; trimmed: boolean } {
  if (value.length <= SKILL_DESCRIPTION_LIMIT) return { description: value, trimmed: false };
  const cut = value.slice(0, SKILL_DESCRIPTION_LIMIT);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return { description: (stop > 200 ? cut.slice(0, stop + 1) : cut).trim(), trimmed: true };
}

/**
 * Разбор ответа модели в черновик скилла.
 *
 * Возвращает отказ только тогда, когда чинить нечего: не разобрался JSON или
 * потерялась инструкция. Имя и описание панель приводит в порядок сама, а если
 * имя не вышло латиницей — отдаёт пустым с пометкой: человек допишет его руками,
 * и сгенерированная инструкция при этом не пропадёт.
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
