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
  assert.match(html, /el\('close-side'\)\.onclick = closeSide/, 'крестик по-прежнему закрывает меню');
});

test('над списком диалогов — только заголовок, без счётчика', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /class="dialogs-head">ДИАЛОГИ</, 'заголовок остался');
  assert.doesNotMatch(html, /chat-count/, 'цифра после «ДИАЛОГИ» не нужна');
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
