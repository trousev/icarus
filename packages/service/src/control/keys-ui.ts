// The "Keys" section page. The frame is shared (shell from ui.ts), the client lives in
// separate files: in TypeScript we don't have to escape backticks, and tests can execute
// the same script the browser receives.
import fs from 'node:fs';
import { escapeHtml, sessionStrings, settingsAside, shell, sessionUiLanguage, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./keys-client.css', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./keys-client.js', import.meta.url), 'utf8');

export function keysPage(session: PanelSession): string {
  const ui = sessionStrings(session);
  const json = JSON.stringify({ user: session.user, section: 'keys' }).replaceAll('<', '\\u003c');
  return shell(`<style>${CLIENT_CSS}</style>
<div class="app">
${settingsAside(session, 'keys', {
  foot: [
    [ui.modelLabel, session.model ?? '—'],
    [ui.accessLabel, ui.accessAdmin],
  ],
})}
<div>
  <div class="top">
    <div class="crumbs">Icarus / <b>Ключи</b></div>
    <div class="status"><i></i>${escapeHtml(ui.agentActive)}</div>
  </div>
  <div class="content">
    <p class="section-title">СЕКРЕТЫ ИНСТАЛЯЦИИ</p>
    <div class="head">
      <div class="lead">
        <h1>Ключи</h1>
        <p class="keys-intro">
          Ключи провайдеров, поиска, Telegram и MCP. Секретные значения не показываются
          и в браузер не возвращаются: видно только, задан ключ или нет. Переключатели
          вроде <code>ICARUS_SEARCH_PROVIDER</code> показываются как есть.
        </p>
        <p class="keys-meta" id="keys-meta">Читаю…</p>
      </div>
      <div class="keys-actions">
        <button class="btn" id="keys-reload-button" title="Перечитать .env и config.yaml, ничего не записывая">Перечитать</button>
        <button class="btn primary" id="keys-add-button">Добавить ключ</button>
      </div>
    </div>
    <div class="keys-notice" id="keys-notice" hidden></div>
    <div class="keys-form add" id="keys-add" hidden></div>
    <div id="keys-list"><p class="keys-empty">Читаю…</p></div>
  </div>
</div>
</div>
<script>window.__KEYS_CFG__ = ${json};</script>
<script>${CLIENT_JS}</script>`, sessionUiLanguage(session));
}
