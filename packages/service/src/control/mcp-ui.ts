// Страница раздела MCP. Каркас и стили — как у остальных разделов панели, а
// клиентский скрипт лежит отдельным файлом: в TypeScript не приходится экранировать
// бэктики и скобки, а браузер получает тот же JS и локально, и на проде.
import fs from 'node:fs';
import { escapeHtml, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./mcp-client.css', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./mcp-client.js', import.meta.url), 'utf8');

export type McpPageOptions = { embed?: boolean };

export function mcpPage(session: PanelSession, options: McpPageOptions = {}): string {
  const embed = Boolean(options.embed);
  const config = { user: session.user, section: 'mcp', embed };
  // JSON уезжает в <script>: «<» экранируем, иначе значение с </script> закроет тег.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');

  const nav =
    '<a href="/panel/chat">Чат</a>' +
    session.sections
      .map(
        (item) =>
          `<a class="${item.id === 'mcp' ? 'active' : ''}" href="/panel/${item.id}">` +
          `${escapeHtml(item.label)}<em id="count-${item.id}"></em></a>`,
      )
      .join('');

  const sidebar = embed
    ? ''
    : `<aside>
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
    <div><span>хранилище</span><span>${escapeHtml(session.storage ?? 'git · local')}</span></div>
  </div>
</aside>`;

  return shell(`<style>${CLIENT_CSS}</style>
<div class="app${embed ? ' embedded' : ''}">
${sidebar}
<div>
  <div class="top">
    <div class="crumbs">Icarus / <b>MCP</b></div>
    <div class="status"><i></i>Агент активен</div>
  </div>
  <div class="content">
    <p class="section-title">ВНЕШНИЕ ИНСТРУМЕНТЫ</p>
    <div class="head">
      <div class="lead">
        <h1>MCP</h1>
        <p class="mcp-intro">
          Серверы, которые добавляют Икару инструменты: списки задач, календарь, домашние дела.
          <b>Включённый</b> сервер Икар видит и может подключить; <b>выключенный</b> лежит здесь,
          но в разговор не попадает и контекст не занимает.
        </p>
        <p class="mcp-intro" id="mcp-summary">Читаю…</p>
      </div>
      <button class="btn primary" id="mcp-add">Добавить MCP</button>
    </div>
    <div class="mcp-notice" id="mcp-notice" hidden></div>
    <div class="mcp-list" id="mcp-list"><p class="mcp-empty">Читаю…</p></div>
  </div>
</div>
</div>
<script>window.__MCP_CFG__ = ${json};</script>
<script>${CLIENT_JS}</script>`);
}
