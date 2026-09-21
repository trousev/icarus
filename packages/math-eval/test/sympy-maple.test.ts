// Конвертер эталонов ASyMOB из SymPy в Maple: ошибка здесь не роняет прогон,
// а тихо превращает верные ответы в неверные, поэтому проверяем каждое правило.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sympyToMaple } from '../src/sympy-maple.ts';

test('степень и корни переводятся в синтаксис Maple', () => {
  assert.equal(sympyToMaple('x**5/120 - x**3/6'), 'x^5/120 - x^3/6');
  assert.equal(sympyToMaple('sqrt(x + 4)/(x - 4)'), 'sqrt(x + 4)/(x - 4)');
});

test('e и E — это число Эйлера, а не свободный символ', () => {
  assert.equal(sympyToMaple('e**(4/9)'), 'exp(1)^(4/9)');
  assert.equal(sympyToMaple('e**(-1/24)'), 'exp(1)^(-1/24)');
  assert.equal(sympyToMaple('E**2 / 4'), 'exp(1)^2 / 4');
  // `exp` и имена, где встречается буква e, не должны пострадать.
  assert.equal(sympyToMaple('exp(-x) + sec(x) + sin(x)'), 'exp(-x) + sec(x) + sin(x)');
});

test('обратные функции, модуль, пи и бесконечность', () => {
  assert.equal(sympyToMaple('atan(x) + asin(x) + atanh(x)'), 'arctan(x) + arcsin(x) + arctanh(x)');
  assert.equal(sympyToMaple('log(Abs(tan(x)))'), 'log(abs(tan(x)))');
  assert.equal(sympyToMaple('pi/2'), 'Pi/2');
  assert.equal(sympyToMaple('oo'), 'infinity');
});

test('Rational и вложенные скобки', () => {
  assert.equal(sympyToMaple('Rational(1, 2)*x'), '((1)/(2))*x');
  assert.equal(sympyToMaple('Rational(x + 1, x - 1)'), '((x + 1)/(x - 1))');
});

test('эталон берётся из SymPy, если LaTeX пустой', async () => {
  const { toProblem } = await import('../src/asymob.ts');
  const problem = toProblem({
    Index: '7',
    Challenge: 'Evaluate the limit',
    'Answer in Latex': '',
    'Answer in Sympy': 'e**(4/9)',
    Variation: 'Equivalence-All-Hard',
    Source: 'U-Math\nlimits\nid',
    Category: 'Limits',
  });
  assert.deepEqual(problem.answers, ['exp(1)^(4/9)']);
  assert.match(problem.verify ?? '', /SymPy: e\*\*\(4\/9\)/);

  const withLatex = toProblem({
    Index: '8',
    Challenge: 'Evaluate the limit',
    'Answer in Latex': '\\frac{1}{2}',
    'Answer in Sympy': 'S.Half',
    Variation: 'Symbolic-2',
    Source: 'U-Math\nlimits\nid',
    Category: 'Limits',
  });
  assert.deepEqual(withLatex.answers, ['\\frac{1}{2}']);
});
