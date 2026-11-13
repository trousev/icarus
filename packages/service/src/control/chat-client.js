// Chat client: no build and no dependencies. The server serves the shell, the chat list and
// history — this file only draws them and reads the NDJSON response stream.
//
// Markup lives in chat-markdown.js and is connected earlier: these are plain global
// functions, not an import — there is no build in the panel. Code highlighting — likewise.
/* global markdown, linkify, imageSrc, highlightCode */
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
  // The old call passes three strings, the new one — forms from the dictionary.
  const words = typeof one === 'string' ? { one, few, many } : one;
  if (cfg.ui.lang !== 'ru') return n === 1 ? words.one : words.many;
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return words.many;
  if (ones === 1) return words.one;
  if (ones >= 2 && ones <= 4) return words.few;
  return words.many;
};

/** Substitution into a dictionary template: «{name}» → value. Same technique as in ui.ts. */
const fill = (template, values) =>
  Object.entries(values).reduce((text, [key, value]) => text.split('{' + key + '}').join(String(value)), template);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('application/json')) {
    const message = type.includes('application/json')
      ? ((await response.json().catch(() => ({}))).error || {}).message || response.statusText
      : cfg.ui.sessionExpired;
    throw new Error(message);
  }
  return response.json();
}

/* ── dates and chats ──────────────────────────────────────────────────────── */
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
  if (days <= 0) return cfg.ui.today;
  if (days === 1) return cfg.ui.yesterday;
  if (days < 7) return cfg.ui.thisWeek;
  return cfg.ui.earlier;
}

const SUB_MARK = { queued: '·', running: '◐', ok: '✓', error: '✕', aborted: '■', skipped: '–' };

function seconds(ms) {
  const value = Math.max(0, Number(ms) || 0) / 1000;
  return value < 10 ? value.toFixed(1) + ' с' : Math.round(value) + ' с';
}

/**
 * Live list of subagents under a step: who is working, who is queued and who has already finished.
 * Data comes from the tool (details.subagents) — here only drawing.
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
      // There can be more total steps than fit in the list: we don't lie with the number.
      const total = Number.isFinite(sub.actionsTotal) && sub.actionsTotal > 0 ? sub.actionsTotal : actions.length;
      const label =
        total > actions.length
          ? total + ' ' + plural(total, 'действие', 'действия', 'действий') + ' · последние ' + actions.length
          : actions.length + ' ' + plural(actions.length, 'действие', 'действия', 'действий');
      const key = (step.id || 'step') + ':' + index;
      // A child's actions are a nested list: collapsed by default, so a long
      // trace doesn't eat the answer; the expanded state survives a redraw.
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
    .map((step) => {
      // Class by tool: page search and fetch are colored differently,
      // otherwise in the trace "SEARCH" with a URL looks like searching by that URL.
      const tool = String(step.tool || 'tool').replace(/[^a-z0-9_]/gi, '_');
      return (
        '<div class="trace-step ' +
        esc(step.status || 'ok') +
        ' tool-' +
        tool +
        (step.subagents && step.subagents.length ? ' has-subs' : '') +
        '" title="' +
        esc(step.result || '') +
        '"><span class="trace-label">' +
        esc(step.label) +
        '</span><span class="trace-detail">' +
        esc(step.detail || step.tool || '') +
        '</span><span class="trace-dot"></span>' +
        subagentsHtml(step, opened) +
        '</div>'
      );
    })
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

/** "Context cleared" boundary: not a message, but a divider between pi sessions. */
function clearDividerHtml() {
  return '<div class="turn divider"><hr><span>Контекст очищен</span></div>';
}

/* ── state ───────────────────────────────────────────────────────────────── */
let chats = [];
let currentId = cfg.chatId || null;
let currentChat = null;
/**
 * Which turn the panel is currently WATCHING (subscription to this chat's live stream).
 * It used to be a boolean `streaming`; it became an identifier, because you can watch
 * only one chat while turns can run in many at once.
 */
let liveChatId = null;
/**
 * The response box currently being streamed, and its abort. Kept side by side: a departed
 * chat must be dropped in a way that doesn't look like an error in its feed.
 */
let liveBox = null;
let liveAbort = null;
/**
 * The body of the response for the ongoing turn for each chat: F5 or leaving to another chat —
 * that's "went to look", not "answer again". Returning to the same turn, the panel
 * picks up the same box: otherwise two returns to one turn — two responses in the feed.
 */
const liveBodies = new Map();
/** Chats where a turn is running right now — from the bulletin and the status snapshot. */
const busyChats = new Set();
/** Chats with an unread response — a yellow/green dot in the sidebar. */
const unread = new Set();
/** Whether a turn is running in the open chat: the composer and "stop" need exactly this. */
const streaming = () => liveChatId !== null && liveChatId === currentId;
/** Whether the person pressed "stop" in this turn: the flag shows how the response ended. */
let stoppedByUser = false;
/** Draft of a new chat: it doesn't exist on the server yet until the first message is sent. */
let draft = false;
/** Workspace in which the draft of a new chat will appear. */
let draftWorkspace = 'talk';
/** History load generation: a response that arrived after a chat switch is no longer needed. */
let historyToken = 0;
/** Queue of messages by chat: the truth lives on the server, here only its view. */
const queues = new Map();
/**
 * Our own bubble, drawn in advance. The server announces the message with a `user`
 * event (by it it's visible after F5), but there's no need for the sender to draw a second one.
 */
let optimisticUser = null;
/** Whether one can write to the open chat: Telegram and API are read-only in the panel. */
let writable = Boolean(cfg.enabled);
/** The chat list is paginated: the cursor brings the next page. */
let nextCursor = null;
let loadingChats = false;
let loadGeneration = 0;
let searchTimer = 0;
let pending = [];
/** The person's workspaces and the one in which the current chat is open. */
let workspaces = [];
/**
 * Folders in the left menu. Collapsed state and composition are stored by the server: the menu must look
 * the same from any device, not only in this browser (unlike unread).
 */
let folders = [];
/** New folder input is open: the row is drawn right in the list, without a modal. */
let folderDraft = false;
/** id of the folder being renamed in place. */
let folderRenaming = null;
/** The chat currently being dragged with the mouse: we highlight the target by it. */
let draggingChatId = null;
/** Open "Move to…" menu: one for the whole panel. */
let chatMenu = null;
let currentWorkspace = cfg.defaultWorkspace || 'talk';
/** Default folder of a new chat: clicking "New chat" doesn't drag the previous chat's folder. */
const defaultWorkspace = currentWorkspace;
/** Empty state before it's replaced by the workspace picker screen. */
let defaultEmptyHtml = '';
const CHAT_PAGE_SIZE = 30;
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const UNREAD_KEY = 'icarus.unread';
/** Whether the archive is expanded: the collapsed state survives a reload. */
const ARCHIVE_OPEN_KEY = 'icarus.archive-open';
/** Archive — a separate list of the same chat: the chat left sight but wasn't deleted. */
let archivedChats = [];
let archiveOpen = false;

function storedArchiveOpen() {
  try {
    return localStorage.getItem(ARCHIVE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveArchiveOpen(open) {
  try {
    localStorage.setItem(ARCHIVE_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* private mode — the state simply won't be remembered */
  }
}

/**
 * Unread lives only in the browser: the server has no use for it, and extra
 * persistence for a green dot isn't needed. Hence the consequence — on another device
 * the dots are its own (see README).
 */
function loadUnread() {
  try {
    const raw = JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]');
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') unread.add(id);
  } catch {
    /* broken key — we'll just start from empty */
  }
}

function saveUnread() {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...unread]));
  } catch {
    /* private mode — the dot simply won't be remembered */
  }
}

/** A response arrived in a chat the person isn't looking at: we set a green dot. */
function markUnread(chatId) {
  if (!chatId) return;
  // We're looking at this chat and the tab is visible — the response is already on screen, the dot is superfluous.
  if (chatId === currentId && !document.hidden) return;
  if (unread.has(chatId)) return;
  unread.add(chatId);
  saveUnread();
  renderChats();
}

/** The chat was opened (or the tab returned to it) — the dot goes out. */
function markRead(chatId) {
  if (!chatId || !unread.has(chatId)) return;
  unread.delete(chatId);
  saveUnread();
  renderChats();
}

/**
 * The chat was deleted or its id became stale — the dot is no longer needed. We clean by the
 * actually loaded list, not guessing what's in localStorage.
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

/** What to call the entry from which the chat came. */
function channelName(chat) {
  if (!chat) return '';
  if (chat.channel === 'telegram') return 'Telegram';
  if (chat.channel === 'api') return 'API';
  return '';
}

/**
 * Where the last message came from. The session file doesn't distinguish channels, so
 * the service remembers the channel: the header shows the mark of the last turn, not
 * "the conversation started here" (that's visible from the channel tag in the list).
 */
function viaLabel(turn) {
  if (!turn) return '';
  const name = turn.channel === 'telegram' ? 'Telegram' : turn.channel === 'api' ? 'API' : cfg.ui.viaPanel;
  const time = turn.at ? timeLabel(turn.at) : '';
  return fill(cfg.ui.viaLast, { name }) + (time ? ' · ' + time : '');
}

/** Chat header: channel of the last message. null — draft or no data. */
function renderVia(chat) {
  const node = el('chat-via');
  if (!node) return;
  const text = chat ? viaLabel(chat.lastTurn) : '';
  node.textContent = text;
  node.hidden = !text;
  node.dataset.channel = chat && chat.lastTurn ? chat.lastTurn.channel : '';
  node.title = text ? cfg.ui.viaTitle : '';
}

/**
 * What to say about the channel of the open chat. From a Telegram chat the response won't
 * go to Telegram — the bot lives on its own side — and staying silent about it is impossible:
 * the person would wait for the answer there.
 */
function chatHint(chat) {
  if (chat && chat.channel === 'telegram') {
    return cfg.ui.telegramHint;
  }
  return '';
}

/** A turn is running in another channel: a second one can't be started, and there's nothing to look at here. */
function busyInNote(channel) {
  const where =
    channel === 'telegram' ? cfg.ui.busyInTelegram : channel === 'api' ? cfg.ui.busyInApi : cfg.ui.busyInPanel;
  return fill(cfg.ui.busyInNote, { where });
}

/** Short tag in the chat list: a long "read-only" eats the title. */
function channelTag(chat) {
  if (!chat) return '';
  if (chat.channel === 'telegram') return 'TG';
  if (chat.channel === 'api') return 'API';
  return chat.readOnly ? '🔒' : '';
}

/**
 * Composer — by the chat's channel. The web chat is writable, Telegram and API are read-only:
 * the server will refuse anyway, but one can't promise in the input field what doesn't exist.
 */
function setComposer(readOnly) {
  const locked = Boolean(readOnly);
  writable = Boolean(cfg.enabled) && !locked;
  const label = channelName(currentChat);
  el('chat-input').disabled = !writable;
  el('chat-send').disabled = !writable;
  el('chat-attach').disabled = !writable;
  syncNowButton();
  el('chat-input').placeholder = !cfg.enabled
    ? cfg.ui.chatUnavailablePlaceholder
    : locked
      ? cfg.ui.readOnlyPlaceholder
      : cfg.ui.inputPlaceholder;
  el('chat-locked').hidden = !locked || !cfg.enabled;
  el('chat-locked').textContent =
    locked && cfg.enabled
      ? fill(cfg.ui.lockedNote, { label: label || cfg.ui.lockedOther })
      : '';
  el('chat-status').textContent = !cfg.enabled ? cfg.ui.chatOffStatus : locked ? cfg.ui.readOnlyStatus : cfg.ui.agentActive;
}

function setTitle(title) {
  el('chat-title').textContent = title || cfg.ui.newChat;
  document.title = 'Icarus · ' + (title || cfg.ui.newChat);
}

/** /rename: the new name immediately in the header and sidebar, without reloading the feed. */
function applyChatTitle(chatId, title) {
  if (currentChat && currentChat.id === chatId) {
    currentChat.title = title;
    setTitle(title);
  }
  const known = chats.find((chat) => chat.id === chatId);
  if (known && known.title !== title) {
    known.title = title;
    renderChats();
  }
}

/**
 * The line under the input field — for what isn't visible in the feed: a refusal ("no more
 * than eight attachments"), a failed load, a stop confirmation. What Icarus is doing right
 * now, we don't write here: steps and commands already go into the response trace,
 * and a second progress screen under the composer only gets in the way of reading.
 */
function setNote(text) {
  el('chat-note').textContent = text || '';
}

function showEmpty(show) {
  el('chat-empty').hidden = !show;
  if (show) el('chat-messages').innerHTML = '';
}

/** "Inbox" — not a folder in the registry, but everything left without a shelf. */
const INBOX_FOLDER = { id: '', name: cfg.ui.folderInbox, collapsed: false };

