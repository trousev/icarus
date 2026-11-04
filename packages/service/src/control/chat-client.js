// Клиент чата: без сборки и зависимостей. Сервер отдаёт каркас, список диалогов и
// историю — этот файл только рисует их и читает NDJSON-поток ответа.
//
// Разметка живёт в chat-markdown.js и подключается раньше: это обычные глобальные
// функции, а не импорт — сборки в панели нет.
/* global markdown, linkify, imageSrc */
const cfg = window.__CHAT_CFG__;

const el = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function cleanPreview(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const plural = (n, one, few, many) => {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('application/json')) {
    const message = type.includes('application/json')
      ? ((await response.json().catch(() => ({}))).error || {}).message || response.statusText
      : 'сессия входа истекла — обнови страницу';
    throw new Error(message);
  }
  return response.json();
}

/* ── даты и диалоги ───────────────────────────────────────────────────────── */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function daysAgo(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 99;
  return Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = daysAgo(iso);
  if (days <= 0) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function groupLabel(iso) {
  const days = daysAgo(iso);
  if (days <= 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  if (days < 7) return 'На этой неделе';
  return 'Раньше';
}

const SUB_MARK = { queued: '·', running: '◐', ok: '✓', error: '✕', aborted: '■', skipped: '–' };

function seconds(ms) {
  const value = Math.max(0, Number(ms) || 0) / 1000;
  return value < 10 ? value.toFixed(1) + ' с' : Math.round(value) + ' с';
}

/**
 * Живой список субагентов под шагом: кто работает, кто в очереди и кто уже кончил.
 * Данные приходят от инструмента (details.subagents) — здесь только рисование.
 */
function subagentsHtml(step, opened) {
  const list = step.subagents;
  if (!list || !list.length) return '';
  const items = list
    .map((sub, index) => {
      const status = String(sub.status || 'queued');
      const note =
        status === 'running'
          ? sub.activity || 'работает'
          : status === 'ok' || status === 'error' || status === 'aborted'
            ? sub.error || (sub.ms ? seconds(sub.ms) : 'готово')
            : 'ждёт очереди';
      const actions = Array.isArray(sub.actions) ? sub.actions : [];
      // Всего шагов может быть больше, чем помещается в список: не врём числом.
      const total = Number.isFinite(sub.actionsTotal) && sub.actionsTotal > 0 ? sub.actionsTotal : actions.length;
      const label =
        total > actions.length
          ? total + ' ' + plural(total, 'действие', 'действия', 'действий') + ' · последние ' + actions.length
          : actions.length + ' ' + plural(actions.length, 'действие', 'действия', 'действий');
      const key = (step.id || 'step') + ':' + index;
      // Действия ребёнка — вложенный список: по умолчанию свёрнут, чтобы длинная
      // трассировка не съедала ответ; раскрытое состояние переживает перерисовку.
      const details =
        actions.length > 0
          ? '<details class="sub-actions" data-sub="' +
            esc(key) +
            '"' +
            (opened && opened.has(key) ? ' open' : '') +
            '><summary>' +
            esc(label) +
            '</summary><div class="sub-action-list">' +
            actions
              .map((action) => '<div class="sub-action" title="' + esc(action) + '">' + esc(action) + '</div>')
              .join('') +
            '</div></details>'
          : '';
      return (
        '<div class="sub-step ' +
        esc(status) +
        '"><div class="sub-row"><span class="sub-mark">' +
        esc(SUB_MARK[status] || '·') +
        '</span><span class="sub-agent">' +
        esc(sub.agent) +
        '</span><span class="sub-task" title="' +
        esc(sub.task) +
        '">' +
        esc(sub.task) +
        '</span><span class="sub-note">' +
        esc(note) +
        '</span></div>' +
        details +
        '</div>'
      );
    })
    .join('');
  return '<div class="sub-list">' + items + '</div>';
}

function traceHtml(steps, opened) {
  if (!steps || !steps.length) return '';
  const items = steps
    .map(
      (step) =>
        '<div class="trace-step ' +
        esc(step.status || 'ok') +
        (step.subagents && step.subagents.length ? ' has-subs' : '') +
        '" title="' +
        esc(step.result || '') +
        '"><span class="trace-label">' +
        esc(step.label) +
        '</span><span class="trace-detail">' +
        esc(step.detail || step.tool || '') +
        '</span><span class="trace-dot"></span>' +
        subagentsHtml(step, opened) +
        '</div>',
    )
    .join('');
  const word = plural(steps.length, 'шаг', 'шага', 'шагов');
  return (
    '<details class="trace" open><summary>' +
    steps.length +
    ' ' +
    word +
    ' · трассировка</summary><div class="trace-list">' +
    items +
    '</div></details>'
  );
}

function assistantHtml(message) {
  return (
    '<div class="turn assistant"><div class="avatar">I</div><div class="assistant-body">' +
    '<div class="who"><b>Icarus</b><time>' +
    esc(timeLabel(message.timestamp)) +
    '</time></div>' +
    traceHtml(message.trace) +
    '<div class="md">' +
    markdown(message.text) +
    '</div></div></div>'
  );
}

/* ── состояние ────────────────────────────────────────────────────────────── */
let chats = [];
let currentId = cfg.chatId || null;
let currentChat = null;
/**
 * Чей ход панель сейчас СМОТРИТ (подписка на живой поток этого разговора).
 * Было булево `streaming`; стало идентификатором, потому что смотреть можно
 * только один разговор, а идти ходы могут во многих сразу.
 */
let liveChatId = null;
/**
 * Ящик ответа, который сейчас достримивается, и его обрыв. Держим рядом: ушедший
 * разговор нужно бросить так, чтобы это не выглядело ошибкой в его ленте.
 */
let liveBox = null;
let liveAbort = null;
/**
 * Тело ответа на идущий ход для каждого разговора: F5 или уход в другой чат —
 * это "ушёл смотреть", а не "отвечай заново". Вернувшись к тому же ходу, панель
 * подхватывает ту же плашку: иначе два возврата в один ход — два ответа в ленте.
 */
const liveBodies = new Map();
/** Разговоры, где ход идёт прямо сейчас — из сводки и снимка статуса. */
const busyChats = new Set();
/** Разговоры с непрочитанным ответом — жёлтая/зелёная точка в сайдбаре. */
const unread = new Set();
/** Идёт ли ход прямо в открытом разговоре: композеру и «стоп» это и нужно. */
const streaming = () => liveChatId !== null && liveChatId === currentId;
/** Нажал ли человек «стоп» в этом ходе: по флагу понятно, чем кончился ответ. */
let stoppedByUser = false;
/** Черновик нового чата: на сервере его ещё нет, пока не ушло первое сообщение. */
let draft = false;
/** Workspace, в котором появится черновик нового разговора. */
let draftWorkspace = 'talk';
/** Поколение загрузки истории: ответ, пришедший после смены чата, уже не нужен. */
let historyToken = 0;
/** Можно ли писать в открытый разговор: Telegram и API в панели только читаются. */
let writable = Boolean(cfg.enabled);
/** Список диалогов листается страницами: курсор приносит следующую. */
let nextCursor = null;
let loadingChats = false;
let loadGeneration = 0;
let searchTimer = 0;
let pending = [];
/** Workspace'ы человека и тот, в котором открыт текущий разговор. */
let workspaces = [];
let currentWorkspace = cfg.defaultWorkspace || 'talk';
/** Папка нового чата по умолчанию: клик по «Новый чат» не тащит папку прошлого разговора. */
const defaultWorkspace = currentWorkspace;
/** Пустое состояние до подмены экраном выбора workspace'а. */
let defaultEmptyHtml = '';
const CHAT_PAGE_SIZE = 30;
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const UNREAD_KEY = 'icarus.unread';

/**
 * Непрочитанное живёт только в браузере: серверу оно ни к чему, а лишний
 * персист ради зелёной точки не нужен. Отсюда и следствие — на другом устройстве
 * точки свои (см. README).
 */
function loadUnread() {
  try {
    const raw = JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]');
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') unread.add(id);
  } catch {
    /* битый ключ — просто начнём с пустого */
  }
}

function saveUnread() {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...unread]));
  } catch {
    /* приватный режим — точка просто не запомнится */
  }
}

