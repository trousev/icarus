// Страница панели памяти: один HTML, никакой сборки и зависимостей.
//
// Общего входа с ключом нет: страница открывается личной ссылкой от Икара, и пропуск
// из неё же уходит в заголовке каждого запроса к API. Протухший или битый пропуск —
// это не форма входа, а подсказка попросить у Икара свежую.
//
// Разделов три: личная память, семейная и математика. Математика приходит из сервиса
// как read-only: у неё нет истории и кнопок правки, зато графики показываются
// картинкой, а не строкой base64.
export type PanelSession = { user: string; scopes: Record<string, 'memory' | 'maple'> } | null;

const SCOPE_LABELS: Record<string, string> = {
  personal: 'личная',
  shared: 'семейная',
  maple: 'математика',
};

export function panelHtml(session: PanelSession): string {
  const scopeOptions = session
    ? Object.keys(session.scopes)
        .map((name) => `<option value="${name}">${SCOPE_LABELS[name] ?? escapeHtml(name)}</option>`)
        .join('')
    : '';
  const modes = session ? JSON.stringify(session.scopes) : '{}';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Икар — память</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --panel:#1b1e24; --line:#2a2f38; --text:#e6e8ec; --dim:#8b93a1; --accent:#7aa2f7; --danger:#f7768e; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { display:flex; gap:12px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  h1 { font-size:15px; margin:0 12px 0 0; font-weight:600; }
  .who { color:var(--accent); margin-right:4px; }
  select, input, button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  button { cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.danger:hover { border-color:var(--danger); color:var(--danger); }
  main { display:grid; grid-template-columns: 260px 1fr 320px; gap:0; height:calc(100vh - 57px); }
  /* У математики нет истории: третья колонка ей не нужна, и место отдаём файлу. */
  main.maple { grid-template-columns: 260px 1fr; }
  main.maple #history { display:none; }
  .col { overflow:auto; padding:12px; border-right:1px solid var(--line); }
  .col:last-child { border-right:none; }
  .file { display:flex; justify-content:space-between; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; color:var(--dim); }
  .file:hover { background:var(--panel); color:var(--text); }
  .file.active { background:var(--panel); color:var(--accent); }
  .file small { color:var(--dim); }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:13px/1.6 ui-monospace, monospace; }
  img.plot { max-width:100%; background:#fff; border:1px solid var(--line); border-radius:8px; }
  .line { display:flex; gap:10px; align-items:flex-start; }
  /* Номер строки — только для глаза: в выделение и буфер обмена он не попадает
     (user-select:none), иначе скопированный текст приезжает с цифрами и отступом. */
  .ln { color:var(--dim); flex:0 0 auto; white-space:pre; user-select:none; -webkit-user-select:none; }
  .line:hover .forget { opacity:1; }
  .forget { opacity:0; font-size:11px; padding:0 6px; border-color:transparent; color:var(--dim); user-select:none; -webkit-user-select:none; }
  .hit { padding:6px 8px; border-radius:6px; cursor:pointer; }
  .hit:hover { background:var(--panel); }
  .hit b { color:var(--accent); font-weight:500; }
  .commit { padding:8px; border-bottom:1px solid var(--line); }
  .commit small { color:var(--dim); display:block; }
  .row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .muted { color:var(--dim); }
  .banner { padding:24px; max-width:560px; margin:60px auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; }
  .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:50; }
  .dialog { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; width:min(520px, calc(100% - 32px)); box-shadow:0 12px 40px rgba(0,0,0,.5); }
  .dialog p { margin:0 0 14px; white-space:pre-wrap; word-break:break-word; }
  .dialog .row { justify-content:flex-end; margin:0; }
</style>
</head>
<body>
${
  session
    ? `<header>
  <h1>Икар · память</h1>
  <span class="who">${escapeHtml(session.user)}</span>
  <select id="scope">${scopeOptions}</select>
  <input id="q" placeholder="поиск по разделу" size="28">
  <button id="search">найти</button>
  <span id="status" class="muted"></span>
</header>
<main>
  <div class="col" id="files"></div>
  <div class="col" id="content"><p class="muted">Выбери файл слева или найди что-нибудь поиском.</p></div>
  <div class="col" id="history"></div>
</main>
<script>
const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
const modes = ${modes};
let current = null;

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error?.message || response.statusText);
  return response.json();
};
const qs = (extra = {}) => new URLSearchParams({ scope: scope.value, ...extra }).toString();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const status = (text) => { document.getElementById('status').textContent = text || ''; };
const mode = () => modes[scope.value] || 'memory';
const isImage = (path) => /\\.(gif|jpe?g|bmp)$/i.test(path);
const humanSize = (bytes) => bytes < 1024 ? bytes + ' б' : (bytes / 1024).toFixed(1) + ' Кб';

// Свой диалог вместо window.confirm: браузер глушит нативные модалки, если
// вкладка не активна, и нативный confirm молча возвращает false — кнопки «не работают».
function askConfirm(message, confirmLabel = 'подтвердить') {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    const text = document.createElement('p');
    text.textContent = message;
    const row = document.createElement('div');
    row.className = 'row';
    const cancel = document.createElement('button');
    cancel.textContent = 'отмена';
    const confirmButton = document.createElement('button');
    confirmButton.className = 'danger';
    confirmButton.textContent = confirmLabel;
    row.append(cancel, confirmButton);
    dialog.append(text, row);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey, true);
    cancel.onclick = () => finish(false);
    confirmButton.onclick = () => finish(true);
    backdrop.onclick = (event) => { if (event.target === backdrop) finish(false); };
    confirmButton.focus();
  });
}

// Общий обработчик кнопок: любая ошибка API должна быть видна, а не глохнуть.
const guard = (action) => async () => {
  try { await action(); } catch (error) { status('ошибка: ' + (error && error.message ? error.message : error)); }
};

async function loadFiles() {
  const maple = mode() === 'maple';
  document.querySelector('main').classList.toggle('maple', maple);
  const data = await api('/panel/api/files?' + qs());
  const box = document.getElementById('files');
  box.innerHTML = data.files.length
    ? data.files.map((f) => '<div class="file" data-path="' + esc(f.path) + '"><span>' + esc(f.path) + '</span><small>' + humanSize(f.size) + '</small></div>').join('')
    : '<p class="muted">' + (maple ? 'Расчётов пока нет.' : 'Память пока пуста.') + '</p>';
  box.querySelectorAll('.file').forEach((el) => el.onclick = () => openFile(el.dataset.path));
  document.getElementById('content').innerHTML = '<p class="muted">' + (maple
    ? 'Это математика: журналы сессий Maple и графики. Файлы создаёт Maple, здесь они только смотрятся.'
    : 'Выбери файл слева или найди что-нибудь поиском.') + '</p>';
  if (maple) {
    document.getElementById('history').innerHTML = '<p class="muted">Раздел только для чтения: журналы и графики создаёт Maple, правки и откаты — в личной памяти.</p>';
  } else {
    await loadHistory();
  }
}

async function openFile(path) {
  current = path;
  const base = '/panel/api/file?' + qs({ path });
  document.querySelectorAll('.file').forEach((el) => el.classList.toggle('active', el.dataset.path === path));
  const box = document.getElementById('content');

  // Картинку тянем байтами с пропуском в заголовке и показываем как <img>: base64
  // в JSON раздул бы ответ втрое, а графики Maple — это gif на сотни килобайт.
  if (isImage(path)) {
    const response = await fetch(base + '&raw=1', { headers: { authorization: 'Bearer ' + token } });
    if (!response.ok) { box.innerHTML = '<p class="muted">Картинка не открылась.</p>'; return; }
    const url = URL.createObjectURL(await response.blob());
    box.innerHTML = '<div class="row"><b>' + esc(path) + '</b></div><img class="plot" alt="' + esc(path) + '">';
    box.querySelector('img').src = url;
    return;
  }

  const data = await api(base);
  box.innerHTML =
    '<div class="row"><b>' + esc(path) + '</b></div><pre>' +
    data.content.split('\\n').map((line, i) =>
      '<div class="line"><span class="ln">' + String(i + 1).padStart(3) + '</span><span style="flex:1">' + esc(line) +
      (mode() === 'memory' && line.trim().startsWith('-') ? '</span><button class="forget danger" data-line="' + esc(line.trim()) + '">забыть</button>' : '</span>') +
      '</div>').join('') +
    '</pre>';
  if (mode() === 'memory') document.querySelectorAll('.forget').forEach((el) => el.onclick = guard(() => forget(path, el.dataset.line)));
}

async function forget(path, line) {
  if (!(await askConfirm('Убрать строку из памяти?\\n\\n' + line, 'забыть'))) return;
  const result = await api('/panel/api/forget', { method: 'POST', body: JSON.stringify({ scope: scope.value, path, line }) });
  status(result.message);
  await openFile(path);
  await loadFiles();
}

async function doSearch() {
  const query = document.getElementById('q').value.trim();
  if (query.length < 2) return;
  const data = await api('/panel/api/search?' + qs({ q: query }));
  document.getElementById('content').innerHTML = data.hits.length
    ? '<div class="row"><b>Найдено: ' + data.hits.length + '</b></div>' + data.hits.map((h) =>
        '<div class="hit" data-path="' + esc(h.path) + '"><b>' + esc(h.path) + ':' + h.line + '</b><br>' + esc(h.text) + '</div>').join('')
    : '<p class="muted">Ничего не нашлось.</p>';
  document.querySelectorAll('.hit').forEach((el) => el.onclick = () => openFile(el.dataset.path));
}

async function loadHistory() {
  const data = await api('/panel/api/history?' + qs());
  const box = document.getElementById('history');
  box.innerHTML = '<div class="row"><b>История</b></div>' + (data.commits.length
    ? data.commits.map((c) => '<div class="commit"><div>' + esc(c.subject) + '</div><small>' + c.date.slice(0, 16).replace('T', ' ') +
        ' · ' + c.hash.slice(0, 8) + '</small><div class="row" style="margin-top:6px">' +
        '<button data-show="' + c.hash + '">дифф</button><button class="danger" data-revert="' + c.hash + '">откатить</button></div></div>').join('')
    : '<p class="muted">Коммитов пока нет.</p>');
  box.querySelectorAll('[data-show]').forEach((el) => el.onclick = () => showCommit(el.dataset.show));
  box.querySelectorAll('[data-revert]').forEach((el) => el.onclick = guard(() => revertCommit(el.dataset.revert)));
}

async function showCommit(hash) {
  const data = await api('/panel/api/show?' + qs({ commit: hash }));
  document.getElementById('content').innerHTML = '<div class="row"><b>' + hash.slice(0, 8) + '</b></div><pre>' + esc(data.patch) + '</pre>';
}

async function revertCommit(hash) {
  if (!(await askConfirm('Откатить коммит ' + hash.slice(0, 8) + '? Изменения вернутся обратным коммитом.', 'откатить'))) return;
  const result = await api('/panel/api/revert', { method: 'POST', body: JSON.stringify({ scope: scope.value, commit: hash }) });
  status(result.message);
  await loadFiles();
  if (current) await openFile(current);
}

const scope = document.getElementById('scope');

(async () => {
  const state = await api('/panel/api/state');
  document.title = 'Икар — память · ' + state.user;
  document.querySelector('.who').textContent = state.user;
  scope.onchange = loadFiles;
  document.getElementById('search').onclick = guard(doSearch);
  document.getElementById('q').onkeydown = (e) => { if (e.key === 'Enter') guard(doSearch)(); };
  await loadFiles();
})().catch((error) => { document.getElementById('files').innerHTML = '<p class="muted">' + esc(error.message) + '</p>'; });
</script>`
    : `<div class="banner">
  <h1>Икар · память</h1>
  <p class="muted">Ссылка не сработала: она истекла или подпись не та.</p>
  <p class="muted">Попроси Икара: «дай ссылку на управление памятью» — он выдаст свежую,
  и она откроет только твою память.</p>
</div>`
}
</body>
</html>`;
}

/** Экранирование для единственного недоверенного значения — имени пользователя. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
