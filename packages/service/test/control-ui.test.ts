// Панель управления, вёрстка: что из старой страницы обязано выжить в новой.
//
// Смыслы, которые тут охраняются, появились не из любви к разметке:
//  - номер строки — подсказка для глаза, а не текст: иначе копирование выделенного
//    куска приезжает с цифрами и отступом;
//  - правки и удаление есть только у памяти: у математики файлы создаёт Maple, и
//    журнал сессии — это код, из которого сессия восстанавливается;
//  - разделы рисуются из SECTIONS, а не зашиты в страницу;
//  - в странице нет никаких пропусков: человека называет SSO-прокси.
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelHtml, type PanelSession } from '../src/control/ui.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [
    { id: 'memory', label: 'Память' },
    { id: 'maple', label: 'Математика' },
  ],
  scopes: { personal: 'memory', shared: 'memory', maple: 'maple' },
  scopeLabels: { personal: 'Личная', shared: 'Семейная', maple: 'Математика' },
  model: 'icarus-core-2',
};

test('номер строки в панели не попадает в выделение и буфер обмена', () => {
  const html = panelHtml(SESSION, { section: 'memory', scope: 'personal', file: 'identity.md' });

  const gutterRule = /(?:^|\n)\s*\.num\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(gutterRule, /user-select\s*:\s*none/, 'номер строки должен быть некопируемым');
  assert.match(gutterRule, /-webkit-user-select\s*:\s*none/, 'то же для webkit');

  // Номер рисуется жёлобом .num рядом с текстом, а не склейкой в одну строку.
  assert.match(html, /<span class="num">' \+ String\(entry\.line\)\.padStart\(2, '0'\)/, 'номер строки рисуется жёлобом .num');
  assert.match(html, /<span class="row-text">' \+ esc\(/, 'текст записи лежит отдельно от номера');
});

test('память правится, математика только смотрится', () => {
  const html = panelHtml(SESSION, { section: 'memory', scope: 'personal', file: 'identity.md' });

  // Области приходят из сервиса: их подписи и число файлов панель не выдумывает.
  assert.match(html, /id="count-personal"/);
  assert.match(html, /href="\/panel\/memory\?scope=shared"/);
  assert.match(html, /counts\.personal/, 'счётчики берутся у сервиса');

  // Удаление записей живёт в разделе памяти и уходит своим маршрутом.
  assert.match(html, /endpoint\('forget-many'\)/, 'пачка уходит маршрутом раздела');
  assert.match(html, /askConfirm\('Убрать из памяти '/);

  // А у математики ни галочек, ни истории файла: рендер другой ветки.
  const maple = panelHtml(SESSION, { section: 'maple', scope: 'maple', file: 'osc.jsonl' });
  assert.match(maple, /renderReadOnly\(data\)/, 'журнал Maple рисуется без галочек');
  assert.match(
    maple,
    /showFileHead\(path, 'только для чтения', false\)/,
    'у математики нет вкладки истории',
  );
  assert.match(maple, /\.file-head\[hidden\] \{ display:none; \}/, 'пустая шапка файла не занимает место');
});

test('раздел скиллов — редактор, а не список файлов с галочками', () => {
  const session: PanelSession = {
    ...SESSION,
    sections: [
      { id: 'memory', label: 'Память' },
      { id: 'skills', label: 'Скиллы' },
    ],
    scopes: { personal: 'memory', shared: 'memory' },
  };

  const list = panelHtml(session, { section: 'skills' });
  assert.match(list, /href="\/panel\/skills"/, 'раздел стоит в сайдбаре рядом с памятью');
  assert.doesNotMatch(list, /href="\/panel\/skills\?/, 'области у скиллов нет — и параметра тоже');
  assert.match(list, /id="new-skill"/, 'новый скилл заводится кнопкой');
  assert.match(list, /cfg\.mode === 'skills' \? loadSkills\(\) : loadFiles\(\)/, 'список рисуется скиллами');
  assert.doesNotMatch(list, /id="count-skills"[^>]*>5</, 'число у раздела приходит из сервиса');

  // Пустой редактор нового скилла: раздел открывается и без файла, и это состояние
  // живёт в адресе (`?new=1`), а не в скрытой переменной.
  const fresh = panelHtml(session, { section: 'skills', fresh: true });
  assert.match(fresh, /id="skill-body"/, 'тело SKILL.md правится тут же');
  assert.match(fresh, /fillSkill\(null\)/, 'у нового скилла полей ещё нет — значения пустые');
  assert.match(fresh, /go\(\{ file: null, fresh: true, tab: 'notes' \}\)/, 'кнопка ведёт в пустой редактор');

  const open = panelHtml(session, { section: 'skills', file: 'pirate-mode/SKILL.md' });
  assert.match(open, /endpoint\('skill', \{ id: cfg\.file \}\)/, 'скилл открывается своим маршрутом');
  assert.match(open, /endpoint\('history'\)/, 'у скиллов история — по всему каталогу, а не по файлу');
  assert.match(open, /endpoint\('save'\)/);
  assert.match(open, /askConfirm\('Удалить скилл «'/, 'удаление спрашивает подтверждение');
  // Отказ проверки не должен стирать черновик: сообщение уходит в строку состояния,
  // а не вместо редактора (иначе «нет описания» уносит с собой весь написанный текст).
  assert.match(open, /skillStatus\('Не сохранилось: '/, 'ошибка сохранения видна в редакторе');
});

test('без Maple раздела математики в панели нет', () => {
  const session: PanelSession = {
    ...SESSION,
    sections: [{ id: 'memory', label: 'Память' }],
    scopes: { personal: 'memory', shared: 'memory' },
  };
  const html = panelHtml(session, { section: 'memory', scope: 'personal' });
  assert.doesNotMatch(html, /href="\/panel\/maple/, 'выключенного раздела в сайдбаре нет');
  assert.doesNotMatch(html, /id="count-maple"/);
});

test('шапка подписана Icarus Control Panel и рисует разделы из сервиса', () => {
  const html = panelHtml(SESSION, { section: 'maple', scope: 'maple' });
  assert.match(html, /<title>Icarus Control Panel<\/title>/);
  assert.match(html, /<b>Icarus<\/b>/, 'в сайдбаре — имя панели');
  assert.match(html, /document\.title = 'Icarus Control Panel · ' \+ cfg\.user/);
  // Область в ссылке несёт только память: у математики своей области нет, и
  // `?scope=personal` в её адресе — это и была та путаница с двумя входами.
  assert.match(html, /href="\/panel\/memory\?scope=maple"/, 'раздел памяти — ссылкой с областью');
  assert.match(html, /href="\/panel\/maple"/, 'у математики область в адресе не тащим');
  assert.doesNotMatch(html, /href="\/panel\/maple\?/, 'лишнего параметра у раздела математики нет');
  assert.match(html, /icarus-core-2/, 'в подвале видно, какая модель работает');

  // Следующий раздел — это ещё одна ссылка, а не переделка страницы.
  const withSessions = panelHtml(
    { ...SESSION, sections: [...SESSION.sections, { id: 'sessions', label: 'Разговоры' }] },
    { section: 'memory', scope: 'personal' },
  );
  assert.match(withSessions, /href="\/panel\/sessions">Разговоры</);
});

test('панель не приносит с собой никаких пропусков: вход делает прокси', () => {
  const html = panelHtml(SESSION, { section: 'memory', scope: 'personal' });
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
  assert.doesNotMatch(html, /class="cols"/, 'пустой панели при отказе не показываем');
});