/** Ответ пришёл в разговор, который человек не смотрит: ставим зелёную точку. */
function markUnread(chatId) {
  if (!chatId) return;
  // Смотрим этот разговор и вкладка на виду — ответ и так на экране, точка лишняя.
  if (chatId === currentId && !document.hidden) return;
  if (unread.has(chatId)) return;
  unread.add(chatId);
  saveUnread();
  renderChats();
}

/** Разговор открыли (или вкладка вернулась к нему) — точка гаснет. */
function markRead(chatId) {
  if (!chatId || !unread.has(chatId)) return;
  unread.delete(chatId);
  saveUnread();
  renderChats();
}

/**
 * Разговор удалён или его id устарел — точка на него больше не нужна. Чистим по
 * фактически загруженному списку, а не гадаем, что там лежит в localStorage.
 */
function pruneUnread() {
  const known = new Set(chats.map((chat) => chat.id));
  let changed = false;
  for (const id of [...unread]) {
    if (known.has(id)) continue;
    unread.delete(id);
    changed = true;
  }
  if (changed) saveUnread();
}

/** Как назвать вход, из которого пришёл разговор. */
function channelName(chat) {
  if (!chat) return '';
  if (chat.channel === 'telegram') return 'Telegram';
  if (chat.channel === 'api') return 'API';
  return '';
}

/** Короткая метка в списке диалогов: длинное «только чтение» съедает заголовок. */
function channelTag(chat) {
  if (!chat) return '';
  if (chat.channel === 'telegram') return 'TG';
  if (chat.channel === 'api') return 'API';
  return chat.readOnly ? '🔒' : '';
}

/**
 * Композер — по каналу разговора. Веб-чат пишется, Telegram и API читаются:
 * сервер всё равно откажет, но обещать в поле ввода несуществующее нельзя.
 */
function setComposer(readOnly) {
  const locked = Boolean(readOnly);
  writable = Boolean(cfg.enabled) && !locked;
  const label = channelName(currentChat);
  el('chat-input').disabled = !writable;
  el('chat-send').disabled = !writable;
  el('chat-attach').disabled = !writable;
  el('chat-input').placeholder = !cfg.enabled
    ? 'Чат недоступен…'
    : locked
      ? 'Разговор только для чтения'
      : 'Написать Icarus...';
  el('chat-locked').hidden = !locked || !cfg.enabled;
  el('chat-locked').textContent =
    locked && cfg.enabled
      ? 'Этот разговор начат в ' +
        (label || 'другом входе') +
        '. Здесь он только для чтения — продолжить можно там, где он начат.'
      : '';
  el('chat-status').textContent = !cfg.enabled ? 'Чат выключен' : locked ? 'Только чтение' : 'Агент активен';
}

function setTitle(title) {
  el('chat-title').textContent = title || 'Новый чат';
  document.title = 'Icarus · ' + (title || 'Новый чат');
}

/**
 * Строка под полем ввода — для того, чего не видно в ленте: отказ («не больше
 * восьми вложений»), сорванная загрузка, подтверждение остановки. Что делает
 * Икар прямо сейчас, здесь не пишем: шаги и команды и так идут в трассировке
 * ответа, а второй экран прогресса под композером только мешает читать.
 */
function setNote(text) {
  el('chat-note').textContent = text || '';
}

function showEmpty(show) {
  el('chat-empty').hidden = !show;
  if (show) el('chat-messages').innerHTML = '';
}

function renderChats() {
  const box = el('chat-list');
  const top = box.scrollTop;
  if (!chats.length) {
    const query = el('chat-search').value.trim();
    if (query) {
      box.innerHTML = '<p class="side-empty">Ничего не найдено.</p>';
    } else {
      // В черновике подсказка «начни новый чат» лишняя: он уже начат.
      box.innerHTML = draft ? '' : '<p class="side-empty">Пока пусто. Начни новый чат.</p>';
    }
    return;
  }
  let group = '';
  let html = '';
  for (const chat of chats) {
    const label = groupLabel(chat.createdAt);
    if (label !== group) {
      if (group) html += '</div>';
      group = label;
      html += '<div class="chat-group"><p class="chat-group-title">' + esc(label) + '</p>';
    }
    // Точка одна и она старше видит занятость: жёлтая — ход идёт, зелёная — есть
    // непрочитанный ответ. Разметка точки появляется, только когда она нужна, —
    // иначе `gap` у flex-строки съедал бы место под пустую колонку.
    const dot = busyChats.has(chat.id) ? 'busy' : unread.has(chat.id) ? 'unread' : '';
    html +=
      '<button class="chat-item' +
      (chat.id === currentId ? ' active' : '') +
      (chat.readOnly ? ' read-only' : '') +
      '" data-id="' +
      esc(chat.id) +
      '"><div class="chat-item-top">' +
      (dot ? '<span class="chat-dot ' + dot + '"></span>' : '') +
      '<span class="chat-item-title">' +
      esc(chat.title) +
      '</span>' +
      (channelTag(chat) ? '<span class="chat-item-tag">' + esc(channelTag(chat)) + '</span>' : '') +
      '<time class="chat-item-time">' +
      esc(timeLabel(chat.createdAt)) +
      '</time></div><div class="chat-item-preview">' +
      esc(cleanPreview(chat.preview || '')) +
      '</div></button>';
  }
  if (group) html += '</div>';
  box.innerHTML = html;
  box.scrollTop = top;
  box.querySelectorAll('.chat-item').forEach((node) => {
    node.onclick = () => selectChat(node.dataset.id);
  });
}