/** One list row: the chat itself, with the "✎" and "⋯" buttons beside it, not inside the button. */
function chatRowHtml(chat) {
  // The name is edited right in the list row: double-click on the title or the pencil
  // on hover. While editing — an input field stands instead of the row.
  if (chat.id === renamingId) {
    return (
      '<div class="chat-row" data-id="' + esc(chat.id) + '">' +
      '<div class="chat-item editing"><div class="chat-item-top">' +
      '<input class="chat-item-input" maxlength="128" value="' + esc(chat.title) +
      '" aria-label="' + esc(cfg.ui.chatRenamePlaceholder) + '" /></div></div></div>'
    );
  }
  // There's one dot and the older one sees busyness: yellow — a turn is running, green — there's
  // an unread response. The dot markup appears only when needed —
  // otherwise the `gap` of the flex row would eat space for an empty column.
  const dot = busyChats.has(chat.id) ? 'busy' : unread.has(chat.id) ? 'unread' : '';
  return (
    '<div class="chat-row" data-id="' + esc(chat.id) + '">' +
    '<button class="chat-item' +
    (chat.id === currentId ? ' active' : '') +
    (chat.readOnly ? ' read-only' : '') +
    '" data-id="' + esc(chat.id) + '">' +
    '<div class="chat-item-top">' +
    (dot ? '<span class="chat-dot ' + dot + '"></span>' : '') +
    '<span class="chat-item-title">' + esc(chat.title) + '</span>' +
    (channelTag(chat) ? '<span class="chat-item-tag">' + esc(channelTag(chat)) + '</span>' : '') +
    '<time class="chat-item-time">' + esc(timeLabel(chat.createdAt)) + '</time>' +
    '</div><div class="chat-item-preview">' + esc(cleanPreview(chat.preview || '')) + '</div></button>' +
    // Renaming — right here: the person sees the name in the list and wants to fix it here.
    '<button class="chat-rename" type="button" data-id="' + esc(chat.id) +
    '" title="' + esc(cfg.ui.chatRename) + '" aria-label="' + esc(cfg.ui.chatRename) + '">✎</button>' +
    // Moving is available both by mouse and by keyboard: the button opens a menu with folders.
    '<button class="chat-more" type="button" data-id="' + esc(chat.id) +
    '" title="' + esc(cfg.ui.chatMove) + '" aria-label="' + esc(cfg.ui.chatMove) + '">⋯</button>' +
    '</div>'
  );
}

/** Chats with the previous date headings: inside a folder they also help the eyes. */
function chatItemsHtml(list, withDates) {
  let group = '';
  let html = '';
  for (const chat of list) {
    if (withDates) {
      const label = groupLabel(chat.createdAt);
      if (label !== group) {
        if (group) html += '</div>';
        group = label;
        html += '<div class="chat-group"><p class="chat-group-title">' + esc(label) + '</p>';
      }
    }
    html += chatRowHtml(chat);
  }
  if (group) html += '</div>';
  return html;
}

/** Folder header: click collapses, "✎" and "×" edit the folder itself. */
function folderHeadHtml(folder, count) {
  const collapsed = Boolean(folder.collapsed);
  const renaming = folderRenaming === folder.id && folder.id !== '';
  // "Inbox" is not a registry folder: it has neither collapsed state nor actions, so
  // it doesn't need the button role either — otherwise the keyboard runs into an empty button.
  const interactive = folder.id !== '';
  return (
    '<div class="folder-head' + (collapsed ? ' collapsed' : '') + (interactive ? '' : ' inbox') +
    '" data-folder="' + esc(folder.id) + '"' +
    (interactive ? ' role="button" tabindex="0" aria-expanded="' + (collapsed ? 'false' : 'true') + '"' : '') + '>' +
    '<span class="folder-caret" aria-hidden="true">▾</span>' +
    (renaming
      ? '<input class="folder-rename" data-folder="' + esc(folder.id) + '" value="' + esc(folder.name) +
        '" maxlength="64" autocomplete="off" aria-label="' + esc(cfg.ui.folderName) + '">'
      : '<span class="folder-name">' + esc(folder.name) + '</span>') +
    '<span class="folder-count">' + count + '</span>' +
    (folder.id
      ? '<span class="folder-actions">' +
        '<button class="folder-act" type="button" data-act="rename" data-folder="' + esc(folder.id) +
        '" title="' + esc(cfg.ui.folderRename) + '" aria-label="' + esc(cfg.ui.folderRename) + '">✎</button>' +
        '<button class="folder-act" type="button" data-act="delete" data-folder="' + esc(folder.id) +
        '" title="' + esc(cfg.ui.folderDelete) + '" aria-label="' + esc(cfg.ui.folderDelete) + '">×</button></span>'
      : '') +
    '</div>'
  );
}

/** The chat name currently being edited in the list; `null` — not editing. */
let renamingId = null;

/** Fields whose Enter already saved the name: blur follows, we don't write a second time. */
const renameCommitted = new WeakSet();

function renderChats() {
  const box = el('chat-list');
  const top = box.scrollTop;
  const query = el('chat-search').value.trim();
  if (!chats.length && !folders.length && !folderDraft) {
    // In a draft the "start a new chat" hint is superfluous: it's already started.
    box.innerHTML = query
      ? '<p class="side-empty">' + esc(cfg.ui.chatListEmptySearch) + '</p>'
      : draft
        ? ''
        : '<p class="side-empty">' + esc(cfg.ui.chatListEmpty) + '</p>';
    return;
  }

  let html = '';
  if (folderDraft) {
    html += '<div class="folder-new"><input id="folder-new-name" placeholder="' + esc(cfg.ui.folderName) + '" maxlength="64" autocomplete="off"></div>';
  }

  if (!folders.length) {
    // There are no folders yet — the list lives as before. There's no point creating
    // "Inbox" for the whole list: the heading will appear when the first folder appears.
    html += chatItemsHtml(chats, true) || (query ? '<p class="side-empty">' + esc(cfg.ui.chatListEmptySearch) + '</p>' : '');
  } else {
    for (const folder of folders) {
      const items = chats.filter((chat) => chat.folder === folder.id);
      html += folderHeadHtml(folder, items.length);
      // During a search collapsed state doesn't hide what's found: otherwise the person decides
      // there are no matches, while they lie in a closed folder.
      if (folder.collapsed && !query) continue;
      // The drag hint isn't a search result, it doesn't belong here.
      html += items.length
        ? chatItemsHtml(items, true)
        : query
          ? ''
          : '<p class="side-empty folder-empty">' + esc(cfg.ui.folderDrop) + '</p>';
    }
    // Chats without a folder and those whose folder was already deleted from another device.
    const inbox = chats.filter((chat) => !folders.some((folder) => folder.id === chat.folder));
    html += folderHeadHtml(INBOX_FOLDER, inbox.length);
    html += inbox.length
      ? chatItemsHtml(inbox, true)
      : query
        ? ''
        : '<p class="side-empty folder-empty">' + esc(cfg.ui.folderEmpty) + '</p>';
    if (query && !chats.length) html += '<p class="side-empty">' + esc(cfg.ui.chatListEmptySearch) + '</p>';
  }

  box.innerHTML = html;
  box.scrollTop = top;
  bindChatList(box);
}

/** Row and header handlers: they're recreated by every list redraw. */
function bindChatList(box) {
  box.querySelectorAll('.chat-row').forEach((row) => {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      draggingChatId = row.dataset.id;
      row.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      // We also put our id as text: dataTransfer is the only piece of state transferable
      // between dragover and drop, a global variable is unreliable here.
      event.dataTransfer.setData('text/plain', draggingChatId);
    });
    row.addEventListener('dragend', () => {
      draggingChatId = null;
      row.classList.remove('dragging');
      box.querySelectorAll('.folder-head.drop-target').forEach((head) => head.classList.remove('drop-target'));
    });
  });
  box.querySelectorAll('.chat-item').forEach((node) => {
    node.onclick = () => selectChat(node.dataset.id);
    node.ondblclick = (event) => {
      event.preventDefault();
      startRename(node.dataset.id);
    };
  });
  box.querySelectorAll('.chat-more').forEach((node) => {
    node.onclick = (event) => {
      event.stopPropagation();
      openChatMenu(node.dataset.id, node);
    };
  });
  box.querySelectorAll('.folder-head').forEach((head) => {
    head.onclick = (event) => {
      if (event.target.closest('.folder-act') || event.target.closest('.folder-rename')) return;
      toggleChatFolder(head.dataset.folder).catch((error) => setNote('не удалось свернуть папку: ' + error.message));
    };
    head.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('.folder-rename')) return;
      event.preventDefault();
      toggleChatFolder(head.dataset.folder).catch(() => {});
    };
  });
  box.querySelectorAll('.folder-act').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const id = button.dataset.folder;
      if (button.dataset.act === 'rename') {
        folderRenaming = id;
        renderChats();
      } else {
        deleteFolderById(id).catch((error) => setNote('не удалось удалить папку: ' + error.message));
      }
    };
  });

  const draftInput = box.querySelector('#folder-new-name');
  if (draftInput) {
    draftInput.focus();
    draftInput.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        createFolderFromInput(draftInput.value).catch((error) => setNote('не удалось создать папку: ' + error.message));
      } else if (event.key === 'Escape') {
        folderDraft = false;
        renderChats();
      }
    };
  }
  const renameInput = box.querySelector('.folder-rename');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
    const finish = (save) => {
      if (folderRenaming !== renameInput.dataset.folder) return;
      const id = folderRenaming;
      folderRenaming = null;
      if (save) renameFolderById(id, renameInput.value).catch((error) => setNote('не удалось переименовать папку: ' + error.message));
      else renderChats();
    };
    renameInput.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };
    // Leaving the field is a cancel: an accidental click on the feed must not rename.
    renameInput.onblur = () => finish(false);
  }
  box.querySelectorAll('.chat-rename').forEach((node) => {
    node.onclick = (event) => {
      event.stopPropagation();
      startRename(node.dataset.id);
    };
  });
  const input = box.querySelector('.chat-item-input');
  if (input) {
    input.focus();
    input.select?.();
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commitRename(input);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    };
    // We moved the mouse elsewhere — that's also "done": the field must not hang.
    // But if the row was redrawn by a bulletin event, that's not "the person finished":
    // saving a fragment of the name from a vanished field is impossible.
    input.onblur = () => {
      if (input.isConnected === false) return;
      void commitRename(input);
    };
  }
}

/* ── folders ────────────────────────────────────────────────────────────────── */

async function loadFolders() {
  try {
    const data = await api('/panel/api/folders');
    folders = data.folders || [];
  } catch (error) {
    folders = [];
    setNote('не удалось загрузить папки: ' + error.message);
  }
  renderChats();
}

/** We change the folder optimistically and roll back if the server didn't accept. */
async function persistFolder(folderId, changes) {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return;
  const before = { ...folder };
  Object.assign(folder, changes);
  renderChats();
  try {
    const data = await api('/panel/api/folders/' + encodeURIComponent(folderId), {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    if (data.folder) Object.assign(folder, data.folder);
  } catch (error) {
    Object.assign(folder, before);
    setNote('не удалось сохранить папку: ' + error.message);
  }
  renderChats();
}

/** Collapse/expand. "Inbox" has no state — it has nothing to collapse. */
async function toggleChatFolder(folderId) {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return;
  await persistFolder(folderId, { collapsed: !folder.collapsed });
}

async function createFolderFromInput(rawName) {
  const name = String(rawName || '').trim();
  if (!name) {
    folderDraft = false;
    renderChats();
    return;
  }
  const data = await api('/panel/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
  if (data.folder) folders.push(data.folder);
  folderDraft = false;
  renderChats();
}

async function renameFolderById(folderId, rawName) {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return;
  const name = String(rawName || '').trim();
  folderRenaming = null;
  if (!name || name === folder.name) {
    renderChats();
    return;
  }
  const data = await api('/panel/api/folders/' + encodeURIComponent(folderId), {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  if (data.folder) Object.assign(folder, data.folder);
  renderChats();
}

/** Deleting a folder doesn't touch chats: the server returns them to "Inbox". */
async function deleteFolderById(folderId) {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return;
  await api('/panel/api/folders/' + encodeURIComponent(folderId), { method: 'DELETE' });
  folders = folders.filter((item) => item.id !== folderId);
  for (const chat of chats) if (chat.folder === folderId) delete chat.folder;
  renderChats();
}

async function moveChatToFolder(chatId, folderId) {
  await api('/panel/api/chat/folder', {
    method: 'POST',
    body: JSON.stringify({ id: chatId, folder: folderId || null }),
  });
  const chat = chats.find((item) => item.id === chatId);
  if (chat) {
    if (folderId) chat.folder = folderId;
    else delete chat.folder;
  }
  // Moving to a collapsed folder would look like "the chat disappeared" — we expand it.
  const target = folders.find((item) => item.id === folderId);
  if (target && target.collapsed) await persistFolder(folderId, { collapsed: false });
  else renderChats();
}

function closeChatMenu() {
  if (!chatMenu) return;
  chatMenu.remove();
  chatMenu = null;
}

/** "Move to…" menu: the same action as dragging, but without the mouse. */
function openChatMenu(chatId, anchor) {
  closeChatMenu();
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) return;
  const current = chat.folder || '';
  const option = (id, name) =>
    '<button type="button" role="menuitemradio" aria-checked="' + (id === current ? 'true' : 'false') + '"' +
    ' class="' + (id === current ? 'on' : '') + '" data-folder="' + esc(id) + '">' + esc(name) + '</button>';
  const menu = document.createElement('div');
  menu.className = 'chat-menu';
  menu.id = 'chat-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML =
    '<p class="chat-menu-title">' + esc(cfg.ui.folderMoveTitle) + '</p>' +
    (folders.length
      ? folders.map((folder) => option(folder.id, folder.name)).join('')
      : '<p class="chat-menu-empty">' + esc(cfg.ui.folderNone) + '</p>') +
    option('', cfg.ui.folderInbox) +
    '<button type="button" class="chat-menu-new" data-new="1">' + esc(cfg.ui.folderMenuNew) + '</button>';
  document.body.appendChild(menu);

  // We place it next to the button, but don't let it overflow the window.
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 200;
  menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
  const below = rect.bottom + 4;
  menu.style.top =
    (below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menu.offsetHeight - 4) : below) + 'px';

  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.new) {
      closeChatMenu();
      folderDraft = true;
      renderChats();
      const input = el('folder-new-name');
      if (input) input.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!('folder' in button.dataset)) return;
    const folderId = button.dataset.folder || null;
    closeChatMenu();
    moveChatToFolder(chatId, folderId).catch((error) => setNote('не удалось перенести чат: ' + error.message));
  });
  chatMenu = menu;
}

/**
 * Archive row: the same chat, but without time and with a restore button on the right —
 * it's visible immediately, because the archive is visited rarely and people look for exactly it.
 */
