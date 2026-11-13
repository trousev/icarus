// Control panel, layout: what from the old page must survive in the new one.
//
// The meanings guarded here did not appear out of love for markup:
//  - the line number is a hint for the eye, not text: otherwise copying a selected
//    fragment comes with digits and indentation;
//  - edits and deletion exist only for memory and skills: other sections have their own render;
//  - sections are drawn from SECTIONS, not hardcoded into the page;
//  - there are no passes in the page at all: the person is named by the SSO proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelHtml, type PanelSession } from '../src/control/ui.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [
    { id: 'memory', label: 'Память' },
    { id: 'skills', label: 'Скиллы' },
  ],
  scopes: { personal: 'memory', shared: 'memory' },
  scopeLabels: { personal: 'Личная', shared: 'Семейная' },
  model: 'icarus-core-2',
};

test('the line number in the panel does not get into the selection and clipboard', () => {
  const html = panelHtml(SESSION, { section: 'memory', scope: 'personal', file: 'identity.md' });

  const gutterRule = /(?:^|\n)\s*\.num\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(gutterRule, /user-select\s*:\s*none/, 'номер строки должен быть некопируемым');
  assert.match(gutterRule, /-webkit-user-select\s*:\s*none/, 'то же для webkit');

  // The number is drawn as a .num gutter next to the text, not glued into one line.
  assert.match(html, /<span class="num">' \+ String\(entry\.line\)\.padStart\(2, '0'\)/, 'номер строки рисуется жёлобом .num');
  assert.match(html, /<span class="row-text">' \+ esc\(/, 'текст записи лежит отдельно от номера');
});

test('memory is edited line by line, skills have their own render', () => {
  const html = panelHtml(SESSION, { section: 'memory', scope: 'personal', file: 'identity.md' });

  // Scopes come from the service: the panel does not invent their labels and file counts.
  assert.match(html, /id="count-personal"/);
  assert.match(html, /href="\/panel\/memory\?scope=shared"/);
  assert.match(html, /counts\.personal/, 'счётчики берутся у сервиса');

  // Deleting entries lives in the memory section and goes through its own route.
  assert.match(html, /endpoint\('forget-many'\)/, 'пачка уходит маршрутом раздела');
  assert.match(html, /askConfirm\(fill\(cfg\.ui\.removeMemoryPrompt, \{ what \}\)/, 'удаление просит подтверждение');

  // An empty file head takes no space: without a file there is none.
  assert.match(html, /\.file-head\[hidden\] \{ display:none; \}/);
});

test('the skills section is an editor, not a list of files with checkboxes', () => {
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
  // The profile mode is inserted between skills and memory: settings have no file list,
  // and substituting loadFiles there would mean hitting a nonexistent route.
  assert.match(
    list,
    /cfg\.mode === 'skills' \? loadSkills\(\) : cfg\.mode === 'profile' \? Promise\.resolve\(\) : loadFiles\(\)/,
    'список рисуется скиллами, а у настроек его нет вовсе',
  );
  assert.doesNotMatch(list, /id="count-skills"[^>]*>5</, 'число у раздела приходит из сервиса');

  // The empty editor of a new skill: the section opens even without a file, and this state
  // lives in the address (`?new=1`), not in a hidden variable.
  const fresh = panelHtml(session, { section: 'skills', fresh: true });
  assert.match(fresh, /id="skill-body"/, 'тело SKILL.md правится тут же');
  assert.match(fresh, /fillSkill\(null\)/, 'у нового скилла полей ещё нет — значения пустые');
  assert.match(fresh, /go\(\{ file: null, fresh: true, tab: 'notes' \}\)/, 'кнопка ведёт в пустой редактор');

  // «Write it for me» is a block with an idea and a button; it exists only where there is
  // someone to write: in a panel without a model container it is not drawn at all.
  const canWrite = panelHtml({ ...session, draftSkills: true }, { section: 'skills', fresh: true });
  assert.match(canWrite, /"draftSkills":true/);
  assert.match(canWrite, /id="skill-idea"/, 'идею спрашивают одним полем');
  assert.match(canWrite, /endpoint\('draft'\)/, 'кнопка уходит своим маршрутом');
  assert.match(canWrite, /Напиши за меня/);

  const noWriter = panelHtml({ ...session, draftSkills: false }, { section: 'skills', fresh: true });
  assert.match(noWriter, /"draftSkills":false/);
  assert.match(noWriter, /cfg\.draftSkills && !cfg\.file/, 'блок под условием, а не всегда');

  const open = panelHtml(session, { section: 'skills', file: 'pirate-mode/SKILL.md' });
  assert.match(open, /endpoint\('skill', \{ id: cfg\.file \}\)/, 'скилл открывается своим маршрутом');
  assert.match(open, /endpoint\('history'\)/, 'у скиллов история — по всему каталогу, а не по файлу');
  assert.match(open, /endpoint\('save'\)/);
  assert.match(open, /askConfirm\(fill\(cfg\.ui\.deleteSkillPrompt, \{ name: data\.name \}\)/, 'удаление спрашивает подтверждение');
  // A validation failure must not erase the draft: the message goes to the status line,
  // not instead of the editor (otherwise «no description» takes the whole written text with it).
  assert.match(open, /skillStatus\(cfg\.ui\.saveFailedPrefix \+/, 'ошибка сохранения видна в редакторе');
});

test('the header is signed Icarus Control Panel and draws sections from the service', () => {
  const html = panelHtml(SESSION, { section: 'memory', scope: 'personal' });
  assert.match(html, /<title>Icarus Control Panel<\/title>/);
  assert.match(html, /<b>Icarus<\/b>/, 'в сайдбаре — имя панели');
  assert.match(html, /document\.title = 'Icarus Control Panel · ' \+ cfg\.user/);
  // The scope in the link carries only memory: skills have no scope of their own, and
  // `?scope=personal` in their address was exactly that confusion with two entries.
  assert.match(html, /href="\/panel\/memory\?scope=shared"/, 'раздел памяти — ссылкой с областью');
  assert.match(html, /icarus-core-2/, 'в подвале видно, какая модель работает');

  // The next section is one more link, not a remake of the page.
  const withSessions = panelHtml(
    { ...SESSION, sections: [...SESSION.sections, { id: 'sessions', label: 'Разговоры' }] },
    { section: 'memory', scope: 'personal' },
  );
  assert.match(withSessions, /href="\/panel\/sessions">Разговоры</);
});

test('the panel brings no passes with it: the proxy does the entry', () => {
  const html = panelHtml(SESSION, { section: 'memory', scope: 'personal' });
  assert.doesNotMatch(html, /params\.get\('t'\)|Bearer |authorization/i, 'одноразовых токенов в странице больше нет');
  assert.match(html, /await fetch\(path, \{/, 'запросы уходят обычным fetch — с кукой SSO, а не с пропуском');
});

test('an access denial explains the reason and escapes what came from outside', () => {
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

test('settings have a single menu — in the left panel, without horizontal tabs', () => {
  // Previously sections opened over the chat: horizontal tabs on top, a second
  // sidebar inside. Now the settings menu is single and lives in the left panel of the page.
  for (const section of ['memory', 'skills']) {
    const html = panelHtml(SESSION, { section });
    assert.match(html, /<aside>/, 'меню разделов живёт в левой панели');
    assert.match(html, /<p class="nav-title">НАСТРОЙКИ<\/p>/);
    assert.match(html, /class="nav-back" href="\/panel\/chat">← Назад в чат<\/a>/, 'из настроек есть выход в чат');
    assert.match(html, /<hr class="nav-sep">/, 'кнопка возврата отделена от разделов');
    assert.doesNotMatch(html, /">Чат<\/a>/, '«Чат» больше не выглядит ещё одним разделом настроек');
    assert.match(html, /id="q"/, 'поиск по разделу остаётся');
    assert.match(html, /id="content"/);
    assert.doesNotMatch(html, /embedded|embed=1|"embed"/, 'встроенного режима больше нет');
    assert.doesNotMatch(html, /settings-tabs|data-settings-tab/, 'горизонтальных табов настроек нет');
  }
});
