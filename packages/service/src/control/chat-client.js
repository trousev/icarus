// Клиент чата: без сборки и зависимостей. Сервер отдаёт каркас, список диалогов и
// историю — этот файл только рисует их и читает NDJSON-поток ответа.
//
// Разметка живёт в chat-markdown.js и подключается раньше: это обычные глобальные
// функции, а не импорт — сборки в панели нет. Подсветка кода — так же.
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
  // Старый вызов передаёт три строки, новый — формы из словаря.
  const words = typeof one === 'string' ? { one, few, many } : one;
  if (cfg.ui.lang !== 'ru') return n === 1 ? words.one : words.many;
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return words.many;
  if (ones === 1) return words.one;
  if (ones >= 2 && ones <= 4) return words.few;
  return words.many;
};

/** Подстановка в шаблон словаря: «{name}» → значение. Тот же приём, что в ui.ts. */
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
    .map((step) => {
      // Класс по инструменту: поиск и извлечение страницы красятся по-разному,
      // иначе в трассировке «ПОИСК» с URL выглядит как поиск по этому URL.
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

/** Граница «контекст очищен»: не реплика, а разделитель между сессиями pi. */
function clearDividerHtml() {
  return '<div class="turn divider"><hr><span>Контекст очищен</span></div>';
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
/** Очередь реплик по разговорам: правда живёт на сервере, тут только её вид. */
const queues = new Map();
/**
 * Свой пузырь, нарисованный заранее. Сервер объявляет реплику событием `user`
 * (по нему её видно после F5), но отправителю рисовать второй такой же незачем.
 */
let optimisticUser = null;
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
/**
 * Папки в меню слева. Свёрнутость и состав хранит сервер: меню должно выглядеть
 * одинаково с любого устройства, а не только в этом браузере (в отличие от unread).
 */
let folders = [];
/** Открыт ввод новой папки: строка рисуется прямо в списке, без модалки. */
let folderDraft = false;
/** id папки, которую переименовывают на месте. */
let folderRenaming = null;
/** Разговор, который сейчас тащат мышью: по нему подсвечиваем цель. */
let draggingChatId = null;
/** Открытое меню «Переместить в…»: одно на всю панель. */
let chatMenu = null;
let currentWorkspace = cfg.defaultWorkspace || 'talk';
/** Папка нового чата по умолчанию: клик по «Новый чат» не тащит папку прошлого разговора. */
const defaultWorkspace = currentWorkspace;
/** Пустое состояние до подмены экраном выбора workspace'а. */
let defaultEmptyHtml = '';
const CHAT_PAGE_SIZE = 30;
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const UNREAD_KEY = 'icarus.unread';
/** Развёрнут ли архив: свёрнутое состояние переживает перезагрузку. */
const ARCHIVE_OPEN_KEY = 'icarus.archive-open';
/** Архив — отдельный список того же чата: разговор ушёл с глаз, но не удалён. */
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
    /* приватный режим — состояние просто не запомнится */
  }
}

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

/**
 * Откуда пришла последняя реплика. Файл сессии каналы не различает, поэтому
 * канал запоминает сервис: шапка показывает отметку последнего хода, а не
 * «здесь начали разговор» (это видно по метке канала в списке).
 */
function viaLabel(turn) {
  if (!turn) return '';
  const name = turn.channel === 'telegram' ? 'Telegram' : turn.channel === 'api' ? 'API' : cfg.ui.viaPanel;
  const time = turn.at ? timeLabel(turn.at) : '';
  return fill(cfg.ui.viaLast, { name }) + (time ? ' · ' + time : '');
}

/** Шапка разговора: канал последней реплики. null — черновик или нет данных. */
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
 * Что сказать про канал открытого разговора. Из Telegram-разговора ответ в
 * Telegram не уедет — бот живёт своей стороной, — и молчать об этом нельзя:
 * человек ждал бы ответ там.
 */
function chatHint(chat) {
  if (chat && chat.channel === 'telegram') {
    return cfg.ui.telegramHint;
  }
  return '';
}

/** Ход идёт в другом канале: второй начинать нельзя, а смотреть здесь нечего. */
function busyInNote(channel) {
  const where =
    channel === 'telegram' ? cfg.ui.busyInTelegram : channel === 'api' ? cfg.ui.busyInApi : cfg.ui.busyInPanel;
  return fill(cfg.ui.busyInNote, { where });
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

/** /rename: новое имя сразу в шапке и в сайдбаре, без перезагрузки ленты. */
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

/** «Входящие» — не папка в реестре, а всё, что осталось без полки. */
const INBOX_FOLDER = { id: '', name: cfg.ui.folderInbox, collapsed: false };

/** Одна строка списка: сам разговор, а кнопки «✎» и «⋯» — рядом, не внутри кнопки. */
function chatRowHtml(chat) {
  // Имя правится прямо в строке списка: двойной клик по названию или карандаш
  // при наведении. Пока правим — вместо строки стоит поле ввода.
  if (chat.id === renamingId) {
    return (
      '<div class="chat-row" data-id="' + esc(chat.id) + '">' +
      '<div class="chat-item editing"><div class="chat-item-top">' +
      '<input class="chat-item-input" maxlength="128" value="' + esc(chat.title) +
      '" aria-label="' + esc(cfg.ui.chatRenamePlaceholder) + '" /></div></div></div>'
    );
  }
  // Точка одна и она старше видит занятость: жёлтая — ход идёт, зелёная — есть
  // непрочитанный ответ. Разметка точки появляется, только когда она нужна, —
  // иначе `gap` у flex-строки съедал бы место под пустую колонку.
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
    // Переименование — здесь же: имя человек видит в списке и хочет поправить тут.
    '<button class="chat-rename" type="button" data-id="' + esc(chat.id) +
    '" title="' + esc(cfg.ui.chatRename) + '" aria-label="' + esc(cfg.ui.chatRename) + '">✎</button>' +
    // Перенос доступен и мышью, и с клавиатуры: кнопка открывает меню с папками.
    '<button class="chat-more" type="button" data-id="' + esc(chat.id) +
    '" title="' + esc(cfg.ui.chatMove) + '" aria-label="' + esc(cfg.ui.chatMove) + '">⋯</button>' +
    '</div>'
  );
}

/** Разговоры с прежними заголовками дат: внутри папки они тоже помогают глазам. */
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

/** Заголовок папки: клик сворачивает, «✎» и «×» правят саму папку. */
function folderHeadHtml(folder, count) {
  const collapsed = Boolean(folder.collapsed);
  const renaming = folderRenaming === folder.id && folder.id !== '';
  // «Входящие» — не папка реестра: у них нет ни свёрнутости, ни действий, поэтому
  // и роль кнопки им не нужна — иначе клавиатура упирается в пустую кнопку.
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

/** Имя разговора, которое сейчас правится в списке; `null` — не правим. */
let renamingId = null;

/** Поля, у которых Enter уже сохранил имя: следом приходит blur, второй раз не пишем. */
const renameCommitted = new WeakSet();

function renderChats() {
  const box = el('chat-list');
  const top = box.scrollTop;
  const query = el('chat-search').value.trim();
  if (!chats.length && !folders.length && !folderDraft) {
    // В черновике подсказка «начни новый чат» лишняя: он уже начат.
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
    // Папок ещё нет — список живёт как раньше. Заводить «Входящие» на весь
    // список незачем: заголовок появится, когда появится первая папка.
    html += chatItemsHtml(chats, true) || (query ? '<p class="side-empty">' + esc(cfg.ui.chatListEmptySearch) + '</p>' : '');
  } else {
    for (const folder of folders) {
      const items = chats.filter((chat) => chat.folder === folder.id);
      html += folderHeadHtml(folder, items.length);
      // Во время поиска свёрнутость не прячет найденное: иначе человек решит,
      // что совпадений нет, хотя они лежат в закрытой папке.
      if (folder.collapsed && !query) continue;
      // Подсказка про перетаскивание — не результат поиска, её тут не место.
      html += items.length
        ? chatItemsHtml(items, true)
        : query
          ? ''
          : '<p class="side-empty folder-empty">' + esc(cfg.ui.folderDrop) + '</p>';
    }
    // Разговоры без папки и те, чья папка уже удалена с другого устройства.
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

/** Обработчики строк и заголовков: их пересоздаёт каждая перерисовка списка. */
function bindChatList(box) {
  box.querySelectorAll('.chat-row').forEach((row) => {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      draggingChatId = row.dataset.id;
      row.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      // Свой id кладём и текстом: dataTransfer — единственный переносимый между
      // dragover и drop кусок состояния, глобальная переменная тут ненадёжна.
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
    // Уход из поля — это отмена: случайный клик по ленте не должен переименовать.
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
    // Ушли мышкой в другое место — это тоже «готово»: поле не должно висеть.
    // Но если строку перерисовало событие сводки, это не «человек закончил»:
    // сохранять обрывок имени из исчезнувшего поля нельзя.
    input.onblur = () => {
      if (input.isConnected === false) return;
      void commitRename(input);
    };
  }
}

/* ── папки ─────────────────────────────────────────────────────────────────── */

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

/** Меняем папку оптимистично и откатываем, если сервер не принял. */
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

/** Свернуть/развернуть. У «Входящих» состояния нет — им сворачивать нечего. */
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

/** Удаление папки разговоры не трогает: сервер возвращает их во «Входящие». */
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
  // Перенос в свёрнутую папку выглядел бы как «чат пропал» — раскрываем её.
  const target = folders.find((item) => item.id === folderId);
  if (target && target.collapsed) await persistFolder(folderId, { collapsed: false });
  else renderChats();
}

function closeChatMenu() {
  if (!chatMenu) return;
  chatMenu.remove();
  chatMenu = null;
}

/** Меню «переместить в…»: то же действие, что перетаскивание, но без мыши. */
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

  // Ставим рядом с кнопкой, но не даём вылезти за окно.
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
 * Строка архива: тот же разговор, но без времени и с кнопкой возврата справа —
 * её видно сразу, потому что в архив заходят редко и ищут именно её.
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
 * Архив в сайдбаре: свёрнутая секция под списком. Счётчик виден и в свёрнутом
 * виде — иначе человек не узнает, что там что-то есть, не открыв её.
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

/** Кнопка в шапке говорит, что произойдёт: «В архив» или «Вернуть». */
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
 * Двигает разговор между списком и архивом. Списки перечитываем с сервера:
 * порядок, превью и total — его дело, а не наша догадка.
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
 * Сохранение имени из списка: сервер пишет его в chats.json, как и `/rename`.
 * Enter и потеря фокуса приходят оба — второй раз запрос не шлём.
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
  // Архивный разговор ответом не возвращается в общий список: иначе архив
  // переставал бы значить «не вижу каждый день».
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
    .map((message) => {
      if (message.divider === 'clear') return clearDividerHtml();
      return message.role === 'user' ? userHtml(message) : assistantHtml(message);
    })
    .join('');
  scrollToBottom(true);
}

async function selectChat(id) {
  // Переключение разговоров больше не заперто: уходим, отписавшись от потока
  // (ход доживёт на сервере), и цепляемся к новому, если там что-то идёт.
  if (!id) return;
  if (liveChatId) detachLive();
  markRead(id);
  endDraft();
  // Из черновика могли остаться экран выбора workspace'а — открытому чату он чужой.
  restoreEmptyState();
  const token = ++historyToken;
  currentId = id;
  // Индикатор очереди — про открытый разговор: у чужого он был бы враньём.
  renderQueue();
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
    // Архивный разговор открывается из своей секции и в общий список не попадает.
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
    // Очередь переживает F5: сервер отдаёт её вместе с историей.
    setQueue(id, data.queue || []);
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

// Готовые запросы берём из словаря: подпись в панели, а не текст памяти.
const wsPrompts = () => cfg.ui.wsPrompts;

/** Подпись над готовыми запросами: они уйдут в выбранную папку, а не всегда в «Разговор». */
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
    setNote(cfg.ui.wsNameRequired);
    return;
  }
  const data = await api('/panel/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  await loadWorkspaces();
  await openWorkspace(data.workspace.slug);
}

/** Выбор папки: в черновике просто переключаем её, не покидая новый чат. */
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
  if (input) input.placeholder = fill(cfg.ui.wsInputPlaceholder, { name: wsLabel(currentWorkspace) });
  // Разговор мог переехать в другую рабочую папку — дерево файлов меняется следом.
  syncFilesWorkspace();
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

/* ── файлы workspace ────────────────────────────────────────────────────────
   Правая панель: дерево рабочей папки открытого разговора и предпросмотр файла.
   Дерево грузится лениво, по папкам; открытые папки и выбранный файл живут в
   памяти, а ширина панели и её открытость — в localStorage. */
const FILES_OPEN_KEY = 'icarus.files-open';
const FILES_WIDTH_KEY = 'icarus.files-w';
const FILES_PREVIEW_KEY = 'icarus.files-preview-h';
const FILES_WIDTH_DEFAULT = 400;
const FILES_WIDTH_MIN = 300;
/** Потолок вдвое выше прежнего: панель можно растянуть на полэкрана. */
const FILES_WIDTH_MAX = 1440;
const FILES_PREVIEW_MIN = 90;

let filesOpen = false;
/** Slug workspace'а, чьё дерево сейчас нарисовано. */
let filesWorkspace = null;
/** Путь для подписи над деревом: `~/icarus/…/workspaces/talk`. */
let filesRootPath = '';
/** path → { entries, truncated }; грузим только раскрытые папки. */
let filesCache = new Map();
const filesExpanded = new Set();
let filesSelected = null;
let filesError = '';
let filesRootToken = 0;
let filesPreviewToken = 0;
let filesPreviewHeight = 0;
/** Текст для кнопки «копировать»: у картинок и бинаря его нет — кнопки тоже. */
let filesPreviewCopy = null;
let filesCopyTimer = 0;
/** Идёт удаление: второй клик по корзине не должен отправить второй запрос. */
let filesDeleting = false;
/** Поиск по файлам: запрос, находки и защита от гонок при быстром вводе. */
let filesSearch = '';
let filesSearchHits = [];
let filesSearchScanned = 0;
let filesSearchTruncated = false;
let filesSearchError = '';
let filesSearchBusy = false;
let filesSearchTimer = 0;
let filesSearchToken = 0;
/** Меньше двух символов искать бессмысленно: совпадений сотни, а скан на каждый ввод. */
const FILES_SEARCH_MIN = 2;
/**
 * Последняя позиция каретки в поле ввода. Путь из предпросмотра вставляем туда,
 * а если человек в поле ещё не вставал — в конец: уже набранное не переписываем.
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
    /* приватный режим — состояние просто не запомнится */
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
    /* приватный режим */
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
    /* приватный режим */
  }
}

/** Потолок ширины зависит от окна: панель не должна съесть ленту целиком. */
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
  // Старое содержимое больше не на экране: копировать его уже нечего.
  filesPreviewCopy = null;
  el('files-panel').classList.add('has-preview');
  // Первый файл забирает примерно половину панели; дальше помним, что человек выбрал.
  if (!filesPreviewHeight) {
    setFilesPreviewHeight(
      storedFilesPreviewHeight() || Math.round((el('files-panel').clientHeight || 720) * 0.45),
    );
  } else {
    setFilesPreviewHeight(filesPreviewHeight);
  }
}

