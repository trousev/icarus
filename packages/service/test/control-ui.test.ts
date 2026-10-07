// Панель управления, вёрстка: номер строки — подсказка для глаза, а не текст.
// Копирование выделенного куска не должно приезжать с цифрами и отступом, поэтому
// жёлоб строки обязан быть некопируемым (user-select:none), а кнопка «забыть» —
// не попадать в выделение вместе со строкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelHtml, type PanelSession } from '../src/control/ui.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [{ id: 'memory', label: 'Память' }],
  scopes: { personal: 'memory', shared: 'memory', maple: 'maple' },
};

test('номер строки в панели не попадает в выделение и буфер обмена', () => {
  const html = panelHtml(SESSION);

  const gutterRule = /(?:^|\n)\s*\.ln\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(gutterRule, /user-select\s*:\s*none/, 'жёлоб строки должен быть некопируемым');
  assert.match(gutterRule, /-webkit-user-select\s*:\s*none/, 'то же для webkit');
  assert.doesNotMatch(html, /<span class="muted">'\s*\+\s*String\(i \+ 1\)/, 'номер строки не рисуется копируемым текстом');
  assert.match(html, /<span class="ln">'\s*\+\s*String\(i \+ 1\)\.padStart\(3\)/, 'номер строки рисуется жёлобом .ln');

  const forgetRule = /(?:^|\n)\s*\.forget\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(forgetRule, /user-select\s*:\s*none/, 'кнопка «забыть» не должна попадать в выделение');
});

test('разделы панели: память правится, математика только смотрится', () => {
  const html = panelHtml(SESSION);
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
  const html = panelHtml({ ...SESSION, scopes: { personal: 'memory', shared: 'memory' } });
  assert.doesNotMatch(html, /<option value="maple">/);
});

test('удаление файла целиком — только там, где память правится', () => {
  const html = panelHtml(SESSION);
  // Кнопка живёт в шапке открытого файла и рисуется лишь в режиме памяти:
  // у математики файлы создаёт Maple, и удалять их из панели нельзя.
  assert.match(html, /mode\(\) === 'memory' \? '<button class="delete-file danger">удалить файл<\/button>'/);
  assert.match(html, /api\('\/panel\/api\/delete'/, 'удаление уходит своим маршрутом');
  // Удаление подтверждается и заранее говорит, что файл вернётся откатом.
  assert.match(html, /askConfirm\('Удалить файл «' \+ path \+ '» целиком\?/);
});

test('шапка подписана Icarus Control Panel и рисует разделы из сервиса', () => {
  const html = panelHtml(SESSION);
  assert.match(html, /<title>Icarus Control Panel<\/title>/);
  assert.match(html, /<h1>Icarus Control Panel<\/h1>/);
  assert.match(html, /<a class="section active" href="\/panel">Память<\/a>/, 'раздел из SECTIONS — вкладкой');
  assert.match(html, /document\.title = 'Icarus Control Panel · ' \+ state\.user/);

  // Следующий раздел — это ещё одна вкладка, а не переделка страницы.
  const withSessions = panelHtml({
    ...SESSION,
    sections: [
      { id: 'memory', label: 'Память' },
      { id: 'sessions', label: 'Разговоры' },
    ],
  });
  assert.match(withSessions, /<a class="section" href="\/panel">Разговоры<\/a>/);
});

test('панель не приносит с собой никаких пропусков: вход делает прокси', () => {
  const html = panelHtml(SESSION);
  assert.doesNotMatch(html, /params\.get\('t'\)|Bearer |authorization/i, 'одноразовых токенов в странице больше нет');
  assert.match(html, /await fetch\(path, \{/, 'запросы уходят обычным fetch — с кукой SSO, а не с пропуском');
});

test('отказ доступа объясняет причину и экранирует то, что пришло извне', () => {
  const html = panelHtml({
    status: 403,
    message: '«<script>alert(1)</script>» не заведён в Icarus',
    hint: 'Человека добавляют в users: config.yaml',
  });
  assert.match(html, /Icarus Control Panel/);
  assert.match(html, /&lt;script&gt;/, 'имя из заголовка экранировано');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<main>/, 'пустой панели при отказе не показываем');
});
