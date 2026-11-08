// Клиент раздела «Артефакты».
//
// Артефакты глобальные: список один, без workspace'ов. Сервер отдаёт каркас,
// данные приезжают сюда; состояние (открытый артефакт) живёт в адресе.
// Права: none — не видит ничего, read — смотреть, write — менять файлы,
// admin — права/удаление/ссылка. По умолчанию семья не видит новый артефакт.
/* global artifactMarkdown, artifactTableMount, artChatClose */

const artCfg = window.__ARTIFACTS_CFG__;
const artEl = (id) => document.getElementById(id);

// Иконка «копировать» приезжает из разметки: на успех подменяем её галочкой и
// возвращаем обратно — кнопка остаётся одной и той же.
const ART_ICON_COPY = artEl('acl-copy')?.innerHTML ?? '';
const ART_ICON_CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';

// Чат правки живёт отдельным скриптом и грузится следом. До него функция
// закрытия ещё не объявлена — тогда закрывать и нечего, поэтому проверяем.
const closeArtifactChat = () => {
  if (typeof artChatClose === 'function') artChatClose();
};

const artApi = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('application/json')) {
    const message = type.includes('application/json')
      ? (await response.json().catch(() => ({}))).error?.message || response.statusText
      : 'сессия входа истекла — обнови страницу';
    throw new Error(message);
  }
  return response.json();
};

const artEsc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const artHumanSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace('.', ',') + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' МБ';
};

const artStamp = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear() +
    ', ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  );
};

const ART_LEVELS = { none: 'нет доступа', read: 'чтение', write: 'запись', admin: 'администрирование' };