/** Строки дерева: рекурсивно по раскрытым папкам, глубина — отступом. */
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

/** Искомый текст длиннее двух символов: только тогда запускаем запрос. */
function filesSearchActive() {
  return filesSearch.trim().length >= FILES_SEARCH_MIN;
}

/** Находка с подсветкой совпадения: esc по кускам, иначе `<mark>` стал бы текстом. */
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

/** Результаты поиска занимают место дерева: два списка в одной колонке не нужны. */
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
    // Один символ дал бы сотни совпадений и скан папки на каждую букву.
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

/** Корень workspace'а заново: панель открыли или разговор переехал в другую папку. */
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
  // Поиск относится к прошлому workspace'у: его находки здесь были бы ложью.
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
 * Поиск по workspace. Ответы могут прийти не в том порядке, в каком их
 * отправили, поэтому у каждого запроса свой token: устаревший ответ не должен
 * затереть находки для уже стёртого запроса.
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
 * Ход закончился — агент мог написать файлы. Дерево перечитываем, сохраняя
 * раскрытые папки и выбранный файл: панель не должна схлопываться посреди работы.
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
  // Агент мог написать файл, который сейчас ищут: результаты пересчитываем.
  if (filesSearchActive()) void runFilesSearch();
  else renderFiles();
}