/**
 * Страница списка. reset — новый поиск или первый вход; иначе догружаем
 * следующую страницу и дописываем её к уже показанным диалогам.
 */
async function loadChats(reset = true) {
  if (!reset && (loadingChats || !nextCursor)) return;
  const generation = ++loadGeneration;
  const query = el('chat-search').value.trim();
  if (reset) {
    chats = [];
    nextCursor = null;
  }

  loadingChats = true;
  try {
    const params = new URLSearchParams({ limit: String(CHAT_PAGE_SIZE) });
    if (query) params.set('q', query);
    if (!reset && nextCursor) params.set('cursor', nextCursor);
    const data = await api('/panel/api/chats?' + params.toString());
    if (generation !== loadGeneration) return;

    const incoming = data.chats || [];
    if (reset) chats = incoming;
    else {
      // Пока листали, наверху мог появиться новый разговор: страницы сдвинулись,
      // и одна и та же запись пришла бы дважды.
      const seen = new Set(chats.map((chat) => chat.id));
      chats = chats.concat(incoming.filter((chat) => !seen.has(chat.id)));
    }
    nextCursor = data.nextCursor || null;
    if (reset) pruneUnread();
    renderChats();
    if (reset) el('chat-list').scrollTop = 0;
  } finally {
    if (generation === loadGeneration) {
      loadingChats = false;
      maybeLoadMore();
    }
  }
}

/** Первая страница не заполнила сайдбар — скролла не будет, догружаем сами. */
function maybeLoadMore() {
  const box = el('chat-list');
  if (!nextCursor || loadingChats || box.clientHeight === 0) return;
  if (box.scrollHeight <= box.clientHeight + 24) {
    loadChats(false).catch((error) => setNote('не удалось догрузить диалоги: ' + error.message));
  }
}

/** Ход закончился: двигаем свой диалог наверх, не сбрасывая уже загруженные страницы. */
function rememberChat(chat, liveText) {
  if (!chat) return;
  const merged = {
    ...chat,
    preview: cleanPreview(chat.preview || liveText || ''),
    updatedAt: chat.updatedAt || new Date().toISOString(),
  };
  chats = chats.filter((item) => item.id !== merged.id);
  chats.unshift(merged);
  renderChats();
}

async function loadState() {
  try {
    const state = await api('/panel/api/state');
    el('count-memory').textContent = String((state.counts || {}).personal ?? 0);
    el('count-skills').textContent = String((state.counts || {}).skills ?? 0);
    el('count-mcp').textContent = String((state.counts || {}).mcp ?? 0);
    const maple = state.sections && state.sections.some((section) => section.id === 'maple');
    el('maple-link').hidden = !maple;
    el('settings-maple').hidden = !maple;
    if (maple) el('count-maple').textContent = String((state.counts || {}).maple ?? 0);
  } catch {
    /* счётчики — украшение; чат должен открыться и без них */
  }
}

function openSettings(section) {
  if (section === 'maple' && el('settings-maple').hidden) return;
  el('settings-frame').src = '/panel/' + section + '?embed=1';
  el('settings-pane').hidden = false;
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.settingsTab === section);
  });
  const url = new URL(window.location.href);
  url.searchParams.set('settings', section);
  history.replaceState(null, '', url);
  closeMenu();
}

function closeSettings() {
  el('settings-pane').hidden = true;
  const url = new URL(window.location.href);
  url.searchParams.delete('settings');
  history.replaceState(null, '', url);
}

function baseName(file) {
  return String(file || '').split(/[\\/]/).pop() || 'файл';
}

function fileSizeText(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' КБ';
  return bytes + ' Б';
}

function renderPending() {
  const box = el('chat-pending');
  if (!pending.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = pending
    .map(
      (item, index) =>
        '<div class="item">' +
        (item.image ? '<img src="' + item.url + '" alt="">' : '') +
        '<span class="name" title="' + esc(item.file.name + ' · ' + fileSizeText(item.file.size)) + '">' +
        esc(item.file.name) +
        '</span><button class="remove" data-index="' +
        index +
        '" aria-label="Убрать">×</button></div>',
    )
    .join('');
  box.querySelectorAll('.remove').forEach((button) => {
    button.onclick = () => {
      const [removed] = pending.splice(Number(button.dataset.index), 1);
      if (removed) URL.revokeObjectURL(removed.url);
      renderPending();
    };
  });
}

function clearPending(revoke = true) {
  if (revoke) for (const item of pending) URL.revokeObjectURL(item.url);
  pending = [];
  renderPending();
}

function addFiles(list) {
  // Прикрепить файл можно, только пока сам этот разговор молчит: вложение уйдёт
  // вместе со следующей репликой, а она в занятый разговор не пойдёт.
  if (streaming() || !writable) return;
  let total = pending.reduce((sum, item) => sum + item.file.size, 0);
  for (const file of Array.from(list || [])) {
    if (pending.length >= MAX_FILES) {
      setNote('не больше ' + MAX_FILES + ' вложений на сообщение');
      break;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      setNote('вложения больше ' + fileSizeText(MAX_TOTAL_BYTES) + ' — не отправлю');
      break;
    }
    total += file.size;
    pending.push({ file, url: URL.createObjectURL(file), image: file.type.startsWith('image/') });
  }
  if (pending.length) setNote('');
  renderPending();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('не прочитать файл'));
    reader.readAsDataURL(file);
  });
}

function historyAttachments(attachments) {
  if (!attachments || !attachments.length) return '';
  return (
    '<div class="attachments">' +
    attachments
      .map((item) => {
        const src = imageSrc(item.path);
        return item.image
          ? '<a href="' + src + '" target="_blank" rel="noopener"><img class="attach-img" src="' + src + '" alt=""></a>'
          : '<span class="attach-file">' + esc(baseName(item.path)) + '</span>';
      })
      .join('') +
    '</div>'
  );
}

function userHtml(message) {
  return (
    '<div class="turn user"><div class="bubble">' +
    linkify(message.text || '') +
    historyAttachments(message.attachments) +
    '</div></div>'
  );
}

function renderHistory(messages) {
  if (!messages.length) {
    showEmpty(true);
    return;
  }
  showEmpty(false);
  el('chat-messages').innerHTML = messages
    .map((message) =>
      message.role === 'user' ? userHtml(message) : assistantHtml(message),
    )
    .join('');
  scrollToBottom(true);
}

