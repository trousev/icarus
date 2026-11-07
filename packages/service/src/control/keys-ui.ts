// Страница раздела «Ключи». Каркас — общий (shell из ui.ts), клиент — отдельными
// файлами: в TypeScript не приходится экранировать бэктики, а тесты могут исполнить
// тот же скрипт, что получает браузер.
import fs from 'node:fs';
import { escapeHtml, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./keys-client.css', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./keys-client.js', import.meta.url), 'utf8');

export function keysPage(session: PanelSession): string {
  const json = JSON.stringify({ user: session.user, section: 'keys' }).replaceAll('<', '\\u003c');
  const nav =
    '<a href="/panel/chat">Чат</a>' +
    session.sections
      .map(
        (item) =>
          `<a class="${item.id === 'keys' ? 'active' : ''}" href="/panel/${item.id}">` +
          `${escapeHtml(item.label)}<em id="count-${item.id}"></em></a>`,
      )
      .join('');

  const sidebar = `<aside>
  <div class="brand">
    <div class="logo">I</div>
    <div><b>Icarus</b><span>агент · чат и настройки</span></div>
  </div>
  <div>
    <p class="nav-title">РАБОЧЕЕ ПРОСТРАНСТВО</p>
    <nav class="nav">${nav}</nav>
  </div>
  <div class="foot">
    <div><span>модель</span><span>${escapeHtml(session.model ?? '—')}</span></div>
    <div><span>доступ</span><span>админ</span></div>
  </div>
</aside>`;

  return shell(`<style>${CLIENT_CSS}</style>
<div class="app">
${sidebar}
<div>
  <div class="top">
    <div class="crumbs">Icarus / <b>Ключи</b></div>
    <div class="status"><i></i>Агент активен</div>
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
<script>${CLIENT_JS}</script>`);
}