const artIcon = (type) => {
  if (type === 'image') {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 2-2 5 5"/></svg>';
  }
  if (type === 'html') {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/><path d="m13 5-2 14"/></svg>';
  }
  if (type === 'table') {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 10v9"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></svg>';
};

let artPreviewToken = 0;

const artState = {
  artifact: artCfg.artifact || null,
  items: [],
  query: '',
  selected: null,
  preview: null,
  deleteArmed: false,
};

function artCrumbs(title) {
  artEl('art-crumbs').innerHTML = 'Icarus / Артефакты' + (title ? ' / <b>' + artEsc(title) + '</b>' : '');
}

function artSetStatus(text, bad = false) {
  const note = artEl('art-note');
  if (!note) return;
  note.textContent = text || '';
  note.className = 'art-note' + (bad ? ' bad' : '');
}

function artPushState() {
  const query = new URLSearchParams();
  if (artState.artifact) query.set('artifact', artState.artifact);
  const next = '/panel/artifacts' + (query.toString() ? '?' + query.toString() : '');
  if (window.location.pathname + window.location.search !== next) {
    history.replaceState(null, '', next);
  }
}

function artMatches(item) {
  if (!artState.query) return true;
  const needle = artState.query.toLowerCase();
  return (
    item.title.toLowerCase().includes(needle) ||
    item.name.toLowerCase().includes(needle) ||
    item.owner.toLowerCase().includes(needle) ||
    (item.summary || '').toLowerCase().includes(needle)
  );
}

function artRenderList() {
  const list = artEl('art-list');
  const visible = artState.items.filter(artMatches);
  artEl('art-total').textContent = String(artState.items.length);
  if (artState.items.length === 0) {
    list.innerHTML =
      '<div class="art-empty"><b>Пока пусто</b><span>Попроси Икара сделать артефакт — он положит его сюда.</span></div>';
    return;
  }
  if (visible.length === 0) {
    list.innerHTML = '<div class="art-empty"><b>Ничего не нашлось</b><span>Попробуй другое слово.</span></div>';
    return;
  }
  list.innerHTML = visible
    .map((item) => {
      const owner = item.owner && item.owner !== artCfg.user ? ' · ' + item.owner : '';
      return (
        '<button type="button" class="art-item' +
        (item.name === artState.artifact ? ' active' : '') +
        '" data-artifact="' + artEsc(item.name) + '">' +
        '<span class="art-item-icon">' + artIcon(item.type) + '</span>' +
        '<span class="art-item-text"><b>' + artEsc(item.title) + '</b><span>' +
        artEsc(item.typeLabel) + ' · ' + artEsc(artHumanSize(item.size)) + artEsc(owner) +
        '</span></span></button>'
      );
    })
    .join('');
}

function artHidePreview() {
  artPreviewToken += 1;
  artState.preview = null;
  artEl('art-preview').hidden = true;
  artSyncHistoryState(null);
}

function artHideHistory() {
  artEl('art-history-panel').hidden = true;
  artHidePreview();
}

function artMetaText(item) {
  return (
    item.typeLabel + ' · ' + artHumanSize(item.size) +
    ' · владелец ' + item.owner + ' · ' + ART_LEVELS[item.access]
  );
}

/**
 * Состояние панели действий. Кнопок-надписей больше нет: подпись объясняет
 * только title, поэтому доступность каждого знака считается здесь.
 */
function artSyncActions(item, preview = false) {
  const selected = Boolean(item);
  const manage = selected && !preview && Boolean(item.canManage);
  const write = selected && Boolean(item.canWrite);

  const share = artEl('art-share');
  share.disabled = !manage;
  share.title = manage
    ? 'Поделиться доступом'
    : selected
      ? 'Правами управляет владелец артефакта'
      : 'Выбери артефакт';

  const history = artEl('art-history');
  history.disabled = !selected;
  history.title = selected ? 'История версий' : 'Выбери артефакт';

  const chat = artEl('art-chat');
  chat.disabled = !write;
  chat.title = write
    ? 'Чат по артефакту'
    : selected
      ? 'Нужно право записи на артефакт'
      : 'Выбери артефакт';

  const download = artEl('art-download');
  const bare = artEl('art-bare');
  if (selected) {
    download.href = item.urls.raw + (item.urls.raw.includes('?') ? '&' : '?') + 'download=1';
    download.removeAttribute('aria-disabled');
    // У markdown и таблицы «без панели» — своя страница: файл показал бы исходник.
    bare.href =
      (item.type === 'markdown' || item.type === 'table') && item.urls.bare
        ? item.urls.bare
        : item.urls.raw;
    bare.removeAttribute('aria-disabled');
  } else {
    download.removeAttribute('href');
    download.setAttribute('aria-disabled', 'true');
    bare.removeAttribute('href');
    bare.setAttribute('aria-disabled', 'true');
  }

  const del = artEl('art-delete');
  if (!manage) artResetDelete();
  del.disabled = !manage;
  del.title = !manage
    ? (selected ? 'Удаляет владелец или админ артефакта' : 'Выбери артефакт')
    : artState.deleteArmed
      ? 'Нажми ещё раз, чтобы удалить'
      : 'Удалить артефакт';
}

/** Ответ сервера о новых правах: обновляем шапку и знаки, не перерисовывая просмотр. */
function artApplyArtifact(item) {
  if (!item) return;
  artState.selected = item;
  artEl('art-meta').textContent = artMetaText(item);
  artSyncActions(item, Boolean(artState.preview));
}

function artClearView(message) {
  artState.selected = null;
  artHideHistory();
  artEl('art-name').textContent = '—';
  artEl('art-meta').textContent = '';
  artEl('art-type-icon').innerHTML = '';
  artEl('art-path').textContent = '';
  artEl('art-updated').textContent = '';
  artSyncActions(null);
  closeArtifactChat();
  artEl('art-view').innerHTML =
    '<div class="art-placeholder"><div class="art-placeholder-icon">' + artIcon('markdown') +
    '</div><b>' + artEsc(message || 'Выбери артефакт') +
    '</b><span>Слева — всё, что сделал Икар для семьи.</span></div>';
  artCrumbs('');
}

function artRawDir(url) {
  return String(url || '').replace(/[^/]*$/, '');
}

function artRenderView(data, preview = null) {
  const item = data.artifact;
  if (!preview) artState.selected = item;
  artEl('art-name').textContent = item.entry;
  artEl('art-type-icon').innerHTML = artIcon(item.type);
  artEl('art-meta').textContent = preview
    ? item.typeLabel + ' · ' + artHumanSize(item.size) + ' · версия от ' + artStamp(preview.date)
    : artMetaText(item);
  artEl('art-path').textContent = '/artifacts/' + item.name + '/' + item.entry;
  artEl('art-updated').textContent = preview
    ? 'Версия от ' + artStamp(preview.date)
    : 'Обновлено ' + artStamp(item.updatedAt);
  artSyncActions(item, Boolean(preview));
  // Чат правки — только тому, кто может писать: остальным он обещал бы
  // изменение, которого сервер всё равно не разрешит.
  if (!item.canWrite) closeArtifactChat();
  artCrumbs(item.title);

  const view = artEl('art-view');
  if (item.type === 'html') {
    view.innerHTML =
      '<iframe class="art-frame" title="' + artEsc(item.title) +
      '" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="' +
      artEsc(item.urls.raw) + '"></iframe>';
    return;
  }
  if (item.type === 'image') {
    view.innerHTML =
      '<div class="art-image"><img src="' + artEsc(item.urls.raw) + '" alt="' + artEsc(item.title) + '"></div>';
    return;
  }
  if (item.type === 'table') {
    // Таблица рисуется из CSV-текста, который уже приехал в ответе read:
    // отдельный запрос за файлом не нужен, версия в предпросмотре тоже работает.
    view.innerHTML = '<div class="art-table-host"></div>';
    const mount = typeof artifactTableMount === 'function' ? artifactTableMount : null;
    if (!mount) {
      view.innerHTML = '<div class="art-placeholder bad"><b>Таблица не загрузилась</b></div>';
      return;
    }
    mount(view.querySelector('.art-table-host'), data.content || '', { file: item.entry });
    return;
  }
  const markdown =
    window.artifactMarkdown || (typeof artifactMarkdown === 'function' ? artifactMarkdown : null);
  if (!markdown) {
    view.innerHTML = '<div class="art-placeholder bad"><b>Разметка не загрузилась</b></div>';
    return;
  }
  view.innerHTML =
    '<article class="art-doc">' +
    markdown(data.content || '', { fileBase: artRawDir(item.urls.raw) }) +
    '</article>';
}

async function artLoadList() {
  artEl('art-list').innerHTML = '<p class="art-empty">Читаю…</p>';
  const data = await artApi('/panel/artifacts/api/list');
  artState.items = data.items || [];
  artRenderList();
  const total = artEl('count-artifacts');
  if (total) total.textContent = String(data.total ?? artState.items.length);
}

async function artOpen(name, push = true, keepHistory = false) {
  if (!name) {
    artClearView();
    artState.artifact = null;
    if (push) artPushState();
    return;
  }
  artState.artifact = name;
  artResetDelete();
  // Панели исключают друг друга: чат правки и история занимают одно место.
  closeArtifactChat();
  if (keepHistory) artHidePreview();
  else artHideHistory();
  artRenderList();
  artEl('art-view').innerHTML = '<div class="art-placeholder"><b>Открываю…</b></div>';
  try {
    const data = await artApi('/panel/artifacts/api/read?artifact=' + encodeURIComponent(name));
    artRenderView(data);
    if (push) artPushState();
  } catch (error) {
    artEl('art-view').innerHTML =
      '<div class="art-placeholder bad"><b>Не открылось</b><span>' + artEsc(error.message) + '</span></div>';
  }
}

async function artCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    let ok;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    input.remove();
    return ok;
  }
}