async function selectChat(id) {
  // Переключение разговоров больше не заперто: уходим, отписавшись от потока
  // (ход доживёт на сервере), и цепляемся к новому, если там что-то идёт.
  if (!id) return;
  if (liveChatId) detachLive();
  markRead(id);
  closeSettings();
  endDraft();
  // Из черновика могли остаться экран выбора workspace'а — открытому чату он чужой.
  restoreEmptyState();
  const token = ++historyToken;
  currentId = id;
  history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(id));
  renderChats();
  // Канал уже известен из списка: композер не должен на миг обещать запись.
  setComposer(Boolean(chats.find((chat) => chat.id === id)?.readOnly));
  try {
    const data = await api('/panel/api/chat/history?id=' + encodeURIComponent(id));
    if (token !== historyToken) return;
    currentChat = data.chat;
    currentId = data.chat.id;
    currentWorkspace = data.chat.workspace || 'talk';
    updateComposerHint();
    history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(currentId));
    if (!chats.some((chat) => chat.id === currentId)) {
      chats.unshift(data.chat);
    }
    renderChats();
    setTitle(currentChat.title);
    setComposer(Boolean(currentChat.readOnly));
    setNote('');
    renderHistory(data.messages || []);
    // Разговор открылся, а ход всё ещё идёт: цепляемся к живому потоку.
    if (data.live && !streaming()) void attachLive();
    closeMenu();
  } catch (error) {
    if (token !== historyToken) return;
    setNote('не удалось открыть разговор: ' + error.message);
  }
}

/* ── новый чат ──────────────────────────────────────────────────────────────
   Клик по «Новый чат» сразу открывает новый чат: слева появляется строка
   черновика, справа — выбор workspace'а. Папку можно менять сколько угодно раз,
   пока не ушло первое сообщение: настоящий чат создаётся только с ним. */
function setDraft(on) {
  draft = on;
  el('new-chat').hidden = on;
  el('draft-wrap').hidden = !on;
  if (on) el('draft-time').textContent = timeLabel(new Date().toISOString());
}

function endDraft() {
  if (draft) setDraft(false);
}

/** Создаёт разговор на сервере — ровно в момент отправки первой реплики. */
async function createChat() {
  const data = await api('/panel/api/chats', {
    method: 'POST',
    body: JSON.stringify({ workspace: draftWorkspace }),
  });
  historyToken += 1;
  currentId = data.chat.id;
  currentChat = data.chat;
  currentWorkspace = data.chat.workspace || draftWorkspace;
  setDraft(false);
  // Экран выбора мог остаться в chat-empty после показа workspace'ов.
  restoreEmptyState();
  // rememberChat сам убирает дубликат и двигает разговор наверх, не сбрасывая
  // уже догруженные страницы списка.
  rememberChat(data.chat);
  el('chat-list').scrollTop = 0;
  history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(currentId));
  setComposer(false);
  updateComposerHint();
  return data.chat;
}

function startDraft(workspace = defaultWorkspace) {
  if (liveChatId) detachLive();
  if (draft && draftWorkspace === workspace) {
    el('chat-input').focus();
    closeMenu();
    return;
  }
  closeSettings();
  historyToken += 1;
  draftWorkspace = workspace;
  currentWorkspace = workspace;
  currentId = null;
  currentChat = null;
  setDraft(true);
  setComposer(false);
  setTitle('Новый чат');
  showEmpty(true);
  // Выбор workspace — не отдельный экран, а пустое состояние нового чата.
  renderPicker();
  updateComposerHint();
  setNote('');
  renderChats();
  history.replaceState(null, '', '/panel/chat?new=1');
  closeMenu();
  el('chat-input').focus();
}

/* ── workspace'ы ─────────────────────────────────────────────────────────────
   Экран выбора: папки человека, а не контейнеры. Создание и удаление тут —
   операции над каталогами, контейнер не трогаем вовсе. */

function wsLabel(slug) {
  const found = workspaces.find((item) => item.slug === slug);
  return found ? found.name : slug;
}

function wsKindLabel(ws) {
  if (ws.kind === 'talk') return 'по умолчанию';
  if (ws.kind === 'private') return 'только чтение';
  return 'свой';
}

function wsDescription(ws) {
  if (ws.kind === 'talk') return 'Своя рабочая папка и свой AGENTS.md. Память общая.';
  if (ws.kind === 'private') {
    return 'Приватный workspace: только чтение и никакой записи в память.';
  }
  return 'Отдельная рабочая папка со своим AGENTS.md.';
}

function wsGlyph(ws) {
  if (ws.kind === 'private') return '◍';
  if (ws.kind === 'talk') return '◔';
  return '▣';
}

async function loadWorkspaces() {
  const data = await api('/panel/api/workspaces');
  workspaces = data.workspaces || [];
  return data;
}

function wsCard(ws) {
  const remove =
    ws.kind === 'custom'
      ? '<button class="ws-del" data-del="' + esc(ws.slug) + '" title="Удалить workspace" aria-label="Удалить workspace">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>' +
        '</button>'
      : '';
  return (
    '<div class="ws-card' + (ws.slug === currentWorkspace ? ' active' : '') + '" data-ws="' + esc(ws.slug) +
    '" role="button" tabindex="0">' +
    '<div class="ws-top"><span class="ws-glyph">' + wsGlyph(ws) + '</span>' +
    '<span class="ws-name">' + esc(ws.name) + '</span>' +
    '<span class="ws-kind">' + esc(wsKindLabel(ws)) + '</span>' + remove + '</div>' +
    '<p class="ws-desc">' + esc(wsDescription(ws)) + '</p>' +
    '<div class="ws-foot"><code>' + esc(ws.path) + '</code><span class="ws-chip">AGENTS.md</span></div>' +
    '</div>'
  );
}

function newWsCard(open) {
  if (!open) {
    return (
      '<button class="ws-card ws-new" id="ws-new">' +
      '<div class="ws-top"><span class="ws-glyph ws-plus">+</span><span class="ws-name">Новый workspace</span>' +
      '<span class="ws-kind">своя папка</span></div>' +
      '<p class="ws-desc">Назовите пространство — оно получит отдельную рабочую папку.</p>' +
      '</button>'
    );
  }
  return (
    '<div class="ws-card ws-new open">' +
    '<input id="ws-name" placeholder="Название workspace" maxlength="64" autocomplete="off">' +
    '<div class="ws-form"><button class="ws-create" id="ws-create">Создать</button>' +
    '<button class="ws-cancel" id="ws-cancel">Отмена</button></div>' +
    '<p class="ws-hint">Новый workspace получит отдельную рабочую папку со своим AGENTS.md.</p>' +
    '</div>'
  );
}

const WS_PROMPTS = [
  'Собери план на сегодня',
  'Что ты помнишь о Марке?',
  'Подготовь сводку по проекту «Атлас»',
  'Напомни про дни рождения в июне',
];

/** Подпись над готовыми запросами: они уйдут в выбранную папку, а не всегда в «Разговор». */
function suggestTitle() {
  return 'НАЧАТЬ В «' + wsLabel(currentWorkspace).toUpperCase() + '»';
}

