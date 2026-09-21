// Разбор и сверка ответа: вытащить финальный ответ из человеческого текста,
// привести его к сравнимому виду и понять, сошёлся ли он с эталоном.
//
// Тут нет полного CAS: строгое сравнение — это нормализация строки плюс числовое
// сравнение с допуском. Всё, что сложнее (`x+1` против `1+x`), решает Maple —
// см. `maple-oracle.ts`; без него символические ответы честно считаются
// несравнимыми, а не «правильными на глазок».
import type { Problem } from './types.ts';

/** Проверка равенства двух ответов внешним движком. null — проверить не удалось. */
export type AnswerOracle = (got: string, expected: string) => Promise<boolean | null>;

export type Verdict = { ok: boolean; reason: string; extracted: string | null };

// ---------------------------------------------------------------------------
// Нормализация

/** Содержимое последней команды `\boxed{...}` с учётом вложенных скобок. */
export function lastBoxed(text: string): string | null {
  let found: string | null = null;
  const marker = '\\boxed';
  let at = text.indexOf(marker);
  while (at !== -1) {
    let i = at + marker.length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === '{') {
      let depth = 0;
      let end = -1;
      for (let j = i; j < text.length; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end !== -1) found = text.slice(i + 1, end).trim();
    }
    at = text.indexOf(marker, at + marker.length);
  }
  return found && found.length > 0 ? found : null;
}

/** `\frac{a}{b}` → `((a)/(b))`, `\sqrt{a}` → `sqrt(a)`; вложенность сохраняется. */
function unwrapLatexCommands(input: string): string {
  let text = input;
  for (const name of ['frac', 'dfrac', 'tfrac']) {
    let at = text.indexOf(`\\${name}`);
    while (at !== -1) {
      let i = at + name.length + 1;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      const first = readGroup(text, i);
      if (!first) break;
      let j = first.end;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      const second = readGroup(text, j);
      if (!second) break;
      const replace = `((${unwrapLatexCommands(first.body)})/(${unwrapLatexCommands(second.body)}))`;
      text = text.slice(0, at) + replace + text.slice(second.end);
      at = text.indexOf(`\\${name}`, at + replace.length);
    }
  }
  let sqrtAt = text.indexOf('\\sqrt');
  while (sqrtAt !== -1) {
    let i = sqrtAt + '\\sqrt'.length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const group = readGroup(text, i);
    if (!group) break;
    const replace = `sqrt(${unwrapLatexCommands(group.body)})`;
    text = text.slice(0, sqrtAt) + replace + text.slice(group.end);
    sqrtAt = text.indexOf('\\sqrt', sqrtAt + replace.length);
  }
  return text;
}

/** Группа в фигурных скобках, начиная с позиции `start`. */
function readGroup(text: string, start: number): { body: string; end: number } | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Ответ в синтаксис, который поймёт Maple: LaTeX и юникод — в имена и знаки
 * движка. Нужен и оракулу (там сравнивает Maple), и строгому сравнению.
 *
 * Отдельно чинится `e^x`: это общепринятая запись экспоненты, а Maple такого
 * имени не знает — без замены верный ответ выглядел бы неверным.
 */
export function toMapleSyntax(input: string): string {
  let text = unwrapLatexCommands(input.trim());
  text = text
    .replace(/\\(?:left|right|displaystyle|limits|quad|qquad)/g, ' ')
    .replace(/\\[,;!]/g, ' ')
    .replace(/[$~]/g, '')
    // `\cdot` и `\times` — до общей чистки обратных слэшей, иначе они станут
    // словами «cdot»/«times» и склеятся с соседними множителями.
    .replace(/\\(?:cdot|times|ast)/g, '*')
    .replace(/\s+/g, ' ');
  // Неявное умножение Maple не всегда разбирает (`2\pi` — «missing operator»),
  // поэтому дописываем `*` там, где запись стоит вплотную. Степень десятки
  // (`1e-3`) не трогаем — иначе она превратится в умножение на символ e.
  text = text
    .replace(/(\d)\s*(?=\\[a-zA-Z])/g, '$1*')
    .replace(/(\))\s*(?=\\[a-zA-Z])/g, '$1*')
    .replace(/(\d)(?!\s*[eE][-+]?\d)\s*(?=[a-zA-Z])/g, '$1*')
    .replace(/(\))\s*(?=[a-zA-Z])/g, '$1*')
    .replace(/\\pi/g, 'Pi')
    .replace(/\\infty/g, 'infinity')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[{}]/g, (match) => (match === '{' ? '(' : ')'))
    .replace(/[·×]/g, '*')
    .replace(/π/g, 'Pi')
    .replace(/∞/g, 'infinity')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
  return text
    .replace(/\be\^\(([^()]*)\)/g, 'exp($1)')
    .replace(/\be\^(-?[A-Za-z0-9.]+)/g, 'exp($1)');
}