function archivedRowHtml(chat) {
  const tag = channelTag(chat);
  return (
    '<div class="chat-row">' +
    '<button class="chat-item' +
    (chat.id === currentId ? ' active' : '') +
    (chat.readOnly ? ' read-only' : '') +
    '" data-id="' +
    esc(chat.id) +
    '"><div class="chat-item-top"><span class="chat-item-title">' +
    esc(chat.title) +
    '</span>' +
    (tag ? '<span class="chat-item-tag">' + esc(tag) + '</span>' : '') +
    '</div><div class="chat-item-preview">' +
    esc(cleanPreview(chat.preview || '')) +
    '</div></button>' +
    '<button class="chat-row-action" type="button" data-restore="' +
    esc(chat.id) +
    '" title="' + esc(cfg.ui.archiveRestoreTitle) + '" aria-label="' + esc(cfg.ui.archiveRestoreTitle) + '">↩</button>' +
    '</div>'
  );
}

/**
 * Archive in the sidebar: a collapsed section under the list. The counter is visible even in the
 * collapsed state — otherwise the person won't know there's something there without opening it.
 */
function renderArchive() {
  const count = el('archive-count');
  count.textContent = String(archivedChats.length);
  count.hidden = archivedChats.length === 0;
  el('archive-toggle').setAttribute('aria-expanded', archiveOpen ? 'true' : 'false');
  const box = el('archive-list');
  box.hidden = !archiveOpen;
  if (!archiveOpen) return;
  if (!archivedChats.length) {
    box.innerHTML = '<p class="side-empty">' + esc(cfg.ui.archiveEmpty) + '</p>';
    return;
  }
  box.innerHTML = archivedChats.map(archivedRowHtml).join('');
  box.querySelectorAll('.chat-item').forEach((node) => {
    node.onclick = () => selectChat(node.dataset.id);
  });
  box.querySelectorAll('[data-restore]').forEach((node) => {
    node.onclick = () => restoreArchived(node.dataset.restore);
  });
}

async function loadArchived() {
  try {
    const data = await api('/panel/api/chats?archived=1&limit=100');
    archivedChats = data.chats || [];
    renderArchive();
  } catch (error) {
    el('archive-list').innerHTML = '<p class="side-empty">' + esc(cfg.ui.archiveLoadFailed) + esc(error.message) + '</p>';
  }
}

/** The header button says what will happen: "Archive" or "Restore". */
function setArchiveState(chat) {
  const archived = Boolean(chat && chat.archived);
  const button = el('toggle-archive');
  button.disabled = !chat;
  button.setAttribute('aria-pressed', archived ? 'true' : 'false');
  button.title = archived ? cfg.ui.archiveRestoreTitle : cfg.ui.archiveAdd;
  el('archive-button-label').textContent = archived ? cfg.ui.archiveRestore : cfg.ui.archiveAdd;
  el('chat-archived-tag').hidden = !archived;
}

/**
 * Moves the chat between the list and the archive. We re-read the lists from the server:
 * order, preview and total are its business, not our guess.
 */
async function setArchived(chatId, archived) {
  await api('/panel/api/chat/archive', {
    method: 'POST',
    body: JSON.stringify({ chatId, archived }),
  });
  if (currentChat && currentChat.id === chatId) {
    currentChat.archived = archived;
    setArchiveState(currentChat);
  }
  await loadChats(true);
  await loadArchived();
}

async function toggleArchive() {
  if (!currentId) return;
  const archived = !(currentChat && currentChat.archived);
  try {
    await setArchived(currentId, archived);
    setNote(
      archived ? cfg.ui.archiveAddedNote : cfg.ui.archiveRemovedNote,
    );
  } catch (error) {
    setNote('не удалось изменить архив: ' + error.message);
  }
}

async function restoreArchived(chatId) {
  try {
    await setArchived(chatId, false);
    setNote(cfg.ui.archiveRestoredNote);
  } catch (error) {
    setNote('не удалось вернуть из архива: ' + error.message);
  }
}

function startRename(chatId) {
  if (!chatId) return;
  renamingId = chatId;
  renderChats();
}

function cancelRename() {
  if (renamingId === null) return;
  renamingId = null;
  renderChats();
}

/**
 * Saving the name from the list: the server writes it to chats.json, just like `/rename`.
 * Enter and loss of focus both come — we don't send the request a second time.
 */
async function commitRename(input) {
  if (renameCommitted.has(input)) return;
  renameCommitted.add(input);
  const chatId = renamingId;
  if (!chatId) return;
  const title = String(input.value || '').replace(/\s+/g, ' ').trim();
  const known = chats.find((chat) => chat.id === chatId);
  renamingId = null;
  if (!title || !known || title === known.title) {
    renderChats();
    return;
  }
  try {
    const data = await api('/panel/api/chats', {
      method: 'PATCH',
      body: JSON.stringify({ id: chatId, title: title }),
    });
    if (data && data.chat) applyChatTitle(data.chat.id, data.chat.title);
  } catch (error) {
    setNote('не получилось переименовать: ' + error.message);
  }
  renderChats();
}

/**
 * List page. reset — a new search or the first entry; otherwise we load
 * the next page and append it to the already shown chats.
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
      // While paging, a new chat could appear at the top: the pages shifted,
      // and the same record would come twice.
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

/** The first page didn't fill the sidebar — there won't be a scroll, we load more ourselves. */
function maybeLoadMore() {
  const box = el('chat-list');
  if (!nextCursor || loadingChats || box.clientHeight === 0) return;
  if (box.scrollHeight <= box.clientHeight + 24) {
    loadChats(false).catch((error) => setNote('не удалось догрузить диалоги: ' + error.message));
  }
}

/** The turn ended: we move our chat to the top without resetting the already loaded pages. */
function rememberChat(chat, liveText) {
  if (!chat) return;
  const merged = {
    ...chat,
    preview: cleanPreview(chat.preview || liveText || ''),
    updatedAt: chat.updatedAt || new Date().toISOString(),
  };
  // An archived chat isn't returned to the common list by a response: otherwise the archive
  // would stop meaning "I don't see it every day".
  if (merged.archived) {
    const at = archivedChats.findIndex((item) => item.id === merged.id);
    if (at >= 0) archivedChats[at] = merged;
    else archivedChats.unshift(merged);
    renderArchive();
    return;
  }
  chats = chats.filter((item) => item.id !== merged.id);
  chats.unshift(merged);
  renderChats();
}

function baseName(file) {
  return String(file || '').split(/[\\/]/).pop() || cfg.ui.filesWord.one;
}

function fileSizeText(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + cfg.ui.megabytesShort;
  if (bytes >= 1024) return Math.round(bytes / 1024) + cfg.ui.kilobytesShort;
  return bytes + cfg.ui.bytesShort;
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
        '" aria-label="' + esc(cfg.ui.filesRemove) + '">×</button></div>',
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
  // A file can be attached only while this chat is silent: the attachment will go
  // with the next message, and it won't go into a busy chat.
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
    .map((message) => {
      if (message.divider === 'clear') return clearDividerHtml();
      return message.role === 'user' ? userHtml(message) : assistantHtml(message);
    })
    .join('');
  scrollToBottom(true);
}

async function selectChat(id) {
  // Switching chats is no longer locked: we leave by unsubscribing from the stream
  // (the turn will survive on the server), and attach to the new one if something is running there.
  if (!id) return;
  if (liveChatId) detachLive();
  markRead(id);
  endDraft();
  // The workspace picker screen could remain from the draft — it's foreign to an open chat.
  restoreEmptyState();
  const token = ++historyToken;
  currentId = id;
  // The queue indicator is about the open chat: at someone else's it would be a lie.
  renderQueue();
  history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(id));
  renderChats();
  // The channel is already known from the list: the composer must not promise writing for a moment.
  setComposer(Boolean(chats.find((chat) => chat.id === id)?.readOnly));
  try {
    const data = await api('/panel/api/chat/history?id=' + encodeURIComponent(id));
    if (token !== historyToken) return;
    currentChat = data.chat;
    currentId = data.chat.id;
    currentWorkspace = data.chat.workspace || 'talk';
    updateComposerHint();
    history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(currentId));
    // An archived chat opens from its own section and doesn't get into the common list.
    if (data.chat.archived) {
      if (!archivedChats.some((chat) => chat.id === currentId)) archivedChats.unshift(data.chat);
    } else if (!chats.some((chat) => chat.id === currentId)) {
      chats.unshift(data.chat);
    }
    renderChats();
    renderArchive();
    setTitle(currentChat.title);
    setArchiveState(currentChat);
    setComposer(Boolean(currentChat.readOnly));
    setNote(chatHint(currentChat));
    renderVia(currentChat);
    renderHistory(data.messages || []);
    // The queue survives F5: the server returns it together with the history.
    setQueue(id, data.queue || []);
    // The chat opened, but the turn is still running: we attach to the live stream.
    if (data.live && !streaming()) void attachLive();
    closeMenu();
  } catch (error) {
    if (token !== historyToken) return;
    setNote('не удалось открыть разговор: ' + error.message);
  }
}

/* ── new chat ──────────────────────────────────────────────────────────────
   Clicking "New chat" immediately opens a new chat: a draft row appears on the left,
   a workspace picker on the right. The folder can be changed any number of times
   until the first message is sent: the real chat is created only with it. */
function setDraft(on) {
  draft = on;
  el('new-chat').hidden = on;
  el('draft-wrap').hidden = !on;
  if (on) el('draft-time').textContent = timeLabel(new Date().toISOString());
}

function endDraft() {
  if (draft) setDraft(false);
}

/** Creates the chat on the server — exactly at the moment the first message is sent. */
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
  // The picker screen could remain in chat-empty after showing workspaces.
  restoreEmptyState();
  // rememberChat itself removes the duplicate and moves the chat to the top, without resetting
  // the already loaded pages of the list.
  rememberChat(data.chat);
  el('chat-list').scrollTop = 0;
  history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(currentId));
  setArchiveState(currentChat);
  setComposer(false);
  updateComposerHint();
  setNote('');
  renderVia(data.chat);
  return data.chat;
}

function startDraft(workspace = defaultWorkspace) {
  if (liveChatId) detachLive();
  if (draft && draftWorkspace === workspace) {
    el('chat-input').focus();
    closeMenu();
    return;
  }
  historyToken += 1;
  draftWorkspace = workspace;
  currentWorkspace = workspace;
  currentId = null;
  currentChat = null;
  setDraft(true);
  setArchiveState(null);
  setComposer(false);
  renderQueue();
  setTitle(cfg.ui.newChat);
  renderVia(null);
  showEmpty(true);
  // Workspace selection is not a separate screen, but the empty state of a new chat.
  renderPicker();
  updateComposerHint();
  setNote('');
  renderChats();
  history.replaceState(null, '', '/panel/chat?new=1');
  closeMenu();
  el('chat-input').focus();
}

/* ── workspaces ─────────────────────────────────────────────────────────────
   Picker screen: the person's folders, not containers. Creating and deleting here —
   operations on directories, we don't touch the container at all. */

function wsLabel(slug) {
  const found = workspaces.find((item) => item.slug === slug);
  return found ? found.name : slug;
}

function wsKindLabel(ws) {
  if (ws.kind === 'talk') return cfg.ui.wsDefaultKind;
  if (ws.kind === 'private') return cfg.ui.wsPrivateKind;
  return cfg.ui.wsCustomKind;
}

function wsDescription(ws) {
  if (ws.kind === 'talk') return cfg.ui.wsTalkDescription;
  if (ws.kind === 'private') {
    return cfg.ui.wsPrivateDescription;
  }
  return cfg.ui.wsCustomDescription;
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
      ? '<button class="ws-del" data-del="' + esc(ws.slug) + '" title="' + esc(cfg.ui.wsDeleteTitle) + '" aria-label="' + esc(cfg.ui.wsDeleteTitle) + '">' +
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
      '<div class="ws-top"><span class="ws-glyph ws-plus">+</span><span class="ws-name">' + esc(cfg.ui.wsNewTitle) + '</span>' +
      '<span class="ws-kind">' + esc(cfg.ui.wsNewKind) + '</span></div>' +
      '<p class="ws-desc">' + esc(cfg.ui.wsNewDescription) + '</p>' +
      '</button>'
    );
  }
  return (
    '<div class="ws-card ws-new open">' +
    '<input id="ws-name" placeholder="' + esc(cfg.ui.wsNewPlaceholder) + '" maxlength="64" autocomplete="off">' +
    '<div class="ws-form"><button class="ws-create" id="ws-create">' + esc(cfg.ui.wsCreate) + '</button>' +
    '<button class="ws-cancel" id="ws-cancel">' + esc(cfg.ui.wsCancel) + '</button></div>' +
    '<p class="ws-hint">' + esc(cfg.ui.wsNewHint) + '</p>' +
    '</div>'
  );
}

// We take ready-made prompts from the dictionary: a caption in the panel, not memory text.
const wsPrompts = () => cfg.ui.wsPrompts;

/** Caption above ready-made prompts: they'll go to the selected folder, not always to "Talk". */
function suggestTitle() {
  return fill(cfg.ui.wsStartIn, { name: wsLabel(currentWorkspace).toUpperCase() });
}

function pickerHtml() {
  return (
    '<div class="ws-screen">' +
    '<h2>' + esc(cfg.ui.wsPickTitle) + '</h2>' +
    '<p class="ws-about">' + esc(cfg.ui.wsPickAbout) + '</p>' +
    '<div class="ws-grid">' + workspaces.map(wsCard).join('') + newWsCard(false) + '</div>' +
    '<p class="ws-suggest-title" id="ws-suggest-title">' + esc(suggestTitle()) + '</p>' +
    '<div class="suggestions ws-suggestions">' +
    wsPrompts().map((prompt) => '<button data-prompt="' + esc(prompt) + '">' + esc(prompt) + '</button>').join('') +
    '</div>' +
    '</div>'
  );
}

function restoreEmptyState() {
  if (defaultEmptyHtml) el('chat-empty').innerHTML = defaultEmptyHtml;
}

/** Empty state of the draft: workspace selection lives right in the new chat. */
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
    setNote(cfg.ui.wsNameRequired);
    return;
  }
  const data = await api('/panel/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  await loadWorkspaces();
  await openWorkspace(data.workspace.slug);
}