function pickerHtml() {
  return (
    '<div class="ws-screen">' +
    '<h2>Выберите workspace</h2>' +
    '<p class="ws-about">Workspace — это рабочая папка агента. У каждого своя папка и свой ' +
    'AGENTS.md, поэтому поведение отличается. «Приватный» — исключение: папка только для чтения, ' +
    'а запись в память запрещена.</p>' +
    '<div class="ws-grid">' + workspaces.map(wsCard).join('') + newWsCard(false) + '</div>' +
    '<p class="ws-suggest-title" id="ws-suggest-title">' + esc(suggestTitle()) + '</p>' +
    '<div class="suggestions ws-suggestions">' +
    WS_PROMPTS.map((prompt) => '<button data-prompt="' + esc(prompt) + '">' + esc(prompt) + '</button>').join('') +
    '</div>' +
    '</div>'
  );
}

function restoreEmptyState() {
  if (defaultEmptyHtml) el('chat-empty').innerHTML = defaultEmptyHtml;
}

/** Пустое состояние черновика: выбор workspace'а живёт прямо в новом чате. */
function renderPicker() {
  el('chat-empty').hidden = false;
  el('chat-empty').innerHTML = pickerHtml();
  bindPicker();
}

function bindPicker() {
  const screen = el('chat-empty');
  screen.querySelectorAll('.ws-card[data-ws]').forEach((node) => {
    const open = (event) => {
      if (event.target.closest('[data-del]')) return;
      openWorkspace(node.dataset.ws).catch((error) => setNote('не удалось открыть workspace: ' + error.message));
    };
    node.onclick = open;
    node.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open(event);
      }
    };
  });
  screen.querySelectorAll('[data-del]').forEach((node) => {
    node.onclick = (event) => {
      event.stopPropagation();
      askDeleteWorkspace(node.dataset.del);
    };
  });
  const create = el('ws-new');
  if (create) create.onclick = () => renderNewForm();
  const submit = el('ws-create');
  if (submit) submit.onclick = () => submitWorkspace().catch((error) => setNote(error.message));
  const cancel = el('ws-cancel');
  if (cancel) cancel.onclick = () => bindNewCard(false);
  const input = el('ws-name');
  if (input) {
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitWorkspace().catch((error) => setNote(error.message));
      }
      if (event.key === 'Escape') bindNewCard(false);
    };
  }
}

function bindNewCard(open) {
  const screen = el('chat-empty');
  const card = screen.querySelector('.ws-new');
  if (!card) return;
  if (!open) {
    card.outerHTML = newWsCard(false);
    bindPicker();
    return;
  }
  card.outerHTML = newWsCard(true);
  const input = el('ws-name');
  if (input) input.focus();
  const submit = el('ws-create');
  if (submit) submit.onclick = () => submitWorkspace().catch((error) => setNote(error.message));
  const cancel = el('ws-cancel');
  if (cancel) cancel.onclick = () => bindNewCard(false);
  if (input) {
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitWorkspace().catch((error) => setNote(error.message));
      }
      if (event.key === 'Escape') bindNewCard(false);
    };
  }
}

function renderNewForm() {
  bindNewCard(true);
}

async function submitWorkspace() {
  const input = el('ws-name');
  const name = (input ? input.value : '').trim();
  if (!name) {
    setNote('нужно название workspace');
    return;
  }
  const data = await api('/panel/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  await loadWorkspaces();
  await openWorkspace(data.workspace.slug);
}

/** Выбор папки: в черновике просто переключаем её, не покидая новый чат. */
async function openWorkspace(slug) {
  if (liveChatId) detachLive();
  closeSettings();
  if (!draft) {
    startDraft(slug);
    return;
  }
  if (draftWorkspace === slug) {
    el('chat-input').focus();
    return;
  }
  draftWorkspace = slug;
  currentWorkspace = slug;
  // Перерисовка заодно показывает только что созданную папку и гасит форму создания.
  renderPicker();
  updateComposerHint();
  setNote('');
  el('chat-input').focus();
}

/** Готовый запрос уходит в выбранную папку — и создаёт чат, как обычная реплика. */
async function startPrompt(prompt) {
  if (!draft) startDraft();
  await sendText(prompt);
}

function updateComposerHint() {
  const input = el('chat-input');
  if (input) input.placeholder = 'Написать в «' + wsLabel(currentWorkspace) + '»';
}

/** Список папок изменился: перерисовываем выбор, не выкидывая человека из черновика. */
function refreshPicker() {
  if (!draft) {
    startDraft();
    return;
  }
  if (!workspaces.some((item) => item.slug === draftWorkspace)) {
    draftWorkspace = defaultWorkspace;
    currentWorkspace = defaultWorkspace;
  }
  renderPicker();
  updateComposerHint();
}

function askDeleteWorkspace(slug) {
  const ws = workspaces.find((item) => item.slug === slug);
  if (!ws) return;
  const overlay = document.createElement('div');
  overlay.className = 'ws-modal';
  overlay.innerHTML =
    '<div class="ws-modal-card" role="dialog" aria-modal="true">' +
    '<h2>Удалить workspace?</h2>' +
    '<p>Workspace «' + esc(ws.name) + '» будет удалён. Диалоги останутся и вернутся в «' +
    esc(wsLabel('talk')) + '». Рабочая папка на диске не затрагивается.</p>' +
    '<div class="ws-modal-actions"><button class="ws-ghost" data-cancel>Отмена</button>' +
    '<button class="ws-danger" data-ok>Удалить</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-cancel]').onclick = close;
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector('[data-ok]').onclick = async () => {
    close();
    try {
      await api('/panel/api/workspaces/' + encodeURIComponent(slug), { method: 'DELETE' });
      await loadWorkspaces();
      await loadChats(true);
      refreshPicker();
    } catch (error) {
      setNote('не удалось удалить workspace: ' + error.message);
    }
  };
}

/* ── живой ответ ──────────────────────────────────────────────────────────── */
function scrollToBottom(force = false) {
  const box = el('chat-scroll');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 180) {
    box.scrollTop = box.scrollHeight;
  }
}

function addUser(text, files = []) {
  const node = document.createElement('div');
  node.className = 'turn user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (text) bubble.append(document.createTextNode(text));
  if (files.length) {
    const box = document.createElement('div');
    box.className = 'attachments';
    for (const item of files) {
      if (item.image) {
        const link = document.createElement('a');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener';
        const image = document.createElement('img');
        image.className = 'attach-img';
        image.src = item.url;
        image.alt = item.file.name;
        link.append(image);
        box.append(link);
      } else {
        const link = document.createElement('a');
        link.className = 'attach-file';
        link.href = item.url;
        link.download = item.file.name;
        link.textContent = item.file.name;
        box.append(link);
      }
    }
    bubble.append(box);
  }
  node.append(bubble);
  el('chat-messages').append(node);
  scrollToBottom(true);
}