function artShareNote(text, bad = false) {
  const note = artEl('art-share-note');
  note.textContent = text;
  note.className = 'art-share-note' + (bad ? ' bad' : '');
}

function artSetShareBusy(busy) {
  for (const id of ['acl-me', 'acl-family', 'acl-public', 'acl-copy', 'art-share-done']) {
    const node = artEl(id);
    if (node) node.disabled = busy;
  }
}

/** Кнопка копирования — иконка: сбрасываем её в исходный вид после показа галочки. */
function artResetCopy() {
  const button = artEl('acl-copy');
  if (!button) return;
  button.innerHTML = ART_ICON_COPY;
  button.title = 'Копировать ссылку';
  button.setAttribute('aria-label', 'Копировать ссылку');
}

/** Ссылка есть только у публичного чтения: публично писать нельзя. */
function artRenderShareLink() {
  const item = artState.selected;
  const url = item?.publicId ? item.urls.public || '' : '';
  artEl('art-share-link').hidden = !url;
  artEl('acl-link').value = url;
  artEl('acl-link').title = url;
  artEl('acl-public').value = url ? 'read' : 'none';
  artEl('acl-public-hint').textContent = url ? 'любой человек по ссылке — чтение' : 'выключена';
}

function artOpenShare() {
  const item = artState.selected;
  if (!item?.canManage) return;
  const own = item.owner === artCfg.user;
  artEl('art-share-name').textContent = item.title;
  artEl('art-share-me-name').textContent = own ? 'Я' : 'Владелец';
  artEl('art-share-me-sub').textContent = own ? 'владелец артефакта' : item.owner;
  artEl('art-share-me-avatar').textContent = own ? 'Я' : 'В';
  artEl('acl-me').value = item.acl.me;
  artEl('acl-family').value = item.acl.family;
  artEl('acl-me').dataset.previous = item.acl.me;
  artEl('acl-family').dataset.previous = item.acl.family;
  artEl('acl-public').dataset.previous = item.publicId ? 'read' : 'none';
  artResetCopy();
  artRenderShareLink();
  artShareNote('Изменения сохраняются сразу.');
  artEl('art-share-modal').hidden = false;
  artEl('acl-family').focus();
}