/** Folder selection: in a draft we just switch it without leaving the new chat. */
async function openWorkspace(slug) {
  if (liveChatId) detachLive();
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
  // The redraw also shows the just-created folder and hides the creation form.
  renderPicker();
  updateComposerHint();
  setNote('');
  el('chat-input').focus();
}

/** A ready-made prompt goes to the selected folder — and creates a chat, like a regular message. */
async function startPrompt(prompt) {
  if (!draft) startDraft();
  await sendText(prompt);
}

function updateComposerHint() {
  const input = el('chat-input');
  if (input) input.placeholder = fill(cfg.ui.wsInputPlaceholder, { name: wsLabel(currentWorkspace) });
  // The chat could have moved to another working folder — the file tree changes after it.
  syncFilesWorkspace();
}

/** The folder list changed: we redraw the picker without throwing the person out of the draft. */
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
    '<h2>' + esc(cfg.ui.wsDeleteTitle) + '</h2>' +
    '<p>' + esc(fill(cfg.ui.wsDeleteBody, { name: ws.name, talk: wsLabel('talk') })) + '</p>' +
    '<div class="ws-modal-actions"><button class="ws-ghost" data-cancel>' + esc(cfg.ui.wsCancel) + '</button>' +
    '<button class="ws-danger" data-ok>' + esc(cfg.ui.deleteLabel) + '</button></div>' +
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

/* ── workspace files ────────────────────────────────────────────────────────
   Right panel: the file tree of the open chat's working folder and file preview.
   The tree loads lazily, by folder; open folders and the selected file live in
   memory, while the panel width and its openness — in localStorage. */
const FILES_OPEN_KEY = 'icarus.files-open';
const FILES_WIDTH_KEY = 'icarus.files-w';
const FILES_PREVIEW_KEY = 'icarus.files-preview-h';
const FILES_WIDTH_DEFAULT = 400;
const FILES_WIDTH_MIN = 300;
/** The ceiling is twice the previous one: the panel can be stretched to half the screen. */
const FILES_WIDTH_MAX = 1440;
const FILES_PREVIEW_MIN = 90;

let filesOpen = false;
/** Slug of the workspace whose tree is currently drawn. */
let filesWorkspace = null;
/** Path for the caption above the tree: `~/icarus/…/workspaces/talk`. */
let filesRootPath = '';
/** path → { entries, truncated }; we load only expanded folders. */
let filesCache = new Map();
const filesExpanded = new Set();
let filesSelected = null;
let filesError = '';
let filesRootToken = 0;
let filesPreviewToken = 0;
let filesPreviewHeight = 0;
/** Text for the "copy" button: images and binaries don't have it — no button either. */
let filesPreviewCopy = null;
let filesCopyTimer = 0;
/** Deletion in progress: a second click on the trash must not send a second request. */
let filesDeleting = false;
/** File search: query, hits and race protection during fast typing. */
let filesSearch = '';
let filesSearchHits = [];
let filesSearchScanned = 0;
let filesSearchTruncated = false;
let filesSearchError = '';
let filesSearchBusy = false;
let filesSearchTimer = 0;
let filesSearchToken = 0;
/** Searching fewer than two characters is pointless: there are hundreds of matches, and a scan on every input. */
const FILES_SEARCH_MIN = 2;
/**
 * Last caret position in the input field. We insert the path from the preview there,
 * and if the person hasn't been in the field yet — at the end: we don't overwrite what's typed.
 */
let composerCaret = null;

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const IMAGE_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-6 6-3-3-4 4"/></svg>';
const CARET_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>';
const SEND_TO_CHAT_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
const COPIED_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
const COPY_TITLE = cfg.ui.filesCopy;

const filesNarrow = () => window.matchMedia('(max-width: 1100px)').matches;

function filesUrl(slug, route, relative = '', extra = {}) {
  const query = new URLSearchParams({ workspace: slug, path: relative });
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return '/panel/api/workspace-files' + (route ? '/' + route : '') + '?' + query.toString();
}

function fetchFileList(slug, relative) {
  return api(filesUrl(slug, '', relative));
}

function fetchFilePreview(slug, relative) {
  return api(filesUrl(slug, 'read', relative));
}

