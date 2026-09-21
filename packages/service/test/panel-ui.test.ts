// Панель памяти, вёрстка файла: номер строки — подсказка для глаза, а не текст.
// Копирование выделенного куска не должно приезжать с цифрами и отступом, поэтому
// жёлоб строки обязан быть некопируемым (user-select:none), а кнопка «забыть» —
// не попадать в выделение вместе со строкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelHtml } from '../src/panel/ui.ts';

test('номер строки в панели не попадает в выделение и буфер обмена', () => {
  const html = panelHtml({ user: 'probe' });

  const gutterRule = /(?:^|\n)\s*\.ln\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(gutterRule, /user-select\s*:\s*none/, 'жёлоб строки должен быть некопируемым');
  assert.match(gutterRule, /-webkit-user-select\s*:\s*none/, 'то же для webkit');
  assert.doesNotMatch(html, /<span class="muted">'\s*\+\s*String\(i \+ 1\)/, 'номер строки не рисуется копируемым текстом');
  assert.match(html, /<span class="ln">'\s*\+\s*String\(i \+ 1\)\.padStart\(3\)/, 'номер строки рисуется жёлобом .ln');

  const forgetRule = /(?:^|\n)\s*\.forget\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(forgetRule, /user-select\s*:\s*none/, 'кнопка «забыть» не должна попадать в выделение');
});
