// Эталон ASyMOB лежит в синтаксисе SymPy: у возмущённых семейств поле
// `Answer in Latex` пустое (непустых LaTeX во всём датасете — 200 из 35 368).
// Чтобы сверять ответы одним движком — Maple, — эталон переводится в его
// синтаксис. Отдельный модуль и отдельные тесты: ошибка здесь тихо превращает
// верные ответы в неверные.
//
// Отдельно про `e`: в ASyMOB это **число Эйлера** (`e**(4/9)` для предела
// (tan 2x / 2x)^(1/(3x²)) — это e^{4/9}), а в SymPy `e` — свободный символ.
// Поэтому `e` переводится в `exp(1)`, а не остаётся буквой.

/** Обратные тригонометрические: SymPy `asin` — Maple `arcsin`. */
const ARC = /\ba(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|coth)\(/g;

/** Простые переименования и подстановки. */
const RENAME: Array<[RegExp, string]> = [
  [/\bAbs\(/g, 'abs('],
  [/\bRational\(\s*([^,()]+)\s*,\s*([^()]+)\)/g, '(($1)/($2))'],
  [/\bpi\b/g, 'Pi'],
  [/\boo\b/g, 'infinity'],
  [/\bE\b/g, 'exp(1)'],
  [/\be\b/g, 'exp(1)'],
];

export function sympyToMaple(input: string): string {
  let text = input.trim().replace(ARC, (_match, name: string) => `arc${name}(`);
  for (const [pattern, replacement] of RENAME) text = text.replace(pattern, replacement);
  // Степень — последней: до неё `**` не мешает искать имена.
  return text.replace(/\*\*/g, '^');
}
