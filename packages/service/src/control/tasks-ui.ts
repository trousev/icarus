// "Tasks" section page. The shell and styles are like the other panel sections,
// and the client script is a separate file: in TypeScript you don't have to escape
// backticks and braces, and the browser gets the same JS both locally and in prod.
import fs from 'node:fs';
import { taskTimeZone } from '../sessions/schedule.ts';
import { escapeHtml, sessionStrings, sessionUiLanguage, settingsAside, shell, type PanelSession } from './ui.ts';
import type { IcarusConfig } from '../config.ts';

const CLIENT_CSS = fs.readFileSync(new URL('./tasks-client.css', import.meta.url), 'utf8');
const CLIENT_JS = fs.readFileSync(new URL('./tasks-client.js', import.meta.url), 'utf8');

/**
 * Weekday labels for the form. They come from Intl, not a dictionary: these are day names,
 * and they already exist in both languages in the browser standard library.
 */
function weekdayLabels(lang: string): Array<[number, string]> {
  const format = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ru-RU', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  // January 7, 2024 is a Sunday: we count days from it, starting with Monday.
  return [1, 2, 3, 4, 5, 6, 0].map((day) => [day, format.format(new Date(Date.UTC(2024, 0, 7 + day)))]);
}

export function tasksPage(session: PanelSession, config: IcarusConfig): string {
  const ui = sessionStrings(session);
  const timeZone = taskTimeZone(config);
  const configJson = JSON.stringify({ user: session.user, section: 'tasks', timeZone, ui }).replaceAll('<', '\\u003c');
  const days = weekdayLabels(sessionUiLanguage(session))
    .map(
      ([value, label]) =>
        `<label><input type="checkbox" value="${value}"${value === 1 ? ' checked' : ''}> ${escapeHtml(label)}</label>`,
    )
    .join('\n        ');

  return shell(
    `<style>${CLIENT_CSS}</style>
<div class="app">
${settingsAside(session, 'tasks')}
<div>
  <div class="top">
    <div class="crumbs">Icarus / <b>${escapeHtml(ui.sectionTasks)}</b></div>
    <div class="status"><i></i>${escapeHtml(ui.agentActive)}</div>
  </div>
  <div class="content">
    <p class="section-title">${escapeHtml(ui.tasksKicker)}</p>
    <div class="head">
      <div class="lead">
        <h1>${escapeHtml(ui.sectionTasks)}</h1>
        <p class="task-intro">${escapeHtml(ui.tasksIntro.replace('{tz}', timeZone))}</p>
      </div>
      <button class="btn primary" id="task-new">${escapeHtml(ui.tasksNew)}</button>
    </div>
    <div class="task-notice" id="task-notice" hidden></div>

    <div class="task-form" id="task-form" hidden>
      <h2>${escapeHtml(ui.tasksNew)}</h2>
      <div class="field">
        <label for="task-name">${escapeHtml(ui.tasksNameLabel)}</label>
        <input type="text" id="task-name" placeholder="${escapeHtml(ui.tasksNamePlaceholder)}">
      </div>
      <div class="field">
        <label for="task-prompt">${escapeHtml(ui.tasksPromptLabel)}</label>
        <textarea id="task-prompt" rows="3" placeholder="${escapeHtml(ui.tasksPromptPlaceholder)}"></textarea>
      </div>
      <div class="two">
        <div class="field">
          <label for="task-repeat">${escapeHtml(ui.tasksWhen)}</label>
          <select id="task-repeat">
            <option value="daily">${escapeHtml(ui.tasksEveryDay)}</option>
            <option value="weekly">${escapeHtml(ui.tasksByWeekdays)}</option>
            <option value="once">${escapeHtml(ui.tasksOnce)}</option>
          </select>
        </div>
        <div class="field">
          <label for="task-time">${escapeHtml(ui.tasksTime)}</label>
          <input type="time" id="task-time" value="08:00">
        </div>
      </div>
      <div class="field" id="task-date-field" hidden>
        <label for="task-date">${escapeHtml(ui.tasksDate)}</label>
        <input type="date" id="task-date">
      </div>
      <div class="field" id="task-days-field" hidden>
        <label>${escapeHtml(ui.tasksWeekdays)}</label>
        <div class="days" id="task-days">
        ${days}
        </div>
      </div>
      <div class="field">
        <label for="task-workspace">${escapeHtml(ui.tasksWorkspace)}</label>
        <select id="task-workspace"></select>
      </div>
      <div class="row">
        <button class="primary" id="task-create" type="button">${escapeHtml(ui.tasksCreate)}</button>
        <button id="task-cancel" type="button">${escapeHtml(ui.tasksCancel)}</button>
      </div>
    </div>

    <div class="task-list" id="task-list"><p class="task-empty">${escapeHtml(ui.loading)}</p></div>
  </div>
</div>
</div>
<script>window.__TASKS_CFG__ = ${configJson};</script>
<script>${CLIENT_JS}</script>`,
    sessionUiLanguage(session),
  );
}