function artCloseShare() {
  artEl('art-share-modal').hidden = true;
}

/** Права изменились настолько, что артефакт больше не наш: закрываем и чистим. */
function artLostAccess() {
  artCloseShare();
  artState.artifact = null;
  artClearView('Нет доступа к артефакту');
  artPushState();
}

async function artChangeAcl(select, previous) {
  const item = artState.selected;
  if (!item?.canManage) return;
  const acl = { me: artEl('acl-me').value, family: artEl('acl-family').value };
  artSetShareBusy(true);
  try {
    const data = await artApi('/panel/artifacts/api/acl', {
      method: 'POST',
      body: JSON.stringify({ artifact: item.name, acl }),
    });
    artApplyArtifact(data.artifact);
    if (!data.artifact?.canRead) {
      artLostAccess();
      return;
    }
    artShareNote('Права сохранены');
    await artLoadList();
    if (!data.artifact.canManage) {
      artSetStatus('Права сохранены — управлять артефактом больше нельзя', true);
      artCloseShare();
    }
  } catch (error) {
    select.value = previous;
    select.dataset.previous = previous;
    artShareNote('Права не сохранились: ' + error.message, true);
  } finally {
    artSetShareBusy(false);
  }
}

async function artChangePublic(select, previous) {
  const item = artState.selected;
  if (!item?.canManage) return;
  const wanted = select.value;
  artSetShareBusy(true);
  try {
    const route = wanted === 'read' ? 'link' : 'unpublish';
    const data = await artApi('/panel/artifacts/api/' + route, {
      method: 'POST',
      body: JSON.stringify({ artifact: item.name }),
    });
    artApplyArtifact(data.artifact);
    if (!data.artifact?.canRead) {
      artLostAccess();
      return;
    }
    artRenderShareLink();
    artShareNote(
      wanted === 'read'
        ? 'Ссылка включена — скопируй её и отправь'
        : 'Ссылка отозвана — старый адрес больше не откроется',
    );
    await artLoadList();
  } catch (error) {
    select.value = previous;
    select.dataset.previous = previous;
    artShareNote('Ссылка не изменилась: ' + error.message, true);
  } finally {
    artSetShareBusy(false);
  }
}

async function artCopyLink() {
  const url = artEl('acl-link').value;
  if (!url) return;
  const copied = await artCopy(url);
  const button = artEl('acl-copy');
  if (copied) {
    button.innerHTML = ART_ICON_CHECK;
    button.title = 'Скопировано';
    button.setAttribute('aria-label', 'Скопировано');
  }
  artShareNote(
    copied ? 'Ссылка скопирована' : 'Не получилось скопировать — выдели адрес вручную',
    !copied,
  );
  setTimeout(() => {
    if (button.isConnected) artResetCopy();
  }, 2000);
}

/** Удаление без confirm(): первый клик взводит корзину, второй — удаляет. */
function artResetDelete() {
  artState.deleteArmed = false;
  const button = artEl('art-delete');
  if (button) button.classList.remove('armed');
}

async function artDelete() {
  if (!artState.selected?.canManage) return;
  const name = artState.selected.name;
  const button = artEl('art-delete');
  if (!artState.deleteArmed) {
    artState.deleteArmed = true;
    button.classList.add('armed');
    button.title = 'Нажми ещё раз, чтобы удалить';
    artSetStatus('Артефакт уедет в artifacts/.trash — вернуть можно руками.');
    setTimeout(() => {
      if (!artState.deleteArmed) return;
      artResetDelete();
      artSyncActions(artState.selected, Boolean(artState.preview));
    }, 4000);
    return;
  }
  button.disabled = true;
  try {
    await artApi('/panel/artifacts/api/delete', {
      method: 'POST',
      body: JSON.stringify({ artifact: name }),
    });
    artSetStatus('Артефакт удалён');
    if (artState.artifact === name) {
      artState.artifact = null;
      artClearView();
    }
    await artLoadList();
    artPushState();
  } catch (error) {
    artSetStatus('Не удалилось: ' + error.message, true);
  } finally {
    artResetDelete();
    artSyncActions(artState.selected, Boolean(artState.preview));
  }
}

