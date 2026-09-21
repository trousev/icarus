// Сэмпл из ASyMOB: стратифицированная выборка возмущённых семейств без сидов.
//
// Сид-набор (`Original`, 100 задач) брать нельзя — топ-модели берут его на ~97%,
// это уже не измерение. Возмущённые семейства бьют по тому же навыку, но ломают
// узнавание шаблона: буквенные параметры, длинные числа, подмена символа на
// тождественно равное выражение.
//
// Выборка детерминирована зерном: тот же seed даёт тот же набор задач, поэтому
// прогоны воспроизводимы, а сам набор не обязан лежать в репозитории.
//
// Данные: Shalyt/ASyMOB-Algebraic_Symbolic_Mathematical_Operations_Benchmark,
// лицензия CC BY-SA 4.0. Производная выборка остаётся под той же лицензией —
// поэтому по умолчанию она пишется в gitignored `runtime/`, а не в репозиторий.
import fs from 'node:fs';
import path from 'node:path';
import { sympyToMaple } from './sympy-maple.ts';
import type { Problem } from './types.ts';

export type AsymobRow = {
  Index: string;
  Challenge: string;
  'Answer in Latex': string;
  'Answer in Sympy'?: string;
  Variation: string;
  Source: string;
  Category: string;
};

/** Группа семейств: то, что измеряем и о чём отчитываемся. */
export type Group =
  | 'symbolic'
  | 'numeric-one'
  | 'numeric-all'
  | 'numeric-random'
  | 'equivalence-one-easy'
  | 'equivalence-one-hard'
  | 'equivalence-all-easy'
  | 'equivalence-all-hard';

/** Сколько задач берём из каждой группы: ровно 400 на всех. */
export const GROUP_WEIGHTS: Record<Group, number> = {
  symbolic: 80,
  'numeric-one': 80,
  'numeric-all': 60,
  'numeric-random': 40,
  'equivalence-one-easy': 35,
  'equivalence-one-hard': 35,
  'equivalence-all-easy': 35,
  'equivalence-all-hard': 35,
};

/** `Original` — не группа: сиды исключены осознанно. */
export function groupOf(variation: string): Group | null {
  if (variation.startsWith('Symbolic-')) return 'symbolic';
  if (variation.startsWith('Numeric-One-')) return 'numeric-one';
  if (variation.startsWith('Numeric-All-') && variation.endsWith('-S')) return 'numeric-random';
  if (variation.startsWith('Numeric-All-')) return 'numeric-all';
  if (variation.startsWith('Equivalence-One-Easy')) return 'equivalence-one-easy';
  if (variation.startsWith('Equivalence-One-Hard')) return 'equivalence-one-hard';
  if (variation.startsWith('Equivalence-All-Easy')) return 'equivalence-all-easy';
  if (variation.startsWith('Equivalence-All-Hard')) return 'equivalence-all-hard';
  return null;
}