/** Запись из уже загруженного дерева: по ней понятно, файл это или папка. */
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

/** Разговор переехал в другую папку: дерево меняется следом. */
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

/** Убирает удалённую запись из локального дерева, не дожидаясь перечитывания. */
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
 * DELETE отдельным запросом: `api()` рассчитан на JSON-успех, а тут важен
 * именно 409 «папка не пуста» — по нему панель и спрашивает подтверждение.
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

/** Подтверждение удаления: окно, а не тост — удалённое не вернуть. */
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
 * Удаление: файл всегда спрашивает подтверждение; папку сначала пробуем убрать
 * без force — пустая удаляется сразу, а непустая отвечает 409 и тогда решает
 * человек. Сервер тоже не удалит непустую папку без явного force.
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

/** Путь из ссылки/картинки markdown внутрь workspace; `null` — не наш файл. */
function workspaceRelative(raw) {
  let value = String(raw || '').trim().replace(/^\/+/, '');
  if (!value) return null;
  const own = 'workspaces/' + filesWorkspace + '/';
  if (value.startsWith(own)) return value.slice(own.length);
  // Чужие рабочие папки и служебное — не показываем и не открываем.
  if (/^(?:workspaces|\.icarus|incoming)\//.test(value)) return null;
  if (/^[a-z]+:\/\//i.test(value) || value.startsWith('data:')) return null;
  return value;
}

/** Относительный путь внутри workspace считаем от папки самого markdown-файла. */
function resolvePreviewPath(basePath, raw) {
  let href = String(raw || '').trim();
  if (!href || href.startsWith('#')) return null;
  // Чужие схемы и адреса панели — не файлы workspace: ссылка должна остаться ссылкой.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith('/') && !href.startsWith('/workspaces/')) return null;
  href = href.split('#')[0].split('?')[0];
  if (!href) return null;
  try {
    href = decodeURIComponent(href);
  } catch {
    /* битое кодирование — оставляем как есть */
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

/** Картинка из markdown: renderer уже завернул её в /chat/image — достаём путь. */
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
 * Вставка пути в поле ввода. Именно вставка: уже набранный текст остаётся,
 * путь встаёт в каретку, а если человек в поле ещё не вставал — в конец.
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
  // Пробелы по краям — только если без них путь слипнется с соседним текстом.
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
      /* браузер без поддержки — каретка просто останется где была */
    }
  }
  growInput();
  setNote('');
}

/** Запоминаем каретку, пока человек работает с полем ввода. */
function rememberComposerCaret() {
  const input = el('chat-input');
  if (typeof input.selectionStart === 'number') composerCaret = input.selectionStart;
}

/**
 * Текст в буфер обмена. Clipboard API живёт только в защищённом контексте, а
 * панель часто открыта по http в локальной сети — тогда копируем скрытой textarea.
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
      /* execCommand в этом браузере нет — остаётся «не вышло» */
    }
    area.remove();
    return ok;
  }
}

