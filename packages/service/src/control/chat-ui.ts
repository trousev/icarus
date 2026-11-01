// Страница чата в панели. Каркас статичный, данные приезжают из /panel/api/chat*,
// а стили и клиентский скрипт лежат рядом отдельными файлами: так в TypeScript не
// приходится экранировать бэктики и скобки, а браузер получает один и тот же JS
// и в локальной панели, и в сервисе на проде.
import fs from 'node:fs';
import { escapeHtml, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./chat-client.css', import.meta.url), 'utf8');
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
  };
  // JSON уезжает в <script>: экранируем «<», иначе значение с </script> закроет тег.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');

  return shell(`<style>${CLIENT_CSS}</style>
<div class="chat-app" id="chat-app">
  <aside class="chat-side" id="chat-side">
    <div class="side-brand">
      <div class="logo">I</div>
      <div class="brand-text"><b>Icarus</b><span>агент · чат и настройки</span></div>
      <button class="icon-btn side-close" id="close-side" aria-label="Закрыть меню">×</button>
    </div>

    <button class="new-chat" id="new-chat"><span>+</span> Новый чат</button>

    <div class="dialogs-head">ДИАЛОГИ · <span id="chat-count">0</span></div>
    <div class="chat-list" id="chat-list"><p class="side-empty">Пока пусто. Начни новый чат.</p></div>

    <div class="side-settings">
      <p class="side-title">НАСТРОЙКИ</p>
      <a class="side-link" href="/panel/memory" data-settings="memory"><span>Память</span><em id="count-memory">…</em></a>
      <a class="side-link" href="/panel/skills" data-settings="skills"><span>Скиллы</span><em id="count-skills">…</em></a>
      <a class="side-link" href="/panel/maple" id="maple-link" data-settings="maple" hidden><span>Математика</span><em id="count-maple">…</em></a>
    </div>

    <div class="side-foot">
      <div><span>модель</span><span>${escapeHtml(session.model ?? '—')}</span></div>
      <div><span>хранилище</span><span>${escapeHtml(session.storage ?? 'git · local')}</span></div>
    </div>
  </aside>

  <main class="chat-main">
    <header class="chat-top">
      <button class="icon-btn menu-btn" id="toggle-side" aria-label="Меню">☰</button>
      <div class="chat-crumbs">Icarus / <b id="chat-title">Новый чат</b></div>
      <label class="chat-search"><span>⌕</span><input id="chat-search" placeholder="Поиск по диалогам" autocomplete="off"></label>
      <div class="top-status"><i></i>Агент активен</div>
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
      <div class="composer-box">
        <textarea id="chat-input" rows="1" placeholder="Написать Icarus..."${options.enabled ? '' : ' disabled'}></textarea>
        <button class="send" id="chat-send" aria-label="Отправить"${options.enabled ? '' : ' disabled'}>↑</button>
      </div>
      <div class="composer-foot">
        <span id="chat-working">${options.enabled ? '' : 'чат недоступен: панель поднята без контейнера с pi'}</span>
        <span>Enter — отправить · Shift+Enter — перенос строки</span>
      </div>
    </div>
  </main>

  <section class="settings-pane" id="settings-pane" hidden>
    <header class="settings-head">
      <div class="settings-tabs">
        <button data-settings-tab="memory" class="active">Память</button>
        <button data-settings-tab="skills">Скиллы</button>
        <button data-settings-tab="maple" id="settings-maple" hidden>Математика</button>
      </div>
      <button class="icon-btn" id="settings-close" aria-label="Закрыть настройки">×</button>
    </header>
    <iframe class="settings-frame" id="settings-frame" title="Настройки Икара"></iframe>
  </section>
</div>
<script>window.__CHAT_CFG__ = ${json};</script>
<script>${CLIENT_JS}</script>`);
}
