/* Client for the «Tasks» section: list of schedules, creation, enabling and deletion.
   All state lives on the server (scheduled-tasks.json): the page can be reloaded and
   the tasks stay. Here there's only the form and rendering.

   Labels are computed here, not on the server: the server sends the moment in ISO and
   the time zone, while «today», «tomorrow» and day names depend on the interface language. */
'use strict';

(function () {
  const cfg = window.__TASKS_CFG__ || {};
  const ui = cfg.ui || {};
  const state = { tasks: [], workspaces: [], timeZone: cfg.timeZone || 'UTC', now: new Date().toISOString() };
  const locale = ui.lang === 'en' ? 'en-GB' : 'ru-RU';
  let busy = false;

  const el = (id) => document.getElementById(id);
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  /** «{when}» → value: the string templates live in the panel dictionary. */
  function fill(template, values) {
    return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (whole, key) =>
      key in values ? values[key] : whole,
    );
  }

  async function api(path, body) {
    const options =
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(path, options);
    let data = {};
    try {
      data = await response.json();
    } catch {
      /* an empty body is also a response */
    }
    if (!response.ok) {
      const error = data && data.error ? data.error.message : 'HTTP ' + response.status;
      throw new Error(error || 'запрос не вышел');
    }
    return data;
  }

  function notice(text, bad) {
    const box = el('task-notice');
    box.textContent = text || '';
    box.className = 'task-notice' + (bad ? ' bad' : '');
    box.hidden = !text;
  }

  // ── dates in the person's time zone ───────────────────────────────────────────
  // The time zone comes from the server: the browser may be in another one. «Today» and
  // «tomorrow» are compared by calendar days in this zone, not by the hour difference:
  // on a daylight-saving day a day can be 23 or 25 hours.
  const clockFmt = new Intl.DateTimeFormat(locale, {
    timeZone: state.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: state.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const shortFmt = new Intl.DateTimeFormat(locale, {
    timeZone: state.timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });

  function dayKey(date) {
    const parts = dayParts.formatToParts(date);
    const pick = (type) => (parts.find((part) => part.type === type) || {}).value || '';
    return pick('year') + '-' + pick('month') + '-' + pick('day');
  }
  function shiftKey(key, days) {
    const parts = key.split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days)).toISOString().slice(0, 10);
  }
  /** «today, 08:00» / «tomorrow, 09:30» / «Sat, 15 Nov, 09:00». */
  function runLabel(iso) {
    if (!iso) return ui.tasksNoMoreRuns || '';
    const at = new Date(iso);
    const key = dayKey(at);
    const nowKey = dayKey(new Date(state.now));
    const clock = clockFmt.format(at);
    if (key === nowKey) return (ui.tasksToday || '') + ', ' + clock;
    if (key === shiftKey(nowKey, 1)) return (ui.tasksTomorrow || '') + ', ' + clock;
    return shortFmt.format(at) + ', ' + clock;
  }
  function calendarDate(value) {
    const parts = String(value || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return '';
    return dateFmt.format(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])));
  }
  function weekdayName(day) {
    return weekdayFmt.format(new Date(Date.UTC(2024, 0, 7 + Number(day))));
  }

  /** Schedule in words: «every day at 08:00», «on Mon, Wed at 09:30». */
  function repeatLabel(task) {
    const repeat = task.repeat || {};
    const time = repeat.time || '';
    if (repeat.kind === 'once') return fill(ui.tasksRepeatOnce, { when: calendarDate(repeat.date) + ', ' + time });
    if (repeat.kind === 'weekly') {
      const days = (repeat.weekdays || []).map(weekdayName).join(', ');
      return days ? fill(ui.tasksRepeatWeekly, { days: days, time: time }) : fill(ui.tasksRepeatEveryWeek, { time: time });
    }
    return fill(ui.tasksRepeatDaily, { time: time });
  }

  function workspaceName(slug) {
    const found = state.workspaces.find((item) => item.slug === slug);
    return found ? found.name : slug;
  }

  function taskHtml(task) {
    const badge = !task.enabled
      ? '<span class="badge off">' +
        esc(task.nextRunAt === null && task.lastRunAt ? ui.tasksDone : ui.tasksOff) +
        '</span>'
      : '<span class="badge on">' + esc(ui.tasksOn) + '</span>';
    const next = task.nextRunAt ? fill(ui.tasksNextRun, { when: runLabel(task.nextRunAt) }) : ui.tasksNoMoreRuns;
    const meta = [
      badge,
      '<span>' + esc(repeatLabel(task)) + '</span>',
      '<span>' + esc(next) + '</span>',
      ...(task.workspace ? ['<span>' + esc(workspaceName(task.workspace)) + '</span>'] : []),
      ...(task.lastRunAt ? ['<span>' + esc(fill(ui.tasksLastRun, { when: runLabel(task.lastRunAt) })) + '</span>'] : []),
      ...(task.lastChat
        ? [
            '<a href="/panel/chat?chat=' +
              encodeURIComponent(task.lastChat.id) +
              '">' +
              esc(fill(ui.tasksLastChat, { title: task.lastChat.title })) +
              '</a>',
          ]
        : []),
    ];
    return (
      '<div class="task-card' + (task.enabled ? '' : ' off') + '" data-id="' + esc(task.id) + '">' +
      '<div class="task-card-head"><div class="task-body">' +
      '<p class="task-prompt">' + esc(task.prompt) + '</p>' +
      '<div class="task-meta">' + meta.join('<span>·</span>') + '</div>' +
      (task.lastError ? '<div class="task-error">' + esc(fill(ui.tasksError, { error: task.lastError })) + '</div>' : '') +
      '</div><div class="task-actions">' +
      '<label class="switch" title="Включить или выключить"><input type="checkbox" data-toggle ' +
      (task.enabled ? 'checked' : '') + '><span></span></label>' +
      '<button type="button" data-delete class="danger">' + esc(ui.tasksDelete) + '</button>' +
      '</div></div></div>'
    );
  }

  function render() {
    const box = el('task-list');
    if (!state.tasks.length) {
      box.innerHTML = '<p class="task-empty">' + esc(ui.tasksEmpty) + '</p>';
      return;
    }
    box.innerHTML = state.tasks.map(taskHtml).join('');
  }

  async function load() {
    try {
      const data = await api('/panel/tasks/api');
      state.tasks = data.tasks || [];
      state.workspaces = data.workspaces || [];
      state.timeZone = data.timeZone || state.timeZone;
      state.now = data.now || state.now;
      fillWorkspaces();
      render();
    } catch (error) {
      notice('не удалось прочитать задачи: ' + error.message, true);
    }
  }

  function fillWorkspaces() {
    const select = el('task-workspace');
    const current = select.value;
    select.innerHTML = state.workspaces
      .map((item) => '<option value="' + esc(item.slug) + '">' + esc(item.name) + '</option>')
      .join('');
    if (current && state.workspaces.some((item) => item.slug === current)) select.value = current;
  }

  function today() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + month + '-' + day;
  }

  function repeatChanged() {
    const kind = el('task-repeat').value;
    el('task-date-field').hidden = kind !== 'once';
    el('task-days-field').hidden = kind !== 'weekly';
  }

  function showForm(on) {
    el('task-form').hidden = !on;
    el('task-new').hidden = on;
    notice('');
    if (on) {
      if (!el('task-date').value) el('task-date').value = today();
      if (!el('task-time').value) el('task-time').value = '08:00';
      el('task-prompt').focus();
    }
  }

  function resetForm() {
    el('task-prompt').value = '';
    el('task-repeat').value = 'daily';
    el('task-time').value = '08:00';
    el('task-date').value = today();
    for (const box of document.querySelectorAll('#task-days input')) box.checked = box.value === '1';
    repeatChanged();
  }

  function repeatValue() {
    const kind = el('task-repeat').value;
    const time = el('task-time').value;
    if (kind === 'once') return { kind: kind, date: el('task-date').value, time: time };
    if (kind === 'weekly') {
      const weekdays = [...document.querySelectorAll('#task-days input:checked')].map((box) => Number(box.value));
      return { kind: kind, time: time, weekdays: weekdays };
    }
    return { kind: kind, time: time };
  }

  async function create() {
    if (busy) return;
    busy = true;
    el('task-create').disabled = true;
    try {
      await api('/panel/tasks/api/create', {
        prompt: el('task-prompt').value,
        repeat: repeatValue(),
        workspace: el('task-workspace').value,
      });
      resetForm();
      showForm(false);
      await load();
      notice(ui.tasksCreated);
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      el('task-create').disabled = false;
    }
  }

  async function toggle(id, enabled) {
    try {
      await api('/panel/tasks/api/toggle', { id: id, enabled: enabled });
      await load();
      notice(enabled ? ui.tasksEnabled : ui.tasksDisabled);
    } catch (error) {
      notice(error.message, true);
      await load();
    }
  }

  async function remove(id, button) {
    // Deletion in two presses: the prompt is text the person wrote, and losing it
    // from one accidental click is a shame.
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = ui.tasksDeleteArmed;
      setTimeout(() => {
        if (button.dataset.armed === '1') {
          button.dataset.armed = '';
          button.textContent = ui.tasksDelete;
        }
      }, 4000);
      return;
    }
    try {
      await api('/panel/tasks/api/delete', { id: id });
      await load();
      notice(ui.tasksDeleted);
    } catch (error) {
      notice(error.message, true);
    }
  }

  el('task-new').addEventListener('click', () => showForm(true));
  el('task-cancel').addEventListener('click', () => {
    showForm(false);
    resetForm();
  });
  el('task-create').addEventListener('click', () => void create());
  el('task-repeat').addEventListener('change', repeatChanged);
  el('task-list').addEventListener('change', (event) => {
    const input = event.target.closest('input[data-toggle]');
    if (!input) return;
    const card = input.closest('.task-card');
    if (card) void toggle(card.dataset.id, input.checked);
  });
  el('task-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-delete]');
    if (!button) return;
    const card = button.closest('.task-card');
    if (card) void remove(card.dataset.id, button);
  });

  repeatChanged();
  void load();
})();