/** Предпросмотр показывает первые 256 КБ — для копирования берём файл целиком. */
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
  // Ответ на клик: иконка на секунду становится галочкой, иначе непонятно, сработало ли.
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
  // Копировать имеет смысл только текст: картинку и бинарь в буфер не положить.
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
    // Подсветка знает только те языки, которые панель показывает сама; для
    // остальных `highlightCode` вернёт null, и текст останется текстом.
    const highlighted = typeof highlightCode === 'function' ? highlightCode(data.text || '', file.type) : null;
    body =
      (data.truncated ? '<p class="files-truncated">' + esc(cfg.ui.filesTruncated) + '</p>' : '') +
      (highlighted === null
        ? '<pre class="files-code">' + esc(data.text || '') + '</pre>'
        : '<pre class="files-code hl">' + highlighted + '</pre>');
  } else if (data.kind === 'image') {
    // Вектор тянем на всю ширину: он не мылится. Растр показываем в натуральную
    // величину, но не шире панели — иначе маленькая картинка выглядела бы кашей.
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

/** Клик по файлу: первый открывает предпросмотр, повторный его прячет. */
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
  // Результат поиска — та же цель «открыть файл», но приходит из другой разметки.
  const result = event.target.closest('.srow');
  if (result) {
    event.preventDefault();
    void openFilesPreview(result.dataset.path);
    return;
  }
  // Вся строка — цель клика, не только кнопка с именем: в макете строка широкая,
  // и попадать в неё должно быть просто.
  const row = event.target.closest('.frow');
  if (!row) return;
  if (row.dataset.dir === '1') void toggleFolder(row.dataset.path);
  else void openFilesPreview(row.dataset.path);
});

