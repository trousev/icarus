// Панель памяти, вёрстка файла: номер строки — подсказка для глаза, а не текст.
// Копирование выделенного куска не должно приезжать с цифрами и отступом, поэтому
// жёлоб строки обязан быть некопируемым (user-select:none), а кнопка «забыть» —
// не попадать в выделение вместе со строкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelHtml } from '../src/panel/ui.ts';

const SCOPES = { personal: 'memory', shared: 'memory', maple: 'maple' } as const;

test('номер строки в панели не попадает в выделение и буфер обмена', () => {
  const html = panelHtml({ user: 'probe', scopes: SCOPES });

  const gutterRule = /(?:^|\n)\s*\.ln\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(gutterRule, /user-select\s*:\s*none/, 'жёлоб строки должен быть некопируемым');
  assert.match(gutterRule, /-webkit-user-select\s*:\s*none/, 'то же для webkit');
  assert.doesNotMatch(html, /<span class="muted">'\s*\+\s*String\(i \+ 1\)/, 'номер строки не рисуется копируемым текстом');
  assert.match(html, /<span class="ln">'\s*\+\s*String\(i \+ 1\)\.padStart\(3\)/, 'номер строки рисуется жёлобом .ln');

  const forgetRule = /(?:^|\n)\s*\.forget\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(forgetRule, /user-select\s*:\s*none/, 'кнопка «забыть» не должна попадать в выделение');
});

test('разделы панели: память правится, математика только смотрится', () => {
  const html = panelHtml({ user: 'probe', scopes: SCOPES });
  assert.match(html, /<option value="personal">личная<\/option>/);
  assert.match(html, /<option value="shared">семейная<\/option>/);
  assert.match(html, /<option value="maple">математика<\/option>/);
  assert.match(html, /main\.maple #history \{ display:none; \}/, 'у математики нет истории коммитов');

  // «Забыть» и «откатить» рисуются только в режиме памяти: у математики файлы
  // создаёт Maple, и построчная правка журнала сломала бы восстановление сессии.
  assert.match(html, /mode\(\) === 'memory' && line\.trim\(\)\.startsWith\('-'\)/);
  assert.match(html, /mode\(\) === 'memory'\) document\.querySelectorAll\('\.forget'\)/);
});

test('без Maple раздела математики в панели нет', () => {
  const html = panelHtml({ user: 'probe', scopes: { personal: 'memory', shared: 'memory' } });
  assert.doesNotMatch(html, /<option value="maple">/);
});