function storedFilesOpen() {
  try {
    return localStorage.getItem(FILES_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveFilesOpen(open) {
  try {
    localStorage.setItem(FILES_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* private mode — the state simply won't be remembered */
  }
}

function storedFilesWidth() {
  try {
    const stored = Number(localStorage.getItem(FILES_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : FILES_WIDTH_DEFAULT;
  } catch {
    return FILES_WIDTH_DEFAULT;
  }
}

function saveFilesWidth(width) {
  try {
    localStorage.setItem(FILES_WIDTH_KEY, String(width));
  } catch {
    /* private mode */
  }
}

function storedFilesPreviewHeight() {
  try {
    const stored = Number(localStorage.getItem(FILES_PREVIEW_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function saveFilesPreviewHeight(height) {
  try {
    localStorage.setItem(FILES_PREVIEW_KEY, String(Math.round(height)));
  } catch {
    /* private mode */
  }
}

/** The width ceiling depends on the window: the panel must not eat the whole feed. */
function filesWidthLimit() {
  const width = window.innerWidth || 1280;
  return Math.max(FILES_WIDTH_MIN, Math.min(FILES_WIDTH_MAX, width - 720));
}

function applyFilesWidth(width) {
  const next = Math.round(Math.max(FILES_WIDTH_MIN, Math.min(filesWidthLimit(), width)));
  el('chat-app').style.setProperty('--files-w', next + 'px');
  const handle = el('files-resizer');
  if (handle) {
    handle.setAttribute('aria-valuemax', String(Math.round(filesWidthLimit())));
    handle.setAttribute('aria-valuenow', String(next));
  }
  return next;
}

function setFilesPreviewHeight(height) {
  const panel = el('files-panel');
  const max = Math.max(FILES_PREVIEW_MIN, (panel.clientHeight || 720) - 180);
  const next = Math.round(Math.max(FILES_PREVIEW_MIN, Math.min(max, height)));
  filesPreviewHeight = next;
  el('files-preview').style.height = next + 'px';
  el('files-split').setAttribute('aria-valuenow', String(next));
  return next;
}

function hideFilesPreview() {
  el('files-panel').classList.remove('has-preview');
  el('files-preview').innerHTML = '';
  filesPreviewCopy = null;
}

function showFilesPreview(html) {
  el('files-preview').innerHTML = html;
  // The old content is no longer on screen: there's nothing to copy.
  filesPreviewCopy = null;
  el('files-panel').classList.add('has-preview');
  // The first file takes about half the panel; after that we remember what the person chose.
  if (!filesPreviewHeight) {
    setFilesPreviewHeight(
      storedFilesPreviewHeight() || Math.round((el('files-panel').clientHeight || 720) * 0.45),
    );
  } else {
    setFilesPreviewHeight(filesPreviewHeight);
  }
}

/** Tree rows: recursively by expanded folders, depth — by indent. */
function treeRows(dir, depth, rows) {
  const list = filesCache.get(dir);
  if (!list) return;
  for (const entry of list.entries) {
    const expanded = entry.dir && filesExpanded.has(entry.path);
    const active = !entry.dir && filesSelected === entry.path;
    const classes =
      'frow' + (entry.dir ? ' dir' : '') + (expanded ? ' open' : '') + (active ? ' active' : '');
    const icon = entry.dir ? FOLDER_ICON : entry.image ? IMAGE_ICON : FILE_ICON;
    rows.push(
      '<div class="' + classes + '" data-path="' + esc(entry.path) + '" data-dir="' +
        (entry.dir ? '1' : '0') + '" style="--depth:' + depth + '">' +
        '<button type="button" class="fmain" data-path="' + esc(entry.path) + '" data-dir="' +
        (entry.dir ? '1' : '0') + '"' +
        (entry.dir ? ' aria-expanded="' + (expanded ? 'true' : 'false') + '"' : '') + '>' +
        '<span class="fcaret">' + (entry.dir ? CARET_ICON : '') + '</span>' +
        '<span class="ficon">' + icon + '</span>' +
        '<span class="fname">' + esc(entry.name) + (entry.dir ? '/' : '') + '</span>' +
        (entry.dir ? '' : '<span class="ftype">' + esc(entry.type) + '</span>') +
        '</button>' +
        (entry.removable === false
          ? ''
          : '<button type="button" class="fdel" data-del="' + esc(entry.path) +
            '" title="' + esc(cfg.ui.deleteLabel) + '" aria-label="' + esc(cfg.ui.deleteLabel + ' ' + entry.name) + '">' + TRASH_ICON + '</button>') +
        '</div>',
    );
    if (!expanded) continue;
    if (!filesCache.has(entry.path)) {
      rows.push('<p class="files-note" style="margin-left:' + (16 + depth * 16) + 'px">' + esc(cfg.ui.loading) + '</p>');
      continue;
    }
    treeRows(entry.path, depth + 1, rows);
  }
}

/** The searched text is longer than two characters: only then do we start a request. */
function filesSearchActive() {
  return filesSearch.trim().length >= FILES_SEARCH_MIN;
}

/** A hit with match highlighting: esc by pieces, otherwise `<mark>` would become text. */
function searchSnippet(hit) {
  const text = String(hit.text || '');
  const match = hit.match;
  if (!match) return '<span class="ssnip name">' + esc(cfg.ui.filesNameMatch) + '</span>';
  const start = Math.max(0, Math.min(text.length, match.start));
  const end = Math.min(text.length, start + match.length);
  return (
    '<span class="ssnip">' + esc(text.slice(0, start)) +
    '<mark>' + esc(text.slice(start, end)) + '</mark>' +
    esc(text.slice(end)) + '</span>'
  );
}

/** Search results take the place of the tree: two lists in one column aren't needed. */
function searchRows() {
  const rows = [];
  if (filesSearchBusy) rows.push('<p class="files-note">' + esc(cfg.ui.filesSearching) + '</p>');
  if (filesSearchError) rows.push('<p class="files-error">' + esc(filesSearchError) + '</p>');
  if (!filesSearchBusy && !filesSearchError && !filesSearchHits.length) {
    rows.push('<p class="files-note">' + esc(cfg.ui.emptyNoResults) + '</p>');
  }
  for (const hit of filesSearchHits) {
    const file = hit.file || {};
    const active = Boolean(file.path) && filesSelected === file.path;
    rows.push(
      '<button type="button" class="srow' + (active ? ' active' : '') +
        '" data-path="' + esc(file.path) + '">' +
        '<span class="shead"><span class="sname">' + esc(file.name) + '</span>' +
        '<span class="spath">' + esc(file.path) + (hit.line ? ':' + hit.line : '') + '</span></span>' +
        searchSnippet(hit) +
        '</button>',
    );
  }
  if (filesSearchScanned || filesSearchTruncated) {
    rows.push(
      '<p class="files-more">' + esc(fill(cfg.ui.filesScanned, { n: filesSearchScanned })) +
        (filesSearchTruncated
          ? esc(fill(cfg.ui.filesFirstHits, { n: filesSearchHits.length }))
          : '.') +
        '</p>',
    );
  }
  return rows;
}

function renderFiles() {
  if (!filesOpen) return;
  const tree = el('files-tree');
  const keep = tree.scrollTop;
  const rows = [
    '<div class="files-root">' + FOLDER_ICON + '<span>' + esc(filesRootPath || '~/workspace') + '</span></div>',
  ];
  if (filesError) rows.push('<p class="files-error">' + esc(filesError) + '</p>');
  if (filesSearchActive()) {
    rows.push(...searchRows());
  } else if (filesSearch.trim()) {
    // A single character would give hundreds of matches and a folder scan on every letter.
    rows.push('<p class="files-note">' + esc(cfg.ui.filesTwoChars) + '</p>');
  } else {
    const root = filesCache.get('');
    if (!root) {
      rows.push('<p class="files-note">' + esc(cfg.ui.readingFolder) + '</p>');
    } else if (!root.entries.length) {
      rows.push('<p class="files-note">' + esc(cfg.ui.filesEmptyFolder) + '</p>');
    } else {
      treeRows('', 0, rows);
      if (root.truncated) {
        rows.push('<p class="files-more">' + esc(fill(cfg.ui.filesFirstEntries, { n: root.entries.length })) + '</p>');
      }
    }
  }
  tree.innerHTML = rows.join('');
  tree.scrollTop = keep;
}

/** Workspace root anew: the panel was opened or the chat moved to another folder. */
async function loadFilesRoot() {
  if (!filesOpen) return;
  const token = ++filesRootToken;
  const slug = currentWorkspace;
  filesWorkspace = slug;
  filesRootPath = '';
  filesCache = new Map();
  filesExpanded.clear();
  filesSelected = null;
  filesError = '';
  // The search belongs to the previous workspace: its hits here would be a lie.
  filesSearch = '';
  filesSearchHits = [];
  filesSearchScanned = 0;
  filesSearchTruncated = false;
  filesSearchError = '';
  filesSearchBusy = false;
  filesSearchToken += 1;
  clearTimeout(filesSearchTimer);
  const searchInput = el('files-search');
  if (searchInput) searchInput.value = '';
  hideFilesPreview();
  renderFiles();
  try {
    const data = await fetchFileList(slug, '');
    if (token !== filesRootToken || filesWorkspace !== slug) return;
    filesRootPath = data.workspace?.path || '';
    filesCache.set('', { entries: data.entries || [], truncated: Boolean(data.truncated) });
    renderFiles();
  } catch (error) {
    if (token !== filesRootToken) return;
    filesError = 'не удалось открыть папку: ' + error.message;
    renderFiles();
  }
}

/**
 * Search across the workspace. Responses may arrive out of the order in which they
 * were sent, so each request has its own token: a stale response must not
 * overwrite the hits for an already erased query.
 */
async function runFilesSearch() {
  if (!filesOpen || !filesWorkspace) return;
  const query = filesSearch.trim();
  const token = ++filesSearchToken;
  if (query.length < FILES_SEARCH_MIN) {
    filesSearchHits = [];
    filesSearchScanned = 0;
    filesSearchTruncated = false;
    filesSearchError = '';
    filesSearchBusy = false;
    renderFiles();
    return;
  }
  const slug = filesWorkspace;
  filesSearchBusy = true;
  filesSearchError = '';
  renderFiles();
  try {
    const data = await api(filesUrl(slug, 'search', '', { q: query }));
    if (token !== filesSearchToken || filesWorkspace !== slug) return;
    filesSearchHits = data.hits || [];
    filesSearchScanned = data.scanned || 0;
    filesSearchTruncated = Boolean(data.truncated);
  } catch (error) {
    if (token !== filesSearchToken || filesWorkspace !== slug) return;
    filesSearchHits = [];
    filesSearchScanned = 0;
    filesSearchTruncated = false;
    filesSearchError = 'поиск не удался: ' + error.message;
  }
  filesSearchBusy = false;
  renderFiles();
}

/**
 * The turn ended — the agent could have written files. We re-read the tree while preserving
 * the expanded folders and the selected file: the panel must not collapse mid-work.
 */
async function refreshFilesTree() {
  if (!filesOpen || !filesWorkspace) return;
  const slug = filesWorkspace;
  const token = filesRootToken;
  const paths = ['', ...filesExpanded];
  const fresh = new Map();
  let rootFailed = false;
  await Promise.all(
    paths.map(async (relative) => {
      try {
        const data = await fetchFileList(slug, relative);
        if (token !== filesRootToken || filesWorkspace !== slug) return;
        fresh.set(relative, {
          entries: data.entries || [],
          truncated: Boolean(data.truncated),
        });
        if (!relative) {
          filesRootPath = data.workspace?.path || filesRootPath;
        }
      } catch {
        if (!relative) rootFailed = true;
      }
    }),
  );
  if (rootFailed || token !== filesRootToken || filesWorkspace !== slug) return;
  filesCache = fresh;
  for (const path of [...filesExpanded]) if (!fresh.has(path)) filesExpanded.delete(path);
  if (filesSelected && !entryAt(filesSelected)) {
    filesSelected = null;
    hideFilesPreview();
  }
  // The agent could have written a file that's currently being searched: we recompute the results.
  if (filesSearchActive()) void runFilesSearch();
  else renderFiles();
}

/** An entry from the already loaded tree: it shows whether it's a file or a folder. */
function entryAt(relative) {
  const cut = relative.lastIndexOf('/');
  const parent = cut === -1 ? '' : relative.slice(0, cut);
  return filesCache.get(parent)?.entries.find((entry) => entry.path === relative) || null;
}

function openFilesPanel() {
  if (filesOpen) return;
  filesOpen = true;
  el('chat-app').classList.add('files-open');
  el('toggle-files').setAttribute('aria-pressed', 'true');
  saveFilesOpen(true);
  if (filesWorkspace !== currentWorkspace || !filesCache.has('')) {
    void loadFilesRoot();
  } else {
    renderFiles();
  }
}

function closeFilesPanel() {
  if (!filesOpen) return;
  filesOpen = false;
  el('chat-app').classList.remove('files-open');
  el('toggle-files').setAttribute('aria-pressed', 'false');
  saveFilesOpen(false);
}

function toggleFilesPanel() {
  if (filesOpen) closeFilesPanel();
  else openFilesPanel();
}

/** The chat moved to another folder: the tree changes after it. */
function syncFilesWorkspace() {
  if (!filesOpen) return;
  if (filesWorkspace === currentWorkspace && filesCache.has('')) return;
  void loadFilesRoot();
}

async function toggleFolder(relative) {
  if (!filesOpen) return;
  if (filesExpanded.has(relative)) {
    filesExpanded.delete(relative);
    renderFiles();
    return;
  }
  filesExpanded.add(relative);
  if (filesCache.has(relative)) {
    renderFiles();
    return;
  }
  renderFiles();
  const slug = filesWorkspace;
  try {
    const data = await fetchFileList(slug, relative);
    if (filesWorkspace !== slug || !filesExpanded.has(relative)) return;
    filesCache.set(relative, {
      entries: data.entries || [],
      truncated: Boolean(data.truncated),
    });
    filesError = '';
  } catch (error) {
    if (filesWorkspace !== slug) return;
    filesExpanded.delete(relative);
    filesError = 'не удалось открыть папку: ' + error.message;
  }
  renderFiles();
}

/** Removes a deleted entry from the local tree without waiting for a re-read. */
function forgetFilesPath(relative) {
  const cut = relative.lastIndexOf('/');
  const parent = cut === -1 ? '' : relative.slice(0, cut);
  const list = filesCache.get(parent);
  if (list) list.entries = list.entries.filter((entry) => entry.path !== relative);
  for (const path of [...filesCache.keys()]) {
    if (path === relative || path.startsWith(relative + '/')) filesCache.delete(path);
  }
  for (const path of [...filesExpanded]) {
    if (path === relative || path.startsWith(relative + '/')) filesExpanded.delete(path);
  }
  if (filesSelected === relative || filesSelected?.startsWith(relative + '/')) {
    filesSelected = null;
    filesPreviewToken += 1;
    hideFilesPreview();
  }
}

/**
 * DELETE as a separate request: `api()` expects a JSON success, but here what matters is
 * exactly the 409 "folder not empty" — by it the panel also asks for confirmation.
 */
async function deleteFilesEntryRequest(slug, relative, force) {
  const query = new URLSearchParams({ workspace: slug, path: relative });
  if (force) query.set('force', '1');
  const response = await fetch('/panel/api/workspace-files?' + query.toString(), { method: 'DELETE' });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
  return {
    ok: response.ok,
    status: response.status,
    message: (data.error || {}).message || response.statusText || 'не удалось удалить',
  };
}

/** Delete confirmation: a window, not a toast — the deleted can't be returned. */
function askDeleteEntry(entry, nonEmpty) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal';
    const title = entry.dir ? cfg.ui.filesDeleteFolder : cfg.ui.filesDeleteFile;
    const text = entry.dir
      ? nonEmpty
        ? esc(fill(cfg.ui.filesFolderNotEmpty, { name: entry.name }))
        : esc(fill(cfg.ui.filesFolderWillDelete, { name: entry.name }))
      : esc(fill(cfg.ui.filesFileWillDelete, { path: entry.path }));
    overlay.innerHTML =
      '<div class="ws-modal-card" role="dialog" aria-modal="true">' +
      '<h2>' + esc(title) + '</h2>' +
      '<p>' + text + '</p>' +
      '<div class="ws-modal-actions"><button class="ws-ghost" data-cancel>' + esc(cfg.ui.cancel) + '</button>' +
      '<button class="ws-danger" data-ok>' + esc(cfg.ui.deleteLabel) + '</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    function onKey(event) {
      if (event.key === 'Escape') close(false);
    }
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('[data-cancel]').onclick = () => close(false);
    overlay.querySelector('[data-ok]').onclick = () => close(true);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKey);
    const cancel = overlay.querySelector('[data-cancel]');
    if (cancel && typeof cancel.focus === 'function') cancel.focus();
  });
}

/**
 * Deletion: a file always asks for confirmation; for a folder we first try to remove it
 * without force — an empty one is deleted immediately, a non-empty one responds 409 and then the
 * person decides. The server also won't delete a non-empty folder without an explicit force.
 */
async function deleteFilesEntry(relative) {
  if (!filesOpen || !filesWorkspace || filesDeleting) return;
  const entry = entryAt(relative);
  if (!entry) {
    filesError = 'файл уже исчез — обновляю список';
    renderFiles();
    void refreshFilesTree();
    return;
  }
  if (entry.removable === false) {
    filesError = 'корневой AGENTS.md удалить нельзя: это инструкции агента в workspace';
    renderFiles();
    return;
  }

  filesDeleting = true;
  const slug = filesWorkspace;
  try {
    if (!entry.dir) {
      if (!(await askDeleteEntry(entry, false))) return;
      if (filesWorkspace !== slug) return;
      const result = await deleteFilesEntryRequest(slug, relative, false);
      if (!result.ok) throw new Error(result.message);
      if (filesWorkspace !== slug) return;
      forgetFilesPath(relative);
      filesError = '';
      renderFiles();
      void refreshFilesTree();
      return;
    }

    let result = await deleteFilesEntryRequest(slug, relative, false);
    if (filesWorkspace !== slug) return;
    if (result.status === 409) {
      if (!(await askDeleteEntry(entry, true))) return;
      if (filesWorkspace !== slug) return;
      result = await deleteFilesEntryRequest(slug, relative, true);
    }
    if (!result.ok) throw new Error(result.message);
    if (filesWorkspace !== slug) return;
    forgetFilesPath(relative);
    filesError = '';
    renderFiles();
    void refreshFilesTree();
  } catch (error) {
    filesError = 'не удалось удалить: ' + error.message;
    renderFiles();
  } finally {
    filesDeleting = false;
  }
}

/** Path from a markdown link/image inside the workspace; `null` — not our file. */
function workspaceRelative(raw) {
  let value = String(raw || '').trim().replace(/^\/+/, '');
  if (!value) return null;
  const own = 'workspaces/' + filesWorkspace + '/';
  if (value.startsWith(own)) return value.slice(own.length);
  // Other people's working folders and service ones — we don't show and don't open.
  if (/^(?:workspaces|\.icarus|incoming)\//.test(value)) return null;
  if (/^[a-z]+:\/\//i.test(value) || value.startsWith('data:')) return null;
  return value;
}

/** We count a relative path inside the workspace from the folder of the markdown file itself. */
function resolvePreviewPath(basePath, raw) {
  let href = String(raw || '').trim();
  if (!href || href.startsWith('#')) return null;
  // Other schemes and panel addresses — not workspace files: the link must remain a link.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith('/') && !href.startsWith('/workspaces/')) return null;
  href = href.split('#')[0].split('?')[0];
  if (!href) return null;
  try {
    href = decodeURIComponent(href);
  } catch {
    /* broken encoding — we leave as is */
  }
  const local = workspaceRelative(href);
  if (!local) return null;
  const cut = basePath.lastIndexOf('/');
  const parts = cut === -1 ? [] : basePath.slice(0, cut).split('/');
  for (const segment of local.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Image from markdown: the renderer already wrapped it in /chat/image — we extract the path. */
function markdownImagePath(src) {
  const value = String(src || '');
  if (!value.startsWith('/panel/api/chat/image?')) return value;
  try {
    return new URLSearchParams(value.slice(value.indexOf('?') + 1)).get('path') || '';
  } catch {
    return '';
  }
}

function bindPreviewFiles(filePath) {
  const preview = el('files-preview');
  preview.querySelectorAll('img[src]').forEach((img) => {
    const raw = markdownImagePath(img.getAttribute('src'));
    if (/^(?:https?:|data:)/i.test(raw)) return;
    const target = resolvePreviewPath(filePath, raw);
    if (target && filesWorkspace) img.src = filesUrl(filesWorkspace, 'raw', target);
  });
  preview.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (/^https?:/i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return;
    }
    const target = resolvePreviewPath(filePath, href);
    if (!target) return;
    link.onclick = (event) => {
      event.preventDefault();
      openFilesPreview(target);
    };
  });
}

/**
 * Inserting a path into the input field. Specifically insertion: already typed text remains,
 * the path goes to the caret, and if the person hasn't been in the field yet — at the end.
 */
function insertPathIntoChat(relative) {
  const input = el('chat-input');
  if (!input || !relative) return;
  if (!writable || input.disabled) {
    setNote('в этом разговоре писать нельзя — путь не вставлен');
    return;
  }
  const value = input.value;
  const at = Math.min(composerCaret ?? value.length, value.length);
  const before = value.slice(0, at);
  const after = value.slice(at);
  // Spaces on the edges — only if without them the path would stick to adjacent text.
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  input.value = before + lead + relative + tail + after;
  const caret = (before + lead + relative + tail).length;
  composerCaret = caret;
  input.focus();
  if (typeof input.setSelectionRange === 'function') {
    try {
      input.setSelectionRange(caret, caret);
    } catch {
      /* browser without support — the caret will simply stay where it was */
    }
  }
  growInput();
  setNote('');
}

/** We remember the caret while the person works with the input field. */
function rememberComposerCaret() {
  const input = el('chat-input');
  if (typeof input.selectionStart === 'number') composerCaret = input.selectionStart;
}

/**
 * Text to the clipboard. The Clipboard API lives only in a secure context, and
 * the panel is often opened over http on a local network — then we copy with a hidden textarea.
 */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* there's no execCommand in this browser — "didn't work" remains */
    }
    area.remove();
    return ok;
  }
}

/** The preview shows the first 256 KB — for copying we take the whole file. */
async function fetchPreviewFullText(source) {
  if (!source.slug || !source.path) return null;
  try {
    const response = await fetch(filesUrl(source.slug, 'raw', source.path));
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function copyPreviewContent(button) {
  const source = filesPreviewCopy;
  if (!source) return;
  let text = source.text;
  if (source.truncated) {
    const full = await fetchPreviewFullText(source);
    if (typeof full === 'string') text = full;
  }
  if (!(await writeClipboard(text))) {
    setNote('не удалось скопировать содержимое — выдели текст вручную');
    return;
  }
  setNote('');
  // Response to the click: the icon becomes a checkmark for a second, otherwise it's unclear if it worked.
  button.classList.add('copied');
  button.title = cfg.ui.filesCopied;
  button.setAttribute('aria-label', cfg.ui.filesCopied);
  button.innerHTML = COPIED_ICON;
  clearTimeout(filesCopyTimer);
  filesCopyTimer = setTimeout(() => {
    if (!button.isConnected) return;
    button.classList.remove('copied');
    button.title = COPY_TITLE;
    button.setAttribute('aria-label', COPY_TITLE);
    button.innerHTML = COPY_ICON;
  }, 1500);
}

function renderFilePreview(data) {
  const file = data.file || {};
  // Copying only makes sense for text: an image and a binary can't be put on the clipboard.
  const copyable = data.kind === 'markdown' || data.kind === 'text';
  const copy = copyable
    ? '<button type="button" class="files-copy" title="' + COPY_TITLE +
      '" aria-label="' + COPY_TITLE + '">' + COPY_ICON + '</button>'
    : '';
  const actions =
    '<button type="button" class="files-send" data-send="' + esc(file.path || '') +
    '" title="' + esc(cfg.ui.filesToChatTitle) + '" aria-label="' + esc(cfg.ui.filesToChatTitle) + '">' +
    SEND_TO_CHAT_ICON + '<span>' + esc(cfg.ui.filesToChat) + '</span></button>' +
    copy +
    '<a class="files-dl" href="' + esc(data.download || '#') + '" download title="' + esc(cfg.ui.filesDownload) + '">↓</a>';
  const head =
    '<div class="files-preview-head"><b>' + esc(file.path || '') + '</b>' + actions + '</div>';
  let body;
  if (data.kind === 'markdown') {
    body =
      (data.truncated ? '<p class="files-truncated">' + esc(cfg.ui.filesTruncated) + '</p>' : '') +
      '<div class="md files-md">' + markdown(data.text || '') + '</div>';
  } else if (data.kind === 'text') {
    // Highlighting knows only the languages the panel shows itself; for
    // the rest `highlightCode` returns null, and the text remains text.
    const highlighted = typeof highlightCode === 'function' ? highlightCode(data.text || '', file.type) : null;
    body =
      (data.truncated ? '<p class="files-truncated">' + esc(cfg.ui.filesTruncated) + '</p>' : '') +
      (highlighted === null
        ? '<pre class="files-code">' + esc(data.text || '') + '</pre>'
        : '<pre class="files-code hl">' + highlighted + '</pre>');
  } else if (data.kind === 'image') {
    // We stretch the vector to the full width: it doesn't blur. We show the raster at natural
    // size, but not wider than the panel — otherwise a small image would look like mush.
    const vector = file.type === 'SVG' ? ' vector' : '';
    body =
      '<div class="files-image' + vector + '"><a href="' + esc(data.url || '#') + '" target="_blank" rel="noopener">' +
      '<img src="' + esc(data.url || '') + '" alt="' + esc(file.name || '') + '"></a></div>';
  } else {
    body =
      '<div class="files-binary"><p>' + esc(cfg.ui.filesBinary) + '</p>' +
      '<a class="files-dl" href="' + esc(data.download || '#') + '" download>' + esc(cfg.ui.filesDownload) + '</a></div>';
  }
  showFilesPreview(head + body);
  filesPreviewCopy = copyable
    ? {
        slug: filesWorkspace,
        path: file.path || '',
        text: data.text || '',
        truncated: Boolean(data.truncated),
      }
    : null;
  if (data.kind === 'markdown') bindPreviewFiles(file.path || '');
}

/** Click on a file: the first opens the preview, a repeated one hides it. */
async function openFilesPreview(relative) {
  if (!filesOpen || !filesWorkspace) return;
  if (filesSelected === relative) {
    filesSelected = null;
    hideFilesPreview();
    renderFiles();
    return;
  }
  filesSelected = relative;
  renderFiles();
  showFilesPreview('<p class="files-note">' + esc(cfg.ui.filesReadingFile) + '</p>');
  const token = ++filesPreviewToken;
  const slug = filesWorkspace;
  try {
    const data = await fetchFilePreview(slug, relative);
    if (!filesOpen || token !== filesPreviewToken || filesWorkspace !== slug) return;
    renderFilePreview(data);
  } catch (error) {
    if (token !== filesPreviewToken) return;
    showFilesPreview(
      '<div class="files-binary"><p>' + esc('не удалось открыть файл: ' + error.message) + '</p></div>',
    );
  }
}

applyFilesWidth(storedFilesWidth());

el('toggle-files').onclick = toggleFilesPanel;
el('files-close').onclick = closeFilesPanel;
el('files-tree').addEventListener('click', (event) => {
  const remove = event.target.closest('.fdel');
  if (remove) {
    event.preventDefault();
    event.stopPropagation();
    void deleteFilesEntry(remove.dataset.del);
    return;
  }
  // A search result is the same goal "open file", but comes from a different markup.
  const result = event.target.closest('.srow');
  if (result) {
    event.preventDefault();
    void openFilesPreview(result.dataset.path);
    return;
  }
  // The whole row is the click target, not only the button with the name: in the mockup the row is wide,
  // and hitting it should be easy.
  const row = event.target.closest('.frow');
  if (!row) return;
  if (row.dataset.dir === '1') void toggleFolder(row.dataset.path);
  else void openFilesPreview(row.dataset.path);
});

// Search: while the person types, the list updates immediately (otherwise the field looks
// dead), and the request goes with a delay — there's no need to scan the folder on every letter.
const filesSearchInput = el('files-search');
filesSearchInput.addEventListener('input', () => {
  filesSearch = filesSearchInput.value;
  renderFiles();
  clearTimeout(filesSearchTimer);
  filesSearchTimer = setTimeout(() => void runFilesSearch(), 250);
});
filesSearchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  filesSearchInput.value = '';
  filesSearch = '';
  clearTimeout(filesSearchTimer);
  void runFilesSearch();
});

// "To chat" in the preview header: the path is inserted into the input field, not sent.
el('files-preview').addEventListener('click', (event) => {
  const copy = event.target.closest('.files-copy');
  if (copy) {
    event.preventDefault();
    void copyPreviewContent(copy);
    return;
  }
  const send = event.target.closest('.files-send');
  if (!send) return;
  event.preventDefault();
  const relative = send.dataset.send || '';
  if (relative) insertPathIntoChat(relative);
});

/* Panel width: we drag the left border, with the arrow keys — from the keyboard. */
const filesHandle = el('files-resizer');
let filesDrag = null;

filesHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || filesNarrow()) return;
  filesDrag = { x: event.clientX, width: el('files-panel').getBoundingClientRect().width };
  filesHandle.setPointerCapture(event.pointerId);
  el('chat-app').classList.add('files-resizing');
  event.preventDefault();
});

filesHandle.addEventListener('pointermove', (event) => {
  if (!filesDrag) return;
  applyFilesWidth(filesDrag.width - (event.clientX - filesDrag.x));
});

function endFilesDrag(event) {
  if (!filesDrag) return;
  filesDrag = null;
  el('chat-app').classList.remove('files-resizing');
  if (filesHandle.hasPointerCapture(event.pointerId)) filesHandle.releasePointerCapture(event.pointerId);
  saveFilesWidth(el('files-panel').getBoundingClientRect().width);
}

filesHandle.addEventListener('pointerup', endFilesDrag);
filesHandle.addEventListener('pointercancel', endFilesDrag);

filesHandle.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
  event.preventDefault();
  const current = el('files-panel').getBoundingClientRect().width || storedFilesWidth();
  const next = event.key === 'Home'
    ? FILES_WIDTH_DEFAULT
    : current + (event.key === 'ArrowLeft' ? 16 : -16);
  saveFilesWidth(applyFilesWidth(next));
});

