// Клиент раздела «Артефакты».
//
// Артефакты глобальные: список один, без workspace'ов. Сервер отдаёт каркас,
// данные приезжают сюда; состояние (открытый артефакт) живёт в адресе.
// Права: read — смотреть, write — менять файлы, admin — права/удаление/ссылка.
/* global artifactMarkdown */

const artCfg = window.__ARTIFACTS_CFG__;
const artEl = (id) => document.getElementById(id);

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

const ART_LEVELS = { read: 'чтение', write: 'запись', admin: 'администрирование' };

const artIcon = (type) => {
  if (type === 'image') {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 2-2 5 5"/></svg>';
  }
  if (type === 'html') {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/><path d="m13 5-2 14"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></svg>';
};

const artState = {
  artifact: artCfg.artifact || null,
  items: [],
  query: '',
  selected: null,
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

function artClearView(message) {
  artState.selected = null;
  artEl('art-history-modal').hidden = true;
  artEl('art-name').textContent = '—';
  artEl('art-meta').textContent = '';
  artEl('art-type-icon').innerHTML = '';
  artEl('art-path').textContent = '';
  artEl('art-updated').textContent = '';
  artEl('art-link').disabled = true;
  artEl('art-unpublish').hidden = true;
  artEl('art-acl').hidden = true;
  artEl('art-download').setAttribute('aria-disabled', 'true');
  artEl('art-download').removeAttribute('href');
  artEl('art-bare').setAttribute('aria-disabled', 'true');
  artEl('art-bare').removeAttribute('href');
  artEl('art-delete').disabled = true;
  artEl('art-view').innerHTML =
    '<div class="art-placeholder"><div class="art-placeholder-icon">' + artIcon('markdown') +
    '</div><b>' + artEsc(message || 'Выбери артефакт') +
    '</b><span>Слева — всё, что сделал Икар для семьи.</span></div>';
  artCrumbs('');
}

function artRawDir(url) {
  return String(url || '').replace(/[^/]*$/, '');
}

function artRenderView(data) {
  const item = data.artifact;
  artState.selected = item;
  artEl('art-name').textContent = item.entry;
  artEl('art-type-icon').innerHTML = artIcon(item.type);
  artEl('art-meta').textContent =
    item.typeLabel + ' · ' + artHumanSize(item.size) +
    ' · владелец ' + item.owner + ' · ' + ART_LEVELS[item.access];
  artEl('art-path').textContent = '/artifacts/' + item.name + '/' + item.entry;
  artEl('art-updated').textContent = 'Обновлено ' + artStamp(item.updatedAt);
  artEl('art-link').disabled = !item.canManage;
  artEl('art-unpublish').hidden = !item.publicId || !item.canManage;
  artEl('art-acl').hidden = !item.canManage;
  artEl('art-delete').disabled = !item.canManage;
  artEl('art-download').href = item.urls.raw + '?download=1';
  artEl('art-download').removeAttribute('aria-disabled');
  artEl('art-bare').href =
    item.type === 'markdown' && item.urls.bare ? item.urls.bare : item.urls.raw;
  artEl('art-bare').removeAttribute('aria-disabled');
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

async function artOpen(name, push = true) {
  if (!name) {
    artClearView();
    artState.artifact = null;
    if (push) artPushState();
    return;
  }
  artState.artifact = name;
  artState.deleteArmed = false;
  artEl('art-delete').textContent = 'Удалить';
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

async function artMakeLink() {
  if (!artState.selected?.canManage) return;
  artEl('art-link').disabled = true;
  try {
    const data = await artApi('/panel/artifacts/api/link', {
      method: 'POST',
      body: JSON.stringify({ artifact: artState.selected.name }),
    });
    const url = data.urls.public;
    const copied = await artCopy(url);
    artSetStatus(copied ? 'Публичная ссылка скопирована' : 'Публичная ссылка: ' + url);
    artState.selected.urls = data.urls;
    artState.selected.publicId = data.artifact?.publicId;
    artEl('art-unpublish').hidden = !artState.selected.publicId;
  } catch (error) {
    artSetStatus('Ссылка не сделалась: ' + error.message, true);
  } finally {
    artEl('art-link').disabled = false;
  }
}

async function artUnpublish() {
  if (!artState.selected?.canManage) return;
  artEl('art-unpublish').disabled = true;
  try {
    const data = await artApi('/panel/artifacts/api/unpublish', {
      method: 'POST',
      body: JSON.stringify({ artifact: artState.selected.name }),
    });
    artState.selected.urls = data.urls;
    artState.selected.publicId = undefined;
    artEl('art-unpublish').hidden = true;
    artSetStatus('Публичная ссылка отозвана — старый адрес больше не откроется');
  } catch (error) {
    artSetStatus('Ссылка не отозвалась: ' + error.message, true);
  } finally {
    artEl('art-unpublish').disabled = false;
  }
}

function artOpenAcl() {
  if (!artState.selected?.canManage) return;
  artEl('acl-me').value = artState.selected.acl.me;
  artEl('acl-family').value = artState.selected.acl.family;
  artEl('art-acl-modal').hidden = false;
  artEl('acl-family').focus();
}

function artCloseAcl() {
  artEl('art-acl-modal').hidden = true;
}

async function artSaveAcl() {
  if (!artState.selected?.canManage) return;
  const acl = { me: artEl('acl-me').value, family: artEl('acl-family').value };
  artEl('acl-save').disabled = true;
  try {
    await artApi('/panel/artifacts/api/acl', {
      method: 'POST',
      body: JSON.stringify({ artifact: artState.selected.name, acl }),
    });
    artCloseAcl();
    artSetStatus('Права сохранены');
    await artLoadList();
    await artOpen(artState.selected.name);
  } catch (error) {
    artSetStatus('Права не сохранились: ' + error.message, true);
  } finally {
    artEl('acl-save').disabled = false;
  }
}

async function artDelete() {
  if (!artState.selected?.canManage) return;
  const name = artState.selected.name;
  if (!artState.deleteArmed) {
    artState.deleteArmed = true;
    artEl('art-delete').textContent = 'Точно удалить?';
    artSetStatus('Артефакт уедет в artifacts/.trash — вернуть можно руками.');
    setTimeout(() => {
      artState.deleteArmed = false;
      artEl('art-delete').textContent = 'Удалить';
    }, 4000);
    return;
  }
  artEl('art-delete').disabled = true;
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
    artEl('art-delete').disabled = false;
    artState.deleteArmed = false;
    artEl('art-delete').textContent = 'Удалить';
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

function artRenderHistory(data) {
  const list = artEl('art-history-list');
  const history = data.history || [];
  if (history.length === 0) {
    list.innerHTML =
      '<div class="art-empty"><b>Пока нет версий</b><span>История появится после первого изменения артефакта.</span></div>';
    return;
  }
  const canRestore = artCanRestore(artState.selected);
  list.innerHTML = history
    .map((commit) => {
      const current = commit.hash === data.current;
      const action = current
        ? '<em>текущая</em>'
        : canRestore
          ? '<em>Вернуть</em>'
          : '';
      return (
        '<div class="art-history-item' + (current ? ' current' : '') + '">' +
        '<div class="art-history-text"><b>' + artEsc(artHistoryLabel(commit.subject)) + '</b>' +
        '<span>' + artEsc(artStamp(commit.date)) + '</span></div>' +
        (current || !canRestore
          ? '<span class="art-history-current">' + action + '</span>'
          : '<button type="button" class="btn art-history-restore" data-commit="' + artEsc(commit.hash) + '">Вернуть</button>') +
        '</div>'
      );
    })
    .join('');
}

async function artOpenHistory() {
  if (!artState.selected) return;
  artEl('art-history-list').innerHTML = '<p class="art-empty">Читаю историю…</p>';
  artEl('art-history-modal').hidden = false;
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

function artCloseHistory() {
  artEl('art-history-modal').hidden = true;
}

async function artRestore(commit, button) {
  if (!artState.selected || !commit) return;
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = 'Точно вернуть?';
    setTimeout(() => {
      if (button.isConnected) {
        button.dataset.armed = '';
        button.textContent = 'Вернуть';
      }
    }, 4000);
    return;
  }
  button.disabled = true;
  try {
    await artApi('/panel/artifacts/api/restore', {
      method: 'POST',
      body: JSON.stringify({ artifact: artState.selected.name, commit }),
    });
    artCloseHistory();
    artSetStatus('Артефакт возвращён к выбранной версии');
    const name = artState.selected.name;
    await artLoadList();
    await artOpen(name);
  } catch (error) {
    artSetStatus('Версия не вернулась: ' + error.message, true);
    button.disabled = false;
    button.dataset.armed = '';
    button.textContent = 'Вернуть';
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
  artEl('art-link').addEventListener('click', artMakeLink);
  artEl('art-unpublish').addEventListener('click', artUnpublish);
  artEl('art-acl').addEventListener('click', artOpenAcl);
  artEl('art-history').addEventListener('click', artOpenHistory);
  artEl('art-history-list').addEventListener('click', (event) => {
    const button = event.target.closest('.art-history-restore');
    if (button) artRestore(button.dataset.commit, button);
  });
  artEl('art-delete').addEventListener('click', artDelete);
  artEl('acl-cancel').addEventListener('click', artCloseAcl);
  artEl('acl-save').addEventListener('click', artSaveAcl);
  artEl('history-close').addEventListener('click', artCloseHistory);
  artEl('art-acl-modal').addEventListener('click', (event) => {
    if (event.target === artEl('art-acl-modal')) artCloseAcl();
  });
  artEl('art-history-modal').addEventListener('click', (event) => {
    if (event.target === artEl('art-history-modal')) artCloseHistory();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!artEl('art-acl-modal').hidden) artCloseAcl();
    else if (!artEl('art-history-modal').hidden) artCloseHistory();
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
