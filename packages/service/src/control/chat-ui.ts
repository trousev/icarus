// Страница чата в панели. Каркас статичный, данные приезжают из /panel/api/chat*,
// а стили и клиентский скрипт лежат рядом отдельными файлами: так в TypeScript не
// приходится экранировать бэктики и скобки, а браузер получает один и тот же JS
// и в локальной панели, и в сервисе на проде.
import fs from 'node:fs';
import { DEFAULT_WORKSPACE } from '../config.ts';
import { WEB_COMMANDS } from '../sessions/commands.ts';
import { escapeHtml, sessionStrings, sessionUiLanguage, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./chat-client.css', import.meta.url), 'utf8');
// Сообщения (пузыри, трассировка, .md) — общий файл с боковым чатом артефактов:
// один и тот же ответ должен выглядеть одинаково в обоих местах.
const MESSAGES_CSS = fs.readFileSync(new URL('./chat-messages.css', import.meta.url), 'utf8');
// Разметку держим отдельным файлом: её разбирает тест, а клиенту она нужна раньше
// самого чата — функции разметки подключаются как обычные глобальные.
const CLIENT_MD = fs.readFileSync(new URL('./chat-markdown.js', import.meta.url), 'utf8');
// Подсветку кода тоже подключаем раньше клиента: предпросмотр файлов зовёт
// `highlightCode` как обычную глобальную функцию.
const CLIENT_HIGHLIGHT = fs.readFileSync(new URL('./files-highlight.js', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./chat-client.js', import.meta.url), 'utf8');

export type ChatPageOptions = {
  /** Какой разговор открыть сразу; без него клиент выберет самый свежий. */
  chatId?: string;
  /** Есть ли куда отправить реплику: в панели без pi чат только для чтения. */
  enabled: boolean;
};

export function chatPage(session: PanelSession, options: ChatPageOptions): string {
  const ui = sessionStrings(session);
  const config = {
    user: session.user,
    chatId: options.chatId ?? null,
    model: session.model ?? '—',
    storage: session.storage ?? 'git · local',
    enabled: options.enabled,
    defaultWorkspace: DEFAULT_WORKSPACE,
    // Команды, которые чат разбирает сам: палитра показывает их сразу, не дожидаясь
    // ответа pi. Команды pi (скиллы, шаблоны, расширения) приезжают отдельно.
    commands: WEB_COMMANDS,
    // Строки клиента — из того же словаря, что и серверная разметка: иначе поле
    // ввода переключится, а «Ничего не найдено» в списке чатов останется русским.
    ui,
  };
  // JSON уезжает в <script>: экранируем «<», иначе значение с </script> закроет тег.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');

  return shell(`<style>${MESSAGES_CSS}</style>
<style>${CLIENT_CSS}</style>
<div class="chat-app" id="chat-app">
  <aside class="chat-side" id="chat-side">
    <div class="side-brand">
      <div class="logo">I</div>
      <div class="brand-text"><b>Icarus</b><span>${escapeHtml(ui.brandTagline)}</span></div>
      <button class="icon-btn side-close" id="close-side" aria-label="${escapeHtml(ui.closeMenu)}">×</button>
    </div>

    <button class="new-chat" id="new-chat"><span>+</span> ${escapeHtml(ui.newChat)}</button>

    <!-- Папки — надстройка над списком, а не ещё один чат: кнопка маленькая и
         стоит рядом с главной. Свёрнутость и состав папок помнит сервер. -->
    <button class="new-folder" id="new-folder" type="button"><span>+</span> ${escapeHtml(ui.folderNew)}</button>

    <!-- Черновик занимает место кнопки: разговор создаётся только с первым
         сообщением, а до тех пор это просто строка списка «Новый чат». -->
    <div class="draft-wrap" id="draft-wrap" hidden>
      <button class="chat-item active" id="draft-item" type="button">
        <div class="chat-item-top"><span class="chat-item-title">${escapeHtml(ui.newChat)}</span>
          <time class="chat-item-time" id="draft-time"></time></div>
        <div class="chat-item-preview">${escapeHtml(ui.draftPreview)}</div>
      </button>
    </div>

    <div class="chat-list" id="chat-list"><p class="side-empty">${escapeHtml(ui.chatListEmpty)}</p></div>

    <!-- Архив — секция того же списка, а не отдельная страница: разговор уходит
         из ежедневного списка, но остаётся под рукой вместе с историей и файлами. -->
    <div class="archive-zone" id="archive-zone">
      <button class="archive-toggle" id="archive-toggle" type="button"
              aria-expanded="false" aria-controls="archive-list">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></svg>
        <span class="archive-label">${escapeHtml(ui.archive)}</span>
        <span class="archive-count" id="archive-count" hidden></span>
        <span class="archive-chevron" aria-hidden="true">▸</span>
      </button>
      <div class="archive-list" id="archive-list" hidden></div>
    </div>

    <!-- Настройки — одна дверь. Сами разделы живут на своей странице, и там же
         в этой панели появляется их меню: два списка настроек человеку не нужны.
         Артефакты — не настройка, поэтому стоят рядом с «Настройками», а не внутри. -->
    <div class="side-settings">
      <a class="side-link" href="/panel/artifacts"><span>${escapeHtml(ui.artifacts)}</span></a>
      <a class="side-link" href="/panel/memory"><span>${escapeHtml(ui.settings)}</span></a>
    </div>

    <div class="side-foot">
      <div><span>${escapeHtml(ui.modelLabel)}</span><span>${escapeHtml(session.model ?? '—')}</span></div>
      <div><span>${escapeHtml(ui.storageLabel)}</span><span>${escapeHtml(session.storage ?? 'git · local')}</span></div>
    </div>

    <div class="side-resizer" id="side-resizer" role="separator" aria-orientation="vertical"
         aria-label="${escapeHtml(ui.panelWidth)}" aria-valuemin="220" aria-valuemax="560" aria-valuenow="278"
         tabindex="0"></div>
  </aside>

  <main class="chat-main">
    <header class="chat-top">
      <button class="icon-btn menu-btn" id="toggle-side" aria-label="${escapeHtml(ui.menu)}">☰</button>
      <div class="chat-crumbs">Icarus / <b id="chat-title">${escapeHtml(ui.newChat)}</b><span class="chat-archived-tag" id="chat-archived-tag" hidden>${escapeHtml(ui.archiveTag)}</span></div>
      <!-- Откуда пришла последняя реплика: сессия у разговора одна на все входы,
           и по файлу истории этого не видно — канал запоминает сервис. -->
      <span class="chat-via" id="chat-via" hidden></span>
      <label class="chat-search"><span>⌕</span><input id="chat-search" placeholder="${escapeHtml(ui.searchTitles)}" autocomplete="off"></label>
      <div class="top-status"><i></i><span id="chat-status">${escapeHtml(ui.agentActive)}</span></div>
      <!-- Архив открытого разговора: убрать с глаз, не теряя историю. Кнопка
           меняет смысл, когда разговор уже в архиве, — «вернуть» ищут там же. -->
      <button class="archive-btn" id="toggle-archive" type="button" aria-pressed="false" disabled>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></svg>
        <span id="archive-button-label">${escapeHtml(ui.archiveAdd)}</span>
      </button>
      <button class="icon-btn files-btn" id="toggle-files" aria-label="${escapeHtml(ui.workspaceFiles)}" title="${escapeHtml(ui.workspaceFiles)}" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></svg>
      </button>
    </header>

    <section class="chat-scroll" id="chat-scroll">
      <div class="chat-empty" id="chat-empty">
        <div class="empty-logo">I</div>
        <h1>${escapeHtml(ui.emptyHeading)}</h1>
        <p>${escapeHtml(ui.emptyText)}</p>
        <div class="suggestions">
          ${ui.suggestions
            .map((prompt) => `<button data-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`)
            .join('\n          ')}
        </div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
    </section>

    <div class="composer">
      <div class="pending" id="chat-pending" hidden></div>
      <!-- Очередь реплик, написанных во время хода: живёт на сервере, поэтому
           переживает F5. Каждую можно снять, пока она не отправилась. -->
      <div class="queue" id="chat-queue" hidden>
        <div class="queue-head"><b id="queue-count">${escapeHtml(ui.queueCount.replace('{n}', '0'))}</b><span class="queue-hint">${escapeHtml(ui.queueHint)}</span></div>
        <div class="queue-list" id="queue-list"></div>
      </div>
      <div class="composer-locked" id="chat-locked" hidden></div>
      <div class="composer-box" id="composer-box">
        <!-- Палитра команд: всплывает над полем, как только человек набрал «/».
             Список команд чата известен сразу, команды pi подгружаются следом. -->
        <div class="cmd-palette" id="cmd-palette" role="listbox" aria-label="${escapeHtml(ui.chatCommands)}" hidden></div>
        <button class="icon-btn attach" id="chat-attach" aria-label="${escapeHtml(ui.attachFile)}" title="${escapeHtml(ui.attachFile)}"${options.enabled ? '' : ' disabled'}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <input id="chat-files" type="file" multiple hidden>
        <textarea id="chat-input" rows="1" placeholder="${escapeHtml(ui.inputPlaceholder)}"${options.enabled ? '' : ' disabled'}></textarea>
        <div class="composer-actions">
          <!-- Две разные операции: «сейчас» отменяет чужую работу, «отправить»
               при идущем ходе ставит реплику в очередь. -->
          <button class="now" id="chat-now" title="${escapeHtml(ui.nowTitle)}" hidden>${escapeHtml(ui.nowSend)}</button>
          <button class="stop" id="chat-stop" aria-label="${escapeHtml(ui.stop)}" title="${escapeHtml(ui.stopAnswer)}" hidden>■</button>
          <button class="send" id="chat-send" aria-label="${escapeHtml(ui.send)}"${options.enabled ? '' : ' disabled'}>↑</button>
        </div>
      </div>
      <div class="composer-foot">
        <!-- Под полем ввода — только отказы и подтверждения. Прогресс хода
             (шаги, команды, субагенты) живёт в трассировке ответа: дублировать
             его мелким текстом снизу незачем. -->
        <span id="chat-note">${options.enabled ? '' : escapeHtml(ui.chatDisabledNote)}</span>
        <span>${escapeHtml(ui.composerHint)}</span>
      </div>
    </div>
  </main>

  <!-- Правая панель: файлы рабочей папки открытого разговора. Клиент рисует
       дерево и предпросмотр; здесь только каркас, иначе страница пухнет вдвое. -->
  <aside class="files-panel" id="files-panel" aria-label="${escapeHtml(ui.workspaceFiles)}">
    <!-- На узком экране панель выдвигается поверх шапки чата и закрывает кнопку
         «Файлы»: свой крестик остаётся единственным способом её свернуть. -->
    <button class="icon-btn files-close" id="files-close" aria-label="${escapeHtml(ui.hideFiles)}" title="${escapeHtml(ui.hideFiles)}">×</button>
    <!-- Поиск по всему workspace, а не по открытой папке: чаще всего файл ищут
         по куску текста, не зная, в какой он папке. Результаты встают на место
         дерева, поэтому панель не раздваивается. -->
    <label class="files-search"><span>⌕</span><input id="files-search" placeholder="${escapeHtml(ui.filesSearch)}" autocomplete="off" aria-label="${escapeHtml(ui.filesSearchAria)}"></label>
    <div class="files-tree" id="files-tree"><p class="files-note">${escapeHtml(ui.readingFolder)}</p></div>
    <div class="files-split" id="files-split" role="separator" aria-orientation="horizontal"
         aria-label="${escapeHtml(ui.previewHeight)}" aria-valuemin="90" tabindex="0"><span></span></div>
    <section class="files-preview" id="files-preview" aria-live="polite"></section>
    <div class="files-resizer" id="files-resizer" role="separator" aria-orientation="vertical"
         aria-label="${escapeHtml(ui.filesPanelWidth)}" aria-valuemin="300" aria-valuemax="1440" aria-valuenow="400"
         tabindex="0"></div>
  </aside>
</div>
<script>window.__CHAT_CFG__ = ${json};</script>
<script>${CLIENT_MD}</script>
<script>${CLIENT_HIGHLIGHT}</script>
<script>${CLIENT_JS}</script>`, sessionUiLanguage(session));
}