function artHistoryLabel(subject) {
  const text = String(subject || '');
  if (text === 'artifact: initial version') return 'начальная версия';
  if (text === 'artifact: snapshot before change') return 'перед изменением';
  if (text === 'artifact: update') return 'обновление';
  if (text === 'artifact: before restore') return 'перед откатом';
  if (/^artifact: restore [0-9a-f]+$/i.test(text)) return 'возврат к более ранней версии';
  const write = /^artifact: (write|edit) (.+)$/.exec(text);
  if (write) return (write[1] === 'write' ? 'запись ' : 'правка ') + write[2];
  return text.replace(/^artifact:\s*/, '') || 'версия';
}

function artCanRestore(item) {
  return Boolean(item?.canWrite || item?.canManage);
}

function artSyncHistoryState(hash) {
  for (const row of document.querySelectorAll('.art-history-item')) {
    const selected = row.dataset.commit === hash;
    row.classList.toggle('selected', selected);
    const state = row.querySelector('.art-history-current');
    if (state && !row.classList.contains('current')) state.textContent = selected ? 'смотришь' : '';
  }
}

function artRenderHistory(data) {
  const list = artEl('art-history-list');
  const history = data.history || [];
  if (history.length === 0) {
    list.innerHTML =
      '<div class="art-empty"><b>Пока нет версий</b><span>История появится после первого изменения артефакта.</span></div>';
    return;
  }
  const previewHash = artState.preview?.commit?.hash;
  list.innerHTML = history
    .map((commit) => {
      const current = commit.hash === data.current;
      const selected = commit.hash === previewHash;
      const state = current ? 'текущая' : selected ? 'смотришь' : '';
      return (
        '<button type="button" class="art-history-item' +
        (current ? ' current' : '') + (selected ? ' selected' : '') +
        '" data-commit="' + artEsc(commit.hash) + '">' +
        '<span class="art-history-text"><b>' + artEsc(artHistoryLabel(commit.subject)) + '</b>' +
        '<span>' + artEsc(artStamp(commit.date)) + '</span></span>' +
        '<span class="art-history-current">' + state + '</span></button>'
      );
    })
    .join('');
}

async function artOpenHistory() {
  if (!artState.selected) return;
  closeArtifactChat();
  const panel = artEl('art-history-panel');
  if (!panel.hidden) {
    await artCloseHistory();
    return;
  }
  panel.hidden = false;
  artEl('art-history-list').innerHTML = '<p class="art-empty">Читаю историю…</p>';
  try {
    const data = await artApi(
      '/panel/artifacts/api/history?artifact=' + encodeURIComponent(artState.selected.name),
    );
    artRenderHistory(data);
  } catch (error) {
    artEl('art-history-list').innerHTML =
      '<div class="art-empty bad"><b>История не загрузилась</b><span>' + artEsc(error.message) + '</span></div>';
  }
}

function artPreviewMeta(data) {
  return 'Версия от ' + artStamp(data.commit.date) + ' · ' + artHistoryLabel(data.commit.subject);
}

function artShowPreview(data) {
  artState.preview = data;
  artRenderView(data, data.commit);
  artEl('art-preview').hidden = false;
  artEl('art-preview-meta').textContent = artPreviewMeta(data);
  artEl('art-preview-restore').hidden = !artCanRestore(artState.selected);
  artEl('art-preview-restore').disabled = false;
  artEl('art-preview-restore').textContent = 'Вернуть эту версию';
  artEl('art-preview-restore').dataset.armed = '';
  artSyncHistoryState(data.commit.hash);
}