function addAssistant() {
  const turn = document.createElement('div');
  turn.className = 'turn assistant';
  turn.innerHTML =
    '<div class="avatar">I</div><div class="assistant-body">' +
    '<div class="who"><b>Icarus</b><time>' +
    timeLabel(new Date().toISOString()) +
    '</time></div><div class="trace-slot"></div><div class="md"></div>' +
    '<div class="typing">Икар думает</div></div>';
  el('chat-messages').append(turn);
  scrollToBottom(true);
  return {
    turn,
    trace: turn.querySelector('.trace-slot'),
    md: turn.querySelector('.md'),
    typing: turn.querySelector('.typing'),
    text: '',
    steps: [],
    traceOpen: true,
    stopped: false,
  };
}

/**
 * Плажка ответа для идущего хода. Второй заход в тот же ход — не новый ответ:
 * берём уже нарисованную плашку и достраиваем её поверх остальных.
 */
function assistantBoxFor(chatId) {
  const existing = liveBodies.get(chatId);
  if (existing && existing.turn.isConnected) {
    el('chat-messages').append(existing.turn);
    scrollToBottom(true);
    return existing;
  }
  const box = addAssistant();
  box.chatId = chatId;
  liveBodies.set(chatId, box);
  return box;
}

/** Плашка — не ответ, а неудавшийся заход (ход уже занят другим): из ленты её вон. */
function dropLiveBody(chatId) {
  const box = liveBodies.get(chatId);
  if (!box) return;
  liveBodies.delete(chatId);
  box.turn.remove();
}

/**
 * Ход кончился записью в разговоре, и плашка уже несёт готовый ответ: в ленте её
 * оставляем — это и есть сообщение, которое человек читает. Из карты убираем:
 * вернувшись сюда, панель прочитает запись из истории, а не дорисует второй ответ.
 * Раньше плашку тут выбрасывали из DOM в расчёте, что «запись разговора заменит
 * её», но никто её не перерисовывал: ответ пропадал до перезагрузки страницы.
 */
function settleLiveBody(chatId) {
  liveBodies.delete(chatId);
}

function renderLive(box) {
  const details = box.trace.querySelector('details.trace');
  if (details) box.traceOpen = details.open;
  // Раскрытые списки действий детей тоже должны пережить перерисовку.
  const opened = new Set();
  box.trace.querySelectorAll('details.sub-actions[open]').forEach((node) => opened.add(node.dataset.sub));
  box.trace.innerHTML = traceHtml(box.steps, opened);
  const next = box.trace.querySelector('details.trace');
  if (next) next.open = box.traceOpen;
  box.md.innerHTML = markdown(box.text);
  box.typing.hidden = Boolean(box.text) || !streaming();
  scrollToBottom();
}

function handleEvent(box, event) {
  if (event.type === 'text') {
    box.text += event.text || '';
    renderLive(box);
    return;
  }
  // Шаги и их обновления живут в трассировке ответа: подпись «ТЕРМИНАЛ: такая-то
  // команда» под композером дублировала её слово в слово, только мельче.
  if (event.type === 'step') {
    box.steps.push(event.step);
    renderLive(box);
    return;
  }
  if (event.type === 'step-update') {
    const index = box.steps.findIndex((item) => item.id === event.id);
    if (index !== -1) box.steps[index] = event.step;
    renderLive(box);
    return;
  }
  if (event.type === 'step-end') {
    const step = box.steps.find((item) => item.id === event.id);
    if (step) {
      step.status = event.status;
      step.result = event.result;
      if (event.subagents) step.subagents = event.subagents;
      renderLive(box);
    }
    return;
  }
  if (event.type === 'notice') {
    setNote(event.message || '');
    return;
  }
  if (event.type === 'reauth') {
    if (!event.url) return;
    const card = document.createElement('div');
    card.className = 'reauth-card';
    const text = document.createElement('span');
    text.textContent = 'Доступ к MCP «' + (event.server || 'MCP') + '» истёк. ';
    const link = document.createElement('a');
    link.href = String(event.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Переподключить';
    card.append(text, link);
    box.turn.querySelector('.assistant-body')?.append(card);
    scrollToBottom();
    return;
  }
  if (event.type === 'done') {
    if (!box.text && !box.steps.length) {
      box.text = '(ответ пустой)';
      box.md.innerHTML = markdown(box.text);
    }
    box.typing.hidden = true;
    // Ответ окончательный и уже показан живой плашкой: саму плашку оставляем в
    // ленте (это и есть сообщение), а из карты убираем — иначе следующее
    // возвращение в этот разговор нарисует его второй раз.
    settleLiveBody(box.chatId);
    if (event.chat) {
      currentChat = event.chat;
      currentId = event.chat.id;
      setTitle(event.chat.title);
      setComposer(false);
      rememberChat(event.chat, box.text);
    } else {
      loadChats(true).catch(() => {});
    }
    setNote(stoppedByUser ? 'остановил — можно писать дальше' : '');
    return;
  }
  if (event.type === 'error') {
    box.text = [box.text, '\n\n[ошибка: ' + (event.message || 'ответ не пришёл') + ']'].filter(Boolean).join('');
    box.turn.classList.add('error');
    box.md.innerHTML = markdown(box.text);
    box.typing.hidden = true;
    setNote('');
  }
}

async function sendText(forced) {
  // Отказ только от СВОЕГО занятого разговора: чужие ходы отправке не мешают.
  if (!writable || (currentId && busyChats.has(currentId))) return;
  const input = el('chat-input');
  const text = String(forced ?? input.value).trim();
  const files = pending.slice();
  if (!text && files.length === 0) return;
  if (!currentId) {
    try {
      await createChat();
    } catch (error) {
      setNote('не удалось создать чат: ' + error.message);
      return;
    }
  }

  let attachments = [];
  if (files.length > 0) {
    try {
      attachments = await Promise.all(
        files.map(async (item) => ({
          name: item.file.name,
          type: item.file.type || 'application/octet-stream',
          data: await fileToBase64(item.file),
        })),
      );
    } catch (error) {
      setNote('не прочитать вложение: ' + error.message);
      return;
    }
  }

  // Запоминаем, чей это ход: пока он идёт, человек может уйти в другой разговор,
  // и `finally` не должен затирать подписку, которая к тому времени станет чужой.
  const turnChatId = currentId;
  setLive(turnChatId);
  const abort = new AbortController();
  liveAbort = abort;
  input.value = '';
  growInput();
  clearPending(false);
  showEmpty(false);
  addUser(text, files);
  const box = assistantBoxFor(turnChatId);
  box.stopped = false;
  liveBox = box;

  try {
    const response = await fetch('/panel/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: turnChatId, text, attachments }),
      signal: abort.signal,
    });
    if (!response.ok) {
      const type = response.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
      // Ход уже идёт (кто-то другой написал туда же): это не ошибка, а повод
      // прицепиться к живому потоку вместо того, чтобы падать с 409-кой.
      if (data.live) {
        dropLiveBody(turnChatId);
        setLive(null);
        await attachLive();
        return;
      }
      throw new Error((data.error || {}).message || response.statusText || 'ответ не начался: ' + response.status);
    }

    await readStream(response, box);
  } catch (error) {
    // Ушли в другой разговор — ответ доедет на сервере, панель его догонит.
    if (!box.stopped) {
      box.turn.classList.add('error');
      box.text = [box.text, '\n\n[ошибка: ' + error.message + ']'].filter(Boolean).join('');
      box.md.innerHTML = markdown(box.text);
      setNote('');
    }
  } finally {
    if (liveAbort === abort) liveAbort = null;
    if (liveBox === box) liveBox = null;
    markRead(turnChatId);
    if (liveChatId === turnChatId) setLive(null);
    box.typing.hidden = true;
    if (currentId === turnChatId) input.focus();
  }
}

