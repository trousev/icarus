// Клиент раздела «Артефакты».
//
// Сервер отдаёт только каркас: список и содержимое приезжают сюда. Так панель
// открывается мгновенно, а выбор артефакта и поиск не ходят в сервис за каждым
// нажатием. Состояние (workspace и артефакт) живёт в адресе: ссылку на конкретный
// артефакт можно переслать, «назад» работает как надо.
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
    pad(date.getDate()) +
    '.' +
    pad(date.getMonth() + 1) +
    '.' +
    date.getFullYear() +
    ', ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
};

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
  workspace: artCfg.workspace || artCfg.workspaces[0]?.slug || 'talk',
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
  query.set('workspace', artState.workspace);
  if (artState.artifact) query.set('artifact', artState.artifact);
  const next = '/panel/artifacts?' + query.toString();
  if (window.location.pathname + window.location.search !== next) {
    history.replaceState(null, '', next);
  }
}

function artRenderWorkspaces() {
  const select = artEl('art-workspace');
  if (!select) return;
  select.innerHTML = artCfg.workspaces
    .map(
      (item) =>
        '<option value="' +
        artEsc(item.slug) +
        '"' +
        (item.slug === artState.workspace ? ' selected' : '') +
        '>' +
        artEsc(item.name) +
        '</option>',
    )
    .join('');
}

