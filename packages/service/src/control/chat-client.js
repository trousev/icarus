// Клиент чата: без сборки и зависимостей. Сервер отдаёт каркас, список диалогов и
// историю — этот файл только рисует их и читает NDJSON-поток ответа.
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

/* ── markdown ────────────────────────────────────────────────────────────────
   Без библиотек: сначала экранируем HTML, потом включаем обратно только те
   конструкции, которые реально нужны в ответах. Сырой HTML от модели не проходит. */
function escCode(text) {
  return esc(text);
}

/** Локальную картинку отдаёт сервер; внешнюю браузер грузит сам. */
function imageSrc(raw) {
  const value = String(raw ?? '').trim();
  if (/^(https?:|data:|\/panel\/api\/)/i.test(value)) return value;
  return '/panel/api/chat/image?path=' + encodeURIComponent(value);
}

function inline(raw) {
  const safe = esc(raw);
  return safe
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_, alt, src) => '<img class="md-image" src="' + imageSrc(src) + '" alt="' + alt + '">',
    )
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function markdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  let quote = [];
  let code = null;

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push('</' + list + '>');
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push('<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>');
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push('<pre><code>' + escCode(code.join('\n')) + '</code></pre>');
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length + 2;
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
      continue;
    }

    const blockquote = /^>\s?(.*)$/.exec(line);
    if (blockquote) {
      flushPara();
      flushList();
      quote.push(blockquote[1]);
      continue;
    }

    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const bullet = task ? null : /^[-*+]\s+(.*)$/.exec(line);
    if (task || bullet) {
      flushPara();
      flushQuote();
      if (list !== 'ul') {
        flushList();
        out.push('<ul>');
        list = 'ul';
      }
      const text = task ? task[2] : bullet[1];
      const mark = task ? (task[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') : '';
      out.push('<li' + (task ? ' class="task"' : '') + '>' + mark + inline(text) + '</li>');
      continue;
    }

    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      flushQuote();
      if (list !== 'ol') {
        flushList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push('<li>' + inline(numbered[1]) + '</li>');
      continue;
    }

    flushList();
    flushQuote();
    para.push(line);
  }

  if (code !== null) out.push('<pre><code>' + escCode(code.join('\n')) + '</code></pre>');
  flushAll();
  return out.join('') || '<p></p>';
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

function traceHtml(steps) {
  if (!steps || !steps.length) return '';
  const items = steps
    .map(
      (step) =>
        '<div class="trace-step ' +
        esc(step.status || 'ok') +
        '" title="' +
        esc(step.result || '') +
        '"><span class="trace-label">' +
        esc(step.label) +
        '</span><span class="trace-detail">' +
        esc(step.detail || step.tool || '') +
        '</span><span class="trace-dot"></span></div>',
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
let streaming = false;
/** Черновик нового чата: на сервере его ещё нет, пока не ушло первое сообщение. */
let draft = false;
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
const CHAT_PAGE_SIZE = 30;
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

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

function setWorking(text) {
  el('chat-working').textContent = text || '';
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
    html +=
      '<button class="chat-item' +
      (chat.id === currentId ? ' active' : '') +
      (chat.readOnly ? ' read-only' : '') +
      '" data-id="' +
      esc(chat.id) +
      '"><div class="chat-item-top"><span class="chat-item-title">' +
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
    loadChats(false).catch((error) => setWorking('не удалось догрузить диалоги: ' + error.message));
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
  if (streaming || !writable) return;
  let total = pending.reduce((sum, item) => sum + item.file.size, 0);
  for (const file of Array.from(list || [])) {
    if (pending.length >= MAX_FILES) {
      setWorking('не больше ' + MAX_FILES + ' вложений на сообщение');
      break;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      setWorking('вложения больше ' + fileSizeText(MAX_TOTAL_BYTES) + ' — не отправлю');
      break;
    }
    total += file.size;
    pending.push({ file, url: URL.createObjectURL(file), image: file.type.startsWith('image/') });
  }
  if (pending.length) setWorking('');
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
    esc(message.text || '') +
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
  if (!id || streaming) return;
  closeSettings();
  endDraft();
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
    history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(currentId));
    if (!chats.some((chat) => chat.id === currentId)) {
      chats.unshift(data.chat);
    }
    renderChats();
    setTitle(currentChat.title);
    setComposer(Boolean(currentChat.readOnly));
    setWorking('');
    renderHistory(data.messages || []);
    closeMenu();
  } catch (error) {
    if (token !== historyToken) return;
    setWorking('не удалось открыть разговор: ' + error.message);
  }
}

/* ── новый чат ──────────────────────────────────────────────────────────────
   Клик по «Новый чат» не заводит разговор на сервере: кнопка превращается в
   строку черновика, а настоящий чат появляется только с первым сообщением. */
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
  const data = await api('/panel/api/chats', { method: 'POST', body: '{}' });
  historyToken += 1;
  currentId = data.chat.id;
  currentChat = data.chat;
  setDraft(false);
  // rememberChat сам убирает дубликат и двигает разговор наверх, не сбрасывая
  // уже догруженные страницы списка.
  rememberChat(data.chat);
  el('chat-list').scrollTop = 0;
  history.replaceState(null, '', '/panel/chat?chat=' + encodeURIComponent(currentId));
  setComposer(false);
  return data.chat;
}