/** Строчки NDJSON из потока: общий разбор и для отправки, и для догона хода. */
async function readStream(response, box) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      // Отписка рвёт чтение намеренно — это не ошибка ответа.
      if (box.stopped) return;
      throw error;
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) {
        try {
          handleEvent(box, JSON.parse(line));
        } catch {
          /* одна битая строка не должна рвать весь ответ */
        }
      }
      cut = buffer.indexOf('\n');
    }
  }
}

/**
 * Перечитать ленту разговора. Нужно там, где ответ уже записан, а в DOM его нет:
 * ход кончился между загрузкой истории и подпиской на живой поток.
 */
async function reloadHistory(chatId) {
  if (currentId !== chatId) return;
  const token = ++historyToken;
  try {
    const data = await api('/panel/api/chat/history?id=' + encodeURIComponent(chatId));
    if (token !== historyToken || currentId !== chatId) return;
    currentChat = data.chat;
    renderHistory(data.messages || []);
  } catch (error) {
    setNote('ответ пришёл, но лента не обновилась: ' + error.message);
  }
}

/**
 * Догон идущего хода — после F5 или открытия панели на другом устройстве.
 * Сервер сперва отдаёт накопленный журнал, потом живое до самого `done`,
 * поэтому ответ собирается с нуля ровно таким, каким был бы без перезагрузки.
 */
async function attachLive() {
  if (streaming() || !currentId) return;
  const chatId = currentId;
  const box = assistantBoxFor(chatId);
  setLive(chatId);
  const abort = new AbortController();
  liveAbort = abort;
  liveBox = box;
  box.stopped = false;
  try {
    const response = await fetch('/panel/api/chat/stream?id=' + encodeURIComponent(chatId), {
      signal: abort.signal,
    });
    if (!response.ok) {
      // Ход успел кончиться, пока подписывались: плашка-пустышка — не ответ, её
      // вон, а готовый ответ уже лежит в записи разговора — перечитываем ленту.
      dropLiveBody(chatId);
      await reloadHistory(chatId);
      return;
    }
    await readStream(response, box);
  } catch (error) {
    if (!box.stopped) setNote('догнать ответ не вышло: ' + error.message);
  } finally {
    if (liveAbort === abort) liveAbort = null;
    if (liveBox === box) liveBox = null;
    markRead(chatId);
    // Подписка могла к этому моменту уже уехать в другой разговор: трогаем
    // состояние, только если оно всё ещё наше.
    if (liveChatId === chatId) setLive(null);
    box.typing.hidden = true;
  }
}

/* ── сводка по всем разговорам ──────────────────────────────────────────────
   Отдельный канал поверх разговоров: панель узнаёт, что где-то начали думать и
   где-то закончили, не подписываясь на полный поток каждого разговора. Событий
   мало (старт и финал), поэтому стримом он не душит. */
let bulletin = null;

function applyBulletin(event) {
  if (!event || !event.chatId) return;
  if (event.type === 'busy') {
    busyChats.add(event.chatId);
    renderChats();
    // Открыт занятый разговор, а мы к нему не подписаны (ход начался в другой
    // вкладке или мы только что его открыли) — цепляемся.
    if (event.chatId === currentId && !streaming()) void attachLive();
    return;
  }
  if (event.type !== 'idle') return;
  busyChats.delete(event.chatId);
  // Ответ окончательный: плашку не выбрасываем — она уже несёт готовый текст.
  // `idle` приходит по сводке раньше `done` (разные соединения), поэтому именно
  // здесь ответ и пропадал, если событие успевало первым.
  settleLiveBody(event.chatId);
  if (event.chat) rememberChat(event.chat);
  // Ход доехал, пока мы смотрели другой разговор: ставим зелёную точку.
  markUnread(event.chatId);
  renderChats();
}

async function syncStatus() {
  try {
    const data = await api('/panel/api/chat/status');
    const incoming = new Set(data.busy || []);
    // Снимок — истина на момент открытия: подчищаем всё, чего в нём нет (ход мог
    // кончиться, пока мы были отключены и события за это время потерялись).
    for (const id of [...busyChats]) if (!incoming.has(id)) busyChats.delete(id);
    for (const id of incoming) busyChats.add(id);
    renderChats();
    if (currentId && busyChats.has(currentId) && !streaming()) void attachLive();
  } catch {
    /* снимок — удобство; чат должен открыться и без него */
  }
}

function startBulletin() {
  if (bulletin || !window.EventSource) return;
  bulletin = new EventSource('/panel/api/chat/events');
  // `EventSource` сам переподключается, но события за время разрыва теряет —
  // поэтому на каждое открытие (и первое, и после обрыва) сверяемся с сервером.
  bulletin.onopen = () => void syncStatus();
  bulletin.onmessage = (message) => {
    try {
      applyBulletin(JSON.parse(message.data));
    } catch {
      /* одна битая строка не должна ронять канал */
    }
  };
  bulletin.onerror = () => {
    // Состояние соединения браузер держит сам; тут делать нечего.
  };
}

/**
 * Отписка без остановки хода: человек ушёл в другой разговор, но Икар продолжает
 * думать. Вернётся — `/chat/stream` отдаст накопленное с нуля (см. attachLive).
 */
function detachLive() {
  // Бросаем чтение намеренно: обрыв тут — не ошибка ответа, а уход человека.
  if (liveBox) liveBox.stopped = true;
  if (liveAbort) {
    liveAbort.abort();
    liveAbort = null;
  }
  liveBox = null;
  if (liveChatId) setLive(null);
}

/**
 * Пока идёт ответ, на месте «отправить» стоит «стоп»: остановить ход можно и в
 * середине — вместе с субагентами, которые в этот момент работают.
 */
function setLive(chatId) {
  liveChatId = chatId || null;
  const on = Boolean(liveChatId);
  el('chat-stop').hidden = !on;
  el('chat-stop').disabled = false;
  el('chat-send').hidden = Boolean(on);
  el('chat-send').disabled = on || !writable;
  if (!on) stoppedByUser = false;
  // Точка «в работе» в сайдбаре — это в том числе наш собственный ход.
  renderChats();
}

async function stopStream() {
  if (!streaming() || !currentId) return;
  el('chat-stop').disabled = true;
  try {
    const result = await api('/panel/api/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ chatId: currentId }),
    });
    stoppedByUser = Boolean(result.ok);
    if (stoppedByUser) setNote('остановил — можно писать дальше');
  } catch (error) {
    setNote('остановить не вышло: ' + error.message);
  }
}

