// Страница чата в панели. Каркас статичный, данные приезжают из /panel/api/chat*,
// а стили и клиентский скрипт лежат рядом отдельными файлами: так в TypeScript не
// приходится экранировать бэктики и скобки, а браузер получает один и тот же JS
// и в локальной панели, и в сервисе на проде.
import fs from 'node:fs';
import { DEFAULT_WORKSPACE } from '../config.ts';
import { escapeHtml, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./chat-client.css', import.meta.url), 'utf8');
// Сообщения (пузыри, трассировка, .md) — общий файл с боковым чатом артефактов:
// один и тот же ответ должен выглядеть одинаково в обоих местах.
const MESSAGES_CSS = fs.readFileSync(new URL('./chat-messages.css', import.meta.url), 'utf8');
// Разметку держим отдельным файлом: её разбирает тест, а клиенту она нужна раньше
// самого чата — функции разметки подключаются как обычные глобальные.
const CLIENT_MD = fs.readFileSync(new URL('./chat-markdown.js', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./chat-client.js', import.meta.url), 'utf8');

export type ChatPageOptions = {
  /** Какой разговор открыть сразу; без него клиент выберет самый свежий. */
  chatId?: string;
  /** Есть ли куда отправить реплику: в панели без pi чат только для чтения. */
  enabled: boolean;
};

export function chatPage(session: PanelSession, options: ChatPageOptions): string {
  const config = {
    user: session.user,
    chatId: options.chatId ?? null,
    model: session.model ?? '—',
    storage: session.storage ?? 'git · local',
    enabled: options.enabled,
    defaultWorkspace: DEFAULT_WORKSPACE,
  };
  // JSON уезжает в <script>: экранируем «<», иначе значение с </script> закроет тег.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');

  return shell(`<style>${MESSAGES_CSS}</style>
<style>${CLIENT_CSS}</style>
<div class="chat-app" id="chat-app">
  <aside class="chat-side" id="chat-side">
    <div class="side-brand">
      <div class="logo">I</div>
      <div class="brand-text"><b>Icarus</b><span>агент · чат и настройки</span></div>
      <button class="icon-btn side-close" id="close-side" aria-label="Закрыть меню">×</button>
    </div>

    <button class="new-chat" id="new-chat"><span>+</span> Новый чат</button>

    <!-- Черновик занимает место кнопки: разговор создаётся только с первым
         сообщением, а до тех пор это просто строка списка «Новый чат». -->
    <div class="draft-wrap" id="draft-wrap" hidden>
      <button class="chat-item active" id="draft-item" type="button">
        <div class="chat-item-top"><span class="chat-item-title">Новый чат</span>
          <time class="chat-item-time" id="draft-time"></time></div>
        <div class="chat-item-preview">Расскажи, что нужно сделать.</div>
      </button>
    </div>

    <div class="chat-list" id="chat-list"><p class="side-empty">Пока пусто. Начни новый чат.</p></div>

    <!-- Настройки — одна дверь. Сами разделы живут на своей странице, и там же
         в этой панели появляется их меню: два списка настроек человеку не нужны.
         Артефакты — не настройка, поэтому стоят рядом с «Настройками», а не внутри. -->
    <div class="side-settings">
      <a class="side-link" href="/panel/artifacts"><span>Артефакты</span></a>
      <a class="side-link" href="/panel/memory"><span>Настройки</span></a>
    </div>

    <div class="side-foot">
      <div><span>модель</span><span>${escapeHtml(session.model ?? '—')}</span></div>
      <div><span>хранилище</span><span>${escapeHtml(session.storage ?? 'git · local')}</span></div>
    </div>

    <div class="side-resizer" id="side-resizer" role="separator" aria-orientation="vertical"
         aria-label="Ширина панели" aria-valuemin="220" aria-valuemax="560" aria-valuenow="278"
         tabindex="0"></div>
  </aside>

  <main class="chat-main">
    <header class="chat-top">
      <button class="icon-btn menu-btn" id="toggle-side" aria-label="Меню">☰</button>
      <div class="chat-crumbs">Icarus / <b id="chat-title">Новый чат</b></div>
      <label class="chat-search"><span>⌕</span><input id="chat-search" placeholder="Поиск по названиям" autocomplete="off"></label>
      <div class="top-status"><i></i><span id="chat-status">Агент активен</span></div>
      <button class="icon-btn files-btn" id="toggle-files" aria-label="Файлы workspace" title="Файлы workspace" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></svg>
      </button>
    </header>

    <section class="chat-scroll" id="chat-scroll">
      <div class="chat-empty" id="chat-empty">
        <div class="empty-logo">I</div>
        <h1>Чем займёмся?</h1>
        <p>Icarus помнит контекст из кластеров памяти и работает по своим скиллам.
           Начни с вопроса или готового запроса.</p>
        <div class="suggestions">
          <button data-prompt="Собери план на сегодня">Собери план на сегодня</button>
          <button data-prompt="Что ты помнишь о Марке?">Что ты помнишь о Марке?</button>
          <button data-prompt="Подготовь сводку по «Атласу»">Подготовь сводку по «Атласу»</button>
          <button data-prompt="Напомни про дни рождения в июне">Напомни про дни рождения в июне</button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
    </section>

    <div class="composer">
      <div class="pending" id="chat-pending" hidden></div>
      <div class="composer-locked" id="chat-locked" hidden></div>
      <div class="composer-box">
        <button class="icon-btn attach" id="chat-attach" aria-label="Приложить файл" title="Приложить файл"${options.enabled ? '' : ' disabled'}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <input id="chat-files" type="file" multiple hidden>
        <textarea id="chat-input" rows="1" placeholder="Написать Icarus..."${options.enabled ? '' : ' disabled'}></textarea>
        <button class="stop" id="chat-stop" aria-label="Остановить" title="Остановить ответ" hidden>■</button>
        <button class="send" id="chat-send" aria-label="Отправить"${options.enabled ? '' : ' disabled'}>↑</button>
      </div>
      <div class="composer-foot">
        <!-- Под полем ввода — только отказы и подтверждения. Прогресс хода
             (шаги, команды, субагенты) живёт в трассировке ответа: дублировать
             его мелким текстом снизу незачем. -->
        <span id="chat-note">${options.enabled ? '' : 'чат недоступен: панель поднята без контейнера с pi'}</span>
        <span>Enter — отправить · Shift+Enter — перенос строки</span>
      </div>
    </div>
  </main>

  <!-- Правая панель: файлы рабочей папки открытого разговора. Клиент рисует
       дерево и предпросмотр; здесь только каркас, иначе страница пухнет вдвое. -->
  <aside class="files-panel" id="files-panel" aria-label="Файлы workspace">
    <header class="files-head">
      <i class="files-dot"></i>
      <div class="files-id"><b id="files-ws">Разговор</b><span id="files-ws-path"></span></div>
      <button class="icon-btn files-close" id="files-close" aria-label="Скрыть файлы" title="Скрыть файлы">×</button>
    </header>
    <div class="files-tree" id="files-tree"><p class="files-note">Читаю папку…</p></div>
    <div class="files-split" id="files-split" role="separator" aria-orientation="horizontal"
         aria-label="Высота предпросмотра" aria-valuemin="90" tabindex="0"><span></span></div>
    <section class="files-preview" id="files-preview" aria-live="polite"></section>
    <div class="files-resizer" id="files-resizer" role="separator" aria-orientation="vertical"
         aria-label="Ширина панели файлов" aria-valuemin="300" aria-valuemax="1440" aria-valuenow="400"
         tabindex="0"></div>
  </aside>
</div>
<script>window.__CHAT_CFG__ = ${json};</script>
<script>${CLIENT_MD}</script>
<script>${CLIENT_JS}</script>`);
}
