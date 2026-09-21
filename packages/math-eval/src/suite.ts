// Чтение набора задач: JSONL, где `#` — комментарий, а битая строка — ошибка.
//
// Строка с опечаткой не должна молча выпадать из прогона: незамеченная задача
// хуже упавшей, потому что портит знаменатель точности.
import fs from 'node:fs';
import type { Problem, ProblemKind } from './types.ts';

export function loadSuite(file: string): Problem[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const problems: Problem[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('#')) return;
    const where = `${file}:${index + 1}`;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${where}: не разобрал JSON — ${String(error)}`, { cause: error });
    }
    const problem = validate(raw, where);
    if (seen.has(problem.id)) throw new Error(`${where}: id «${problem.id}» повторяется`);
    seen.add(problem.id);
    problems.push(problem);
  });

  if (problems.length === 0) throw new Error(`${file}: в наборе нет ни одной задачи`);
  return problems;
}

function validate(raw: Record<string, unknown>, where: string): Problem {
  const id = raw.id;
  const category = raw.category;
  const question = raw.question;
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${where}: нет поля id`);
  if (typeof category !== 'string' || category.length === 0) throw new Error(`${where}: нет поля category`);
  if (typeof question !== 'string' || question.length === 0) throw new Error(`${where}: нет поля question`);

  const kind = raw.kind ?? 'answer';
  if (kind !== 'answer' && kind !== 'refusal') throw new Error(`${where}: kind «${String(kind)}» неизвестен`);

  const answers = raw.answers ?? [];
  if (!Array.isArray(answers) || answers.some((answer) => typeof answer !== 'string')) {
    throw new Error(`${where}: answers должен быть массивом строк`);
  }
  if (kind === 'answer' && answers.length === 0) throw new Error(`${where}: для kind=answer нужен хотя бы один эталон`);

  const tier = raw.tier ?? 'smoke';
  if (tier !== 'smoke' && tier !== 'full') throw new Error(`${where}: tier «${String(tier)}» неизвестен`);

  return {
    id,
    category,
    tier,
    kind: kind as ProblemKind,
    question,
    answers: answers as string[],
    verify: typeof raw.verify === 'string' ? raw.verify : undefined,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
  };
}

export type Selection = { tier?: 'smoke' | 'full' | 'all'; category?: string; ids?: string[] };

export function selectProblems(problems: Problem[], selection: Selection = {}): Problem[] {
  const tier = selection.tier ?? 'all';
  const wanted = selection.ids && selection.ids.length > 0 ? new Set(selection.ids) : null;
  const chosen = problems.filter((problem) => {
    if (tier !== 'all' && problem.tier !== tier) return false;
    if (selection.category && problem.category !== selection.category) return false;
    if (wanted && !wanted.has(problem.id)) return false;
    return true;
  });
  if (chosen.length === 0) throw new Error('под фильтр не попала ни одна задача');
  if (wanted) {
    const known = new Set(problems.map((problem) => problem.id));
    const missing = [...wanted].filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`в наборе нет задач: ${missing.join(', ')}`);
  }
  return chosen;
}