// Поиск: пока человек печатает, список обновляется сразу (иначе поле выглядит
// мёртвым), а запрос уходит с задержкой — на каждую букву сканировать папку незачем.
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

// «В чат» в шапке предпросмотра: путь вставляется в поле ввода, а не отправляется.
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

/* Ширина панели: тянем за левую границу, стрелками — с клавиатуры. */
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

/* Высота предпросмотра: тянем за разделитель между деревом и файлом. */
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

/* Окно сузили — подрезаем сохранённые размеры, чтобы чат не пропал. */
window.addEventListener('resize', () => {
  if (!filesDrag) applyFilesWidth(storedFilesWidth());
  if (!filesSplitDrag && filesPreviewHeight) setFilesPreviewHeight(filesPreviewHeight);
});

/* ── живой ответ ──────────────────────────────────────────────────────────── */
function scrollToBottom(force = false) {
  const box = el('chat-scroll');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 180) {
    box.scrollTop = box.scrollHeight;
  }
}

/**
 * Реплика человека в ленте. Возвращает узел: отправка убирает его, если сервер
 * принял текст в очередь (тогда реплика появится сама, уже как ход).
 * `before` — чтобы реплика из очереди встала выше плашки ответа, а не под ней.
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

/** Реплика не ушла (её не приняли): убираем и пузырь, иначе в ленте останется вопрос без ответа. */
function dropLastUser() {
  const nodes = el('chat-messages').querySelectorAll('.turn.user');
  const last = nodes[nodes.length - 1];
  if (last) last.remove();
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
  // Реплика — часть журнала хода, а не только наш пузырь: после F5 и после хода
  // из очереди она приезжает сюда. Встаёт выше ответа, иначе непонятно, на что он.
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
    // Ответ окончательный и уже показан живой плашкой: саму плашку оставляем в
    // ленте (это и есть сообщение), а из карты убираем — иначе следующее
    // возвращение в этот разговор нарисует его второй раз.
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
    // Агент мог написать файлы в рабочую папку — дерево справа обновляем сами.
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
 * Отправка реплики. `options.now` — вторая операция: прервать текущий ход и
 * отправить это немедленно. Без неё занятый разговор не отбивает реплику, а
 * ставит её в серверную очередь (202) — человек видит её в индикаторе, а ход
 * начнётся сам, когда освободится.
 */
async function sendText(forced, options = {}) {
  const input = el('chat-input');
  const text = String(forced ?? input.value).trim();
  const files = pending.slice();
  if (!text && files.length === 0) return;
  // Команду разбираем до проверки занятости: /stop и /stats нужны именно
  // во время хода, а обычную реплику в занятый разговор отправлять нельзя.
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
  // «Сейчас» сначала останавливает чужую работу. Частичный ответ не выбрасываем:
  // он уже отдан и остаётся в ленте как есть, с пометкой «прервано».
  if (now) interruptCurrentBox(turnChatId);

  // Живой поток мог остаться от идущего хода: его плашку не переиспользуем, иначе
  // новый ответ приклеится к старому. Запоминаем, кому вернуть «живое» состояние,
  // если реплика уедет в очередь, а чужой ход продолжится.
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
  // Сервер пришлёт эту же реплику событием хода: свой пузырь у себя не дублируем.
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
      // Сервер взял реплику в очередь. Пузырь убираем: ход начнётся сам, и тогда
      // сервер объявит реплику событием `user` — иначе текст был бы дважды.
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
      // Ход уже идёт (кто-то другой написал туда же): это не ошибка, а повод
      // прицепиться к живому потоку вместо того, чтобы падать с 409-кой.
      if (data.live) {
        userNode.remove();
        optimisticUser = null;
        if (!input.value) input.value = text;
        claimed = false;
        restoreLive(previous);
        await attachLive();
        return;
      }
      // Ход идёт в другом канале — смотреть здесь нечего: второй ответ начнётся
      // только со следующей реплики. Пузырь и плашку убираем, текст возвращаем.
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
    // Ушли в другой разговор — ответ доедет на сервере, панель его догонит.
    if (box && !box.stopped) {
      box.turn.classList.add('error');
      box.text = [box.text, '\n\n[ошибка: ' + error.message + ']'].filter(Boolean).join('');
      box.md.innerHTML = markdown(box.text);
      setNote('');
    } else if (!box) {
      // Реплика не ушла вовсе — возвращаем её в поле ввода, чтобы не набирать заново.
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
      // Ход мог встать и сразу уступить очередь: `busy` по сводке приходит раньше,
      // чем закрывается наш поток, поэтому догон запускаем и здесь.
      if (liveChatId === turnChatId) setLive(null);
      if (currentId === turnChatId && busyChats.has(turnChatId) && !streaming()) void attachLive();
      if (box) box.typing.hidden = true;
      if (currentId === turnChatId) input.focus();
    }
  }
}

