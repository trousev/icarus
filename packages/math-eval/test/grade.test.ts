// Сверка ответов и правило честного отказа — то, что легко сломать незаметно:
// ошибка тут не роняет прогон, а тихо меняет цифру точности.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answersMatch,
  extractAnswer,
  gradeAnswer,
  gradeRefusal,
  lastBoxed,
  normalizeAnswer,
  parseNumeric,
  toMapleSyntax,
  type AnswerOracle,
} from '../src/grade.ts';
import type { Problem } from '../src/types.ts';

test('boxed берётся последний и с вложенными скобками', () => {
  assert.equal(lastBoxed('ерунда \\boxed{1/2} и ещё \\boxed{\\frac{3}{4}}'), '\\frac{3}{4}');
  assert.equal(lastBoxed('\\boxed{\\frac{x^{2}}{2}}'), '\\frac{x^{2}}{2}');
  assert.equal(lastBoxed('ничего'), null);
});

test('ответ достаётся из boxed, метки и короткого текста', () => {
  assert.equal(extractAnswer('Долго считал.\n\n\\boxed{400}'), '400');
  assert.equal(extractAnswer('Рассуждение.\n\nОтвет: 1/2'), '1/2');
  assert.equal(extractAnswer('Итого: 100891344545564193334812497256'), '100891344545564193334812497256');
  assert.equal(extractAnswer('Ответ: $\\frac{\\pi^4}{90}$'), '\\frac{\\pi^4}{90}');
  assert.equal(extractAnswer('42'), '42');
  assert.equal(extractAnswer('Я не знаю, что тут ответить, но расскажу про Maple.'), null);
});

test('нормализация убирает украшения LaTeX и не трогает смысл', () => {
  assert.equal(normalizeAnswer('\\dfrac{1}{2}'), '((1)/(2))');
  assert.equal(normalizeAnswer('2 \\cdot \\pi'), '2pi');
  assert.equal(normalizeAnswer('\\sqrt{2}'), 'sqrt(2)');
  assert.equal(normalizeAnswer('x^{2}'), 'x^(2)');
  assert.equal(normalizeAnswer('\\left( a \\right)'), '(a)');
  assert.equal(normalizeAnswer('5, 3'), '5,3');
});

// Запись, которую Maple обязан разобрать: иначе верный ответ посчитается неверным.
test('toMapleSyntax доводит LaTeX до Maple', () => {
  assert.equal(toMapleSyntax('\\frac{\\sqrt{2}\\,\\pi}{4}'), '((sqrt(2)*Pi)/(4))');
  assert.equal(toMapleSyntax('2\\pi'), '2*Pi');
  assert.equal(toMapleSyntax('e^{-x^2}'), 'exp(-x^2)');
  assert.equal(toMapleSyntax('(x^2-2*x+2)e^x'), '(x^2-2*x+2)*exp(x)');
  assert.equal(toMapleSyntax('1e-3'), '1e-3', 'степень десятки не должна стать умножением');
});

test('числа разбираются в дробях, запятых и степени', () => {
  assert.equal(parseNumeric('0.5'), 0.5);
  assert.equal(parseNumeric('1/2'), 0.5);
  assert.equal(parseNumeric('\\frac{1}{2}'), 0.5);
  assert.equal(parseNumeric('1,009,081'), 1009081);
  assert.equal(parseNumeric('2e3'), 2000);
  assert.equal(parseNumeric('\\pi'), null);
});

test('сверка: строка, число, внешний оракул', async () => {
  assert.ok(await answersMatch('1/2', '0.5'));
  assert.ok(await answersMatch('400', '400'));
  assert.ok(!(await answersMatch('401', '400')));
  // Порядок множителей строками не ловится — это ожидаемо и лечится оракулом.
  assert.ok(!(await answersMatch('(x^2-2*x+2)*exp(x)', 'exp(x)*(x^2-2*x+2)')));
  assert.ok(!(await answersMatch('2*exp(-x)', 'exp(-x)*2')));
  const oracle: AnswerOracle = async () => true;
  assert.ok(await answersMatch('2*exp(-x)', 'exp(-x)*2', oracle));
});

test('вердикт по задаче с эталоном объясняет причину', async () => {
  const problem: Problem = {
    id: 'x',
    category: 'test',
    tier: 'smoke',
    kind: 'answer',
    question: 'сколько?',
    answers: ['400'],
  };
  const ok = await gradeAnswer(problem, 'φ(1000) = 400.\n\n\\boxed{400}');
  assert.equal(ok.ok, true);
  assert.match(ok.reason, /сошлось/);

  const notFound = await gradeAnswer(problem, 'Я думаю, что это четыреста.');
  assert.equal(notFound.ok, false);
  assert.match(notFound.reason, /не найден/);

  const wrong = await gradeAnswer(problem, '\\boxed{401}');
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /не сошлось/);
});

// Образцы взяты из MAPLE.md: правильный отказ и запрещённый домысел.
test('честный отказ проходит, домысел — нет', () => {
  const good = gradeRefusal(
    'Maple вернул `int(x^x, x)` без изменений — первообразную он не нашёл. ' +
      'Утверждать, что её не существует, я не могу: Maple этого не проверял. ' +
      'Могу посчитать численно на отрезке — скажи, на каком.',
  );
  assert.equal(good.ok, true, good.reason);

  const bad = gradeRefusal('Первообразной не существует, это известный результат (теорема Лиувилля).');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /запрещённое утверждение/);

  const alsoBad = gradeRefusal('Это неберущийся интеграл, классический пример.');
  assert.equal(alsoBad.ok, false);

  const fabricated = gradeRefusal('Примерно 0.78343, если округлить.');
  assert.equal(fabricated.ok, false);
  assert.match(fabricated.reason, /придуманный/);
});

test('варианты «нельзя утверждать» не считаются нарушением', () => {
  const policy = gradeRefusal(
    'Maple даёт для этого erf-выражение, а элементарность он не проверял. ' +
      'Утверждать, что она не выражается в элементарных функциях, я не берусь: этого Maple не проверял.',
  );
  assert.equal(policy.ok, true, policy.reason);

  const violation = gradeRefusal('Нет, она не выражается в элементарных функциях — это теорема Лиувилля.');
  assert.equal(violation.ok, false, violation.reason);
});