async function artPreviewVersion(commit) {
  if (!artState.selected || !commit) return;
  const token = ++artPreviewToken;
  try {
    const data = await artApi(
      '/panel/artifacts/api/preview?artifact=' +
        encodeURIComponent(artState.selected.name) +
        '&commit=' +
        encodeURIComponent(commit),
    );
    if (token !== artPreviewToken) return;
    if (data.current === commit) {
      await artShowCurrent();
      return;
    }
    artShowPreview(data);
  } catch (error) {
    artSetStatus('Версия не открылась: ' + error.message, true);
  }
}

async function artShowCurrent() {
  const name = artState.selected?.name;
  if (!name) return;
  artHidePreview();
  await artOpen(name, true, true);
}

async function artCloseHistory() {
  const hadPreview = Boolean(artState.preview);
  const name = artState.selected?.name;
  artHideHistory();
  if (hadPreview && name) await artOpen(name);
}

async function artRestorePreview() {
  const preview = artState.preview;
  const name = artState.selected?.name;
  if (!preview || !name || !artCanRestore(artState.selected)) return;
  const button = artEl('art-preview-restore');
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = 'Точно вернуть?';
    setTimeout(() => {
      if (button.isConnected && button.dataset.armed === '1') {
        button.dataset.armed = '';
        button.textContent = 'Вернуть эту версию';
      }
    }, 4000);
    return;
  }
  button.disabled = true;
  try {
    await artApi('/panel/artifacts/api/restore', {
      method: 'POST',
      body: JSON.stringify({ artifact: name, commit: preview.commit.hash }),
    });
    artHideHistory();
    artSetStatus('Артефакт возвращён к выбранной версии');
    await artLoadList();
    await artOpen(name);
  } catch (error) {
    artSetStatus('Версия не вернулась: ' + error.message, true);
    button.disabled = false;
    button.dataset.armed = '';
    button.textContent = 'Вернуть эту версию';
  }
}

/** Числа у остальных разделов приходят с сервера: клиент их только расставляет. */
function artFillCounts() {
  for (const [id, value] of Object.entries(artCfg.counts || {})) {
    const node = artEl('count-' + (id === 'personal' ? 'memory' : id));
    if (node) node.textContent = String(value);
  }
}

async function artStart() {
  artEl('q').addEventListener('input', (event) => {
    artState.query = event.target.value.trim();
    artRenderList();
  });
  artEl('art-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-artifact]');
    if (!button) return;
    artOpen(button.dataset.artifact);
  });
  artEl('art-share').addEventListener('click', artOpenShare);
  artEl('art-share-close').addEventListener('click', artCloseShare);
  artEl('art-share-done').addEventListener('click', artCloseShare);
  artEl('art-share-modal').addEventListener('click', (event) => {
    if (event.target === artEl('art-share-modal')) artCloseShare();
  });
  artEl('acl-copy').addEventListener('click', artCopyLink);
  artEl('acl-link').addEventListener('focus', (event) => event.target.select());
  const aclChanged = (event) => {
    const select = event.target;
    const previous = select.dataset.previous || select.value;
    select.dataset.previous = select.value;
    void artChangeAcl(select, previous);
  };
  artEl('acl-me').addEventListener('change', aclChanged);
  artEl('acl-family').addEventListener('change', aclChanged);
  artEl('acl-public').addEventListener('change', (event) => {
    const select = event.target;
    const previous = select.dataset.previous || select.value;
    select.dataset.previous = select.value;
    void artChangePublic(select, previous);
  });
  artEl('art-history').addEventListener('click', artOpenHistory);
  artEl('art-history-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-commit]');
    if (button) artPreviewVersion(button.dataset.commit);
  });
  artEl('art-preview-current').addEventListener('click', artShowCurrent);
  artEl('art-preview-restore').addEventListener('click', artRestorePreview);
  artEl('art-delete').addEventListener('click', artDelete);
  artEl('history-close').addEventListener('click', artCloseHistory);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!artEl('art-share-modal').hidden) artCloseShare();
    else if (!artEl('art-history-panel').hidden) artCloseHistory();
  });
  artFillCounts();
  try {
    await artLoadList();
    const wanted = artState.artifact && artState.items.find((item) => item.name === artState.artifact);
    const first = wanted || artState.items[0];
    if (first) await artOpen(first.name);
    else artClearView('Пока пусто');
  } catch (error) {
    artSetStatus('Раздел не загрузился: ' + error.message, true);
    artEl('art-list').innerHTML = '<p class="art-empty">Не удалось прочитать список.</p>';
    artClearView('Ошибка');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', artStart);
else artStart();
