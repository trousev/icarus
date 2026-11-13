// The "Artifacts" section page and public view.
//
// Artifacts are global: one list for everyone, no workspace switcher.
// The frame is like other panel sections: sidebar, breadcrumbs, search; the artifact itself
// on the right. The list and content arrive client-side (artifacts-client.js), styles
// and markdown live in separate files — like for chat and MCP.
import fs from 'node:fs';
import type { Artifact } from '../artifacts.ts';
import { escapeHtml, sessionStrings, sessionUiLanguage, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./artifacts-client.css', import.meta.url), 'utf8');
// Messages (bubbles, trace, .md) — the same file as the main chat:
// the AI answer in the side panel should look the same as in the big feed.
const MESSAGES_CSS = fs.readFileSync(new URL('./chat-messages.css', import.meta.url), 'utf8');
const CLIENT_MD = fs.readFileSync(new URL('./artifacts-markdown.js', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./artifacts-client.js', import.meta.url), 'utf8');
// The edit chat — as a separate file: it has its own stream and its own feed, and together with
// the section client it would be one unreadable script.
const CLIENT_CHAT = fs.readFileSync(new URL('./artifacts-chat.js', import.meta.url), 'utf8');

// Action panel icons: labels live in title/aria-label, on screen — only
// the sign. The same set for the panel and for the public view.
const ICON_SHARE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.4 10.8 7.2-4.3"/><path d="m8.4 13.2 7.2 4.3"/></svg>';
const ICON_HISTORY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.7-6.4L3 8"/><path d="M3 3v5h5"/><path d="M12 7.5V12l3.2 2"/></svg>';
const ICON_CHAT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/></svg>';
const ICON_BARE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H5a1 1 0 0 0-1 1v4"/><path d="M15 4h4a1 1 0 0 1 1 1v4"/><path d="M9 20H5a1 1 0 0 1-1-1v-4"/><path d="M15 20h4a1 1 0 0 0 1-1v-4"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 4h4"/><path d="M6.5 7l.8 12.1a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9L17.5 7"/><path d="M10 11v5M14 11v5"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const ICON_GLOBE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.3 3.3 5.2 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.2-3.3-8.5s1.1-6.2 3.3-8.5z"/></svg>';
// Cursor: "select a block on the page" — not "open a file".
const ICON_PICK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 3 6.5 17 2.4-6.1L20 11.5z"/></svg>';

export type ArtifactsPageOptions = {
  artifact?: string;
  counts: Record<string, number>;
};

/** Settings menu — the former flat list; artifacts are not part of it. */
function navLinks(session: PanelSession, active: string, counts: Record<string, number>): string {
  return session.sections
    .map((item) => {
      const count = item.id === 'memory' ? counts.personal : counts[item.id];
      const badge = count === undefined ? '' : `<em id="count-${item.id}">${count}</em>`;
      return `<a class="${item.id === active ? 'active' : ''}" href="/panel/${item.id}">${escapeHtml(item.label)}${badge}</a>`;
    })
    .join('');
}

export function artifactsPage(session: PanelSession, options: ArtifactsPageOptions): string {
  const ui = sessionStrings(session);
  const config = { user: session.user, artifact: options.artifact ?? null, counts: options.counts };
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');
  const nav = navLinks(session, 'artifacts', options.counts);

  return shell(`<style>${MESSAGES_CSS}</style>
<style>${CLIENT_CSS}</style>
<div class="app art-app art-panel-app">
  <aside class="art-side">
    <div class="brand">
      <div class="logo">I</div>
      <div><b>Icarus</b><span>${escapeHtml(ui.brandTagline)}</span></div>
    </div>
    <a class="nav-back" href="/panel/chat">${escapeHtml(ui.backToChat)}</a>
    <div class="art-side-head"><span>${escapeHtml(ui.artifacts.toUpperCase())}</span><em id="art-total">0</em></div>
    <div class="art-list" id="art-list"><p class="art-empty">${escapeHtml(ui.loading)}</p></div>
    <div class="art-side-bottom">
      <p class="nav-title">${escapeHtml(ui.settingsNavTitle)}</p>
      <nav class="nav">${nav}</nav>
    </div>
    <div class="foot">
      <div><span>${escapeHtml(ui.modelLabel)}</span><span>${escapeHtml(session.model ?? '—')}</span></div>
      <div><span>${escapeHtml(ui.storageLabel)}</span><span>${escapeHtml(session.storage ?? 'git · local')}</span></div>
    </div>
  </aside>
  <main class="art-main">
    <div class="art-main-body">
    <div class="top">
      <div class="crumbs" id="art-crumbs">Icarus / <b>${escapeHtml(ui.artifacts)}</b></div>
      <div class="search"><input id="q" placeholder="${escapeHtml(ui.searchArtifacts)}" size="30" autocomplete="off"></div>
      <div class="status"><i></i>${escapeHtml(ui.agentActive)}</div>
    </div>
    <div class="art-toolbar">
      <div class="art-file">
        <span class="art-item-icon" id="art-type-icon"></span>
        <div><strong id="art-name">—</strong><small id="art-meta"></small></div>
      </div>
      <div class="art-actions">
        <button type="button" class="art-icon-btn" id="art-pick" disabled aria-pressed="false"
                title="Выбери артефакт" aria-label="Выбрать элемент">${ICON_PICK}</button>
        <button type="button" class="art-icon-btn" id="art-share" disabled title="Выбери артефакт" aria-label="Поделиться">${ICON_SHARE}</button>
        <button type="button" class="art-icon-btn" id="art-history" disabled title="Выбери артефакт" aria-label="История">${ICON_HISTORY}</button>
        <button type="button" class="art-icon-btn" id="art-chat" disabled aria-controls="art-chat-panel" aria-expanded="false"
                title="Выбери артефакт" aria-label="Чат">${ICON_CHAT}</button>
        <a class="art-icon-btn" id="art-bare" href="#" target="_blank" rel="noopener" aria-disabled="true"
           title="Без панели — открыть только артефакт" aria-label="Без панели">${ICON_BARE}</a>
        <a class="art-icon-btn" id="art-download" href="#" aria-disabled="true" title="Скачать" aria-label="Скачать">${ICON_DOWNLOAD}</a>
        <button type="button" class="art-icon-btn danger" id="art-delete" disabled title="Выбери артефакт" aria-label="Удалить">${ICON_DELETE}</button>
      </div>
    </div>
    <div class="art-preview" id="art-preview" hidden>
      <div class="art-preview-text">
        <b>Предпросмотр версии</b>
        <span id="art-preview-meta"></span>
      </div>
      <div class="art-preview-actions">
        <button class="btn" id="art-preview-current">К текущей</button>
        <button class="btn primary" id="art-preview-restore">Вернуть эту версию</button>
      </div>
    </div>
    <div class="art-view" id="art-view">
      <div class="art-placeholder"><b>Читаю артефакты…</b></div>
    </div>
    <div class="art-status">
      <span id="art-path"></span>
      <span id="art-note" class="art-note"></span>
      <span id="art-updated"></span>
    </div>
    </div>
    <aside class="art-history-panel" id="art-history-panel" hidden>
      <div class="art-history-head">
        <div><b>История версий</b><span>Икар сохраняет изменения сам</span></div>
        <button class="art-icon-btn" id="history-close" title="Закрыть историю" aria-label="Закрыть историю">×</button>
      </div>
      <p class="art-history-note">Нажми на версию, чтобы посмотреть её. Артефакт изменится только после «Вернуть эту версию».</p>
      <div class="art-history-list" id="art-history-list"><p class="art-empty">Читаю…</p></div>
    </aside>
    <aside class="art-history-panel art-chat-panel" id="art-chat-panel" hidden aria-label="Чат по артефакту">
      <div class="art-history-head">
        <div><b>Чат по артефакту</b><span id="art-chat-sub">Правка через ИИ</span></div>
        <button class="art-icon-btn" id="art-chat-close" title="Закрыть чат" aria-label="Закрыть чат">×</button>
      </div>
      <div class="art-chat-log" id="art-chat-log">
        <div class="art-empty"><b>Скажи, что поправить</b><span>Икар изменит файлы прямо в папке артефакта: «добавь заголовок», «сделай таблицу», «поменяй цвет».</span><span>Команды — как в большом чате: /clear начнёт заново, /compact сожмёт, /stats покажет токены.</span></div>
      </div>
      <div class="art-chat-foot">
        <div class="art-chat-ref" id="art-chat-ref" hidden>
          <span class="art-chat-ref-label">элемент</span>
          <code id="art-chat-ref-path"></code>
          <span class="art-chat-ref-quote" id="art-chat-ref-quote"></span>
          <button type="button" class="art-chat-ref-clear" id="art-chat-ref-clear"
                  title="Убрать из ссылки" aria-label="Убрать из ссылки">×</button>
        </div>
        <div class="art-chat-note" id="art-chat-note"></div>
        <div class="art-chat-box">
          <textarea id="art-chat-input" rows="1" placeholder="Что поправить в артефакте?" disabled></textarea>
          <button class="art-icon-btn art-chat-send" id="art-chat-send" disabled title="Отправить" aria-label="Отправить">↑</button>
          <button class="art-icon-btn art-chat-stop" id="art-chat-stop" hidden title="Остановить" aria-label="Остановить">■</button>
        </div>
      </div>
    </aside>
  </main>
</div>
<div class="art-modal" id="art-share-modal" hidden>
  <div class="art-modal-card art-share-card" role="dialog" aria-modal="true" aria-labelledby="art-share-title">
    <div class="art-share-head">
      <div>
        <h2 id="art-share-title">Поделиться</h2>
        <p class="art-share-sub">Доступ к артефакту <b id="art-share-name">—</b></p>
      </div>
      <button type="button" class="art-icon-btn" id="art-share-close" title="Закрыть" aria-label="Закрыть">×</button>
    </div>
    <div class="art-share-rows">
      <div class="art-share-row">
        <span class="art-share-avatar" id="art-share-me-avatar" aria-hidden="true">Я</span>
        <span class="art-share-who"><b id="art-share-me-name">Я</b><span id="art-share-me-sub">владелец артефакта</span></span>
        <select id="acl-me" aria-label="Мои права"><option value="read">чтение</option><option value="write">запись</option><option value="admin">администрирование</option></select>
      </div>
      <div class="art-share-row">
        <span class="art-share-avatar" aria-hidden="true">С</span>
        <span class="art-share-who"><b>Семья</b><span>все остальные люди</span></span>
        <select id="acl-family" aria-label="Права семьи"><option value="none">нет доступа</option><option value="read">чтение</option><option value="write">запись</option><option value="admin">администрирование</option></select>
      </div>
      <div class="art-share-row">
        <span class="art-share-avatar" aria-hidden="true">${ICON_GLOBE}</span>
        <span class="art-share-who"><b>Публичная ссылка</b><span id="acl-public-hint">выключена</span></span>
        <select id="acl-public" aria-label="Доступ по публичной ссылке"><option value="none">нет доступа</option><option value="read">чтение</option></select>
      </div>
    </div>
    <div class="art-share-link" id="art-share-link" hidden>
      <input id="acl-link" readonly spellcheck="false" aria-label="Публичная ссылка">
      <button type="button" class="art-icon-btn" id="acl-copy" title="Копировать ссылку" aria-label="Копировать ссылку">${ICON_COPY}</button>
    </div>
    <p class="art-share-note" id="art-share-note">Изменения сохраняются сразу.</p>
    <div class="art-share-actions">
      <button type="button" class="btn primary" id="art-share-done">Готово</button>
    </div>
  </div>
</div>
<script>window.__ARTIFACTS_CFG__ = ${json};</script>
<script>${CLIENT_MD}</script>
<script>${CLIENT_JS}</script>
<script>${CLIENT_CHAT}</script>`, sessionUiLanguage(session));
}

/**
 * Public view: the same panel, but without the list of other people's artifacts and without editing.
 * A person with the link sees only this artifact; "bare" — a separate address
 * that serves the file itself (see http/server.ts).
 */
export function publicArtifactPage(artifact: Artifact, content: string | null): string {
  const base = artifact.urls.public ?? '';
  const entryUrl = `${base}${encodeURIComponent(artifact.entry)}`;
  const bareUrl = artifact.type === 'markdown' ? (artifact.urls.bare ?? entryUrl) : entryUrl;
  const doc = {
    title: artifact.title,
    entry: artifact.entry,
    type: artifact.type,
    content: content ?? '',
    raw: base,
  };

  const body =
    artifact.type === 'html'
      ? `<iframe class="art-frame" title="${escapeHtml(artifact.title)}" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="${escapeHtml(entryUrl)}"></iframe>`
      : artifact.type === 'image'
        ? `<div class="art-image"><img src="${escapeHtml(entryUrl)}" alt="${escapeHtml(artifact.title)}"></div>`
        : `<article class="art-doc" id="public-doc"></article>`;

  return shell(`<style>${CLIENT_CSS}</style>
<div class="app art-app">
  <aside class="art-side">
    <div class="brand">
      <div class="logo">I</div>
      <div><b>Icarus</b><span>агент · чат и настройки</span></div>
    </div>
    <a class="nav-back" href="/panel/artifacts">← В панель</a>
    <div class="art-side-head"><span>ПУБЛИЧНЫЙ АРТЕФАКТ</span></div>
    <div class="art-list">
      <div class="art-item active">
        <span class="art-item-icon">${icon(artifact.type)}</span>
        <span class="art-item-text"><b>${escapeHtml(artifact.title)}</b><span>${escapeHtml(artifact.typeLabel)} · ${escapeHtml(sizeLabel(artifact.size))}</span></span>
      </div>
    </div>
    <div class="art-side-bottom">
      <p class="nav-title">ССЫЛКА</p>
      <p class="art-empty"><span>Любой, у кого есть этот адрес, может смотреть артефакт. Владелец может отозвать ссылку в панели.</span></p>
    </div>
    <div class="foot">
      <div><span>владелец</span><span>${escapeHtml(artifact.owner)}</span></div>
      <div><span>режим</span><span>публичный</span></div>
      <div><span>обновлено</span><span>${escapeHtml(dateLabel(artifact.updatedAt))}</span></div>
    </div>
  </aside>
  <main class="art-main">
    <div class="top">
      <div class="crumbs">Icarus / Артефакты / <b>${escapeHtml(artifact.title)}</b></div>
      <div class="status"><i></i>Публичный просмотр</div>
    </div>
    <div class="art-toolbar">
      <div class="art-file">
        <span class="art-item-icon">${icon(artifact.type)}</span>
        <div><strong>${escapeHtml(artifact.entry)}</strong><small>${escapeHtml(artifact.typeLabel)} · ${escapeHtml(sizeLabel(artifact.size))}</small></div>
      </div>
      <div class="art-actions">
        <a class="art-icon-btn" href="${escapeHtml(bareUrl)}" target="_blank" rel="noopener"
           title="Без панели — открыть только артефакт" aria-label="Без панели">${ICON_BARE}</a>
        <a class="art-icon-btn" href="${escapeHtml(entryUrl)}?download=1" title="Скачать" aria-label="Скачать">${ICON_DOWNLOAD}</a>
      </div>
    </div>
    <div class="art-view" id="art-view">${body}</div>
    <div class="art-status">
      <span>${escapeHtml(artifact.entry)}</span>
      <span class="art-note"></span>
      <span>Обновлено ${escapeHtml(dateLabel(artifact.updatedAt))}</span>
    </div>
  </main>
</div>
${artifact.type === 'markdown' ? `<script>${CLIENT_MD}</script>
<script>window.__PUBLIC_DOC__ = ${JSON.stringify(doc).replaceAll('<', '\\u003c')};
document.getElementById('public-doc').innerHTML = artifactMarkdown(window.__PUBLIC_DOC__.content, { fileBase: window.__PUBLIC_DOC__.raw });</script>` : ''}`);
}

function icon(type: Artifact['type']): string {
  if (type === 'image') {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 2-2 5 5"/></svg>';
  }
  if (type === 'html') {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/><path d="m13 5-2 14"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></svg>';
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
