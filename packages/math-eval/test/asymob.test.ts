// Сэмпл ASyMOB: проверяем то, что нельзя заметить глазами в отчёте — что сиды
// исключены, что темы внутри группы не перекошены и что зерно действительно
// воспроизводимо.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  groupOf,
  largestRemainder,
  loadAsymob,
  sampleAsymob,
  scaleWeights,
  toProblem,
  type AsymobRow,
  type Group,
} from '../src/asymob.ts';

const VARIATION: Record<Group, string> = {
  symbolic: 'Symbolic-2',
  'numeric-one': 'Numeric-One-3',
  'numeric-all': 'Numeric-All-4',
  'numeric-random': 'Numeric-All-2-S',
  'equivalence-one-easy': 'Equivalence-One-Easy',
  'equivalence-one-hard': 'Equivalence-One-Hard',
  'equivalence-all-easy': 'Equivalence-All-Easy',
  'equivalence-all-hard': 'Equivalence-All-Hard',
};

const ALL_ONE = Object.fromEntries(Object.keys(VARIATION).map((group) => [group, 1])) as Record<Group, number>;

let index = 0;
function row(group: Group, topic: string, overrides: Partial<AsymobRow> = {}): AsymobRow {
  index += 1;
  return {
    Index: String(index),
    Challenge: `Задача ${index}`,
    'Answer in Latex': `\\frac{${index}}{2}`,
    'Answer in Sympy': `${index}/2`,
    Variation: VARIATION[group],
    Source: 'U-Math\ntopic\nid',
    Category: topic,
    ...overrides,
  };
}

test('семейства раскладываются по группам, сиды — мимо', () => {
  assert.equal(groupOf('Original'), null);
  assert.equal(groupOf('Symbolic-5'), 'symbolic');
  assert.equal(groupOf('Numeric-One-10'), 'numeric-one');
  assert.equal(groupOf('Numeric-All-7'), 'numeric-all');
  assert.equal(groupOf('Numeric-All-3-S'), 'numeric-random');
  assert.equal(groupOf('Equivalence-All-Hard'), 'equivalence-all-hard');
  assert.equal(groupOf('Что-то-ещё'), null);
});

test('доли раскладываются без потери единиц', () => {
  assert.deepEqual(largestRemainder([1, 1, 1], 2), [1, 1, 0]);
  assert.deepEqual(largestRemainder([9, 1], 10), [9, 1]);
  assert.equal(largestRemainder([3, 5, 7], 17).reduce((a, b) => a + b, 0), 17);
  assert.deepEqual(scaleWeights(8), ALL_ONE);
  assert.equal(
    Object.values(scaleWeights(400)).reduce((a, b) => a + b, 0),
    400,
  );
});

test('темы внутри группы сохраняют пропорции группы', () => {
  const rows: AsymobRow[] = [
    ...Array.from({ length: 9 }, () => row('symbolic', 'Integrals')),
    row('symbolic', 'Limits'),
  ];
  const zero = Object.fromEntries(Object.keys(VARIATION).map((group) => [group, 0])) as Record<Group, number>;
  const sample = sampleAsymob(rows, { seed: 's', weights: { ...zero, symbolic: 10 } });
  const integrals = sample.filter((item) => item.Category === 'Integrals').length;
  assert.equal(integrals, 9, 'девять интегралов из десяти должны остаться интегралами');
  assert.equal(sample.filter((item) => item.Category === 'Limits').length, 1);
});

test('то же зерно — тот же набор, сиды не попадают', () => {
  const rows: AsymobRow[] = [];
  for (const group of Object.keys(VARIATION) as Group[]) {
    for (let i = 0; i < 20; i += 1) rows.push(row(group, i % 2 === 0 ? 'Integrals' : 'Series'));
  }
  rows.push(row('symbolic', 'Integrals', { Variation: 'Original', Index: '9999' }));

  const weights = Object.fromEntries(Object.keys(VARIATION).map((group) => [group, 4])) as Record<Group, number>;
  const first = sampleAsymob(rows, { seed: 'asymob-x', weights });
  const second = sampleAsymob(rows, { seed: 'asymob-x', weights });
  assert.deepEqual(
    first.map((item) => item.Index),
    second.map((item) => item.Index),
  );
  assert.equal(first.length, 32);
  assert.ok(!first.some((item) => item.Variation === 'Original'), 'сиды исключены');
  assert.deepEqual(
    [...new Set(first.map((item) => groupOf(item.Variation)))].sort(),
    (Object.keys(VARIATION) as Group[]).sort(),
  );
});

test('промпт повторяет запрет на код из ASyMOB и просит строку Answer', () => {
  const prompt = buildPrompt('Compute the integral $\\int x^2 e^x dx$');
  assert.match(prompt, /Solve the following problem\./);
  assert.match(prompt, /Assume you don't have access to a computer, and do not use code to solve the question\./);
  assert.match(prompt, /prefixed by "Answer:"/);
});

test('задача получает id с темой и семейством и эталон в LaTeX', () => {
  const problem = toProblem(row('numeric-random', 'Differential Equations'));
  assert.match(problem.id, /^asymob-differential-equations-numeric-all-2-s-\d+$/);
  assert.equal(problem.category, 'Differential Equations');
  assert.equal(problem.kind, 'answer');
  assert.equal(problem.answers.length, 1);
  assert.match(problem.notes ?? '', /numeric-random/);
});

test('датасет без нужной группы — ошибка, а не молчаливый пустой сэмпл', () => {
  assert.throws(() => sampleAsymob([row('symbolic', 'Integrals')], { seed: 's' }), /только 1 задач/);
  const onlySeeds = row('symbolic', 'Integrals', { Variation: 'Original' });
  assert.throws(() => sampleAsymob([onlySeeds], { seed: 's', weights: ALL_ONE }), /нет группы/);
  assert.throws(() => loadAsymob('/nonexistent/asymob.json'), /ENOENT/);
});