function startDraft() {
  if (streaming) return;
  if (draft) {
    el('chat-input').focus();
    closeMenu();
    return;
  }
  closeSettings();
  historyToken += 1;
  currentId = null;
  currentChat = null;
  setDraft(true);
  setComposer(false);
  setTitle('Новый чат');
  showEmpty(true);
  setWorking('');
  renderChats();
  history.replaceState(null, '', '/panel/chat?new=1');
  closeMenu();
  el('chat-input').focus();
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
  };
}

function renderLive(box) {
  const details = box.trace.querySelector('details');
  if (details) box.traceOpen = details.open;
  box.trace.innerHTML = traceHtml(box.steps);
  const next = box.trace.querySelector('details');
  if (next) next.open = box.traceOpen;
  box.md.innerHTML = markdown(box.text);
  box.typing.hidden = Boolean(box.text) || !streaming;
  scrollToBottom();
}

function handleEvent(box, event) {
  if (event.type === 'status') {
    setWorking(event.text || 'Икар работает…');
    return;
  }
  if (event.type === 'text') {
    box.text += event.text || '';
    renderLive(box);
    return;
  }
  if (event.type === 'step') {
    box.steps.push(event.step);
    renderLive(box);
    setWorking((event.step.label || 'Икар') + ': ' + (event.step.detail || 'работает…'));
    return;
  }
  if (event.type === 'step-end') {
    const step = box.steps.find((item) => item.id === event.id);
    if (step) {
      step.status = event.status;
      step.result = event.result;
      renderLive(box);
    }
    return;
  }
  if (event.type === 'notice') {
    setWorking(event.message || '');
    return;
  }
  if (event.type === 'done') {
    if (!box.text && !box.steps.length) {
      box.text = '(ответ пустой)';
      box.md.innerHTML = markdown(box.text);
    }
    box.typing.hidden = true;
    if (event.chat) {
      currentChat = event.chat;
      currentId = event.chat.id;
      setTitle(event.chat.title);
      setComposer(false);
      rememberChat(event.chat, box.text);
    } else {
      loadChats(true).catch(() => {});
    }
    setWorking('');
    return;
  }
  if (event.type === 'error') {
    box.text = [box.text, '\n\n[ошибка: ' + (event.message || 'ответ не пришёл') + ']'].filter(Boolean).join('');
    box.turn.classList.add('error');
    box.md.innerHTML = markdown(box.text);
    box.typing.hidden = true;
    setWorking('');
  }
}

async function sendText(forced) {
  if (streaming || !writable) return;
  const input = el('chat-input');
  const text = String(forced ?? input.value).trim();
  const files = pending.slice();
  if (!text && files.length === 0) return;
  if (!currentId) {
    try {
      await createChat();
    } catch (error) {
      setWorking('не удалось создать чат: ' + error.message);
      return;
    }
  }

  let attachments = [];
  if (files.length > 0) {
    setWorking('готовлю вложения…');
    try {
      attachments = await Promise.all(
        files.map(async (item) => ({
          name: item.file.name,
          type: item.file.type || 'application/octet-stream',
          data: await fileToBase64(item.file),
        })),
      );
    } catch (error) {
      setWorking('не прочитать вложение: ' + error.message);
      return;
    }
  }

  streaming = true;
  el('chat-send').disabled = true;
  input.value = '';
  growInput();
  clearPending(false);
  showEmpty(false);
  addUser(text, files);
  const box = addAssistant();
  setWorking(files.length ? 'отправляю вложения…' : 'Икар отвечает…');

  try {
    const response = await fetch('/panel/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: currentId, text, attachments }),
    });
    if (!response.ok) {
      const type = response.headers.get('content-type') || '';
      const message = type.includes('application/json')
        ? ((await response.json().catch(() => ({}))).error || {}).message || response.statusText
        : 'ответ не начался: ' + response.status;
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
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
  } catch (error) {
    box.turn.classList.add('error');
    box.text = [box.text, '\n\n[ошибка: ' + error.message + ']'].filter(Boolean).join('');
    box.md.innerHTML = markdown(box.text);
    box.typing.hidden = true;
    setWorking('');
  } finally {
    streaming = false;
    el('chat-send').disabled = !writable;
    box.typing.hidden = true;
    input.focus();
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

el('new-chat').onclick = startDraft;
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
el('chat-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    loadChats(true).catch((error) => setWorking('поиск не сработал: ' + error.message));
  }, 180);
});
el('chat-list').addEventListener('scroll', () => {
  if (!nextCursor || loadingChats) return;
  const box = el('chat-list');
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 120) {
    loadChats(false).catch((error) => setWorking('не удалось догрузить диалоги: ' + error.message));
  }
});
document.querySelectorAll('.suggestions button').forEach((node) => {
  node.onclick = () => {
    sendText(node.dataset.prompt).catch(() => {});
  };
});

(async () => {
  const params = new URLSearchParams(window.location.search);
  await loadState();
  await loadChats(true);
  if (currentId) await selectChat(currentId);
  else if (params.get('new') || !chats.length) startDraft();
  else await selectChat(chats[0].id);
  if (params.get('settings')) openSettings(params.get('settings'));
  if (writable) el('chat-input').focus();
})().catch((error) => {
  setWorking('чат не открылся: ' + error.message);
});