/* ── композер и меню ──────────────────────────────────────────────────────── */
function growInput() {
  const input = el('chat-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

/* Меню — всплывающее и только на мелких экранах: на широком колонка диалогов
   всегда на месте, поэтому сворачивать и разворачивать её нечем и незачем. */
function closeMenu() {
  el('chat-app').classList.remove('side-open');
}

/* «Новый чат» всегда открывает именно новый чат: workspace выбирается уже в нём. */
el('new-chat').onclick = () => startDraft();
el('draft-item').onclick = () => el('chat-input').focus();
el('toggle-side').onclick = () => {
  if (window.matchMedia('(max-width: 900px)').matches) el('chat-app').classList.toggle('side-open');
};
el('close-side').onclick = closeMenu;
document.querySelectorAll('[data-settings]').forEach((link) => {
  link.onclick = (event) => {
    event.preventDefault();
    openSettings(link.dataset.settings);
  };
});
document.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.onclick = () => openSettings(button.dataset.settingsTab);
});
el('settings-close').onclick = closeSettings;
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el('settings-pane').hidden) closeSettings();
});

/* ── ширина панели ────────────────────────────────────────────────────────── */
/* На широком экране колонку диалогов можно тянуть за правую границу. Ширина
   живёт в localStorage: иначе её пришлось бы подгонять в каждом заходе. */
const SIDE_WIDTH_KEY = 'icarus.side-width';
const SIDE_WIDTH_DEFAULT = 278;
const SIDE_WIDTH_MIN = 220;
const SIDE_WIDTH_MAX = 560;

const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

/** Потолок зависит от окна: панель не должна съесть чат целиком. */
function sideWidthLimit() {
  return Math.max(SIDE_WIDTH_MIN, Math.min(SIDE_WIDTH_MAX, window.innerWidth - 420));
}

function storedSideWidth() {
  try {
    const stored = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : SIDE_WIDTH_DEFAULT;
  } catch {
    return SIDE_WIDTH_DEFAULT;
  }
}

function applySideWidth(width) {
  const next = Math.round(Math.max(SIDE_WIDTH_MIN, Math.min(sideWidthLimit(), width)));
  el('chat-app').style.setProperty('--side-w', next + 'px');
  const handle = el('side-resizer');
  handle.setAttribute('aria-valuemax', String(Math.round(sideWidthLimit())));
  handle.setAttribute('aria-valuenow', String(next));
  return next;
}

function saveSideWidth(width) {
  try {
    localStorage.setItem(SIDE_WIDTH_KEY, String(width));
  } catch {
    /* приватный режим — ширина просто не запомнится */
  }
}

applySideWidth(storedSideWidth());

const sideHandle = el('side-resizer');
let sideDrag = null;

sideHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || isNarrow()) return;
  sideDrag = { x: event.clientX, width: el('chat-side').getBoundingClientRect().width };
  sideHandle.setPointerCapture(event.pointerId);
  el('chat-app').classList.add('resizing');
  event.preventDefault();
});

sideHandle.addEventListener('pointermove', (event) => {
  if (!sideDrag) return;
  applySideWidth(sideDrag.width + event.clientX - sideDrag.x);
});

function endSideDrag(event) {
  if (!sideDrag) return;
  sideDrag = null;
  el('chat-app').classList.remove('resizing');
  if (sideHandle.hasPointerCapture(event.pointerId)) sideHandle.releasePointerCapture(event.pointerId);
  saveSideWidth(Math.round(el('chat-side').getBoundingClientRect().width));
}

sideHandle.addEventListener('pointerup', endSideDrag);
sideHandle.addEventListener('pointercancel', endSideDrag);

/* Клавиатура: ←/→ двигают ширину, Home возвращает исходную. */
sideHandle.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
  event.preventDefault();
  const current = el('chat-side').getBoundingClientRect().width;
  const next = event.key === 'Home'
    ? SIDE_WIDTH_DEFAULT
    : current + (event.key === 'ArrowRight' ? 16 : -16);
  saveSideWidth(applySideWidth(next));
});

/* Окно сузили — подрезаем сохранённую ширину, чтобы чат не пропал. */
window.addEventListener('resize', () => {
  if (!sideDrag && !isNarrow()) applySideWidth(storedSideWidth());
});

el('chat-attach').onclick = () => el('chat-files').click();
el('chat-files').addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});
el('chat-input').addEventListener('paste', (event) => {
  if (event.clipboardData && event.clipboardData.files && event.clipboardData.files.length) {
    event.preventDefault();
    addFiles(event.clipboardData.files);
  }
});
el('chat-app').addEventListener('dragover', (event) => {
  if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault();
});
el('chat-app').addEventListener('drop', (event) => {
  if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
  event.preventDefault();
  addFiles(event.dataTransfer.files);
});
el('chat-input').addEventListener('input', growInput);
el('chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendText().catch(() => {});
  }
});
el('chat-send').onclick = () => {
  sendText().catch(() => {});
};
el('chat-stop').onclick = () => {
  stopStream().catch(() => {});
};
el('chat-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    loadChats(true).catch((error) => setNote('поиск не сработал: ' + error.message));
  }, 180);
});
el('chat-list').addEventListener('scroll', () => {
  if (!nextCursor || loadingChats) return;
  const box = el('chat-list');
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 120) {
    loadChats(false).catch((error) => setNote('не удалось догрузить диалоги: ' + error.message));
  }
});
/* Подсказки живут и в пустом чате, и в черновике, и перерисовываются вместе с
   ними: слушаем контейнер, иначе восстановленная разметка теряет обработчики. */
el('chat-empty').addEventListener('click', (event) => {
  const button = event.target.closest('.suggestions button[data-prompt]');
  if (!button) return;
  event.preventDefault();
  if (draft) startPrompt(button.dataset.prompt);
  else sendText(button.dataset.prompt).catch(() => {});
});

/* Вкладка вернулась на перед — то, что человек смотрит, становится прочитанным. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentId) markRead(currentId);
});
window.addEventListener('focus', () => {
  if (currentId) markRead(currentId);
});

(async () => {
  const params = new URLSearchParams(window.location.search);
  loadUnread();
  await loadState();
  await loadChats(true);
  await loadWorkspaces();
  defaultEmptyHtml = el('chat-empty').innerHTML;
  startBulletin();
  // Снимок занятости берём сразу, не дожидаясь открытия сводки: ходы могли
  // начаться до того, как панель открылась, и узнать о них больше негде.
  await syncStatus();
  if (currentId) await selectChat(currentId);
  else startDraft();
  updateComposerHint();
  if (params.get('settings')) openSettings(params.get('settings'));
  if (writable) el('chat-input').focus();
})().catch((error) => {
  setNote('чат не открылся: ' + error.message);
});
