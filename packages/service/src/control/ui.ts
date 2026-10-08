// Страница панели управления: один HTML, никакой сборки и зависимостей.
//
// Входа с паролем здесь нет и не должно быть: панель стоит за SSO-прокси, и все её
// запросы — обычные same-origin запросы браузера, к которым прокси сам прикладывает
// имя вошедшего. Поэтому в ссылке нет ни ключа, ни токена: если человека не назвал
// прокси, страница честно объясняет, чего не хватает (см. PanelDenial).
//
// Раскладка — сайдбар с разделами, строка с крошками и поиском, и контент раздела.
// Сервер отдаёт каркас и заголовок раздела, а списки, записи и история приезжают из
// /panel/api/* уже в браузер: у человека с десятком файлов памяти страница обязана
// открываться мгновенно, а не ждать, пока сервис обойдёт всю память и git.
//
// Состояние живёт в адресе (?scope=…&file=…&tab=…), поэтому ссылку на конкретную
// запись или историю файла можно переслать, а «назад» в браузере работает как надо.
export type PanelSection = { id: string; label: string };

/** Отказ доступа: что случилось и что с этим делать. */
export type PanelDenial = { status: 401 | 403; message: string; hint: string };

export type PanelSession = {
  user: string;
  sections: PanelSection[];
  scopes: Record<string, 'memory' | 'maple'>;
  /** Заголовки областей: у каждой своё имя, и придумывать их в браузере незачем. */
  scopeLabels?: Record<string, string>;
  /** Модель и хранилище — то, чем человек проверяет, что смотрит в ту панель. */
  model?: string;
  storage?: string;
};

export type PanelView = PanelSession | PanelDenial;

/** Что открыто в разделе: область, файл и вкладка внутри файла. */
export type PanelPage = {
  section: string;
  scope?: string;
  file?: string;
  tab?: 'notes' | 'history';
};

const SCOPE_LABELS: Record<string, string> = {
  personal: 'Личная',
  shared: 'Семейная',
  maple: 'Математика',
};

const scopeLabel = (session: PanelSession, scope: string): string =>
  session.scopeLabels?.[scope] ?? SCOPE_LABELS[scope] ?? scope;

const PANEL_TITLE = 'Icarus Control Panel';

/** Подписи раздела памяти: они одинаковы для личной и семейной области. */
const MEMORY_ABOUT =
  'Профиль, предпочтения и распорядок дня — то, что агент учитывает в первую очередь.';
const MAPLE_ABOUT =
  'Журналы сессий, воркшиты и графики Maple. Раздел только для чтения: файлы создаёт сам Maple.';

function isDenial(view: PanelView): view is PanelDenial {
  return 'status' in view;
}

export function panelHtml(view: PanelView, page: PanelPage = { section: 'memory' }): string {
  return isDenial(view) ? denialPage(view) : sessionPage(view, page);
}

/** Оболочка страницы: шапка документа и стили одни на всех. */
function shell(body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PANEL_TITLE}</title>
<!-- Иконка нарисована тут же: панель не тянет ни одного внешнего файла, и без
     неё браузер на каждом открытии просит /favicon.ico и получает 404. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%237aa2f7'/%3E%3Ctext x='16' y='23' font-size='20' font-family='sans-serif' font-weight='bold' fill='%230f1116' text-anchor='middle'%3EI%3C/text%3E%3C/svg%3E">