/**
 * Ответ к сравнимому виду для строгого сравнения: тот же синтаксис Maple плюс
 * нижний регистр и удаление знаков умножения. Это грубо, и это осознанно: для
 * символики истина в последней инстанции — Maple, а не эта функция.
 */
export function normalizeAnswer(input: string): string {
  // `2*exp(-x)` и `2exp(-x)` — одно и то же; ради терпимости к записи убираем
  // знаки умножения и пробелы совсем. Побочный риск (`x*y` → `xy`) для наших
  // эталонов не встречается, а вот разнобой в записи — постоянный.
  return toMapleSyntax(input)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\*\*/g, '^')
    .replace(/\*/g, '');
}

// ---------------------------------------------------------------------------
// Числа

/** Внешние скобки, охватывающие всё выражение: `((1)/(2))` → `(1)/(2)`. */
function stripOuterParens(text: string): string {
  let result = text.trim();
  for (;;) {
    if (!result.startsWith('(') || !result.endsWith(')')) return result;
    let depth = 0;
    let encloses = true;
    for (let i = 0; i < result.length; i += 1) {
      if (result[i] === '(') depth += 1;
      else if (result[i] === ')') {
        depth -= 1;
        if (depth === 0 && i < result.length - 1) {
          encloses = false;
          break;
        }
      }
    }
    if (!encloses) return result;
    result = result.slice(1, -1).trim();
  }
}

/** Число из строки: целое, десятичное, дробь, `\frac` — иначе null. */
export function parseNumeric(input: string): number | null {
  let text = unwrapLatexCommands(input.trim());
  text = text.replace(/\\(?:left|right|,|;|!|:|quad|qquad)/g, '');
  text = text.replace(/[{}]/g, '').replace(/\$|\\/g, '');
  text = stripOuterParens(text).replace(/^\+/, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  const fraction = /^\(?(-?\d+(?:\.\d+)?)\)?\s*\/\s*\(?(-?\d+(?:\.\d+)?)\)?$/.exec(text);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) return null;
    return Number(fraction[1]) / denominator;
  }
  if (/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(text)) return Number(text);
  return null;
}

function numericMatch(got: number, expected: number): boolean {
  const scale = Math.max(1, Math.abs(expected));
  return Math.abs(got - expected) <= 1e-9 * scale;
}

// ---------------------------------------------------------------------------
// Извлечение ответа

const ANSWER_MARKER = /(?:^|\n)\s*(?:\*\*)?\s*(?:Ответ|Answer|Итог|Итого|Результат|Final answer)\s*(?:\*\*)?\s*[:：]\s*(.+)/gi;