export function loadAsymob(file: string): AsymobRow[] {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as AsymobRow[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${file}: пустой или не массив`);
  return rows;
}

// ---------------------------------------------------------------------------
// Детерминированный случай

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: короткий, воспроизводимый, без зависимостей. */
export function rng(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Разложить `total` по долям пропорционально, остаток — самым крупным остаткам. */
export function largestRemainder(counts: number[], total: number): number[] {
  const sum = counts.reduce((acc, value) => acc + value, 0);
  if (sum === 0) return counts.map(() => 0);
  const exact = counts.map((value) => (value * total) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] += 1;
    left -= 1;
  }
  return floors;
}

export type SampleOptions = { seed: string; weights?: Record<Group, number> };

/**
 * Стратифицированная выборка: внутри группы доли тем сохраняются такими же, как
 * в самой группе, — иначе на 80 задачах легко получить одни интегралы.
 */
export function sampleAsymob(rows: AsymobRow[], options: SampleOptions): AsymobRow[] {
  const weights = options.weights ?? GROUP_WEIGHTS;
  const random = rng(options.seed);
  const chosen: AsymobRow[] = [];

  for (const group of Object.keys(weights) as Group[]) {
    const wanted = weights[group];
    if (wanted === 0) continue;
    const pool = rows.filter((row) => groupOf(row.Variation) === group);
    if (pool.length === 0) throw new Error(`в датасете нет группы ${group}`);
    if (pool.length < wanted) throw new Error(`в группе ${group} только ${pool.length} задач, нужно ${wanted}`);

    const topics = [...new Set(pool.map((row) => row.Category))].sort();
    const perTopic = largestRemainder(
      topics.map((topic) => pool.filter((row) => row.Category === topic).length),
      wanted,
    );

    topics.forEach((topic, index) => {
      const cell = shuffled(
        pool.filter((row) => row.Category === topic),
        random,
      );
      chosen.push(...cell.slice(0, perTopic[index]));
    });
  }

  return chosen.sort((a, b) => Number(a.Index) - Number(b.Index));
}

// ---------------------------------------------------------------------------
// Промпт и задача

/**
 * Формулировка как в ASyMOB: сама задача плюс их же запрет на код. Своя строка
 * только одна — просьба закончить ответ строкой `Answer:`, иначе ответ нечем
 * извлекать; на математику она не влияет.
 */
export function buildPrompt(challenge: string): string {
  return [
    'Solve the following problem.',
    '',
    challenge.trim(),
    '',
    "Assume you don't have access to a computer, and do not use code to solve the question.",
    'End your response with the final answer in LaTeX on a separate line, prefixed by "Answer:".',
  ].join('\n');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export type AsymobManifestEntry = { id: string; group: Group; variation: string; topic: string; index: string };

export function toProblem(row: AsymobRow): Problem {
  const group = groupOf(row.Variation);
  if (!group) throw new Error(`строка ${row.Index}: семейство «${row.Variation}» не поддержано`);
  // У возмущённых семейств LaTeX-эталон пустой: он есть только в синтаксисе SymPy.
  const latex = row['Answer in Latex']?.trim();
  const sympy = row['Answer in Sympy']?.trim();
  const reference = latex && latex.length > 0 ? latex : sympy ? sympyToMaple(sympy) : '';
  if (!reference) throw new Error(`строка ${row.Index}: нет эталона ни в LaTeX, ни в SymPy`);
  return {
    id: `asymob-${slug(row.Category)}-${slug(row.Variation)}-${row.Index}`,
    category: row.Category,
    tier: 'full',
    kind: 'answer',
    question: buildPrompt(row.Challenge),
    answers: [reference],
    verify: sympy ? `ASyMOB SymPy: ${sympy}` : `ASyMOB: ${row.Source.split('\n')[0]}`,
    notes: `${group} / ${row.Variation}`,
  };
}

export function manifestEntry(row: AsymobRow): AsymobManifestEntry {
  const group = groupOf(row.Variation);
  if (!group) throw new Error(`строка ${row.Index}: семейство «${row.Variation}» не поддержано`);
  return { id: toProblem(row).id, group, variation: row.Variation, topic: row.Category, index: row.Index };
}

// ---------------------------------------------------------------------------
// Командная строка

const USAGE = `sample-asymob — стратифицированный сэмпл из ASyMOB.

  node packages/math-eval/src/asymob.ts [флаги]

  --input <файл>   Full_ASyMOB_Dataset.json (по умолчанию runtime/math-eval/datasets/…)
  --out <файл>     куда писать JSONL (по умолчанию runtime/math-eval/suites/asymob-400.jsonl)
  --manifest <файл>  карта id → семейство/тема (по умолчанию рядом с --out, .manifest.json)
  --seed <строка>  зерно выборки (по умолчанию asymob-1); тем же зерном — тот же набор
  --total <n>      сколько задач (по умолчанию 400; доли групп сохраняются)
  --help           эта справка
`;

type Cli = { input: string; out: string; manifest: string; seed: string; total: number };

function parseArgv(argv: string[]): Cli | 'help' {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return 'help';
    if (!arg.startsWith('--')) throw new Error(`не понимаю аргумент «${arg}»`);
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`у флага --${name} нет значения`);
    flags.set(name, value);
    i += 1;
  }
  const out = flags.get('out') ?? path.join('runtime', 'math-eval', 'suites', 'asymob-400.jsonl');
  return {
    input: flags.get('input') ?? path.join('runtime', 'math-eval', 'datasets', 'Full_ASyMOB_Dataset.json'),
    out,
    manifest: flags.get('manifest') ?? out.replace(/\.jsonl$/, '') + '.manifest.json',
    seed: flags.get('seed') ?? 'asymob-1',
    total: Number(flags.get('total') ?? 400),
  };
}

/** Пересчитать доли групп под другой общий размер, сохранив пропорции. */
export function scaleWeights(total: number, weights: Record<Group, number> = GROUP_WEIGHTS): Record<Group, number> {
  const groups = Object.keys(weights) as Group[];
  const scaled = largestRemainder(
    groups.map((group) => weights[group]),
    total,
  );
  return Object.fromEntries(groups.map((group, index) => [group, scaled[index]])) as Record<Group, number>;
}

function main(argv: string[]): number {
  const parsed = parseArgv(argv);
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!Number.isInteger(parsed.total) || parsed.total <= 0) throw new Error('--total: ожидаю целое больше нуля');

  const weights = scaleWeights(parsed.total);
  const rows = loadAsymob(parsed.input);
  const sample = sampleAsymob(rows, { seed: parsed.seed, weights });
  const problems = sample.map(toProblem);
  const manifest = sample.map(manifestEntry);

  fs.mkdirSync(path.dirname(parsed.out), { recursive: true });
  const header = [
    '# Сэмпл ASyMOB (CC BY-SA 4.0, https://huggingface.co/datasets/Shalyt/ASyMOB-Algebraic_Symbolic_Mathematical_Operations_Benchmark).',
    `# зерно выборки: ${parsed.seed}; задач: ${problems.length}; сиды (Original) исключены.`,
    '# Группы: ' + Object.entries(weights).map(([group, count]) => `${group}=${count}`).join(', '),
  ];
  fs.writeFileSync(parsed.out, `${header.join('\n')}\n${problems.map((problem) => JSON.stringify(problem)).join('\n')}\n`);
  fs.writeFileSync(parsed.manifest, JSON.stringify({ seed: parsed.seed, weights, entries: manifest }, null, 2));

  const byGroup = new Map<string, number>();
  for (const entry of manifest) byGroup.set(entry.group, (byGroup.get(entry.group) ?? 0) + 1);
  process.stdout.write(`выборка: ${problems.length} задач → ${parsed.out}\n`);
  for (const [group, count] of byGroup) process.stdout.write(`  ${group}: ${count}\n`);
  process.stdout.write(`карта: ${parsed.manifest}\n`);
  return 0;
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (direct) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`сэмпл не собрался: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