/**
 * «Сейчас»: прерываем текущий ход и сразу отправляем написанное. Текущая плашка
 * остаётся в ленте с тем, что Икар успел сказать, — это и есть частичный ответ.
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

/** Вернуть «живой поток» тому, кто его вёл: наша реплика уехала в очередь. */
function restoreLive(saved) {
  setLive(saved.chatId);
  liveAbort = saved.abort;
  liveBox = saved.box;
}

/* ── очередь реплик ──────────────────────────────────────────────────────────
   Очередь живёт на сервере (переживает F5), панель только рисует её вид: счётчик
   над композером и список того, что доедет после текущего хода. */

/** Очередь разговора: `items` — [{id, text}], пустой список убирает индикатор. */
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

/** Убрать реплику из очереди: человек передумал до того, как её отправили. */
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

/** Кнопка «прервать и отправить» живая только когда есть что отправлять. */
function syncNowButton() {
  const button = el('chat-now');
  if (!button) return;
  button.disabled = !writable || !String(el('chat-input').value || '').trim();
}

/**
 * Кнопка «сейчас»: одна операция — прервать чужую работу под свою реплику.
 * Пустое поле — это не отправка, а «просто стоп»: у него своя кнопка.
 */
async function sendNow() {
  if (!String(el('chat-input').value || '').trim()) {
    setNote(cfg.ui.nowTitle);
    return;
  }
  await sendText(undefined, { now: true });
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
    renderVia(currentChat);
    renderHistory(data.messages || []);
    setQueue(chatId, data.queue || []);
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
    // Нас мог обогнать новый ход («прервать и отправить»): тогда «живое»
    // состояние уже его, и снимать его нельзя — иначе сводка решит, что мы не
    // подписаны, и прицепит к тому же ходу вторую подписку.
    if (liveAbort === abort) {
      liveAbort = null;
      if (liveChatId === chatId) setLive(null);
    }
    if (liveBox === box) liveBox = null;
    markRead(chatId);
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
  // Очередь изменилась: её взяли в работу, в неё что-то добавили или сняли.
  if (event.type === 'queue') {
    setQueue(event.chatId, event.queue || []);
    return;
  }
  if (event.type === 'busy') {
    busyChats.add(event.chatId);
    renderChats();
    // Открыт занятый разговор, а мы к нему не подписаны (ход начался в другой
    // вкладке или мы только что его открыли) — цепляемся.
    if (event.chatId === currentId && !streaming()) void attachLive();
    return;
  }
  // Имя разговора уточнилось: модель придумала его после хода или человек
  // переименовал из списка. Двигаем шапку и строку сайдбара, порядок не трогаем.
  if (event.type === 'title') {
    if (event.chat && event.chat.id) applyChatTitle(event.chat.id, event.chat.title);
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
  // Ход мог оставить файлы в рабочей папке — дереву справа есть что показать.
  void refreshFilesTree();
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
 * Пока идёт ответ, рядом с «отправить» появляются «стоп» и «прервать и отправить»:
 * остановить ход можно и в середине — вместе с субагентами, которые работают.
 * Сам «отправить» не прячется: при занятом разговоре он кладёт реплику в очередь.
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
    // «Стоп» снимает и очередь — говорим об этом, а не прячем пропавшие реплики.
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

/* ── команды ─────────────────────────────────────────────────────────────────
   В Telegram команды разбирает бот, а в веб-чате их не было вовсе: строка
   «/compact» уезжала в pi обычной репликой. Теперь разбор общий и живёт на
   сервере (`/panel/api/chat/command`), а палитра показывает, что можно позвать:
   команды самого чата — из конфига страницы, команды pi — из `get_commands`. */

/** Команды, которые чат разбирает сам. Приезжают в странице, запрос не нужен. */
const WEB_COMMANDS = Array.isArray(cfg.commands) ? cfg.commands : [];
/** Команды pi по разговорам: список спрашиваем один раз на чат. */
const piCommands = new Map();
const piRequested = new Set();
let commandBusy = false;
let paletteOpen = false;
let paletteRows = [];
let paletteIndex = 0;

/** Подпись источника: по ней видно, что команда пришла от pi, а не от чата. */
function sourceLabel(source) {
  if (source === 'skill') return 'скилл';
  if (source === 'prompt') return 'шаблон';
  if (source === 'extension') return 'расширение';
  return '';
}

/** Всё, что можно позвать с косой черты: сначала свои команды, потом pi. */
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
 * Палитра открывается только на один токен: «/» или «/com». Как только человек
 * написал пробел, это уже реплика с аргументами — список ему больше не нужен.
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

/** Список команд pi: лениво, по первому «/» в этом разговоре. */
async function ensurePiCommands() {
  const id = currentId;
  if (!id || piCommands.has(id) || piRequested.has(id)) return;
  piRequested.add(id);
  try {
    const data = await api('/panel/api/chat/commands?id=' + encodeURIComponent(id));
    piCommands.set(id, Array.isArray(data.commands) ? data.commands : []);
  } catch {
    // Список команд — подсказка, а не условие чата: не вышло — покажем свои.
    piCommands.set(id, []);
  }
  if (currentId === id) renderPalette();
}

/** Ввод в поле: тянем высоту и, если это начало команды, обновляем палитру. */
function onComposerInput() {
  growInput();
  syncNowButton();
  // Новый символ — новый фильтр: выбор начинается с первой строки.
  paletteIndex = 0;
  renderPalette();
  if (paletteOpen) void ensurePiCommands();
}

function movePalette(delta) {
  if (!paletteRows.length) return;
  paletteIndex = (paletteIndex + delta + paletteRows.length) % paletteRows.length;
  renderPalette();
}

/** Выбор строки — вставка, а не отправка: аргументы человек допишет сам. */
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
 * Клавиши палитры. Возвращает true, если событие уже обработано и отправлять
 * по Enter ничего не нужно.
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
    // Команда уже набрана целиком — Enter её выполняет. Доклеивать пробел
    // и требовать второго нажатия незачем; выбор нужен только для недописанной.
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

/** Ответ команды — плашка в ленте. В историю он не попадает: это не ответ pi. */
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

/** Живой /clear: та же плашка, что придёт из истории после перезагрузки. */
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

/** Имя команды так, как его разбирает сервер: до пробела и без «/». */
function commandName(text) {
  const match = /^\/([a-zA-Z0-9_]+)/.exec(String(text || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Выполняет строку с косой черты. false значит «сервер не взял её себе»:
 * это команда pi, и её нужно отправить в разговор обычной репликой.
 */
async function runCommand(text) {
  if (!writable) return false;
  // Вторую команду поверх первой не запускаем и не отправляем в pi как текст:
  // это всё ещё команда, просто её время не пришло.
  if (commandBusy) {
    setNote('предыдущая команда ещё выполняется');
    return true;
  }
  const name = commandName(text);
  if (!name) return false;
  // Справке разговор не нужен; остальным — нужен, как и обычной реплике.
  if (!currentId && name !== 'help') {
    try {
      await createChat();
    } catch (error) {
      setNote('не удалось создать чат: ' + error.message);
      return true;
    }
  }
  commandBusy = true;
  // Чей это ход: пока команда идёт (/compact — это вызов модели), человек может
  // уйти в другой разговор, и ответ не должен упасть в чужую ленту.
  const chatId = currentId;
  setNote('выполняю ' + text.trim().split(/\s+/)[0] + '…');
  try {
    const result = await api('/panel/api/chat/command', {
      method: 'POST',
      body: JSON.stringify({ chatId: chatId || undefined, text }),
    });
    if (!result || !result.handled) {
      setNote('');
      // Ушли в другой разговор, пока сервер думал: отправлять команду уже не туда.
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
    // /clear начинает новый контекст, но старую ленту не выбрасывает: рисуем
    // разделитель, ровно как он придёт из истории после перезагрузки.
    if (result.cleared && currentId === chatId) {
      addClearDivider();
    } else if (currentId === chatId) {
      addCommandResult(text, result.text || '', Boolean(result.failed));
    }
    // /rename присылает новое имя: шапка и сайдбар обновляются без перезагрузки.
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

/** Клик по строке палитры: фокус остаётся в поле, выбор — как с клавиатуры. */
el('cmd-palette').addEventListener('mousedown', (event) => event.preventDefault());
el('cmd-palette').addEventListener('click', (event) => {
  const row = event.target.closest('.cmd-row');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) return;
  paletteIndex = index;
  choosePalette();
});

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
/* «+ Папка» открывает ввод прямо в списке: модалка ради одного поля — лишний слой. */
el('new-folder').onclick = () => {
  folderDraft = true;
  folderRenaming = null;
  renderChats();
  const input = el('folder-new-name');
  if (input) input.scrollIntoView({ block: 'nearest' });
};

/* ── перетаскивание разговора в папку ──────────────────────────────────────────
   Слушаем контейнер, а не строки: список перерисовывается целиком, и обработчики
   на строках пришлось бы вешать заново после каждой перерисовки. */
el('chat-list').addEventListener('dragover', (event) => {
  const head = event.target.closest && event.target.closest('.folder-head');
  if (!head || !draggingChatId) return;
  // preventDefault — это и есть «сюда можно бросать»: без него drop не случится.
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

/* Меню переноса закрывается кликом мимо и по Escape: висящее меню перекрывает чат. */
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
/* Архив: секция в сайдбаре сворачивается, состояние помним между заходами. */
el('archive-toggle').onclick = () => {
  archiveOpen = !archiveOpen;
  saveArchiveOpen(archiveOpen);
  renderArchive();
};
el('toggle-archive').onclick = () => {
  toggleArchive().catch(() => {});
};
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
el('chat-input').addEventListener('input', onComposerInput);
// Каретка нужна кнопке «В чат» из панели файлов: путь вставляется на её место.
for (const type of ['click', 'keyup', 'select', 'input']) {
  el('chat-input').addEventListener(type, rememberComposerCaret);
}
el('chat-input').addEventListener('keydown', (event) => {
  // Пока открыта палитра, Enter выбирает команду, а не отправляет реплику.
  if (paletteKeydown(event)) return;
  // Ctrl+Enter — та же вторая операция с клавиатуры: прервать и отправить.
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
  // Клик по строке палитры не уводит фокус (mousedown отменён), а уход из
  // поля ввода должен убрать список.
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
  archiveOpen = storedArchiveOpen();
  loadUnread();
  await loadChats(true);
  // Папки — до первого показа списка как раз нет: они лишь группируют уже
  // загруженные разговоры, поэтому грузим их следом и перерисовываем.
  await loadFolders();
  await loadArchived();
  await loadWorkspaces();
  defaultEmptyHtml = el('chat-empty').innerHTML;
  startBulletin();
  // Снимок занятости берём сразу, не дожидаясь открытия сводки: ходы могли
  // начаться до того, как панель открылась, и узнать о них больше негде.
  await syncStatus();
  if (currentId) await selectChat(currentId);
  else startDraft();
  updateComposerHint();
  // Панель файлов открывают не каждый раз, но если её оставили открытой —
  // восстанавливаем вместе с рабочим деревом текущего разговора.
  if (storedFilesOpen()) openFilesPanel();
  if (writable) el('chat-input').focus();
})().catch((error) => {
  setNote('чат не открылся: ' + error.message);
});
