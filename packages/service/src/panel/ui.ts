// Страница панели памяти: один HTML, никакой сборки и зависимостей.
export function panelHtml(authorized: boolean): string {
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
  select, input, button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  button { cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.danger:hover { border-color:var(--danger); color:var(--danger); }
  main { display:grid; grid-template-columns: 260px 1fr 320px; gap:0; height:calc(100vh - 57px); }
  .col { overflow:auto; padding:12px; border-right:1px solid var(--line); }
  .col:last-child { border-right:none; }
  .file { display:flex; justify-content:space-between; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; color:var(--dim); }
  .file:hover { background:var(--panel); color:var(--text); }
  .file.active { background:var(--panel); color:var(--accent); }
  .file small { color:var(--dim); }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:13px/1.6 ui-monospace, monospace; }
  .line { display:flex; gap:10px; align-items:flex-start; }
  .line:hover .forget { opacity:1; }
  .forget { opacity:0; font-size:11px; padding:0 6px; border-color:transparent; color:var(--dim); }
  .hit { padding:6px 8px; border-radius:6px; cursor:pointer; }
  .hit:hover { background:var(--panel); }
  .hit b { color:var(--accent); font-weight:500; }
  .commit { padding:8px; border-bottom:1px solid var(--line); }
  .commit small { color:var(--dim); display:block; }
  .row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .muted { color:var(--dim); }
  .banner { padding:24px; max-width:520px; margin:60px auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; }
</style>
</head>
<body>
${
  authorized
    ? `<header>
  <h1>Икар · память</h1>
  <select id="user"></select>
  <select id="scope">
    <option value="personal">личная</option>
    <option value="shared">семейная</option>
  </select>
  <input id="q" placeholder="поиск по памяти" size="28">
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
const stored = localStorage.getItem('icarus-panel-key');
const key = params.get('key') || stored || '';
if (params.get('key')) { localStorage.setItem('icarus-panel-key', params.get('key')); history.replaceState({}, '', '/panel'); }
let current = null;

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error?.message || response.statusText);
  return response.json();
};
const qs = (extra = {}) => new URLSearchParams({ user: user.value, scope: scope.value, ...extra }).toString();
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const status = (text) => { document.getElementById('status').textContent = text || ''; };

async function loadFiles() {
  const data = await api('/panel/api/files?' + qs());
  const box = document.getElementById('files');
  box.innerHTML = data.files.length
    ? data.files.map((f) => '<div class="file" data-path="' + esc(f.path) + '"><span>' + esc(f.path) + '</span><small>' + f.size + 'б</small></div>').join('')
    : '<p class="muted">Память пока пуста.</p>';
  box.querySelectorAll('.file').forEach((el) => el.onclick = () => openFile(el.dataset.path));
  loadHistory();
}

async function openFile(path) {
  current = path;
  const data = await api('/panel/api/file?' + qs({ path }));
  document.querySelectorAll('.file').forEach((el) => el.classList.toggle('active', el.dataset.path === path));
  document.getElementById('content').innerHTML =
    '<div class="row"><b>' + esc(path) + '</b></div><pre>' +
    data.content.split('\\n').map((line, i) =>
      '<div class="line"><span class="muted">' + String(i + 1).padStart(3) + '</span><span style="flex:1">' + esc(line) +
      (line.trim().startsWith('-') ? '</span><button class="forget danger" data-line="' + esc(line.trim()) + '">забыть</button>' : '</span>') +
      '</div>').join('') +
    '</pre>';
  document.querySelectorAll('.forget').forEach((el) => el.onclick = () => forget(path, el.dataset.line));
}

async function forget(path, line) {
  if (!confirm('Убрать строку из памяти?\\n\\n' + line)) return;
  const result = await api('/panel/api/forget', { method: 'POST', body: JSON.stringify({ user: user.value, scope: scope.value, path, line }) });
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
  box.querySelectorAll('[data-revert]').forEach((el) => el.onclick = () => revertCommit(el.dataset.revert));
}

async function showCommit(hash) {
  const data = await api('/panel/api/show?' + qs({ commit: hash }));
  document.getElementById('content').innerHTML = '<div class="row"><b>' + hash.slice(0, 8) + '</b></div><pre>' + esc(data.patch) + '</pre>';
}

async function revertCommit(hash) {
  if (!confirm('Откатить коммит ' + hash.slice(0, 8) + '? Изменения вернутся обратным коммитом.')) return;
  const result = await api('/panel/api/revert', { method: 'POST', body: JSON.stringify({ user: user.value, scope: scope.value, commit: hash }) });
  status(result.message);
  await loadFiles();
  if (current) await openFile(current);
}

const user = document.getElementById('user');
const scope = document.getElementById('scope');

(async () => {
  const state = await api('/panel/api/state');
  user.innerHTML = state.users.map((id) => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('');
  user.onchange = loadFiles;
  scope.onchange = loadFiles;
  document.getElementById('search').onclick = doSearch;
  document.getElementById('q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  await loadFiles();
})().catch((error) => { document.getElementById('files').innerHTML = '<p class="muted">' + esc(error.message) + '</p>'; });
</script>`
    : `<div class="banner">
  <h1>Икар · память</h1>
  <p class="muted">Нужен ключ панели. Он лежит в конфиге сервиса (поле panelKey или apiKey).</p>
  <div class="row"><input id="key" placeholder="ключ" size="32"><button onclick="location.href='/panel?key='+encodeURIComponent(document.getElementById('key').value)">войти</button></div>
</div>`
}
</body>
</html>`;
}
