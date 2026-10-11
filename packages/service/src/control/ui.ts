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
  scopes: Record<string, 'memory' | 'skills' | 'maple'>;
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
  /** Пустой редактор нового скилла: файла ещё нет, а страница уже есть. */
  fresh?: boolean;
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
const SKILLS_ABOUT =
  'Скиллы Икара: он видит их имена и описания и читает инструкцию, когда задача совпала. ' +
  'Сохранённый скилл уезжает в следующий же ответ — идущий разговор не рвётся.';

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
  /* Отказ проверки в редакторе скилла: видно там же, где кнопка «Сохранить». */
  #skill-status.bad { color:var(--danger); }
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
  /* Скилл в списке — имя и одной строкой описание: по описанию модель и решает,
     когда скилл открывать, поэтому в списке оно важнее размера файла. */
  .file.skill .grow { white-space:normal; }
  .file.skill b { display:block; font-weight:500; }
  .file.skill .grow small { display:block; margin:2px 0 0; font-family:ui-sans-serif, system-ui, sans-serif;
                            font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .file .flag { color:var(--danger); margin-left:12px; cursor:help; }

  /* Редактор скилла: поля вместо построчных записей — тут пишут файл целиком. */
  .field { display:flex; flex-direction:column; gap:7px; padding:0 0 14px; }
  .field label { color:var(--dim); font-size:10px; letter-spacing:.14em; }
  .field input[type=text], .field textarea { background:var(--bg); border:1px solid var(--line);
      border-radius:9px; color:var(--text); font:inherit; padding:10px 12px; width:100%; }
  .field input[type=text] { font-family:ui-monospace, monospace; }
  .field textarea { resize:vertical; font:13px/1.7 ui-monospace, monospace; }
  .field textarea:focus, .field input[type=text]:focus { outline:none; border-color:var(--accent); }
  .field textarea#skill-body { min-height:320px; }
  .hint { color:var(--dim); font-size:12px; margin:0; padding:0 0 14px; }
  .check { display:flex; gap:9px; align-items:center; color:var(--dim); font-size:13px; padding:0 0 16px; }
  .check input { accent-color:var(--accent); margin:0; }
  .hint code, .check code { font-family:ui-monospace, monospace; color:var(--text); }
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
  const skills = page.section === 'skills';
  const maple = page.section === 'maple';
  // Режим — свойство раздела. Он решает, какие маршруты зовёт страница и каким
  // рендером рисуется правая колонка: память правится построчно, скиллы — файлом,
  // математика только смотрится.
  const mode = skills ? 'skills' : maple ? 'maple' : 'memory';
  const sectionLabel = session.sections.find((item) => item.id === page.section)?.label ?? 'Память';
  const title = skills ? 'Скиллы' : maple ? 'Математика' : scopeLabel(session, scope);
  const about = skills ? SKILLS_ABOUT : maple ? MAPLE_ABOUT : MEMORY_ABOUT;
  // Крошки не повторяют заголовок, когда раздел назван так же: «Скиллы / Скиллы»
  // не сообщает ничего.
  const breadcrumbs = [`Icarus`, sectionLabel, ...(maple || skills ? [] : [title])];

  // Область в ссылке несёт только память: у скиллов и математики своей области нет,
  // и `?scope=personal` в их адресе — это ровно та путаница, когда раздел показывал
  // личную память под своим заголовком.
  const nav = session.sections
    .map((item) => {
      const href = `/panel/${item.id}${item.id === 'memory' ? `?scope=${scope}` : ''}`;
      return (
        `<a class="${item.id === page.section ? 'active' : ''}" href="${href}">` +
        `${escapeHtml(item.label)}<em id="count-${item.id}"></em></a>`
      );
    })
    .join('');

  const areas = maple || skills
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
    fresh: Boolean(page.fresh),
    tab: page.tab === 'history' ? 'history' : 'notes',
    mode,
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
      <input id="q" placeholder="${skills ? 'Поиск по скиллам' : maple ? 'Поиск по математике' : 'Поиск по памяти'}" size="30">
    </div>
    <div class="status"><i></i>Агент активен</div>
  </div>
  <div class="content">
    <p class="section-title">${skills ? 'СКИЛЛЫ АГЕНТА' : maple ? 'МАТЕМАТИКА' : 'ПАМЯТЬ АГЕНТА'}</p>
    <div class="head">
      <div class="lead">
        <h1>${escapeHtml(title)}</h1>
        <p class="about">${about}</p>
      </div>
      ${skills ? '<button class="btn primary" id="new-skill">Новый скилл</button>' : areas}
    </div>
    <div class="cols">
      <div class="card">
        <div class="card-head"><span>${skills ? 'СКИЛЛЫ' : maple ? 'ФАЙЛЫ MAPLE' : 'ФАЙЛЫ'}</span><span id="files-count"></span></div>
        <div id="files"><p class="empty">Читаю…</p></div>
      </div>
      <div class="card" id="content-card">
        <div class="file-head" id="file-head"${page.file || page.fresh ? '' : ' hidden'}>
          <div>
            <strong id="file-name">${page.file ? escapeHtml(page.file) : ''}</strong>
            <div class="meta" id="file-meta"></div>
          </div>
          <div class="head-actions">
            <div class="tabs" id="tabs" hidden>
              <a class="tab${config.tab === 'notes' ? ' active' : ''}" href="#" data-tab="notes">${skills ? 'Скилл' : maple ? 'Содержимое' : 'Записи'}</a>
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
// Русское число: «1 скилл», «2 скилла», «5 скиллов». Считаем по правилу, а не по
// остатку от деления: 11 и 12 — исключение, и без него панель писала бы «11 скилл».
const plural = (n, one, few, many) => {
  const tens = n % 100, ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
};
// Адрес запроса: раздел задаёт корень, область уточняет память. У скиллов и
// математики области нет, и scope в их запросах только сбивал бы с толку.
const endpoint = (name, extra = {}) => {
  const query = cfg.mode === 'memory' ? { scope: cfg.scope, ...extra } : { ...extra };
  const suffix = new URLSearchParams(query).toString();
  return '/panel/' + cfg.section + '/' + name + (suffix ? '?' + suffix : '');
};

// Адрес — это и есть состояние: файл, вкладку и пустой редактор видно в ссылке,
// «назад» работает.
function go(patch) {
  const next = { scope: cfg.scope, file: cfg.file, tab: cfg.tab, fresh: cfg.fresh, ...patch };
  const query = new URLSearchParams();
  // Область в адресе есть только у памяти: у скиллов и математики её нет вовсе.
  if (cfg.mode === 'memory') query.set('scope', next.scope);
  if (next.file) query.set('file', next.file);
  if (next.fresh) query.set('new', '1');
  if (next.file && next.tab === 'history') query.set('tab', 'history');
  const suffix = query.toString();
  location.href = '/panel/' + cfg.section + (suffix ? '?' + suffix : '');
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
  el('files-count').textContent = data.files.length + ' ' + plural(data.files.length, 'файл', 'файла', 'файлов');
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

// ── скиллы ───────────────────────────────────────────────────────────────────
// Скилл — это не файл в списке, а единица работы: имя, описание и инструкция.
// Поэтому список показывает скиллы (с описанием — по нему модель и решает, когда
// скилл открывать), а правая колонка — редактор файла целиком.
async function loadSkills() {
  const data = await api(endpoint('files'));
  const skills = data.skills || [];
  el('files-count').textContent = skills.length + ' ' + plural(skills.length, 'скилл', 'скилла', 'скиллов');
  const box = el('files');
  if (!skills.length) {
    box.innerHTML = '<p class="empty">Скиллов пока нет: нажми «Новый скилл» и напиши первый.</p>';
    return;
  }
  box.innerHTML = '<div class="files">' + skills.map((skill) =>
    '<a class="file skill' + (skill.id === cfg.file ? ' active' : '') + '" href="#" data-id="' + esc(skill.id) + '">' +
    '<span class="grow"><b>' + esc(skill.name) + '</b>' +
    (skill.description ? '<small>' + esc(skill.description) + '</small>' : '') + '</span>' +
    // Сломанный скилл pi пропустит молча — здесь об этом говорит пометка, а
    // подробность («нет описания», «frontmatter не разбирается») лежит в подсказке.
    (skill.problem
      ? '<small class="flag" title="' + esc(skill.problem) + '">⚠</small>'
      : '<small>' + skill.files + ' ' + plural(skill.files, 'файл', 'файла', 'файлов') + '</small>') +
    '</a>').join('') + '</div>';
  box.querySelectorAll('.file').forEach((node) => node.onclick = guard(() => openSkill(node.dataset.id)));
}

function openSkill(id) {
  if (id === cfg.file && !cfg.fresh) return;
  go({ file: id, fresh: false, tab: 'notes' });
}

/** Разметка редактора: статичная, значения подставляет fillSkill. */
function skillForm() {
  return '<div class="bar" id="skill-bar"><span class="grow" id="skill-status">Скилл уедет Икару после сохранения.</span>' +
    '<button class="primary" id="skill-save">Сохранить</button>' +
    '<button class="danger" id="skill-delete"' + (cfg.file ? '' : ' hidden') + '>Удалить</button></div>' +
    '<div class="field"><label for="skill-name">ИМЯ — КАТАЛОГ СКИЛЛА</label>' +
    '<input id="skill-name" type="text" spellcheck="false" autocomplete="off" placeholder="pirate-mode"></div>' +
    '<p class="hint">Строчные латинские буквы, цифры и дефис: имя становится именем каталога, а в разговоре — командой <code>/skill:имя</code>.</p>' +
    '<div class="field"><label for="skill-description">КОГДА ПРИМЕНЯТЬ</label>' +
    '<textarea id="skill-description" rows="2" placeholder="Что делает скилл и в какой момент его звать."></textarea></div>' +
    '<p class="hint">По этой строке Икар и решает, что пора открыть инструкцию: без описания pi скилл пропустит.</p>' +
    '<div class="field"><label for="skill-body">ИНСТРУКЦИЯ (SKILL.MD)</label>' +
    '<textarea id="skill-body" spellcheck="false" placeholder="# Как это делать&#10;&#10;1. …"></textarea></div>' +
    '<label class="check"><input type="checkbox" id="skill-hidden"> скрыть от модели: звать только командой <code>/skill:имя</code></label>';
}

function fillSkill(data) {
  el('skill-name').value = data ? data.name : '';
  el('skill-description').value = data ? data.description : '';
  el('skill-body').value = data ? data.body : '';
  el('skill-hidden').checked = Boolean(data && data.hidden);
}

function skillStatus(text, bad) {
  const node = el('skill-status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('bad', Boolean(bad));
}

/** Сохранение: файл, коммит и пометка «ресурсы обновились» — одним запросом. */
async function saveSkill(id) {
  const payload = {
    name: el('skill-name').value.trim(),
    description: el('skill-description').value.trim(),
    body: el('skill-body').value,
    hidden: el('skill-hidden').checked,
  };
  if (id) payload.id = id;
  skillStatus('Сохраняю…');

  let result;
  try {
    result = await api(endpoint('save'), { method: 'POST', body: JSON.stringify(payload) });
  } catch (error) {
    // Отказ проверки показываем строкой состояния, а не вместо редактора: иначе
    // вместе с «нет описания» пропал бы и текст, который человек только что написал.
    skillStatus('Не сохранилось: ' + (error && error.message ? error.message : error), true);
    return;
  }

  // Дальше живём по адресу сохранённого скилла: имя могло смениться, и вместе с
  // ним переехал каталог — перезагрузка вернула бы человека к старой ссылке.
  cfg.file = result.id;
  cfg.fresh = false;
  history.replaceState(null, '', '/panel/skills?file=' + encodeURIComponent(result.id));
  await Promise.all([loadCounts(), loadSkills()]);
  await renderSkill();
  skillStatus(result.committed ? 'Сохранено · коммит ' + String(result.commit || '').slice(0, 7) : 'Сохранено, но коммит не вышел — загляни в историю');
}

async function deleteSkill(data) {
  if (!data) return;
  if (!(await askConfirm('Удалить скилл «' + data.name + '»?\\n\\nВместе с файлами бандла. Это коммит: вернуть можно откатом в истории.', 'удалить'))) return;
  await api(endpoint('delete'), { method: 'POST', body: JSON.stringify({ id: data.id }) });
  go({ file: null, fresh: false, tab: 'notes' });
}

/**
 * Правая колонка в разделе скиллов: пустой редактор нового скилла, редактор
 * открытого или история — та же, что у памяти.
 */
async function renderSkill() {
  if (!cfg.file) {
    if (!cfg.fresh) {
      showFileHead(null, null, false);
      el('content').innerHTML = '<p class="empty">Выбери скилл слева или заведи новый: «Новый скилл».</p>';
      return;
    }
    // Пустой редактор: скачивать пока нечего, вкладок истории ещё нет.
    showFileHead('Новый скилл', 'ещё не сохранён', false, false);
    el('content').innerHTML = skillForm();
    fillSkill(null);
    el('skill-save').onclick = guard(() => saveSkill(null));
    el('skill-name').focus();
    return;
  }

  const data = await api(endpoint('skill', { id: cfg.file }));
  // Дата изменения — день, а не метка времени: в шапке рядом с путём и числом
  // файлов часы только шумят.
  const meta = data.id + ' · ' + data.files + ' ' + plural(data.files, 'файл', 'файла', 'файлов') +
    ' · изменён ' + day(String(data.modified).slice(0, 10)) + (data.problem ? ' · ⚠ ' + data.problem : '');
  showFileHead(data.name, meta, true);
  if (cfg.tab === 'history') {
    await renderHistory();
    return;
  }
  el('content').innerHTML = skillForm();
  fillSkill(data);
  el('skill-save').onclick = guard(() => saveSkill(data.id));
  el('skill-delete').onclick = guard(() => deleteSkill(data));
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
  await api(endpoint('forget-many'), {
    method: 'POST',
    body: JSON.stringify({ path: data.path, lines }),
  });
  selection = new Set();
  location.reload();
}

// ── история файла ────────────────────────────────────────────────────────────
// В памяти история — по открытому файлу, у скиллов — по всему каталогу: скилл это
// каталог, и коммит «скилл «pirate-mode»» читается лучше, чем история его SKILL.md.
async function renderHistory() {
  const data = await api(cfg.mode === 'skills' ? endpoint('history') : endpoint('file-history', { path: cfg.file }));
  el('content').innerHTML = data.commits.length
    ? '<div class="hist">' + data.commits.map((commit) =>
        '<div class="commit" data-hash="' + esc(commit.hash) + '"><span class="dot"></span><div class="grow">' +
        '<div><b>' + esc(commit.subject) + '</b></div>' +
        '<small>' + esc(commit.short) + ' · ' + esc(commit.author) + ' · ' + stamp(commit.date) +
        '</small></div><span><span class="plus">+' + commit.added + '</span> <span class="minus">−' + commit.removed + '</span></span></div>',
      ).join('') + '</div>'
    : '<p class="empty">' + (cfg.mode === 'skills' ? 'Скиллы ещё не меняли: истории нет.' : 'Истории у этого файла пока нет.') + '</p>';
  el('content').querySelectorAll('.commit').forEach((node) => node.onclick = guard(() => showCommit(node.dataset.hash, node)));
}

/** Дифф открывается под коммитом: до этого в колонке видно саму историю. */
async function showCommit(hash, node) {
  el('content').querySelectorAll('.commit').forEach((other) => other.classList.toggle('active', other === node));
  const data = await api(endpoint('show', { commit: hash }));
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
    await api(endpoint('revert'), { method: 'POST', body: JSON.stringify({ commit: hash }) });
    selection = new Set();
    location.reload();
  });
}
// ── что показать в правой колонке ────────────────────────────────────────────

/**
 * Шапка открытого файла: имя, подпись и вкладки. Пока файла нет, её нет тоже —
 * пустая шапка с прочерком только сбивает с толку.
 *
 * Скачивание включается отдельно: у нового скилла имя есть, а файла ещё нет, и
 * кнопка «Скачать» на пустом редакторе обещала бы несуществующее.
 */
function showFileHead(path, meta, tabs, download = Boolean(path)) {
  el('file-head').hidden = !path;
  el('file-name').textContent = path || '';
  el('file-meta').textContent = meta || '';
  el('tabs').hidden = !tabs;
  // Скачать можно любой файл раздела — и память, и график Maple, и SKILL.md: это
  // чтение, а не правка, и упирается оно в те же проверки пути, что и остальные
  // запросы.
  el('download').hidden = !download;
}

async function renderContent() {
  // У скиллов своя правая колонка: там редактор, а не записи с галочками.
  if (cfg.mode === 'skills') {
    await renderSkill();
    return;
  }
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
// Строка поиска ищет в открытом разделе: в памяти — по записям, в скиллах — по их
// файлам, в математике — по журналам. Обещать «по памяти и скиллам» сразу значило
// бы врать: чужие корни раздел не читает.
async function doSearch() {
  const query = el('q').value.trim();
  if (query.length < 2) return;
  if (cfg.mode === 'skills') {
    await searchSkills(query);
    return;
  }
  const data = await api(endpoint('search', { q: query }));
  showFileHead('Поиск', '«' + query + '» · найдено: ' + data.hits.length, false, false);
  el('content').innerHTML = data.hits.length
    ? '<div class="files">' + data.hits.map((hit) =>
        '<div class="hit" data-path="' + esc(hit.path) + '"><b>' + esc(hit.path) + ':' + hit.line + '</b><div>' + esc(hit.text) + '</div></div>',
      ).join('') + '</div>'
    : '<p class="empty">Ничего не нашлось.</p>';
  el('content').querySelectorAll('.hit').forEach((node) => node.onclick = guard(() => go({ file: node.dataset.path, tab: 'notes' })));
}

/** Поиск по скиллам: находка открывает сам скилл, а не строку в файле. */
async function searchSkills(query) {
  const data = await api(endpoint('search', { q: query }));
  showFileHead('Поиск', '«' + query + '» · найдено: ' + data.hits.length, false, false);
  el('content').innerHTML = data.hits.length
    ? '<div class="files">' + data.hits.map((hit) =>
        '<div class="hit" data-id="' + esc(hit.id) + '"><b>' + esc(hit.name) + ':' + hit.line + '</b><div>' + esc(hit.text) + '</div></div>',
      ).join('') + '</div>'
    : '<p class="empty">Ничего не нашлось.</p>';
  el('content').querySelectorAll('.hit').forEach((node) => node.onclick = guard(() => go({ file: node.dataset.id, fresh: false, tab: 'notes' })));
}

el('tabs').querySelectorAll('.tab').forEach((tab) => tab.onclick = guard((event) => {
  event.preventDefault();
  go({ tab: tab.dataset.tab });
}));
el('q').onkeydown = (event) => { if (event.key === 'Enter') guard(doSearch)(); };
// «Новый скилл» — это адрес, а не скрытое состояние: ссылку на пустой редактор
// можно переслать, а «назад» возвращает к списку.
if (el('new-skill')) el('new-skill').onclick = guard(() => go({ file: null, fresh: true, tab: 'notes' }));

(async () => {
  document.title = '${PANEL_TITLE} · ' + cfg.user;
  await Promise.all([loadCounts(), cfg.mode === 'skills' ? loadSkills() : loadFiles(), renderContent()]);
})().catch(fail);
</script>`);
}

/** Экранирование для недоверенных значений: имя человека из заголовка и тексты отказа. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
