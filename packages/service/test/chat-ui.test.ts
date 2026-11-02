// Страница чата: главный экран панели — диалоги, пустое состояние и композер.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPage } from '../src/control/chat-ui.ts';
import type { PanelSession } from '../src/control/ui.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [
    { id: 'memory', label: 'Память' },
    { id: 'skills', label: 'Скиллы' },
  ],
  scopes: { personal: 'memory', shared: 'memory' },
  model: 'deepseek-v4-flash',
  storage: 'git · local',
};

test('чат — это лента с композером и диалогами, а не таблица настроек', () => {
  const html = chatPage(SESSION, { chatId: 'web-1', enabled: true });

  assert.match(html, /id="new-chat"/);
  assert.match(html, /Чем займёмся\?/);
  assert.match(html, /id="chat-input"/);
  assert.match(html, /id="chat-files"/, 'файл можно приложить');
  assert.match(html, /id="chat-attach"/, 'кнопка приложения');
  assert.match(html, /Поиск по названиям/);
  assert.match(html, /id="chat-list"/);
  assert.match(html, /id="chat-locked"/, 'у внешнего разговора есть плашка «только для чтения»');
  assert.match(html, /id="chat-status"/, 'статус сверху говорит, можно ли писать');
  assert.match(html, /href="\/panel\/memory"/, 'настройки памяти доступны из чата');
  assert.match(html, /href="\/panel\/skills"/, 'настройки скиллов тоже');
  assert.match(html, /id="settings-pane"/, 'настройки открываются поверх чата, не уводя со страницы');
  assert.match(html, /\/panel\/api\/chat\/image/, 'локальные картинки отдаёт сервер');
  assert.match(html, /md-image/, 'markdown-картинки рисуются');
  assert.match(html, /"chatId":"web-1"/);
  assert.match(html, /"enabled":true/);
  assert.doesNotMatch(html, /демо-режим/i, 'чат настоящий, без имитации');
});

test('клик по пустому месту сайдбара не сворачивает колонку диалогов', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Отступы вокруг «ДИАЛОГИ» — просто фон: панель сворачивает только крестик,
  // иначе любая мимоходная клика по сайдбару закрывает его.
  assert.doesNotMatch(html, /el\('chat-side'\)\.addEventListener/, 'сайдбар не ловит клики фоном');
  assert.match(html, /el\('close-side'\)\.onclick = closeMenu/, 'крестик по-прежнему закрывает меню');
});

test('свернуть панель можно только на мелких экранах', () => {
  const html = chatPage(SESSION, { enabled: true });
  // На широком экране колонка диалогов всегда на месте: ни ☰, ни ×, ни режима
  // «свёрнуто», иначе панель безвозвратно пропадает.
  assert.doesNotMatch(html, /side-collapsed/, 'на широком экране нет сворачивания');
  assert.match(html, /\.side-close \{ display: none;/, 'крестик скрыт по умолчанию');
  assert.match(
    html,
    /@media \(max-width: 900px\)[\s\S]*?\.menu-btn, \.side-close \{ display: inline-block; \}/,
    'на узком экране ☰ и × снова видны',
  );
});

test('скролл в списке диалогов — тонкий и в стык с правой границей', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Список выезжает в padding панели: полоса касается её границы, а не висит
  // в воздухе, поэтому и толщину можно позволить вдвое меньше.
  assert.match(html, /\.chat-list \{[\s\S]*?margin-right: -12px/, 'полоса прижата к границе панели');
  assert.match(html, /\.chat-list \{[\s\S]*?scrollbar-gutter: stable/, 'место под полосу не прыгает');
  assert.match(html, /\.chat-list::-webkit-scrollbar \{ width: 4px; \}/, 'в списке полоса 4px, а не 8px');
  assert.match(html, /\.chat-scroll::-webkit-scrollbar \{ width: 8px; \}/, 'ленту не трогаем');
});

test('ширина сайдбара тянется и запоминается', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Ручка на правой границе: колонка следует за --side-w, настройки открываются
  // от её края, на узком экране ручки нет.
  assert.match(html, /id="side-resizer"/, 'у границы есть ручка');
  assert.match(html, /grid-template-columns: var\(--side-w\) minmax\(0, 1fr\)/, 'колонка следует за шириной');
  assert.match(html, /left: var\(--side-w\)/, 'настройки открываются от края панели');
  assert.match(html, /localStorage\.setItem\(SIDE_WIDTH_KEY/, 'ширина переживает перезагрузку');
  assert.match(html, /\.side-resizer \{ display: none; \}/, 'на узком экране ручки нет');
});

test('новый чат — черновик: сервер узнаёт о нём с первым сообщением', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Кнопка превращается в строку списка, а POST /chats уходит из createChat —
  // то есть ровно перед отправкой первой реплики, а не по клику.
  assert.match(html, /id="draft-wrap" hidden/, 'черновик спрятан до клика');
  assert.match(html, /id="draft-item"/, 'у черновика своя строка в списке');
  assert.match(html, /el\('new-chat'\)\.onclick = startDraft/, 'клик по кнопке только открывает черновик');
  assert.match(html, /async function createChat/, 'создание вынесено в отдельную функцию');
  assert.doesNotMatch(html, /newChat\(/, 'мгновенного создания больше нет');
  // Кнопка и черновик — одна и та же высота строки, иначе список прыгает.
  assert.match(html, /--side-row: 58px/, 'высота строки задана один раз');
  assert.match(html, /\.new-chat \{[\s\S]*?height: var\(--side-row\)/, 'кнопка высотой со строку списка');
  assert.match(html, /\.draft-wrap \.chat-item \{[^}]*height: var\(--side-row\)/, 'черновик той же высоты');
});

test('над списком диалогов нет лишнего заголовка', () => {
  const html = chatPage(SESSION, { enabled: true });
  // «Новый чат» и сразу разговоры: подпись «ДИАЛОГИ» дублировала очевидное.
  assert.doesNotMatch(html, /dialogs-head/, 'заголовок убран, список начинается сразу');
  assert.doesNotMatch(html, /chat-count/, 'счётчика тоже нет');
});

test('без pi композер честно выключен', () => {
  const html = chatPage(SESSION, { enabled: false });
  assert.match(html, /id="chat-input"[^>]*disabled/);
  assert.match(html, /чат недоступен/);
  assert.match(html, /"enabled":false/);
});

test('страница чата не тянет внешних файлов и не приносит пропусков', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(html, /Bearer |authorization/i, 'доступ решает SSO-прокси');
});

test('ответ можно остановить на середине: кнопка «стоп» на месте «отправить»', () => {
  const html = chatPage(SESSION, { chatId: 'web-1', enabled: true });
  assert.match(html, /id="chat-stop"/, 'в композере есть кнопка остановки');
  assert.match(html, /\/panel\/api\/chat\/abort/, 'она ходит в abort, а не просто прячется');
  assert.match(html, /function setStreaming/, 'показ кнопки переключается вместе с потоком');
});

test('субагенты в чате видны живым списком, а не одной строкой', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /function subagentsHtml/, 'список детей рисуется отдельно');
  assert.match(html, /step-update/, 'клиент понимает обновления шага');
  assert.match(html, /\.sub-step\.running/, 'у работающего ребёнка свой вид');
  assert.match(html, /details class="sub-actions"/, 'шаги ребёнка — вложенный раскрывающийся список');
  assert.match(html, /data-sub=/, 'раскрытое состояние привязано к конкретному ребёнку');
  assert.match(html, /последние /, 'если шагов больше, чем влезло, подпись честная');
});
