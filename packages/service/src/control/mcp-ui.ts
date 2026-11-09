// Страница раздела MCP. Каркас и стили — как у остальных разделов панели, а
// клиентский скрипт лежит отдельным файлом: в TypeScript не приходится экранировать
// бэктики и скобки, а браузер получает тот же JS и локально, и на проде.
import fs from 'node:fs';
import { mimicCallbackUrl } from '../mcp/oauth.ts';
import { settingsAside, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./mcp-client.css', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./mcp-client.js', import.meta.url), 'utf8');

export function mcpPage(session: PanelSession): string {
  // Адрес мимикрии рисует сервер: порт живёт в одном месте, а не в двух файлах.
  const config = { user: session.user, section: 'mcp', mimicCallback: mimicCallbackUrl() };
  // JSON уезжает в <script>: «<» экранируем, иначе значение с </script> закроет тег.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');

  return shell(`<style>${CLIENT_CSS}</style>
<div class="app">
${settingsAside(session, 'mcp')}
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
    <div class="recipes">
      <div class="recipes-head">
        <div>
          <h2>Рецепты</h2>
          <p class="mcp-rule" id="mcp-rule">Готовые серверы: команда, транспорт и нужные ключи уже известны.</p>
        </div>
        <span class="recipes-checked" id="mcp-checked"></span>
      </div>
      <div class="recipes-grid" id="mcp-recipes"><p class="mcp-empty">Читаю…</p></div>
      <p class="mcp-skipped" id="mcp-skipped"></p>
    </div>
    <p class="section-title">МОИ СЕРВЕРЫ</p>
    <div class="mcp-notice" id="mcp-notice" hidden></div>
    <div class="mcp-list" id="mcp-list"><p class="mcp-empty">Читаю…</p></div>
  </div>
</div>
</div>
<script>window.__MCP_CFG__ = ${json};</script>
<script>${CLIENT_JS}</script>`);
}