<style>
  :root { color-scheme: dark; --bg:#0f1116; --side:#13161d; --panel:#1b1f28; --raise:#20242e;
          --line:#262b36; --text:#e6e8ec; --dim:#8b93a1; --accent:#7aa2f7; --accent-soft:#1e2a44; --danger:#f7768e; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  button { font:inherit; cursor:pointer; }
  .app { display:grid; grid-template-columns:250px 1fr; min-height:100vh; }

  /* Сайдбар: слева разделы панели и подпись, чем эта панель работает. */
  aside { background:var(--side); border-right:1px solid var(--line); padding:18px 14px;
          display:flex; flex-direction:column; gap:22px; }
  .brand { display:flex; gap:10px; align-items:center; }
  .logo { width:30px; height:30px; border-radius:9px; background:linear-gradient(150deg,#7aa2f7,#4c6ef5);
          display:grid; place-items:center; font-weight:700; color:#0f1116; }
  .brand b { display:block; font-size:14px; }
  .brand span { color:var(--dim); font-size:11px; }
  .nav-title { color:var(--dim); font-size:10px; letter-spacing:.14em; margin:0 0 8px 8px; }
  .nav { display:flex; flex-direction:column; gap:2px; }
  .nav a, .nav span { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px;
                      color:var(--dim); text-decoration:none; }
  .nav a:hover { background:var(--raise); color:var(--text); }
  .nav a.active { background:var(--accent-soft); color:var(--accent); }
  .nav .soon { opacity:.55; }
  .nav em { font-style:normal; margin-left:auto; font-size:12px; }
  .nav .pin { margin-left:auto; color:var(--dim); font-size:10px; }
  .foot { margin-top:auto; display:flex; flex-direction:column; gap:8px; color:var(--dim); font-size:12px; }
  .foot div { display:flex; justify-content:space-between; gap:10px; }

  /* Верхняя строка: где мы, поиск по разделам и состояние агента. */
  .top { display:flex; gap:14px; align-items:center; padding:14px 24px; border-bottom:1px solid var(--line); }
  .crumbs { color:var(--dim); font-size:13px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .crumbs b { color:var(--text); font-weight:500; }
  .search { display:flex; align-items:center; gap:8px; background:var(--panel); border:1px solid var(--line);
            border-radius:9px; padding:7px 12px; width:290px; }
  .search input { background:none; border:none; outline:none; color:var(--text); font:inherit; width:100%; }
  .status { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12px; white-space:nowrap; }
  .status i { width:7px; height:7px; border-radius:50%; background:#4ade80; }

  .content { padding:22px 24px 40px; }
  .section-title { color:var(--accent); font-size:11px; letter-spacing:.14em; margin:0 0 6px; }
  h1 { font-size:30px; margin:0 0 8px; letter-spacing:-.3px; }
  .about { color:var(--dim); max-width:620px; margin:0 0 18px; }

  /* Области: личная, семейная, математика. Число у области — сколько в ней файлов. */
  .areas { display:flex; gap:4px; background:var(--panel); border:1px solid var(--line);
           border-radius:11px; padding:4px; flex:0 0 auto; }
  .area { display:flex; gap:8px; align-items:center; padding:7px 14px; border-radius:8px;
          color:var(--dim); text-decoration:none; font-size:13px; white-space:nowrap; }
  .area:hover { color:var(--text); }
  .area.active { background:var(--accent-soft); color:var(--accent); }
  .area em { font-style:normal; font-size:11px; background:var(--raise); border-radius:5px; padding:1px 6px; }
  .head { display:flex; gap:20px; align-items:flex-start; justify-content:space-between; }
  .head .lead { min-width:0; }

  .cols { display:grid; grid-template-columns:330px minmax(0,1fr); gap:16px; align-items:start; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
  .card-head { display:flex; justify-content:space-between; gap:12px; align-items:center;
               padding:11px 16px; border-bottom:1px solid var(--line); color:var(--dim);
               font-size:10px; letter-spacing:.14em; }
  .lead-box { padding:17px 18px 18px; }
  .lead-box h3 { font-size:17px; margin:0 0 7px; }

  /* Правая колонка: открытый файл целиком — с шапкой, вкладками и записями. */
  .file-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; padding:16px 18px 12px; }
  /* Пока файл не открыт, шапка с пустым именем только занимает место. */
  .file-head[hidden] { display:none; }
  /* Вкладки и «Скачать» — одним углом: вкладки переключают, кнопка забирает файл. */
  .head-actions { display:flex; gap:8px; align-items:center; flex:0 0 auto; }
  .head-actions [hidden] { display:none; }
  .file-head strong { font-family:ui-monospace, monospace; font-size:15px; }
  .meta { color:var(--dim); font-size:12px; margin-top:4px; }
  .tabs { display:flex; gap:4px; background:var(--raise); border-radius:9px; padding:3px; }
  /* display:flex сильнее атрибута hidden, поэтому прячем вкладки явным правилом. */
  .tabs[hidden] { display:none; }
  .tab { padding:6px 14px; border-radius:7px; color:var(--dim); text-decoration:none; font-size:13px; }
  .tab.active { background:var(--accent); color:#0f1116; }
  .file-body { padding:0 18px 18px; }

  /* Панель действий появляется только когда есть выделение: пустых кнопок не держим. */
  .bar { display:flex; gap:12px; align-items:center; padding:11px 12px; margin-bottom:10px;
         border:1px solid var(--line); border-radius:9px; color:var(--dim); }
  .bar.on { background:var(--accent-soft); border-color:var(--accent); color:var(--text); }
  .bar .grow { flex:1; }
  .bar button, .btn { background:var(--raise); color:var(--text); border:1px solid var(--line);
                      border-radius:8px; padding:7px 14px; }
  .bar button:hover, .btn:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#0f1116; font-weight:500; }
  button.danger { color:var(--danger); }
  button.danger:hover { border-color:var(--danger); }
  button.solid { background:var(--danger); border-color:var(--danger); color:#0f1116; }

  .rows { display:flex; flex-direction:column; }
  /* Строку выравниваем по базовой линии: галочка, номер и текст — на одной строке,
     иначе номер с галочкой всплывают над текстом. Номер и дата — тем же кеглем и
     интерлиньяжем, что и текст: тогда базовая линия у них общая. */
  .row { display:flex; gap:14px; align-items:baseline; padding:11px 8px; border-radius:8px; }
  .row:hover { background:var(--raise); }
  .row.sel { background:var(--accent-soft); }
  /* У чекбокса базовой линии нет: он не в потоке текста, поэтому подтягиваем его
     к строке вручную — иначе он висит выше текста и номера. */
  .row input { margin:0; position:relative; top:3px; width:15px; height:15px;
               accent-color:var(--accent); flex:0 0 auto; cursor:pointer; }
  .num { color:var(--dim); font:12px/1.6 ui-monospace, monospace; width:26px; flex:0 0 auto;
         user-select:none; -webkit-user-select:none; }
  .row-text { flex:1; min-width:0; word-break:break-word; }
  .date { color:var(--dim); font-size:12px; white-space:nowrap; }
  /* Заголовок раздела — не запись: галочки у него нет, и трогать его нечем. */
  .row.heading { background:var(--raise); cursor:default; }
  .row.heading .row-text { font-weight:500; }
  .row.plain { cursor:default; }
  .row.plain .row-text { color:var(--dim); }
  .plus { color:#4ade80; font:12px/1.6 ui-monospace, monospace; }
  .minus { color:var(--danger); font:12px/1.6 ui-monospace, monospace; }

  /* История: коммит и строки по этому файлу — клик открывает дифф. */
  .hist { display:flex; flex-direction:column; }
  .commit { display:flex; gap:14px; align-items:flex-start; padding:13px 8px; border-radius:8px; cursor:pointer; }
  .commit:hover { background:var(--raise); }
  .commit.active { background:var(--accent-soft); }
  .dot { width:8px; height:8px; border-radius:50%; border:2px solid var(--accent); margin-top:6px; flex:0 0 auto; }
  .commit .grow { flex:1; min-width:0; }
  .commit small { display:block; color:var(--dim); margin-top:5px; font-size:12px; }
  .diff { margin:0 0 6px 22px; padding:12px; background:var(--bg); border:1px solid var(--line); border-radius:9px; }
  pre.diff { white-space:pre-wrap; word-break:break-word; font:12px/1.6 ui-monospace, monospace; color:var(--dim); }
  .diff-actions { display:flex; gap:8px; margin-top:12px; }

  .files { display:flex; flex-direction:column; gap:2px; }
  .folder { color:var(--dim); font-size:10px; letter-spacing:.14em; margin:10px 0 6px 10px; }
  .file { display:flex; gap:10px; align-items:center; padding:10px 12px; border-radius:8px;
          color:var(--text); text-decoration:none; }
  .file:hover { background:var(--raise); }
  .file.active { background:var(--accent-soft); }
  .file .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                font-family:ui-monospace, monospace; font-size:13px; }
  .file small { color:var(--dim); margin-left:12px; }
  .hit { padding:9px 12px; border-radius:8px; cursor:pointer; }
  .hit:hover { background:var(--raise); }
  .hit b { color:var(--accent); font-weight:500; font-family:ui-monospace, monospace; font-size:12px; }
  .hit div { color:var(--dim); margin-top:3px; }
  .empty { color:var(--dim); padding:12px; }
  .plot { max-width:100%; background:#fff; border:1px solid var(--line); border-radius:9px; }
  .note { color:var(--dim); font-size:12px; padding:10px 12px 2px; }

  .banner { padding:24px; max-width:560px; margin:60px auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; }
  .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:50; }
  .dialog { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; width:min(520px, calc(100% - 32px)); box-shadow:0 12px 40px rgba(0,0,0,.5); }
  .dialog p { margin:0 0 14px; white-space:pre-wrap; word-break:break-word; }
  .dialog .row { justify-content:flex-end; margin:0; padding:0; }
  .dialog .row:hover { background:none; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Отказ: прокси не назвал человека (401) или назвал того, кого нет в конфиге (403).
 * Это не форма входа — панель не умеет логинить, — а объяснение, где искать причину.
 */
function denialPage(denial: PanelDenial): string {
  return shell(`<div class="banner">
  <h1>${PANEL_TITLE}</h1>
  <p class="about">${escapeHtml(denial.message)}</p>
  <p class="about">${escapeHtml(denial.hint)}</p>
</div>`);
}

function sessionPage(session: PanelSession, page: PanelPage): string {
  const scopes = Object.keys(session.scopes);
  const scope = page.scope && session.scopes[page.scope] ? page.scope : scopes[0];
  const maple = page.section === 'maple';
  const sectionLabel = session.sections.find((item) => item.id === page.section)?.label ?? 'Память';
  const title = maple ? 'Математика' : scopeLabel(session, scope);
  const about = maple ? MAPLE_ABOUT : MEMORY_ABOUT;
  const breadcrumbs = [`Icarus`, sectionLabel, ...(maple ? [] : [title])];

  // Скиллы показываем подписью, а не ссылкой: редактор скиллов ещё не сделан, и
  // мёртвая ссылка хуже, чем честное «скоро».
  const nav = session.sections
    .map(
      (item) =>
        `<a class="${item.id === page.section ? 'active' : ''}" href="/panel/${item.id}?scope=${scope}">` +
        `${escapeHtml(item.label)}<em id="count-${item.id}"></em></a>`,
    )
    .join('');

  const areas = maple
    ? ''
    : `<nav class="areas">${scopes
        .map(
          (name) =>
            `<a class="area${name === scope ? ' active' : ''}" href="/panel/${page.section}?scope=${name}">` +
            `${escapeHtml(scopeLabel(session, name))}<em id="count-${name}"></em></a>`,
        )
        .join('')}</nav>`;

  const config = {
    user: session.user,
    section: page.section,
    scope,
    file: page.file ?? null,
    tab: page.tab === 'history' ? 'history' : 'notes',
    mode: session.scopes[scope] ?? 'memory',
    scopes,
    labels: Object.fromEntries(scopes.map((name) => [name, scopeLabel(session, name)])),
  };

  return shell(`<div class="app">
<aside>
  <div class="brand">
    <div class="logo">I</div>
    <div><b>Icarus</b><span>агент · память и скиллы</span></div>
  </div>
  <div>
    <p class="nav-title">РАБОЧЕЕ ПРОСТРАНСТВО</p>
    <nav class="nav">${nav}</nav>
  </div>
  <div class="foot">
    <div><span>модель</span><span>${escapeHtml(session.model ?? '—')}</span></div>
    <div><span>хранилище</span><span>${escapeHtml(session.storage ?? 'git · local')}</span></div>
  </div>
</aside>
<div>
  <div class="top">
    <div class="crumbs">${breadcrumbs
      .map((part, index) =>
        index === breadcrumbs.length - 1 ? `<b>${escapeHtml(part)}</b>` : escapeHtml(part),
      )
      .join(' / ')}</div>
    <div class="search">
      <input id="q" placeholder="Поиск по памяти и скиллам" size="30">
    </div>
    <div class="status"><i></i>Агент активен</div>
  </div>
  <div class="content">
    <p class="section-title">${maple ? 'МАТЕМАТИКА' : 'ПАМЯТЬ АГЕНТА'}</p>
    <div class="head">
      <div class="lead">
        <h1>${escapeHtml(title)}</h1>
        <p class="about">${about}</p>
      </div>
      ${areas}
    </div>
    <div class="cols">
      <div class="card">
        <div class="card-head"><span>${maple ? 'ФАЙЛЫ MAPLE' : 'ФАЙЛЫ'}</span><span id="files-count"></span></div>
        <div id="files"><p class="empty">Читаю…</p></div>
      </div>
      <div class="card" id="content-card">
        <div class="file-head" id="file-head"${page.file ? '' : ' hidden'}>
          <div>
            <strong id="file-name">${page.file ? escapeHtml(page.file) : ''}</strong>
            <div class="meta" id="file-meta"></div>
          </div>
          <div class="head-actions">
            <div class="tabs" id="tabs" hidden>
              <a class="tab${config.tab === 'notes' ? ' active' : ''}" href="#" data-tab="notes">${maple ? 'Содержимое' : 'Записи'}</a>
              <a class="tab${config.tab === 'history' ? ' active' : ''}" href="#" data-tab="history">История</a>
            </div>
            <button class="btn" id="download" hidden>Скачать</button>
          </div>
        </div>
        <div class="file-body" id="content"></div>
      </div>
    </div>
  </div>
</div>
</div>
<script>
const cfg = ${JSON.stringify(config)};

// Запросы уходят как есть, без заголовков авторизации: панель стоит за SSO-прокси,
// и он узнаёт человека по своей сессионной куке. Приехал не JSON — значит, вместо
// ответа API браузер получил страницу входа: сессия истекла, и об этом надо сказать
// человеку, а не показывать «Unexpected token <».
const api = async (path, options = {}) => {
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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (id) => document.getElementById(id);
const humanSize = (bytes) => bytes < 1024 ? bytes + ' б' : (bytes / 1024).toFixed(1) + ' Кб';
const day = (iso) => { const [y, m, d] = String(iso).split('-'); return y && m && d ? d + '.' + m + '.' + y : String(iso); };
const stamp = (iso) => String(iso).slice(0, 16).replace('T', ' ');
const isImage = (path) => /\\.(gif|jpe?g|bmp)$/i.test(path);
const endpoint = (name, extra = {}) => '/panel/' + (cfg.mode === 'maple' ? 'maple' : 'memory') + '/' + name + '?' +
  new URLSearchParams({ scope: cfg.scope, ...extra }).toString();

// Адрес — это и есть состояние: файл и вкладку видно в ссылке, «назад» работает.
function go(patch) {
  const next = { scope: cfg.scope, file: cfg.file, tab: cfg.tab, ...patch };
  const query = new URLSearchParams({ scope: next.scope });
  if (next.file) query.set('file', next.file);
  if (next.file && next.tab === 'history') query.set('tab', 'history');
  location.href = '/panel/' + cfg.section + '?' + query.toString();
}

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

// Общий обработчик: любая ошибка API должна быть видна, а не глохнуть.
const guard = (action) => async (event) => {
  if (event && event.preventDefault) event.preventDefault();
  try { await action(); } catch (error) { fail(error); }
};
function fail(error) {
  el('content').innerHTML = '<p class="empty">ошибка: ' + esc(error && error.message ? error.message : error) + '</p>';
}

// Счётчики у областей и разделов: сколько в каждой файлов. Обновляются после правок.
async function loadCounts() {
  const state = await api('/panel/api/state');
  const counts = state.counts || {};
  const targets = Object.assign({}, counts, { memory: counts.personal, maple: counts.maple });
  for (const [id, value] of Object.entries(targets)) {
    const node = el('count-' + id);
    if (node && typeof value === 'number') node.textContent = String(value);
  }
}

async function loadFiles() {
  const data = await api(endpoint('files'));
  el('files-count').textContent = data.files.length + ' ' + (data.files.length === 1 ? 'файл' : 'файлов');
  const box = el('files');
  if (!data.files.length) {
    box.innerHTML = '<p class="empty">' + (cfg.mode === 'maple' ? 'Расчётов пока нет.' : 'Память пока пуста.') + '</p>';
    return;
  }
  // Файлы группируем по полкам: в памяти это осмысленные разделы (люди, дела,
  // журнал), и плоский список из трёх десятков файлов читать было бы нельзя.
  const groups = new Map();
  for (const file of data.files) {
    const cut = file.path.lastIndexOf('/');
    const folder = cut === -1 ? '' : file.path.slice(0, cut + 1);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(file);
  }
  const parts = [];
  for (const [folder, files] of groups) {
    if (folder) parts.push('<p class="folder">' + esc(folder.toUpperCase()) + '</p>');
    for (const file of files) {
      const name = folder ? file.path.slice(folder.length) : file.path;
      parts.push('<a class="file' + (file.path === cfg.file ? ' active' : '') + '" href="#" data-path="' + esc(file.path) + '">' +
        '<span class="grow">' + esc(name) + '</span>' +
        '<small>' + (cfg.mode === 'maple' ? humanSize(file.size) + ' · ' + stamp(file.modified) : humanSize(file.size)) + '</small></a>');
    }
  }
  box.innerHTML = '<div class="files">' + parts.join('') + '</div>';
  box.querySelectorAll('.file').forEach((node) => node.onclick = guard(() => openFile(node.dataset.path)));
}

async function openFile(path) {
  if (path === cfg.file) return;
  go({ file: path, tab: 'notes' });
}

// Скачивание — запрос за байтами и <a download>, а не переход по адресу: переход
// увёл бы со страницы, а неудачное скачивание оставило бы человека с пустой
// вкладкой вместо панели. Сервер при этом всё равно отдаёт имя в заголовке —
// страница его не разбирает, а берёт последний кусок пути, который и так знает.
el('download').onclick = guard(async () => {
  if (!cfg.file) return;
  const response = await fetch(endpoint('file', { path: cfg.file, download: '1' }));
  if (!response.ok) throw new Error('файл не отдался: ' + response.status);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = cfg.file.split('/').pop();
  document.body.append(link);
  link.click();
  link.remove();
  // Освобождаем blob сразу после клика: держать копию файла в памяти незачем.
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
});

// ── записи памяти ────────────────────────────────────────────────────────────
// Строка файла — это запись с галочкой, заголовок раздела или просто текст.
// Выделение живёт в браузере и никуда не уезжает, пока не нажали «удалить».
let selection = new Set();

function renderEntries(data) {
  const rows = data.entries.map((entry) => {
    if (entry.kind === 'heading') {
      return '<div class="row heading"><span class="num"></span><span class="row-text">' + esc(entry.text) + '</span></div>';
    }
    if (entry.kind !== 'note') {
      return '<div class="row plain"><span class="num">' + entry.line + '</span><span class="row-text">' + esc(entry.text.trim()) + '</span></div>';
    }
    const checked = selection.has(entry.line) ? ' checked' : '';
    return '<div class="row note' + (checked ? ' sel' : '') + '" data-line="' + entry.line + '">' +
      '<input type="checkbox"' + checked + '>' +
      '<span class="num">' + String(entry.line).padStart(2, '0') + '</span>' +
      '<span class="row-text">' + esc(entry.text.replace(/^\\s*[-*+]\\s+/, '')) + '</span>' +
      '<span class="date">' + (entry.date ? day(entry.date) : '') + '</span></div>';
  }).join('');

  el('content').innerHTML =
    '<div class="bar' + (selection.size ? ' on' : '') + '" id="bar"><span class="grow">' + barText(data) + '</span>' +
    '<button id="clear"' + (selection.size ? '' : ' hidden') + '>Снять выделение</button>' +
    '<button class="danger" id="remove"' + (selection.size ? '' : ' hidden') + '>Удалить (' + selection.size + ')</button></div>' +
    '<div class="rows">' + rows + '</div>' +
    (data.capped ? '<p class="note">Показаны не все записи: файл длиннее, чем помещается в панель.</p>' : '');

  el('content').querySelectorAll('.row.note').forEach((row) => {
    const box = row.querySelector('input');
    const toggle = () => {
      const line = Number(row.dataset.line);
      if (selection.has(line)) selection.delete(line); else selection.add(line);
      row.classList.toggle('sel', selection.has(line));
      box.checked = selection.has(line);
      updateBar(data);
    };
    box.onclick = (event) => { event.stopPropagation(); toggle(); };
    row.onclick = toggle;
  });
  el('clear').onclick = () => { selection.clear(); renderEntries(data); };
  el('remove').onclick = guard(() => removeSelected(data));
}

function barText(data) {
  return selection.size
    ? 'Выбрано ' + selection.size + ' из ' + data.total
    : 'Выберите строки, чтобы удалить · всего ' + data.total + ' ' + (data.total === 1 ? 'запись' : 'записей');
}

function updateBar(data) {
  const bar = el('bar');
  bar.classList.toggle('on', selection.size > 0);
  bar.querySelector('.grow').textContent = barText(data);
  el('clear').hidden = !selection.size;
  el('remove').hidden = !selection.size;
  el('remove').textContent = 'Удалить (' + selection.size + ')';
}

async function removeSelected(data) {
  const lines = [...selection].sort((a, b) => a - b);
  if (!lines.length) return;
  const word = lines.length === 1 ? 'запись' : 'записей: ' + lines.length;
  if (!(await askConfirm('Убрать из памяти ' + word + '?\\n\\nЭто коммит: вернуть можно откатом в истории.', 'убрать'))) return;
  await api('/panel/' + (cfg.mode === 'maple' ? 'maple' : 'memory') + '/forget-many', {
    method: 'POST',
    body: JSON.stringify({ scope: cfg.scope, path: data.path, lines }),
  });
  selection = new Set();
  location.reload();
}

// ── история файла ────────────────────────────────────────────────────────────
async function renderHistory() {
  const data = await api(endpoint('file-history', { path: cfg.file }));
  el('content').innerHTML = data.commits.length
    ? '<div class="hist">' + data.commits.map((commit) =>
        '<div class="commit" data-hash="' + esc(commit.hash) + '"><span class="dot"></span><div class="grow">' +
        '<div><b>' + esc(commit.subject) + '</b></div>' +
        '<small>' + esc(commit.short) + ' · ' + esc(commit.author) + ' · ' + stamp(commit.date) +
        '</small></div><span><span class="plus">+' + commit.added + '</span> <span class="minus">−' + commit.removed + '</span></span></div>',
      ).join('') + '</div>'
    : '<p class="empty">Истории у этого файла пока нет.</p>';
  el('content').querySelectorAll('.commit').forEach((node) => node.onclick = guard(() => showCommit(node.dataset.hash, node)));
}

/** Дифф открывается под коммитом: до этого в колонке видно саму историю. */
async function showCommit(hash, node) {
  el('content').querySelectorAll('.commit').forEach((other) => other.classList.toggle('active', other === node));
  const data = await api('/panel/api/show?scope=' + cfg.scope + '&commit=' + hash);
  node.insertAdjacentHTML('afterend',
    '<div class="diff"><pre class="diff">' + esc(data.patch || 'пустой дифф') + '</pre>' +
    '<div class="diff-actions"><button class="primary" id="revert">Откатить</button>' +
    '<button data-close>Закрыть</button></div></div>');

  const diff = node.nextElementSibling;
  diff.querySelector('[data-close]').onclick = (event) => {
    event.stopPropagation();
    diff.remove();
    node.classList.remove('active');
  };
  diff.querySelector('#revert').onclick = guard(async () => {
    if (!(await askConfirm('Откатить коммит ' + hash.slice(0, 8) + '? Изменения вернутся обратным коммитом.', 'откатить'))) return;
    await api('/panel/api/revert', { method: 'POST', body: JSON.stringify({ scope: cfg.scope, commit: hash }) });
    selection = new Set();
    location.reload();
  });
}
// ── что показать в правой колонке ────────────────────────────────────────────

/**
 * Шапка открытого файла: имя, подпись и вкладки. Пока файла нет, её нет тоже —
 * пустая шапка с прочерком только сбивает с толку.
 */
function showFileHead(path, meta, tabs) {
  el('file-head').hidden = !path;
  el('file-name').textContent = path || '';
  el('file-meta').textContent = meta || '';
  el('tabs').hidden = !tabs;
  // Скачать можно любой файл раздела — и память, и график Maple: это чтение,
  // а не правка, и упирается оно в те же проверки пути, что и остальные запросы.
  el('download').hidden = !path;
}

async function renderContent() {
  const path = cfg.file;
  if (!path) {
    showFileHead(null, null, false);
    el('content').innerHTML = '<p class="empty">' + (cfg.mode === 'maple'
      ? 'Журналы сессий, воркшиты и графики. Файлы создаёт Maple, здесь они только смотрятся.'
      : 'Выбери файл слева или найди что-нибудь поиском.') + '</p>';
    return;
  }

  // Картинку тянем байтами и показываем как <img>: base64 в JSON раздул бы ответ
  // втрое, а графики Maple — это gif на сотни килобайт.
  if (isImage(path)) {
    showFileHead(path, cfg.mode === 'maple' ? 'график Maple' : 'картинка', false);
    const response = await fetch(endpoint('file', { path, raw: '1' }));
    if (!response.ok) { el('content').innerHTML = '<p class="empty">Картинка не открылась.</p>'; return; }
    const url = URL.createObjectURL(await response.blob());
    el('content').innerHTML = '<img class="plot" alt="' + esc(path) + '">';
    el('content').querySelector('img').src = url;
    return;
  }

  const data = await api(endpoint('entries', { path }));
  // У математики истории файла нет: журнал — это код, из которого Maple
  // восстанавливает сессию, и откатывать его из панели нельзя.
  const tells = data.total + ' ' + (data.total === 1 ? 'запись' : 'записей');
  if (cfg.mode === 'maple') {
    showFileHead(path, 'только для чтения', false);
    renderReadOnly(data);
    return;
  }
  showFileHead(path, tells, true);
  if (cfg.tab === 'history') await renderHistory();
  else renderEntries(data);
}

/** Математика: журналы Maple построчно правки не терпят — сессия из них восстанавливается. */
function renderReadOnly(data) {
  el('content').innerHTML = '<div class="rows">' + data.entries.map((entry) =>
    '<div class="row plain"><span class="num">' + entry.line + '</span><span class="row-text">' + esc(entry.text) + '</span></div>',
  ).join('') + '</div>';
}

// ── поиск ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const query = el('q').value.trim();
  if (query.length < 2) return;
  const data = await api('/panel/memory/search?scope=' + cfg.scope + '&q=' + encodeURIComponent(query));
  showFileHead('Поиск', '«' + query + '» · найдено: ' + data.hits.length, false);
  el('content').innerHTML = data.hits.length
    ? '<div class="files">' + data.hits.map((hit) =>
        '<div class="hit" data-path="' + esc(hit.path) + '"><b>' + esc(hit.path) + ':' + hit.line + '</b><div>' + esc(hit.text) + '</div></div>',
      ).join('') + '</div>'
    : '<p class="empty">Ничего не нашлось.</p>';
  el('content').querySelectorAll('.hit').forEach((node) => node.onclick = guard(() => go({ file: node.dataset.path, tab: 'notes' })));
}

el('tabs').querySelectorAll('.tab').forEach((tab) => tab.onclick = guard((event) => {
  event.preventDefault();
  go({ tab: tab.dataset.tab });
}));
el('q').onkeydown = (event) => { if (event.key === 'Enter') guard(doSearch)(); };

(async () => {
  document.title = '${PANEL_TITLE} · ' + cfg.user;
  await Promise.all([loadCounts(), loadFiles(), renderContent()]);
})().catch(fail);
</script>`);
}

/** Экранирование для недоверенных значений: имя человека из заголовка и тексты отказа. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