function artMatches(item) {
  if (!artState.query) return true;
  const needle = artState.query.toLowerCase();
  return (
    item.title.toLowerCase().includes(needle) ||
    item.name.toLowerCase().includes(needle) ||
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
    .map(
      (item) =>
        '<button type="button" class="art-item' +
        (item.name === artState.artifact ? ' active' : '') +
        '" data-artifact="' +
        artEsc(item.name) +
        '">' +
        '<span class="art-item-icon">' +
        artIcon(item.type) +
        '</span>' +
        '<span class="art-item-text"><b>' +
        artEsc(item.title) +
        '</b><span>' +
        artEsc(item.typeLabel) +
        ' · ' +
        artEsc(artHumanSize(item.size)) +
        '</span></span>' +
        '</button>',
    )
    .join('');
}

function artClearView(message) {
  artState.selected = null;
  artEl('art-name').textContent = '—';
  artEl('art-meta').textContent = '';
  artEl('art-type-icon').innerHTML = '';
  artEl('art-path').textContent = '';
  artEl('art-updated').textContent = '';
  artEl('art-link').disabled = true;
  artEl('art-unpublish').hidden = true;
  artEl('art-download').setAttribute('aria-disabled', 'true');
  artEl('art-download').removeAttribute('href');
  artEl('art-bare').setAttribute('aria-disabled', 'true');
  artEl('art-bare').removeAttribute('href');
  artEl('art-delete').disabled = true;
  artEl('art-view').innerHTML =
    '<div class="art-placeholder"><div class="art-placeholder-icon">' +
    artIcon('markdown') +
    '</div><b>' +
    artEsc(message || 'Выбери артефакт') +
    '</b><span>Слева — всё, что Икар сделал для тебя в этом workspace.</span></div>';
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
  artEl('art-meta').textContent = item.typeLabel + ' · ' + artHumanSize(item.size);
  artEl('art-path').textContent =
    '~/icarus/workspaces/' + artState.workspace + '/artifacts/' + item.name + '/' + item.entry;
  artEl('art-updated').textContent = 'Обновлено ' + artStamp(item.updatedAt);
  artEl('art-link').disabled = false;
  artEl('art-unpublish').hidden = !item.publicId;
  artEl('art-delete').disabled = false;
  artEl('art-download').href = item.urls.raw + '?download=1';
  artEl('art-download').removeAttribute('aria-disabled');
  artEl('art-bare').href =
    item.type === 'markdown' && item.urls.bare ? item.urls.bare : item.urls.raw;
  artEl('art-bare').removeAttribute('aria-disabled');
  artCrumbs(item.title);

  const view = artEl('art-view');
  if (item.type === 'html') {
    view.innerHTML =
      '<iframe class="art-frame" title="' +
      artEsc(item.title) +
      '" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="' +
      artEsc(item.urls.raw) +
      '"></iframe>';
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
  const data = await artApi(
    '/panel/artifacts/api/list?workspace=' + encodeURIComponent(artState.workspace),
  );
  artState.items = data.items || [];
  if (data.workspace) artState.workspace = data.workspace;
  if (data.workspaces) artCfg.workspaces = data.workspaces;
  artRenderWorkspaces();
  artRenderList();
  // В меню настроек артефактов больше нет — общее число живёт в шапке списка.
  const total = artEl('count-artifacts');
  if (total) total.textContent = String(data.total ?? artState.items.length);
}

/** Числа у остальных разделов приходят с сервера: клиент их только расставляет. */
function artFillCounts() {
  for (const [id, value] of Object.entries(artCfg.counts || {})) {
    const node = artEl('count-' + (id === 'personal' ? 'memory' : id));
    if (node) node.textContent = String(value);
  }
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
    const data = await artApi(
      '/panel/artifacts/api/read?workspace=' +
        encodeURIComponent(artState.workspace) +
        '&artifact=' +
        encodeURIComponent(name),
    );
    artRenderView(data);
    if (push) artPushState();
  } catch (error) {
    artEl('art-view').innerHTML =
      '<div class="art-placeholder bad"><b>Не открылось</b><span>' + artEsc(error.message) + '</span></div>';
  }
}

/** Копирование ссылки: clipboard есть не всегда, поэтому есть запасной путь. */
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
  if (!artState.selected) return;
  artEl('art-link').disabled = true;
  try {
    const data = await artApi('/panel/artifacts/api/link', {
      method: 'POST',
      body: JSON.stringify({ workspace: artState.workspace, artifact: artState.selected.name }),
    });
    const url = data.urls.public;
    const copied = await artCopy(url);
    artSetStatus(copied ? 'Публичная ссылка скопирована' : 'Публичная ссылка: ' + url);
    // Открытая ссылка живёт в панели: кнопка «без панели» в шапке ведёт туда же.
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
  if (!artState.selected) return;
  artEl('art-unpublish').disabled = true;
  try {
    const data = await artApi('/panel/artifacts/api/unpublish', {
      method: 'POST',
      body: JSON.stringify({ workspace: artState.workspace, artifact: artState.selected.name }),
    });
    artState.selected.urls = data.urls;
    artState.selected.publicId = undefined;
    artEl('art-unpublish').hidden = true;
    artSetStatus('Публичная ссылка отозвана — старый адрес больше не откроется');
    artRenderList();
  } catch (error) {
    artSetStatus('Ссылка не отозвалась: ' + error.message, true);
  } finally {
    artEl('art-unpublish').disabled = false;
  }
}

async function artDelete() {
  if (!artState.selected) return;
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
      body: JSON.stringify({ workspace: artState.workspace, artifact: name }),
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

async function artStart() {
  artEl('q').addEventListener('input', (event) => {
    artState.query = event.target.value.trim();
    artRenderList();
  });
  artEl('art-workspace').addEventListener('change', async (event) => {
    artState.workspace = event.target.value;
    artState.artifact = null;
    artState.query = '';
    artEl('q').value = '';
    artClearView();
    artPushState();
    try {
      await artLoadList();
      const first = artState.items.find(artMatches);
      await artOpen(first ? first.name : null);
    } catch (error) {
      artSetStatus('Список не загрузился: ' + error.message, true);
    }
  });
  artEl('art-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-artifact]');
    if (!button) return;
    artOpen(button.dataset.artifact);
  });
  artEl('art-link').addEventListener('click', artMakeLink);
  artEl('art-unpublish').addEventListener('click', artUnpublish);
  artEl('art-delete').addEventListener('click', artDelete);
  artFillCounts();
  artRenderWorkspaces();
  try {
    await artLoadList();
    // Открытый в ссылке артефакт важнее «первого в списке»: человек пришёл по ссылке.
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
