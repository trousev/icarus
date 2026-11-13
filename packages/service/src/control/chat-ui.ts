// The chat page in the panel. The shell is static, data arrives from /panel/api/chat*,
// while styles and the client script live alongside in separate files: this way TypeScript
// doesn't have to escape backticks and braces, and the browser gets the same JS
// both in the local panel and in the service in production.
import fs from 'node:fs';
import { DEFAULT_WORKSPACE } from '../config.ts';
import { WEB_COMMANDS } from '../sessions/commands.ts';
import { escapeHtml, sessionStrings, sessionUiLanguage, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./chat-client.css', import.meta.url), 'utf8');
// Messages (bubbles, trace, .md) — a shared file with the artifact side chat:
// the same answer must look identical in both places.
const MESSAGES_CSS = fs.readFileSync(new URL('./chat-messages.css', import.meta.url), 'utf8');
// We keep the markdown in a separate file: a test parses it, and the client needs it before
// the chat itself — the markdown functions are included as ordinary globals.
const CLIENT_MD = fs.readFileSync(new URL('./chat-markdown.js', import.meta.url), 'utf8');
// We also include syntax highlighting before the client: the file preview calls
// `highlightCode` as an ordinary global function.
const CLIENT_HIGHLIGHT = fs.readFileSync(new URL('./files-highlight.js', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./chat-client.js', import.meta.url), 'utf8');

export type ChatPageOptions = {
  /** Which conversation to open immediately; without it the client picks the freshest one. */
  chatId?: string;
  /** Whether there is somewhere to send a message: in a panel without pi the chat is read-only. */
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
    // Commands the chat parses itself: the palette shows them immediately, without waiting
    // for pi's answer. pi commands (skills, templates, extensions) arrive separately.
    commands: WEB_COMMANDS,
    // Client strings come from the same dictionary as the server markup: otherwise the input
    // field would switch but "Nothing found" in the chat list would stay Russian.
    ui,
  };
  // JSON goes into <script>: we escape "<", otherwise a value with </script> would close the tag.
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

    <!-- Folders are an add-on to the list, not another chat: the button is small and
         sits next to the main one. The server remembers collapsed state and folder contents. -->
    <button class="new-folder" id="new-folder" type="button"><span>+</span> ${escapeHtml(ui.folderNew)}</button>

    <!-- The draft takes the place of the button: a conversation is created only with the first
         message, and until then it is just a list row "New chat". -->
    <div class="draft-wrap" id="draft-wrap" hidden>
      <button class="chat-item active" id="draft-item" type="button">
        <div class="chat-item-top"><span class="chat-item-title">${escapeHtml(ui.newChat)}</span>
          <time class="chat-item-time" id="draft-time"></time></div>
        <div class="chat-item-preview">${escapeHtml(ui.draftPreview)}</div>
      </button>
    </div>

    <div class="chat-list" id="chat-list"><p class="side-empty">${escapeHtml(ui.chatListEmpty)}</p></div>

    <!-- The archive is a section of the same list, not a separate page: a conversation leaves
         the daily list but stays at hand along with its history and files. -->
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

    <!-- Settings are one door. The sections themselves live on their own page, and their menu
         appears in this panel: a person does not need two settings lists.
         Artifacts are not a setting, so they sit next to "Settings", not inside. -->
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
      <!-- Where the last message came from: a conversation has one session for all inputs,
           and the history file does not show it — the service remembers the channel. -->
      <span class="chat-via" id="chat-via" hidden></span>
      <label class="chat-search"><span>⌕</span><input id="chat-search" placeholder="${escapeHtml(ui.searchTitles)}" autocomplete="off"></label>
      <div class="top-status"><i></i><span id="chat-status">${escapeHtml(ui.agentActive)}</span></div>
      <!-- Archiving the open conversation: out of sight without losing the history. The button
           changes meaning when the conversation is already archived — "restore" is looked for there too. -->
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
      <!-- Queue of messages written during a turn: it lives on the server, so it
           survives F5. Each one can be removed before it is sent. -->
      <div class="queue" id="chat-queue" hidden>
        <div class="queue-head"><b id="queue-count">${escapeHtml(ui.queueCount.replace('{n}', '0'))}</b><span class="queue-hint">${escapeHtml(ui.queueHint)}</span></div>
        <div class="queue-list" id="queue-list"></div>
      </div>
      <div class="composer-locked" id="chat-locked" hidden></div>
      <div class="composer-box" id="composer-box">
        <!-- Command palette: pops up above the field as soon as the person types "/".
             The chat command list is known immediately, pi commands load after. -->
        <div class="cmd-palette" id="cmd-palette" role="listbox" aria-label="${escapeHtml(ui.chatCommands)}" hidden></div>
        <button class="icon-btn attach" id="chat-attach" aria-label="${escapeHtml(ui.attachFile)}" title="${escapeHtml(ui.attachFile)}"${options.enabled ? '' : ' disabled'}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <input id="chat-files" type="file" multiple hidden>
        <textarea id="chat-input" rows="1" placeholder="${escapeHtml(ui.inputPlaceholder)}"${options.enabled ? '' : ' disabled'}></textarea>
        <div class="composer-actions">
          <!-- Two different operations: "now" cancels someone else's work, "send"
               during an ongoing turn queues the message. -->
          <button class="now" id="chat-now" title="${escapeHtml(ui.nowTitle)}" hidden>${escapeHtml(ui.nowSend)}</button>
          <button class="stop" id="chat-stop" aria-label="${escapeHtml(ui.stop)}" title="${escapeHtml(ui.stopAnswer)}" hidden>■</button>
          <button class="send" id="chat-send" aria-label="${escapeHtml(ui.send)}"${options.enabled ? '' : ' disabled'}>↑</button>
        </div>
      </div>
      <div class="composer-foot">
        <!-- Under the input field are only refusals and confirmations. Turn progress
             (steps, commands, subagents) lives in the response trace: there is no
             need to duplicate it in small text below. -->
        <span id="chat-note">${options.enabled ? '' : escapeHtml(ui.chatDisabledNote)}</span>
        <span>${escapeHtml(ui.composerHint)}</span>
      </div>
    </div>
  </main>

  <!-- Right panel: files of the open conversation's working folder. The client draws
       the tree and preview; here is only the frame, otherwise the page doubles in size. -->
  <aside class="files-panel" id="files-panel" aria-label="${escapeHtml(ui.workspaceFiles)}">
    <!-- On a narrow screen the panel slides over the chat header and covers the "Files"
         button: its own close cross remains the only way to collapse it. -->
    <button class="icon-btn files-close" id="files-close" aria-label="${escapeHtml(ui.hideFiles)}" title="${escapeHtml(ui.hideFiles)}">×</button>
    <!-- Search across the whole workspace, not the open folder: most often a file is searched
         by a piece of text without knowing which folder it is in. Results take the place
         of the tree, so the panel does not split in two. -->
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