/* Preview height: we drag the splitter between the tree and the file. */
const filesSplit = el('files-split');
let filesSplitDrag = null;

filesSplit.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  filesSplitDrag = {
    y: event.clientY,
    height: el('files-preview').getBoundingClientRect().height || filesPreviewHeight,
  };
  filesSplit.setPointerCapture(event.pointerId);
  el('chat-app').classList.add('files-split-drag');
  event.preventDefault();
});

filesSplit.addEventListener('pointermove', (event) => {
  if (!filesSplitDrag) return;
  setFilesPreviewHeight(filesSplitDrag.height - (event.clientY - filesSplitDrag.y));
});

function endSplitDrag(event) {
  if (!filesSplitDrag) return;
  filesSplitDrag = null;
  el('chat-app').classList.remove('files-split-drag');
  if (filesSplit.hasPointerCapture(event.pointerId)) filesSplit.releasePointerCapture(event.pointerId);
  saveFilesPreviewHeight(filesPreviewHeight);
}

filesSplit.addEventListener('pointerup', endSplitDrag);
filesSplit.addEventListener('pointercancel', endSplitDrag);

filesSplit.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home') return;
  event.preventDefault();
  const current = el('files-preview').getBoundingClientRect().height || filesPreviewHeight || 260;
  const next = event.key === 'Home'
    ? Math.round((el('files-panel').clientHeight || 720) * 0.45)
    : current + (event.key === 'ArrowUp' ? 24 : -24);
  saveFilesPreviewHeight(setFilesPreviewHeight(next));
});

/* The window was narrowed — we trim the saved sizes so the chat doesn't disappear. */
window.addEventListener('resize', () => {
  if (!filesDrag) applyFilesWidth(storedFilesWidth());
  if (!filesSplitDrag && filesPreviewHeight) setFilesPreviewHeight(filesPreviewHeight);
});

/* ── live response ─────────────────────────────────────────────────────────── */
function scrollToBottom(force = false) {
  const box = el('chat-scroll');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 180) {
    box.scrollTop = box.scrollHeight;
  }
}

/**
 * The person's message in the feed. Returns the node: sending removes it if the server
 * accepted the text into the queue (then the message appears by itself, already as a turn).
 * `before` — so that a message from the queue stands above the response box, not under it.
 */