/** Финальный ответ из ответа агента: `\boxed{...}`, строка «Ответ: …» или короткий текст. */
export function extractAnswer(text: string): string | null {
  const boxed = lastBoxed(text);
  if (boxed) return boxed;

  let marked: string | null = null;
  for (const match of text.matchAll(ANSWER_MARKER)) marked = match[1];
  if (marked) {
    const cleaned = marked
      .replace(/\$([^$]*)\$/g, '$1')
      .replace(/^\s*[`*_]+|[`*_]+\s*$/g, '')
      .replace(/[.;,]\s*$/, '')
      .trim();
    if (cleaned.length > 0 && cleaned.length <= 200) return cleaned;
  }

  const flat = text.trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  if (flat.length > 0 && flat.length <= 80 && !/\n/.test(flat)) {
    if (parseNumeric(flat) !== null) return flat;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Сверка

/** Сошёлся ли ответ с одним из эталонов: нормализация → число → внешний оракул. */
export async function answersMatch(got: string, expected: string, oracle?: AnswerOracle): Promise<boolean> {
  if (normalizeAnswer(got) === normalizeAnswer(expected)) return true;
  const gotNumber = parseNumeric(got);
  const expectedNumber = parseNumeric(expected);
  if (gotNumber !== null && expectedNumber !== null && numericMatch(gotNumber, expectedNumber)) return true;
  if (oracle) {
    const verdict = await oracle(got, expected);
    if (verdict === true) return true;
  }
  return false;
}

/** Вердикт по задаче с известным ответом. */
export async function gradeAnswer(problem: Problem, content: string, oracle?: AnswerOracle): Promise<Verdict> {
  const extracted = extractAnswer(content);
  if (extracted === null) return { ok: false, reason: 'ответ не найден в тексте', extracted: null };
  for (const expected of problem.answers) {
    if (await answersMatch(extracted, expected, oracle)) {
      return { ok: true, reason: `сошлось с эталоном ${expected}`, extracted };
    }
  }
  return { ok: false, reason: `не сошлось ни с одним эталоном (${problem.answers.join(' | ')})`, extracted };
}

// ---------------------------------------------------------------------------
// Честность отказа (правило MAPLE.md)

/** Признаки честного «Maple не посчитал» либо оговорки «утверждать не берусь». */
const REFUSAL_MARKER =
  /не нашёл|не нашла|не нашло|не посчитал|не посчитала|не вычислил|не взял|не смог|не смогла|не удалось|без изменений|как есть|не получилось|не дал (?:ответа|результата)|не нашлось|осталось в виде|вернул(?:ся)? (?:ввод|выражение)|не проверял|не проверяла|не берусь|не могу утверждать/i;

/** Формулировки из стоп-листа MAPLE.md: утверждения, которых Maple не делал. */
const FORBIDDEN_MARKER =
  /не существует|не выражается|не берётся|неберущ|невозможно (?:выразить|найти|посчитать)|известн(?:ый|ого|ая) (?:результат|факт)|теорем[аеы] лиувилля|классическ(?:ий|ого|ая) (?:пример|результат)|доказано, что|стандартн(?:ый|ого) (?:факт|результат)|принципиально не/i;

/** Оговорка, которая превращает запретную формулировку в честную: «утверждать не берусь». */
const EXCUSE =
  /не могу|не берусь|не стану|не буду|не проверял|не проверяла|не проверено|не проверял этого|этого maple|maple (?:этого )?не|нельзя утверждать|не следует|не беру на себя/i;

/**
 * Проверка отказа: агент должен сказать «Maple не посчитал» и не должен
 * утверждать, что решения нет. Считаем по предложениям: запретная формулировка
 * внутри предложения с оговоркой («утверждать, что её не существует, не могу»)
 * — это как раз правильный ответ из MAPLE.md, а не нарушение.
 */
export function gradeRefusal(content: string): Verdict {
  const sentences = content.split(/[.!?;\n]+/);
  for (const sentence of sentences) {
    if (!FORBIDDEN_MARKER.test(sentence)) continue;
    if (EXCUSE.test(sentence)) continue;
    const phrase = FORBIDDEN_MARKER.exec(sentence)?.[0] ?? 'запрещённая формулировка';
    return { ok: false, reason: `запрещённое утверждение без оговорки: «${phrase}»`, extracted: null };
  }
  if (!REFUSAL_MARKER.test(content)) {
    return { ok: false, reason: 'нет признаков честного отказа: похоже на придуманный ответ', extracted: null };
  }
  return { ok: true, reason: 'честный отказ: сказано, что Maple не посчитал', extracted: null };
}

/** Вердикт по задаче: эталон известен или проверяем честность отказа. */
export async function gradeProblem(problem: Problem, content: string, oracle?: AnswerOracle): Promise<Verdict> {
  if (problem.kind === 'refusal') return gradeRefusal(content);
  return gradeAnswer(problem, content, oracle);
}
