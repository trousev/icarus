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
  assert.match(html, /Поиск по диалогам/);
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