function addUser(text, files = [], before = null) {
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
  el('chat-messages').insertBefore(node, before);
  scrollToBottom(true);
  return node;
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
 * Response box for an ongoing turn. A second entry into the same turn isn't a new response:
 * we take the already drawn box and build on it above the others.
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

/** The message didn't go (it wasn't accepted): we remove both the bubble, otherwise the feed keeps a question without an answer. */
function dropLastUser() {
  const nodes = el('chat-messages').querySelectorAll('.turn.user');
  const last = nodes[nodes.length - 1];
  if (last) last.remove();
}

/** The box is not a response, but a failed attempt (the turn is already taken by another): out of the feed. */
function dropLiveBody(chatId) {
  const box = liveBodies.get(chatId);
  if (!box) return;
  liveBodies.delete(chatId);
  box.turn.remove();
}

/**
 * The turn ended with a record in the chat, and the box already carries the ready response: we leave it
 * in the feed — that's the message the person reads. We remove it from the map:
 * returning here, the panel will read the record from history, not draw a second response.
 * Previously the box was thrown out of the DOM here in the expectation that "the chat record would replace
 * it", but no one redrew it: the response disappeared until the page reloaded.
 */
function settleLiveBody(chatId) {
  liveBodies.delete(chatId);
}

function renderLive(box) {
  const details = box.trace.querySelector('details.trace');
  if (details) box.traceOpen = details.open;
  // The expanded lists of child actions must also survive a redraw.
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
  // The message is part of the turn's log, not just our bubble: after F5 and after a turn
  // from the queue it arrives here. It stands above the response, otherwise it's unclear what it's for.
  if (event.type === 'user') {
    const text = String(event.text || '');
    if (optimisticUser && optimisticUser.chatId === box.chatId && optimisticUser.text === text) {
      optimisticUser = null;
      return;
    }
    addUser(text, [], box.turn);
    return;
  }
  if (event.type === 'text') {
    box.text += event.text || '';
    renderLive(box);
    return;
  }
  // Steps and their updates live in the response trace: the caption "TERMINAL: such-and-such
  // command" under the composer duplicated it word for word, only smaller.
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
      if (event.detail !== undefined) step.detail = event.detail;
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
    // The response is final and already shown by the live box: we leave the box itself
    // in the feed (that's the message), and remove it from the map — otherwise the next
    // return to this chat will draw it a second time.
    settleLiveBody(box.chatId);
    if (event.chat) {
      currentChat = event.chat;
      currentId = event.chat.id;
      setTitle(event.chat.title);
      setComposer(false);
      renderVia(event.chat);
      rememberChat(event.chat, box.text);
    } else {
      loadChats(true).catch(() => {});
    }
    setNote(stoppedByUser ? 'остановил — можно писать дальше' : chatHint(currentChat));
    // The agent could have written files to the working folder — we update the tree on the right ourselves.
    if (box.chatId === currentId) void refreshFilesTree();
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

/**
 * Sending a message. `options.now` — the second operation: interrupt the current turn and
 * send this immediately. Without it, a busy chat doesn't reject the message, but
 * puts it in the server queue (202) — the person sees it in the indicator, and the turn
 * starts by itself when it frees up.
 */
async function sendText(forced, options = {}) {
  const input = el('chat-input');
  const text = String(forced ?? input.value).trim();
  const files = pending.slice();
  if (!text && files.length === 0) return;
  // We parse the command before checking busyness: /stop and /stats are needed exactly
  // during a turn, while a regular message can't be sent to a busy chat.
  if (text.startsWith('/') && files.length === 0) {
    if (await runCommand(text)) return;
  }
  if (!writable) return;
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

  const turnChatId = currentId;
  const now = options.now === true;
  // "Now" first stops someone else's work. We don't discard the partial response:
  // it's already given and remains in the feed as is, marked "interrupted".
  if (now) interruptCurrentBox(turnChatId);

  // A live stream could remain from an ongoing turn: we don't reuse its box, otherwise
  // the new response would stick to the old one. We remember to whom to return the "live" state,
  // if the message goes to the queue and someone else's turn continues.
  const previous = { abort: liveAbort, box: liveBox, chatId: liveChatId };
  const abort = new AbortController();
  liveAbort = abort;
  liveBox = null;
  setLive(turnChatId);
  input.value = '';
  growInput();
  syncNowButton();
  clearPending(false);
  showEmpty(false);
  const userNode = addUser(text, files);
  // The server will send this same message with a turn event: we don't duplicate our bubble.
  optimisticUser = { chatId: turnChatId, text: text || files.map((item) => item.file.name).join(', ') };
  let box = null;
  let claimed = true;

  try {
    const response = await fetch('/panel/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: turnChatId, text, attachments, ...(now ? { mode: 'now' } : {}) }),
      signal: abort.signal,
    });
    if (response.status === 202) {
      // The server took the message to the queue. We remove the bubble: the turn will start by itself, and then
      // the server will announce the message with a `user` event — otherwise the text would be twice.
      const data = await response.json().catch(() => ({}));
      userNode.remove();
      optimisticUser = null;
      claimed = false;
      restoreLive(previous);
      setQueue(turnChatId, data.queue || []);
      setNote(
        now
          ? 'не удалось прервать — поставил в очередь: ' + (data.position || 1)
          : 'в очереди: ' + (data.position || 1) + ' — доедет после текущего хода',
      );
      return;
    }
    if (!response.ok) {
      const type = response.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
      // The turn is already running (someone else wrote there too): this isn't an error, but a reason
      // to attach to the live stream instead of falling with a 409.
      if (data.live) {
        userNode.remove();
        optimisticUser = null;
        if (!input.value) input.value = text;
        claimed = false;
        restoreLive(previous);
        await attachLive();
        return;
      }
      // The turn is running in another channel — there's nothing to look at here: a second response will start
      // only with the next message. We remove the bubble and the box, and return the text.
      if (data.busyIn) {
        dropLiveBody(turnChatId);
        dropLastUser();
        setLive(null);
        setNote(busyInNote(data.busyIn));
        if (currentId === turnChatId) {
          input.value = text;
          growInput();
          input.focus();
        }
        return;
      }
      throw new Error((data.error || {}).message || response.statusText || 'ответ не начался: ' + response.status);
    }

    box = assistantBoxFor(turnChatId);
    box.stopped = false;
    liveBox = box;
    await readStream(response, box);
  } catch (error) {
    // We left to another chat — the response will reach the server, the panel will catch up.
    if (box && !box.stopped) {
      box.turn.classList.add('error');
      box.text = [box.text, '\n\n[ошибка: ' + error.message + ']'].filter(Boolean).join('');
      box.md.innerHTML = markdown(box.text);
      setNote('');
    } else if (!box) {
      // The message didn't go at all — we return it to the input field so it doesn't have to be typed again.
      userNode.remove();
      optimisticUser = null;
      if (!input.value) input.value = text;
      setNote('не отправилось: ' + error.message);
    }
  } finally {
    if (claimed) {
      if (liveAbort === abort) liveAbort = null;
      if (liveBox === box) liveBox = null;
      markRead(turnChatId);
      // The turn could have started and immediately yielded the queue: `busy` from the bulletin arrives earlier
      // than our stream closes, so we also start the catch-up here.
      if (liveChatId === turnChatId) setLive(null);
      if (currentId === turnChatId && busyChats.has(turnChatId) && !streaming()) void attachLive();
      if (box) box.typing.hidden = true;
      if (currentId === turnChatId) input.focus();
    }
  }
}

/**
 * "Now": interrupt the current turn and immediately send what was written. The current box
 * remains in the feed with what Icarus managed to say — that's the partial response.
 */
function interruptCurrentBox(chatId) {
  const box = liveBodies.get(chatId) || (liveBox && liveBox.chatId === chatId ? liveBox : null);
  if (box) {
    box.stopped = true;
    box.typing.hidden = true;
    if (box.text || box.steps.length) {
      const mark = document.createElement('div');
      mark.className = 'interrupted';
      mark.textContent = '⏹ прервано — можно попросить продолжить';
      box.turn.querySelector('.assistant-body')?.append(mark);
    } else {
      box.turn.remove();
    }
  }
  settleLiveBody(chatId);
  if (liveAbort) {
    liveAbort.abort();
    liveAbort = null;
  }
  liveBox = null;
  if (liveChatId === chatId) setLive(null);
}

/** Return the "live stream" to whoever led it: our message went to the queue. */
function restoreLive(saved) {
  setLive(saved.chatId);
  liveAbort = saved.abort;
  liveBox = saved.box;
}

/* ── message queue ──────────────────────────────────────────────────────────
   The queue lives on the server (survives F5), the panel only draws its view: the counter
   above the composer and the list of what will arrive after the current turn. */

/** Chat queue: `items` — [{id, text}], an empty list removes the indicator. */
function setQueue(chatId, items) {
  if (!chatId) return;
  if (items && items.length) queues.set(chatId, items);
  else queues.delete(chatId);
  if (chatId === currentId) renderQueue();
}

function renderQueue() {
  const items = (currentId && queues.get(currentId)) || [];
  el('queue-count').textContent = fill(cfg.ui.queueCount, { n: items.length });
  el('chat-queue').hidden = items.length === 0;
  const list = el('queue-list');
  list.replaceChildren(
    ...items.map((item, index) => {
      const row = document.createElement('div');
      row.className = 'queue-row';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(index + 1);
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = item.text;
      text.title = item.text;
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.dataset.id = item.id;
      remove.title = cfg.ui.queueRemove;
      remove.setAttribute('aria-label', cfg.ui.queueRemove);
      remove.textContent = '×';
      row.append(num, text, remove);
      return row;
    }),
  );
}

/** Remove a message from the queue: the person changed their mind before it was sent. */
async function dropQueuedItem(id) {
  if (!currentId) return;
  try {
    const data = await api('/panel/api/chat/queue/drop', {
      method: 'POST',
      body: JSON.stringify({ chatId: currentId, id }),
    });
    setQueue(currentId, data.queue || []);
  } catch (error) {
    setNote('убрать из очереди не вышло: ' + error.message);
  }
}

/** The "interrupt and send" button is alive only when there's something to send. */
function syncNowButton() {
  const button = el('chat-now');
  if (!button) return;
  button.disabled = !writable || !String(el('chat-input').value || '').trim();
}

/**
 * The "now" button: one operation — interrupt someone else's work for your message.
 * An empty field isn't a send, but "just stop": it has its own button.
 */
async function sendNow() {
  if (!String(el('chat-input').value || '').trim()) {
    setNote(cfg.ui.nowTitle);
    return;
  }
  await sendText(undefined, { now: true });
}

/** NDJSON lines from the stream: common parsing for both sending and catching up a turn. */
async function readStream(response, box) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      // Unsubscribing breaks the read intentionally — this isn't a response error.
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
          /* one broken line must not break the whole response */
        }
      }
      cut = buffer.indexOf('\n');
    }
  }
}

/**
 * Re-read the chat feed. Needed where the response is already recorded but absent in the DOM:
 * the turn ended between loading the history and subscribing to the live stream.
 */
async function reloadHistory(chatId) {
  if (currentId !== chatId) return;
  const token = ++historyToken;
  try {
    const data = await api('/panel/api/chat/history?id=' + encodeURIComponent(chatId));
    if (token !== historyToken || currentId !== chatId) return;
    currentChat = data.chat;
    renderVia(currentChat);
    renderHistory(data.messages || []);
    setQueue(chatId, data.queue || []);
  } catch (error) {
    setNote('ответ пришёл, но лента не обновилась: ' + error.message);
  }
}

/**
 * Catch-up of an ongoing turn — after F5 or opening the panel on another device.
 * The server first gives the accumulated log, then live until `done`,
 * so the response is assembled from scratch exactly as it would be without a reload.
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
      // The turn managed to end while we were subscribing: an empty box is not a response, out
      // with it, and the ready response already lies in the chat record — we re-read the feed.
      dropLiveBody(chatId);
      await reloadHistory(chatId);
      return;
    }
    await readStream(response, box);
  } catch (error) {
    if (!box.stopped) setNote('догнать ответ не вышло: ' + error.message);
  } finally {
    // A new turn could have overtaken us ("interrupt and send"): then the "live"
    // state is already its own, and it can't be removed — otherwise the bulletin decides we're not
    // subscribed and attaches a second subscription to the same turn.
    if (liveAbort === abort) {
      liveAbort = null;
      if (liveChatId === chatId) setLive(null);
    }
    if (liveBox === box) liveBox = null;
    markRead(chatId);
    box.typing.hidden = true;
  }
}

/* ── bulletin across all chats ──────────────────────────────────────────────
   A separate channel on top of the chats: the panel learns that thinking started somewhere and
   finished somewhere, without subscribing to the full stream of each chat. There are few
   events (start and finish), so it doesn't flood with a stream. */
let bulletin = null;

function applyBulletin(event) {
  if (!event || !event.chatId) return;
  // The queue changed: it was taken to work, something was added to it or removed.
  if (event.type === 'queue') {
    setQueue(event.chatId, event.queue || []);
    return;
  }
  if (event.type === 'busy') {
    busyChats.add(event.chatId);
    renderChats();
    // A busy chat is open, and we aren't subscribed to it (the turn started in another
    // tab or we just opened it) — we attach.
    if (event.chatId === currentId && !streaming()) void attachLive();
    return;
  }
  // The chat name was refined: the model came up with it after the turn or the person
  // renamed it from the list. We move the header and the sidebar row, we don't touch the order.
  if (event.type === 'title') {
    if (event.chat && event.chat.id) applyChatTitle(event.chat.id, event.chat.title);
    return;
  }
  if (event.type !== 'idle') return;
  busyChats.delete(event.chatId);
  // The response is final: we don't throw out the box — it already carries the ready text.
  // `idle` arrives via the bulletin earlier than `done` (different connections), so exactly
  // here the response disappeared if the event arrived first.
  settleLiveBody(event.chatId);
  if (event.chat) rememberChat(event.chat);
  // The turn arrived while we were looking at another chat: we set a green dot.
  markUnread(event.chatId);
  renderChats();
  // The turn could have left files in the working folder — the tree on the right has something to show.
  void refreshFilesTree();
}

async function syncStatus() {
  try {
    const data = await api('/panel/api/chat/status');
    const incoming = new Set(data.busy || []);
    // The snapshot is the truth at the moment of opening: we clean out everything not in it (a turn could
    // have ended while we were disconnected and events during that time were lost).
    for (const id of [...busyChats]) if (!incoming.has(id)) busyChats.delete(id);
    for (const id of incoming) busyChats.add(id);
    renderChats();
    if (currentId && busyChats.has(currentId) && !streaming()) void attachLive();
  } catch {
    /* the snapshot is a convenience; the chat must open without it too */
  }
}

function startBulletin() {
  if (bulletin || !window.EventSource) return;
  bulletin = new EventSource('/panel/api/chat/events');
  // `EventSource` reconnects by itself, but loses events during the break —
  // therefore on every open (both the first and after a break) we check with the server.
  bulletin.onopen = () => void syncStatus();
  bulletin.onmessage = (message) => {
    try {
      applyBulletin(JSON.parse(message.data));
    } catch {
      /* one broken line must not drop the channel */
    }
  };
  bulletin.onerror = () => {
    // The connection state is kept by the browser itself; there's nothing to do here.
  };
}

/**
 * Unsubscribe without stopping the turn: the person left to another chat, but Icarus keeps
 * thinking. When he returns — `/chat/stream` will give the accumulated from scratch (see attachLive).
 */
function detachLive() {
  // We break the read intentionally: a break here isn't a response error, but the person leaving.
  if (liveBox) liveBox.stopped = true;
  if (liveAbort) {
    liveAbort.abort();
    liveAbort = null;
  }
  liveBox = null;
  if (liveChatId) setLive(null);
}

/**
 * While a response is running, next to "send" appear "stop" and "interrupt and send":
 * a turn can be stopped even in the middle — together with the subagents that are working.
 * "Send" itself doesn't hide: in a busy chat it puts the message in the queue.
 */
function setLive(chatId) {
  liveChatId = chatId || null;
  const on = Boolean(liveChatId);
  el('composer-box').classList.toggle('live', on);
  el('chat-stop').hidden = !on;
  el('chat-stop').disabled = false;
  el('chat-now').hidden = !on;
  el('chat-send').hidden = false;
  el('chat-send').disabled = !writable;
  el('chat-send').title = on ? 'Поставить в очередь (Enter)' : 'Отправить (Enter)';
  syncNowButton();
  if (!on) stoppedByUser = false;
  // The "in progress" dot in the sidebar is also our own turn.
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
    // "Stop" also clears the queue — we say so, rather than hiding the disappeared messages.
    if (stoppedByUser && result.dropped) {
      setQueue(currentId, []);
      setNote(`остановил, очередь снята: ${result.dropped} — можно писать дальше`);
    } else if (stoppedByUser) {
      setNote('остановил — можно писать дальше');
    }
  } catch (error) {
    setNote('остановить не вышло: ' + error.message);
  }
}

/* ── commands ─────────────────────────────────────────────────────────────────
   In Telegram the bot parses commands, but in the web chat they didn't exist at all: the line
   "/compact" went to pi as a regular message. Now the parsing is common and lives on the
   server (`/panel/api/chat/command`), and the palette shows what can be called:
   the chat's own commands — from the page config, pi's commands — from `get_commands`. */

/** Commands the chat parses itself. They come in the page, no request needed. */
const WEB_COMMANDS = Array.isArray(cfg.commands) ? cfg.commands : [];
/** pi commands by chat: we ask for the list once per chat. */
const piCommands = new Map();
const piRequested = new Set();
let commandBusy = false;
let paletteOpen = false;
let paletteRows = [];
let paletteIndex = 0;

/** Source label: by it it's visible that the command came from pi, not from the chat. */
function sourceLabel(source) {
  if (source === 'skill') return 'скилл';
  if (source === 'prompt') return 'шаблон';
  if (source === 'extension') return 'расширение';
  return '';
}

/** Everything callable with a slash: first our commands, then pi's. */
function paletteCandidates() {
  const list = WEB_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description || '',
    source: 'chat',
  }));
  const extra = currentId ? piCommands.get(currentId) || [] : [];
  for (const command of extra) {
    if (list.some((item) => item.name === command.name)) continue;
    list.push({
      name: command.name,
      description: command.description || '',
      source: command.source || 'pi',
    });
  }
  return list;
}

