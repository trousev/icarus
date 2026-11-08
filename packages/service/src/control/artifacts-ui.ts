// Страница раздела «Артефакты» и публичный просмотр.
//
// Артефакты глобальные: список один на всех, без workspace-переключателя.
// Каркас — как у остальных разделов панели: сайдбар, крошки, поиск; справа сам
// артефакт. Список и содержимое приезжают клиентом (artifacts-client.js), стили
// и markdown лежат отдельными файлами — как у чата и MCP.
import fs from 'node:fs';
import type { Artifact } from '../artifacts.ts';
import { escapeHtml, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./artifacts-client.css', import.meta.url), 'utf8');
const CLIENT_MD = fs.readFileSync(new URL('./artifacts-markdown.js', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./artifacts-client.js', import.meta.url), 'utf8');

export type ArtifactsPageOptions = {
  artifact?: string;
  counts: Record<string, number>;
};

/** Меню настроек — прежний плоский список; артефакты в него не входят. */
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
  const config = { user: session.user, artifact: options.artifact ?? null, counts: options.counts };
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');
  const nav = navLinks(session, 'artifacts', options.counts);

  return shell(`<style>${CLIENT_CSS}</style>
<div class="app art-app art-panel-app">
  <aside class="art-side">
    <div class="brand">
      <div class="logo">I</div>
      <div><b>Icarus</b><span>агент · чат и настройки</span></div>
    </div>
    <a class="nav-back" href="/panel/chat">← Назад в чат</a>
    <div class="art-side-head"><span>АРТЕФАКТЫ</span><em id="art-total">0</em></div>
    <div class="art-list" id="art-list"><p class="art-empty">Читаю…</p></div>
    <div class="art-side-bottom">
      <p class="nav-title">НАСТРОЙКИ</p>
      <nav class="nav">${nav}</nav>
    </div>
    <div class="foot">
      <div><span>модель</span><span>${escapeHtml(session.model ?? '—')}</span></div>
      <div><span>хранилище</span><span>${escapeHtml(session.storage ?? 'git · local')}</span></div>
    </div>
  </aside>
  <main class="art-main">
    <div class="art-main-body">
    <div class="top">
      <div class="crumbs" id="art-crumbs">Icarus / <b>Артефакты</b></div>
      <div class="search"><input id="q" placeholder="Поиск по артефактам" size="30" autocomplete="off"></div>
      <div class="status"><i></i>Агент активен</div>
    </div>
    <div class="art-toolbar">
      <div class="art-file">
        <span class="art-item-icon" id="art-type-icon"></span>
        <div><strong id="art-name">—</strong><small id="art-meta"></small></div>
      </div>
      <div class="art-actions">
        <button class="art-icon-btn" id="art-link" disabled title="Скопировать публичную ссылку" aria-label="Скопировать публичную ссылку">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg>
        </button>
        <button class="btn" id="art-unpublish" hidden>Отозвать ссылку</button>
        <button class="btn" id="art-acl" hidden>Права</button>
        <button class="btn" id="art-history">История</button>
        <a class="btn" id="art-bare" href="#" target="_blank" rel="noopener" aria-disabled="true">Без панели</a>
        <a class="btn" id="art-download" href="#" aria-disabled="true">Скачать</a>
        <button class="btn danger" id="art-delete" disabled>Удалить</button>
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
  </main>
</div>
<div class="art-modal" id="art-acl-modal" hidden>
  <div class="art-modal-card" role="dialog" aria-modal="true" aria-labelledby="art-acl-title">
    <h2 id="art-acl-title">Права доступа</h2>
    <p class="art-modal-note">Новый артефакт по умолчанию личный: у семьи «нет доступа». Уровень включает предыдущий: <b>write</b> умеет и читать, <b>admin</b> — ещё менять права, удалять и делать публичную ссылку.</p>
    <label class="art-field"><span>Я</span><select id="acl-me"><option value="read">чтение</option><option value="write">запись</option><option value="admin">администрирование</option></select></label>
    <label class="art-field"><span>Семья</span><select id="acl-family"><option value="none">нет доступа</option><option value="read">чтение</option><option value="write">запись</option><option value="admin">администрирование</option></select></label>
    <div class="art-modal-actions">
      <button class="btn" id="acl-cancel">Отмена</button>
      <button class="btn primary" id="acl-save">Сохранить</button>
    </div>
  </div>
</div>
<script>window.__ARTIFACTS_CFG__ = ${json};</script>
<script>${CLIENT_MD}</script>
<script>${CLIENT_JS}</script>`);
}

/**
 * Публичный просмотр: та же панель, но без списка чужих артефактов и без правки.
 * Человек с ссылкой видит только этот артефакт; «без панели» — отдельный адрес,
 * который отдаёт сам файл (см. http/server.ts).
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
        <a class="btn" href="${escapeHtml(bareUrl)}" target="_blank" rel="noopener">Без панели</a>
        <a class="btn" href="${escapeHtml(entryUrl)}?download=1">Скачать</a>
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
