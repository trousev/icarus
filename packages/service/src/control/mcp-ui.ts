// Страница раздела MCP. Каркас и стили — как у остальных разделов панели, а
// клиентский скрипт лежит отдельным файлом: в TypeScript не приходится экранировать
// бэктики и скобки, а браузер получает тот же JS и локально, и на проде.
import fs from 'node:fs';
import { mimicCallbackUrl } from '../mcp/oauth.ts';
import { escapeHtml, sessionStrings, sessionUiLanguage, settingsAside, shell, type PanelSession } from './ui.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./mcp-client.css', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./mcp-client.js', import.meta.url), 'utf8');

export function mcpPage(session: PanelSession): string {
  const ui = sessionStrings(session);
  // Адрес мимикрии рисует сервер: порт живёт в одном месте, а не в двух файлах.
  const config = { user: session.user, section: 'mcp', mimicCallback: mimicCallbackUrl(), ui };
  // JSON уезжает в <script>: «<» экранируем, иначе значение с </script> закроет тег.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');

  return shell(`<style>${CLIENT_CSS}</style>
<div class="app">
${settingsAside(session, 'mcp')}
<div>
  <div class="top">
    <div class="crumbs">Icarus / <b>MCP</b></div>
    <div class="status"><i></i>${escapeHtml(ui.agentActive)}</div>
  </div>
  <div class="content">
    <p class="section-title">${escapeHtml(ui.mcpKicker)}</p>
    <div class="head">
      <div class="lead">
        <h1>MCP</h1>
        <p class="mcp-intro">${escapeHtml(ui.mcpIntro)}</p>
        <p class="mcp-intro" id="mcp-summary">${escapeHtml(ui.loading)}</p>
      </div>
      <button class="btn primary" id="mcp-add">${escapeHtml(ui.mcpAdd)}</button>
    </div>
    <div class="recipes">
      <div class="recipes-head">
        <div>
          <h2>${escapeHtml(ui.mcpRecipes)}</h2>
          <p class="mcp-rule" id="mcp-rule">${escapeHtml(ui.mcpRecipesRule)}</p>
        </div>
        <span class="recipes-checked" id="mcp-checked"></span>
      </div>
      <div class="recipes-grid" id="mcp-recipes"><p class="mcp-empty">${escapeHtml(ui.loading)}</p></div>
      <p class="mcp-skipped" id="mcp-skipped"></p>
    </div>
    <p class="section-title">${escapeHtml(ui.mcpMyServers)}</p>
    <div class="mcp-notice" id="mcp-notice" hidden></div>
    <div class="mcp-list" id="mcp-list"><p class="mcp-empty">${escapeHtml(ui.loading)}</p></div>
  </div>
</div>
</div>
<script>window.__MCP_CFG__ = ${json};</script>
<script>${CLIENT_JS}</script>`, sessionUiLanguage(session));
}