function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  paletteRows = [];
  paletteIndex = 0;
  const box = el('cmd-palette');
  box.hidden = true;
  box.innerHTML = '';
}

/**
 * The palette opens only on a single token: "/" or "/com". As soon as the person
 * typed a space, it's already a message with arguments — the list is no longer needed.
 */
function renderPalette() {
  const input = el('chat-input');
  const box = el('cmd-palette');
  const match = writable && input ? /^\/([^\s]*)$/.exec(input.value) : null;
  if (!match) {
    closePalette();
    return;
  }
  const prefix = match[1].toLowerCase();
  paletteRows = paletteCandidates().filter((command) => command.name.toLowerCase().startsWith(prefix));
  if (!paletteRows.length) {
    closePalette();
    return;
  }
  if (paletteIndex >= paletteRows.length) paletteIndex = 0;
  box.innerHTML = paletteRows
    .map((row, index) => {
      const label = sourceLabel(row.source);
      return (
        '<button type="button" class="cmd-row' +
        (index === paletteIndex ? ' active' : '') +
        '" data-index="' +
        index +
        '" role="option" aria-selected="' +
        (index === paletteIndex ? 'true' : 'false') +
        '">' +
        '<code>/' +
        esc(row.name) +
        '</code><span class="cmd-desc">' +
        esc(row.description) +
        '</span>' +
        (label ? '<em class="cmd-src">' + esc(label) + '</em>' : '') +
        '</button>'
      );
    })
    .join('');
  box.hidden = false;
  paletteOpen = true;
}

/** pi command list: lazily, on the first "/" in this chat. */
async function ensurePiCommands() {
  const id = currentId;
  if (!id || piCommands.has(id) || piRequested.has(id)) return;
  piRequested.add(id);
  try {
    const data = await api('/panel/api/chat/commands?id=' + encodeURIComponent(id));
    piCommands.set(id, Array.isArray(data.commands) ? data.commands : []);
  } catch {
    // The command list is a hint, not a chat condition: if it failed — we'll show ours.
    piCommands.set(id, []);
  }
  if (currentId === id) renderPalette();
}

/** Input in the field: we grow the height and, if this is the start of a command, update the palette. */
function onComposerInput() {
  growInput();
  syncNowButton();
  // A new character — a new filter: selection starts from the first row.
  paletteIndex = 0;
  renderPalette();
  if (paletteOpen) void ensurePiCommands();
}

function movePalette(delta) {
  if (!paletteRows.length) return;
  paletteIndex = (paletteIndex + delta + paletteRows.length) % paletteRows.length;
  renderPalette();
}

/** Selecting a row is insertion, not sending: the person will type the arguments themselves. */
function choosePalette() {
  const row = paletteRows[paletteIndex];
  if (!row) return false;
  const input = el('chat-input');
  input.value = '/' + row.name + ' ';
  composerCaret = input.value.length;
  closePalette();
  input.focus();
  growInput();
  return true;
}

/**
 * Palette keys. Returns true if the event has already been handled and there's no need
 * to send anything on Enter.
 */
function paletteKeydown(event) {
  if (!paletteOpen) return false;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    movePalette(1);
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    movePalette(-1);
    return true;
  }
  if (event.key === 'Enter') {
    // The command is already fully typed — Enter executes it. Appending a space
    // and requiring a second press is pointless; selection is needed only for an unfinished one.
    const row = paletteRows[paletteIndex];
    if (row && el('chat-input').value.trim().toLowerCase() === '/' + row.name.toLowerCase()) {
      closePalette();
      return false;
    }
    event.preventDefault();
    choosePalette();
    return true;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    choosePalette();
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closePalette();
    return true;
  }
  return false;
}

/** The command's response is a box in the feed. It doesn't get into history: it's not a pi response. */
function addCommandResult(command, text, failed = false) {
  showEmpty(false);
  const node = document.createElement('div');
  node.className = 'turn command' + (failed ? ' error' : '');
  const card = document.createElement('div');
  card.className = 'command-card';
  const head = document.createElement('div');
  head.className = 'command-head';
  head.textContent = command.trim().split(/\s+/)[0] || 'команда';
  const body = document.createElement('div');
  body.className = 'md command-text';
  body.innerHTML = markdown(text || '');
  card.append(head, body);
  node.append(card);
  el('chat-messages').append(node);
  scrollToBottom(true);
}

/** Live /clear: the same box that will come from history after a reload. */
function addClearDivider() {
  showEmpty(false);
  const node = document.createElement('div');
  node.className = 'turn divider';
  const rule = document.createElement('hr');
  const label = document.createElement('span');
  label.textContent = 'Контекст очищен';
  node.append(rule, label);
  el('chat-messages').append(node);
  scrollToBottom(true);
}

/** Command name as the server parses it: up to the space and without "/". */
function commandName(text) {
  const match = /^\/([a-zA-Z0-9_]+)/.exec(String(text || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Executes a line with a slash. false means "the server didn't take it for itself":
 * it's a pi command, and it must be sent to the chat as a regular message.
 */
async function runCommand(text) {
  if (!writable) return false;
  // We don't start a second command on top of the first and don't send it to pi as text:
  // it's still a command, just its time hasn't come.
  if (commandBusy) {
    setNote('предыдущая команда ещё выполняется');
    return true;
  }
  const name = commandName(text);
  if (!name) return false;
  // Help doesn't need a chat; the rest do — like a regular message.
  if (!currentId && name !== 'help') {
    try {
      await createChat();
    } catch (error) {
      setNote('не удалось создать чат: ' + error.message);
      return true;
    }
  }
  commandBusy = true;
  // Whose turn this is: while the command runs (/compact is a model call), the person may
  // leave to another chat, and the response must not fall into someone else's feed.
  const chatId = currentId;
  setNote('выполняю ' + text.trim().split(/\s+/)[0] + '…');
  try {
    const result = await api('/panel/api/chat/command', {
      method: 'POST',
      body: JSON.stringify({ chatId: chatId || undefined, text }),
    });
    if (!result || !result.handled) {
      setNote('');
      // We left to another chat while the server was thinking: sending the command is already to the wrong place.
      return currentId !== chatId;
    }
    if (currentId === chatId) {
      const input = el('chat-input');
      if (input.value.trim() === text.trim()) {
        input.value = '';
        growInput();
      }
      closePalette();
    }
    // /clear starts a new context, but doesn't throw away the old feed: we draw
    // a divider, exactly as it will come from history after a reload.
    if (result.cleared && currentId === chatId) {
      addClearDivider();
    } else if (currentId === chatId) {
      addCommandResult(text, result.text || '', Boolean(result.failed));
    }
    // /rename sends a new name: the header and sidebar update without a reload.
    if (result.title && currentId === chatId) applyChatTitle(chatId, String(result.title));
    setNote('');
    return true;
  } catch (error) {
    if (currentId === chatId) addCommandResult(text, 'не получилось: ' + error.message, true);
    setNote('');
    return true;
  } finally {
    commandBusy = false;
  }
}

/** Click on a palette row: focus stays in the field, selection — as with the keyboard. */
el('cmd-palette').addEventListener('mousedown', (event) => event.preventDefault());
el('cmd-palette').addEventListener('click', (event) => {
  const row = event.target.closest('.cmd-row');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) return;
  paletteIndex = index;
  choosePalette();
});

/* ── composer and menu ─────────────────────────────────────────────────────── */
function growInput() {
  const input = el('chat-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

/* The menu is pop-up and only on small screens: on a wide one the chat column
   is always in place, so there's nothing and no reason to collapse and expand it. */
function closeMenu() {
  el('chat-app').classList.remove('side-open');
}

/* "New chat" always opens exactly a new chat: the workspace is chosen already in it. */
el('new-chat').onclick = () => startDraft();
/* "+ Folder" opens input right in the list: a modal for one field is an extra layer. */
el('new-folder').onclick = () => {
  folderDraft = true;
  folderRenaming = null;
  renderChats();
  const input = el('folder-new-name');
  if (input) input.scrollIntoView({ block: 'nearest' });
};

/* ── dragging a chat into a folder ──────────────────────────────────────────────
   We listen on the container, not the rows: the list is redrawn as a whole, and handlers
   on rows would have to be attached anew after every redraw. */
el('chat-list').addEventListener('dragover', (event) => {
  const head = event.target.closest && event.target.closest('.folder-head');
  if (!head || !draggingChatId) return;
  // preventDefault is exactly "you can drop here": without it drop won't happen.
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  head.classList.add('drop-target');
});
el('chat-list').addEventListener('dragleave', (event) => {
  const head = event.target.closest && event.target.closest('.folder-head');
  if (head) head.classList.remove('drop-target');
});
el('chat-list').addEventListener('drop', (event) => {
  const head = event.target.closest && event.target.closest('.folder-head');
  if (!head) return;
  event.preventDefault();
  head.classList.remove('drop-target');
  const transferred = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
  const chatId = transferred || draggingChatId;
  if (!chatId) return;
  draggingChatId = null;
  moveChatToFolder(chatId, head.dataset.folder || null).catch((error) =>
    setNote('не удалось перенести чат: ' + error.message),
  );
});

/* The move menu closes on a click outside and on Escape: a hanging menu covers the chat. */
document.addEventListener('click', (event) => {
  if (!chatMenu) return;
  if (event.target.closest('.chat-menu') || event.target.closest('.chat-more')) return;
  closeChatMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeChatMenu();
});
el('draft-item').onclick = () => el('chat-input').focus();
el('toggle-side').onclick = () => {
  if (window.matchMedia('(max-width: 900px)').matches) el('chat-app').classList.toggle('side-open');
};
el('close-side').onclick = closeMenu;
/* Archive: the sidebar section collapses, we remember the state between visits. */
el('archive-toggle').onclick = () => {
  archiveOpen = !archiveOpen;
  saveArchiveOpen(archiveOpen);
  renderArchive();
};
el('toggle-archive').onclick = () => {
  toggleArchive().catch(() => {});
};
/* ── panel width ────────────────────────────────────────────────────────── */
/* On a wide screen the chat column can be dragged by the right border. The width
   lives in localStorage: otherwise it would have to be adjusted on every visit. */
const SIDE_WIDTH_KEY = 'icarus.side-width';
const SIDE_WIDTH_DEFAULT = 278;
const SIDE_WIDTH_MIN = 220;
const SIDE_WIDTH_MAX = 560;

const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

/** The ceiling depends on the window: the panel must not eat the whole chat. */
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
    /* private mode — the width simply won't be remembered */
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

/* Keyboard: ←/→ move the width, Home returns the original. */
sideHandle.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
  event.preventDefault();
  const current = el('chat-side').getBoundingClientRect().width;
  const next = event.key === 'Home'
    ? SIDE_WIDTH_DEFAULT
    : current + (event.key === 'ArrowRight' ? 16 : -16);
  saveSideWidth(applySideWidth(next));
});

/* The window was narrowed — we trim the saved width so the chat doesn't disappear. */
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
el('chat-input').addEventListener('input', onComposerInput);
// The caret is needed by the "To chat" button from the files panel: the path is inserted at its place.
for (const type of ['click', 'keyup', 'select', 'input']) {
  el('chat-input').addEventListener(type, rememberComposerCaret);
}
el('chat-input').addEventListener('keydown', (event) => {
  // While the palette is open, Enter selects a command rather than sending a message.
  if (paletteKeydown(event)) return;
  // Ctrl+Enter — the same second operation from the keyboard: interrupt and send.
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendNow().catch(() => {});
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendText().catch(() => {});
  }
});
el('chat-input').addEventListener('blur', () => {
  // Clicking a palette row doesn't remove focus (mousedown is cancelled), but leaving
  // the input field must remove the list.
  setTimeout(closePalette, 120);
});
el('chat-send').onclick = () => {
  sendText().catch(() => {});
};
el('chat-stop').onclick = () => {
  stopStream().catch(() => {});
};
el('chat-now').onclick = () => {
  sendNow().catch(() => {});
};
el('chat-queue').addEventListener('click', (event) => {
  const button = event.target.closest('.queue-row .remove');
  if (!button) return;
  event.preventDefault();
  dropQueuedItem(button.dataset.id).catch(() => {});
});
el('chat-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    loadChats(true).catch((error) => setNote('поиск не сработал: ' + error.message));
  }, 180);
});
el('chat-list').addEventListener('scroll', () => {
  closeChatMenu();
  if (!nextCursor || loadingChats) return;
  const box = el('chat-list');
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 120) {
    loadChats(false).catch((error) => setNote('не удалось догрузить диалоги: ' + error.message));
  }
});
/* Hints live both in the empty chat and in the draft, and are redrawn together with
   them: we listen on the container, otherwise restored markup loses handlers. */
el('chat-empty').addEventListener('click', (event) => {
  const button = event.target.closest('.suggestions button[data-prompt]');
  if (!button) return;
  event.preventDefault();
  if (draft) startPrompt(button.dataset.prompt);
  else sendText(button.dataset.prompt).catch(() => {});
});

/* The tab came to the front — what the person is looking at becomes read. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentId) markRead(currentId);
});
window.addEventListener('focus', () => {
  if (currentId) markRead(currentId);
});

(async () => {
  archiveOpen = storedArchiveOpen();
  loadUnread();
  await loadChats(true);
  // Folders — before the first show of the list there are none: they only group the already
  // loaded chats, so we load them after and redraw.
  await loadFolders();
  await loadArchived();
  await loadWorkspaces();
  defaultEmptyHtml = el('chat-empty').innerHTML;
  startBulletin();
  // We take the busy snapshot right away, without waiting for the bulletin to open: turns could
  // have started before the panel opened, and there's nowhere else to learn about them.
  await syncStatus();
  if (currentId) await selectChat(currentId);
  else startDraft();
  updateComposerHint();
  // The files panel isn't opened every time, but if it was left open —
  // we restore it together with the working tree of the current chat.
  if (storedFilesOpen()) openFilesPanel();
  if (writable) el('chat-input').focus();
})().catch((error) => {
  setNote('чат не открылся: ' + error.message);
});
