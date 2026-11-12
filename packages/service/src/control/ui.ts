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
import { panelStrings, type PanelStrings } from './strings.ts';
import { DEFAULT_UI_LANGUAGE, isUiLanguage, type UiLanguage } from '../profile.ts';

export type PanelSection = { id: string; label: string };

/** Язык интерфейса из сессии. Неизвестное или отсутствующее значение — русский. */
export function sessionUiLanguage(session: PanelSession): UiLanguage {
  return isUiLanguage(session.uiLanguage) ? session.uiLanguage : DEFAULT_UI_LANGUAGE;
}

export const sessionStrings = (session: PanelSession): PanelStrings => panelStrings(sessionUiLanguage(session));

/** Отказ доступа: что случилось и что с этим делать. */
export type PanelDenial = { status: 401 | 403; message: string; hint: string };

export type PanelSession = {
  user: string;
  sections: PanelSection[];
  scopes: Record<string, 'memory' | 'skills' | 'profile'>;
  /** Заголовки областей: у каждой своё имя, и придумывать их в браузере незачем. */
  scopeLabels?: Record<string, string>;
  /** Модель и хранилище — то, чем человек проверяет, что смотрит в ту панель. */
  model?: string;
  storage?: string;
  /** Есть ли кому написать скилл: в локальной панели контейнера с моделью нет. */
  draftSkills?: boolean;
  /** Админ ли: раздел «Ключи» в сайдбаре есть только у него. */
  admin?: boolean;
  /** Язык ответов этого человека: «ru» или «en». Раздел «Пользователь» им и занят. */
  language?: string;
  /** Язык интерфейса панели: отдельная настройка, «ru» или «en». */
  uiLanguage?: string;
};

export type PanelView = PanelSession | PanelDenial;

/** Что открыто в разделе: область, файл и вкладка внутри файла. */
export type PanelPage = {
  section: string;
  scope?: string;
  file?: string;
  /** Владелец открытого скилла: у расшаренного он чужой и править его нельзя. */
  owner?: string;
  /** Пустой редактор нового скилла: файла ещё нет, а страница уже есть. */
  fresh?: boolean;
  tab?: 'notes' | 'history';
};

/**
 * Подпись области. Сервер присылает её уже на языке человека; здесь остаётся
 * запасной вариант для старых вызовов и тестов без `scopeLabels`.
 */
const scopeLabel = (session: PanelSession, scope: string): string => {
  const ui = sessionStrings(session);
  return session.scopeLabels?.[scope] ?? (scope === 'personal' ? ui.scopePersonal : scope === 'shared' ? ui.scopeShared : scope);
};

const PANEL_TITLE = 'Icarus Control Panel';

function isDenial(view: PanelView): view is PanelDenial {
  return 'status' in view;
}

export function panelHtml(view: PanelView, page: PanelPage = { section: 'memory' }): string {
  return isDenial(view) ? denialPage(view) : sessionPage(view, page);
}

/**
 * Оболочка страницы: шапка документа и стили одни на всех. `lang` — язык
 * интерфейса: от него зависит переносы, озвучка и то, как браузер ищет по странице.
 */
export function shell(body: string, lang: string = DEFAULT_UI_LANGUAGE): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PANEL_TITLE}</title>
<!-- Иконка нарисована тут же: панель не тянет ни одного внешнего файла, и без
     неё браузер на каждом открытии просит /favicon.ico и получает 404. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%237aa2f7'/%3E%3Ctext x='16' y='23' font-size='20' font-family='sans-serif' font-weight='bold' fill='%230f1116' text-anchor='middle'%3EI%3C/text%3E%3C/svg%3E">
<style>
  :root { color-scheme: dark; --bg:#0f1116; --side:#13161d; --panel:#1b1f28; --raise:#20242e;
          --line:#262b36; --text:#e6e8ec; --dim:#8b93a1; --accent:#7aa2f7; --accent-soft:#1e2a44; --danger:#f7768e;
          --busy:#e0af68; --unread:#9ece6a; }
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
  /* Назад в чат — отдельной кнопкой: это выход из настроек, а не ещё один раздел. */
  .nav-box { display:flex; flex-direction:column; }
  .nav-back { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line);
              border-radius:8px; background:var(--panel); color:var(--text); text-decoration:none; font-size:13px; }
  .nav-back:hover { border-color:var(--accent); background:var(--raise); }
  .nav-sep { border:0; border-top:1px solid var(--line); margin:16px 0; }
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
  /* У настроек нет колонки файлов: карточка одна и на всю ширину. */
  .cols.single { grid-template-columns:minmax(0,1fr); }
  /* Выбор языка: строка-переключатель, а не выпадающий список — вариантов два,
     и оба должны быть видны сразу. */
  .choice { display:flex; flex-direction:column; gap:8px; }
  .choice label { display:flex; gap:11px; align-items:center; padding:12px 14px; border:1px solid var(--line);
                  border-radius:9px; cursor:pointer; background:var(--bg); }
  .choice label:hover { border-color:var(--accent); }
  .choice label.on { border-color:var(--accent); background:var(--accent-soft); }
  .choice input { accent-color:var(--accent); margin:0; }
  .choice b { font-weight:500; }
  .choice small { color:var(--dim); margin-left:auto; font-family:ui-monospace, monospace; font-size:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
  .card-head { display:flex; justify-content:space-between; gap:12px; align-items:center;
               padding:11px 16px; border-bottom:1px solid var(--line); color:var(--dim);
               font-size:10px; letter-spacing:.14em; }
  .lead-box { padding:17px 18px 18px; }
  /* Две настройки языка — два блока: черта между ними не даёт прочитать их как одну. */
  .lead-box + .lead-box { border-top:1px solid var(--line); }
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
  /* Пока модель пишет, кнопку не жмём второй раз: это минута и чужой токен. */
  button:disabled { opacity:.55; cursor:default; }
  button:disabled:hover { border-color:var(--line); }
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
  /* Статус и владелец скилла в списке: включён/выключен и «поделился/расшарен» —
     те же две вещи, что у MCP, поэтому и выглядят знакомо. */
  .file.skill.off .grow { opacity:.55; }
  .file .tags { display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex:0 0 auto; }
  .tag { display:inline-block; padding:1px 7px; border-radius:5px; font-size:10px; letter-spacing:.02em;
         background:var(--raise); color:var(--dim); white-space:nowrap; }
  .tag.on { background:#16301f; color:#9ece6a; }
  .tag.off { background:#33222a; color:var(--danger); }
  .tag.shared { background:var(--accent-soft); color:var(--accent); }
  /* Переключатель — тот же, что в формах: маленький, чтобы не спорить с описанием. */
  .switch { position:relative; display:inline-flex; width:34px; height:19px; flex:0 0 auto; }
  .switch input { position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; z-index:1; }
  .switch span { position:absolute; inset:0; border-radius:999px; background:var(--raise);
                 border:1px solid var(--line); transition:background .15s; }
  .switch span::after { content:''; position:absolute; top:2px; left:2px; width:13px; height:13px;
                        border-radius:50%; background:var(--dim); transition:transform .15s, background .15s; }
  .switch input:checked + span { background:var(--accent-soft); border-color:var(--accent); }
  .switch input:checked + span::after { transform:translateX(15px); background:var(--accent); }
  .switch input:disabled { cursor:default; }
  .switch input:disabled + span { opacity:.5; }

  /* Редактор скилла: поля вместо построчных записей — тут пишут файл целиком. */
  .field { display:flex; flex-direction:column; gap:7px; padding:0 0 14px; }
  .field label { color:var(--dim); font-size:10px; letter-spacing:.14em; }
  .field input[type=text], .field textarea { background:var(--bg); border:1px solid var(--line);
      border-radius:9px; color:var(--text); font:inherit; padding:10px 12px; width:100%; }
  .field input[type=text] { font-family:ui-monospace, monospace; }
  .field textarea { resize:vertical; font:13px/1.7 ui-monospace, monospace; }
  .field textarea:focus, .field input[type=text]:focus { outline:none; border-color:var(--accent); }
  .field textarea#skill-body { min-height:320px; }
  /* «Напиши за меня»: отдельным блоком, потому что это другой способ начать скилл —
     не «заполни поля», а «расскажи идею, поля заполнятся сами». */
  .generator { border:1px solid var(--line); border-radius:11px; padding:14px 14px 4px;
               margin:0 0 16px; background:var(--bg); }
  .generator .field textarea { background:var(--panel); min-height:auto; font:inherit; }
  .generator .row { display:flex; gap:10px; align-items:center; padding:0 0 12px; }
  .generator .row .grow { flex:1; color:var(--dim); font-size:12px; }
  .hint { color:var(--dim); font-size:12px; margin:0; padding:0 0 14px; }
  /* Подпись к блоку настроек — тот же начерк, что у заголовков карточек. */
  .field-label { color:var(--dim); font-size:10px; letter-spacing:.14em; margin:0 0 10px; }
  .check { display:flex; gap:9px; align-items:center; color:var(--dim); font-size:13px; padding:0 0 16px; }
  /* display:flex сильнее атрибута hidden, поэтому прячем строку шаринга явно. */
  .check[hidden] { display:none; }
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

/**
 * Сайдбар настроек: дорога назад в чат, отчерк и сами разделы. Один и тот же на
 * всех страницах настроек — иначе их меню разъезжается от раздела к разделу.
 */
export function settingsAside(
  session: PanelSession,
  active: string,
  options: { scope?: string; foot?: Array<[string, string]> } = {},
): string {
  const ui = sessionStrings(session);
  const nav = session.sections
    .map((item) => {
      // Память помнит открытую область: возвращаясь из другого раздела, человек
      // должен попасть в ту же личную или семейную память, а не в первую.
      const href = `/panel/${item.id}${item.id === 'memory' && options.scope ? `?scope=${options.scope}` : ''}`;
      return (
        `<a class="${item.id === active ? 'active' : ''}" href="${href}">` +
        `${escapeHtml(item.label)}<em id="count-${item.id}"></em></a>`
      );
    })
    .join('');
  const foot = options.foot ?? [
    [ui.modelLabel, session.model ?? '—'],
    [ui.storageLabel, session.storage ?? 'git · local'],
  ];
  return `<aside>
  <div class="brand">
    <div class="logo">I</div>
    <div><b>Icarus</b><span>${escapeHtml(ui.brandTagline)}</span></div>
  </div>
  <div class="nav-box">
    <a class="nav-back" href="/panel/chat">${escapeHtml(ui.backToChat)}</a>
    <hr class="nav-sep">
    <p class="nav-title">${escapeHtml(ui.settingsNavTitle)}</p>
    <nav class="nav">${nav}</nav>
  </div>
  <div class="foot">
    ${foot
      .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`)
      .join('\n    ')}
  </div>
</aside>`;
}

function sessionPage(session: PanelSession, page: PanelPage): string {
  const ui = sessionStrings(session);
  const scopes = Object.keys(session.scopes);
  const scope = page.scope && session.scopes[page.scope] ? page.scope : scopes[0];
  const skills = page.section === 'skills';
  // «Пользователь» — не список файлов, а форма. Ему не нужны ни колонка файлов,
  // ни поиск, поэтому он рисуется собственной правой колонкой целиком.
  const profile = page.section === 'profile';
  // Режим — свойство раздела. Он решает, какие маршруты зовёт страница и каким
  // рендером рисуется правая колонка: память правится построчно, скиллы — файлом.
  const mode = skills ? 'skills' : profile ? 'profile' : 'memory';
  const sectionLabel = session.sections.find((item) => item.id === page.section)?.label ?? ui.sectionMemory;
  const title = skills ? ui.sectionSkills : profile ? ui.sectionProfile : scopeLabel(session, scope);
  const about = skills ? ui.aboutSkills : profile ? ui.aboutProfile : ui.aboutMemory;
  // Память остаётся на языке контекста. Английский интерфейс не должен создавать
  // впечатление, что её сейчас переведут: подписываем решение прямо в разделе.
  const memoryNote =
    !skills && !profile && ui.lang !== 'ru' ? `<p class="hint">${escapeHtml(ui.memoryLanguageNote)}</p>` : '';
  // Крошки не повторяют заголовок, когда раздел назван так же: «Скиллы / Скиллы»
  // не сообщает ничего.
  const breadcrumbs = [`Icarus`, sectionLabel, ...(skills || profile ? [] : [title])];

  // Область в ссылке несёт только память: у скиллов своей области нет, и
  // `?scope=personal` в их адресе — это ровно та путаница, когда раздел показывал
  // личную память под своим заголовком.
  const areas = skills || profile
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
    // У своего скилла владелец — сам человек, у расшаренного — автор. Панель по
    // этому полю решает, показывать редактор или только чтение.
    owner: page.owner ?? session.user,
    fresh: Boolean(page.fresh),
    tab: page.tab === 'history' ? 'history' : 'notes',
    mode,
    scopes,
    // Есть ли кому написать скилл. Локальная панель поднимается без контейнера с
    // моделью — там кнопки нет вовсе, а не «есть, но всегда отказывает».
    draftSkills: Boolean(session.draftSkills),
    labels: Object.fromEntries(scopes.map((name) => [name, scopeLabel(session, name)])),
    // Строки клиентского скрипта: тот же словарь, что у серверной разметки, чтобы
    // «Читаю…» в шаблоне и «Ничего не нашлось» после поиска не разъезжались.
    ui,
  };

  return shell(`<div class="app">
${settingsAside(session, page.section, { scope })}
<div>
  <div class="top">
    <div class="crumbs">${breadcrumbs
      .map((part, index) =>
        index === breadcrumbs.length - 1 ? `<b>${escapeHtml(part)}</b>` : escapeHtml(part),
      )
      .join(' / ')}</div>
    <div class="search">
      ${profile ? '' : `<input id="q" placeholder="${escapeHtml(skills ? ui.searchSkills : ui.searchMemory)}" size="30">`}
    </div>
    <div class="status"><i></i>${escapeHtml(ui.agentActive)}</div>
  </div>
  <div class="content">
    <p class="section-title">${escapeHtml(skills ? ui.kickerSkills : profile ? ui.kickerSettings : ui.kickerMemory)}</p>
    <div class="head">
      <div class="lead">
        <h1>${escapeHtml(title)}</h1>
        <p class="about">${escapeHtml(about)}</p>
        ${memoryNote}
      </div>
      ${skills ? `<button class="btn primary" id="new-skill">${escapeHtml(ui.newSkill)}</button>` : areas}
    </div>
    <div class="cols${profile ? ' single' : ''}">
      ${profile ? '' : `<div class="card">
        <div class="card-head"><span>${escapeHtml(skills ? ui.headingSkills : ui.headingFiles)}</span><span id="files-count"></span></div>
        <div id="files"><p class="empty">${escapeHtml(ui.loading)}</p></div>
      </div>`}
      <div class="card" id="content-card">
        <div class="file-head" id="file-head"${profile || page.file || page.fresh ? ' hidden' : ''}>
          <div>
            <strong id="file-name">${page.file ? escapeHtml(page.file) : ''}</strong>
            <div class="meta" id="file-meta"></div>
          </div>
          <div class="head-actions">
            <div class="tabs" id="tabs" hidden>
              <a class="tab${config.tab === 'notes' ? ' active' : ''}" href="#" data-tab="notes">${escapeHtml(skills ? ui.tabSkill : ui.tabNotes)}</a>
              <a class="tab${config.tab === 'history' ? ' active' : ''}" href="#" data-tab="history">${escapeHtml(ui.tabHistory)}</a>
            </div>
            <button class="btn" id="download" hidden>${escapeHtml(ui.download)}</button>
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
      : cfg.ui.sessionExpired;
    throw new Error(message);
  }
  return response.json();
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (id) => document.getElementById(id);
const humanSize = (bytes) => bytes < 1024 ? bytes + cfg.ui.bytesShort : (bytes / 1024).toFixed(1) + cfg.ui.kilobytesShort;
const day = (iso) => { const [y, m, d] = String(iso).split('-'); return y && m && d ? d + '.' + m + '.' + y : String(iso); };
const stamp = (iso) => String(iso).slice(0, 16).replace('T', ' ');
const isImage = (path) => /\\.(gif|jpe?g|bmp)$/i.test(path);
// Число со словом: русскому нужны три формы («1 скилл», «2 скилла», «11 скиллов»),
// английскому хватает двух. Формы приходят из словаря панели, правило — здесь.
const plural = (n, words) => {
  if (cfg.ui.lang !== 'ru') return n === 1 ? words.one : words.many;
  const tens = n % 100, ones = n % 10;
  if (tens >= 11 && tens <= 14) return words.many;
  if (ones === 1) return words.one;
  if (ones >= 2 && ones <= 4) return words.few;
  return words.many;
};
// Подстановка в шаблон словаря: «{n} {word}» и подобные. Без регулярок: строки
// приходят из JSON, и экранировать тут нечего.
const fill = (template, values) =>
  Object.entries(values).reduce((text, [key, value]) => text.split('{' + key + '}').join(String(value)), template);
const countLabel = (n, words) => fill(cfg.ui.countLabel, { n, word: plural(n, words) });
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
  const next = { scope: cfg.scope, file: cfg.file, owner: cfg.owner, tab: cfg.tab, fresh: cfg.fresh, ...patch };
  const query = new URLSearchParams();
  // Область в адресе есть только у памяти: у скиллов и математики её нет вовсе.
  if (cfg.mode === 'memory') query.set('scope', next.scope);
  if (next.file) query.set('file', next.file);
  // Владельца пишем только у чужого скилла: у своего это лишний параметр, который
  // ещё и сломает старые ссылки на «мой скилл».
  if (next.file && next.owner && next.owner !== cfg.user) query.set('owner', next.owner);
  if (next.fresh) query.set('new', '1');
  if (next.file && next.tab === 'history') query.set('tab', 'history');
  const suffix = query.toString();
  location.href = '/panel/' + cfg.section + (suffix ? '?' + suffix : '');
}

// Свой диалог вместо window.confirm: браузер глушит нативные модалки, если
// вкладка не активна, и нативный confirm молча возвращает false — кнопки «не работают».
function askConfirm(message, confirmLabel = cfg.ui.confirm) {
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
    cancel.textContent = cfg.ui.cancel;
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
// Событие передаём в действие: обработчики вкладок сами зовут preventDefault,
// и без аргумента они падали на «event is undefined» вместо перехода.
const guard = (action) => async (event) => {
  if (event && event.preventDefault) event.preventDefault();
  try { await action(event); } catch (error) { fail(error); }
};
function fail(error) {
  el('content').innerHTML = '<p class="empty">' + esc(cfg.ui.errorPrefix) + esc(error && error.message ? error.message : error) + '</p>';
}

// Счётчики у областей и разделов: сколько в каждой файлов. Обновляются после правок.
async function loadCounts() {
  const state = await api('/panel/api/state');
  const counts = state.counts || {};
  const targets = Object.assign({}, counts, { memory: counts.personal });
  for (const [id, value] of Object.entries(targets)) {
    const node = el('count-' + id);
    if (node && typeof value === 'number') node.textContent = String(value);
  }
}

async function loadFiles() {
  const data = await api(endpoint('files'));
  el('files-count').textContent = countLabel(data.files.length, cfg.ui.filesWord);
  const box = el('files');
  if (!data.files.length) {
    box.innerHTML = '<p class="empty">' + esc(cfg.ui.emptyMemory) + '</p>';
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
        '<small>' + humanSize(file.size) + '</small></a>');
    }
  }
  box.innerHTML = '<div class="files">' + parts.join('') + '</div>';
  box.querySelectorAll('.file').forEach((node) => node.onclick = guard(() => openFile(node.dataset.path)));
}

// ── скиллы ───────────────────────────────────────────────────────────────────
// Скилл — это не файл в списке, а единица работы: имя, описание и инструкция.
// Поэтому список показывает скиллы (с описанием — по нему модель и решает, когда
// скилл открывать), а правая колонка — редактор файла целиком.
/** Бейджи скилла: чей он, включён ли и не сломан ли. */
function skillTags(skill) {
  const tags = [];
  if (skill.ownerIsMe) tags.push('<span class="tag' + (skill.shared ? ' shared' : '') + '">' +
    (skill.shared ? cfg.ui.skillTagShared : cfg.ui.skillTagMine) + '</span>');
  else tags.push('<span class="tag shared">' + esc(fill(cfg.ui.skillTagFrom, { owner: skill.owner })) + '</span>');
  tags.push('<span class="tag ' + (skill.enabled ? 'on' : 'off') + '">' +
    (skill.enabled ? cfg.ui.skillEnabled : cfg.ui.skillDisabled) + '</span>');
  if (skill.problem) tags.push('<span class="flag" title="' + esc(skill.problem) + '">⚠</span>');
  return tags.join('');
}

async function loadSkills() {
  const data = await api(endpoint('files'));
  const skills = data.skills || [];
  el('files-count').textContent = countLabel(skills.length, cfg.ui.skillsWord);
  const box = el('files');
  if (!skills.length) {
    box.innerHTML = '<p class="empty">' + esc(cfg.ui.emptyNoSkills) + '</p>';
    return;
  }
  box.innerHTML = '<div class="files">' + skills.map((skill) => {
    const owner = skill.owner || cfg.user;
    const active = skill.id === cfg.file && owner === cfg.owner;
    // Корневой SKILL.md — сам каталог скиллов: выключать его переездом нельзя.
    const switchable = skill.id !== 'SKILL.md';
    return '<div class="file skill' + (skill.enabled ? '' : ' off') + (active ? ' active' : '') +
      '" data-id="' + esc(skill.id) + '" data-owner="' + esc(owner) + '">' +
      '<a class="grow" href="#" data-open><b>' + esc(skill.name) + '</b>' +
      (skill.description ? '<small>' + esc(skill.description) + '</small>' : '') + '</a>' +
      '<span class="tags">' + skillTags(skill) +
      (skill.problem ? '' : '<span class="tag">' + countLabel(skill.files, cfg.ui.filesWord) + '</span>') +
      '</span>' +
      (switchable
        ? '<label class="switch" title="' + (skill.enabled ? cfg.ui.skillToggleOff : cfg.ui.skillToggleOn) + '">' +
          '<input type="checkbox" data-toggle' + (skill.enabled ? ' checked' : '') + '><span></span></label>'
        : '') +
      '</div>';
  }).join('') + '</div>';
  box.querySelectorAll('[data-open]').forEach((node) => node.onclick = guard(() => {
    const row = node.closest('.file');
    openSkill(row.dataset.id, row.dataset.owner);
  }));
  box.querySelectorAll('[data-toggle]').forEach((node) => node.onchange = guard(() => toggleSkill(node)));
}

function openSkill(id, owner) {
  if (id === cfg.file && owner === cfg.owner && !cfg.fresh) return;
  go({ file: id, owner: owner || cfg.user, fresh: false, tab: 'notes' });
}

/** Переключатель в списке: включить/выключить скилл себе, не открывая редактор. */
async function toggleSkill(input) {
  const row = input.closest('.file');
  const owner = row.dataset.owner || cfg.user;
  const payload = { id: row.dataset.id, enabled: input.checked };
  if (owner !== cfg.user) payload.owner = owner;
  input.disabled = true;
  try {
    await api(endpoint('toggle'), { method: 'POST', body: JSON.stringify(payload) });
    await Promise.all([loadCounts(), loadSkills()]);
    // Открыт этот же скилл — редактор должен показать новый статус.
    if (row.dataset.id === cfg.file && owner === cfg.owner && !cfg.fresh) await renderSkill();
  } catch (error) {
    // Не получилось — возвращаем галочку, чтобы она не врала о состоянии.
    input.checked = !input.checked;
    throw error;
  } finally {
    input.disabled = false;
  }
}

/** Разметка редактора: статичная, значения подставляет fillSkill. */
function skillForm() {
  // Блок «напиши за меня» — только у нового скилла и только когда есть кому писать.
  // У открытого скилла он бы значил «перепиши моё», а это уже другая кнопка.
  const generator = cfg.draftSkills && !cfg.file
    ? '<div class="generator"><div class="field"><label for="skill-idea">' + esc(cfg.ui.skillIdeaLabel) + '</label>' +
      '<textarea id="skill-idea" rows="2" placeholder="' + esc(cfg.ui.skillIdeaPlaceholder) + '"></textarea></div>' +
      '<div class="row"><span class="grow">' + esc(cfg.ui.skillGeneratorHint) + '</span>' +
      '<button class="btn" id="skill-write">' + esc(cfg.ui.skillWrite) + '</button></div></div>'
    : '';

  return generator +
    '<div class="bar" id="skill-bar"><span class="grow" id="skill-status">' +
    (cfg.draftSkills && !cfg.file ? esc(cfg.ui.skillNewStatus) : esc(cfg.ui.skillExistingStatus)) +
    '</span>' +
    '<button class="primary" id="skill-save">' + esc(cfg.ui.save) + '</button>' +
    '<button class="danger" id="skill-delete"' + (cfg.file ? '' : ' hidden') + '>' + esc(cfg.ui.deleteLabel) + '</button></div>' +
    '<div class="field"><label for="skill-name">' + esc(cfg.ui.skillNameLabel) + '</label>' +
    '<input id="skill-name" type="text" spellcheck="false" autocomplete="off" placeholder="pirate-mode"></div>' +
    '<p class="hint">' + cfg.ui.skillNameHint + '</p>' +
    '<div class="field"><label for="skill-description">' + esc(cfg.ui.skillDescriptionLabel) + '</label>' +
    '<textarea id="skill-description" rows="2" placeholder="' + esc(cfg.ui.skillDescriptionPlaceholder) + '"></textarea></div>' +
    '<p class="hint">' + esc(cfg.ui.skillDescriptionHint) + '</p>' +
    '<div class="field"><label for="skill-body">' + esc(cfg.ui.skillBodyLabel) + '</label>' +
    '<textarea id="skill-body" spellcheck="false" placeholder="# Как это делать&#10;&#10;1. …"></textarea></div>' +
    '<label class="check"><input type="checkbox" id="skill-hidden"> ' + cfg.ui.skillHidden + '</label>' +
    // Шаринг — только у своего скилла. У чужого этой строки нет: владелец решает сам.
    '<label class="check" id="skill-share-row"><input type="checkbox" id="skill-share"> ' +
    esc(cfg.ui.skillShareLabel) + '</label>';
}

function fillSkill(data) {
  el('skill-name').value = data ? data.name : '';
  el('skill-description').value = data ? data.description : '';
  el('skill-body').value = data ? data.body : '';
  el('skill-hidden').checked = Boolean(data && data.hidden);
  el('skill-share').checked = Boolean(data && data.shared);
}

/** Поделиться или спрятать открытый скилл: то же, что бейдж в списке, но по-человечески. */
async function toggleShare(checkbox) {
  checkbox.disabled = true;
  try {
    await api(endpoint('share'), { method: 'POST', body: JSON.stringify({ id: cfg.file, shared: checkbox.checked }) });
    await Promise.all([loadCounts(), loadSkills()]);
    await renderSkill();
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    throw error;
  } finally {
    checkbox.disabled = false;
  }
}

function skillStatus(text, bad) {
  const node = el('skill-status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('bad', Boolean(bad));
}

/**
 * «Напиши за меня»: один запрос — и поля заполнены черновиком.
 *
 * На диске до этого не появляется ничего: черновик живёт в форме, а файл и коммит
 * делает «Сохранить». Так человек видит, что именно уедет Икару, и может поправить.
 */
async function writeForMe() {
  const idea = el('skill-idea').value.trim();
  if (idea.length < 3) {
    skillStatus(cfg.ui.skillIdeaTooShort, true);
    return;
  }

  const button = el('skill-write');
  button.disabled = true;
  skillStatus(cfg.ui.skillWriting);
  try {
    const draft = await api(endpoint('draft'), { method: 'POST', body: JSON.stringify({ idea }) });
    el('skill-name').value = draft.name || '';
    el('skill-description').value = draft.description || '';
    el('skill-body').value = draft.body || '';
    skillStatus(draft.note ? cfg.ui.skillWritten + draft.note : cfg.ui.skillWrittenCheck);
    // Имя не вышло — ведём человека туда, где от него что-то нужно.
    (draft.name ? el('skill-body') : el('skill-name')).focus();
  } catch (error) {
    skillStatus(cfg.ui.skillWriteFailed + (error && error.message ? error.message : error), true);
  } finally {
    button.disabled = false;
  }
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
  skillStatus(cfg.ui.saving);

  let result;
  try {
    result = await api(endpoint('save'), { method: 'POST', body: JSON.stringify(payload) });
  } catch (error) {
    // Отказ проверки показываем строкой состояния, а не вместо редактора: иначе
    // вместе с «нет описания» пропал бы и текст, который человек только что написал.
    skillStatus(cfg.ui.saveFailedPrefix + (error && error.message ? error.message : error), true);
    return;
  }

  // Дальше живём по адресу сохранённого скилла: имя могло смениться, и вместе с
  // ним переехал каталог — перезагрузка вернула бы человека к старой ссылке.
  cfg.file = result.id;
  cfg.fresh = false;
  history.replaceState(null, '', '/panel/skills?file=' + encodeURIComponent(result.id));
  await Promise.all([loadCounts(), loadSkills()]);
  await renderSkill();
  skillStatus(result.committed ? cfg.ui.savedCommit + String(result.commit || '').slice(0, 7) : cfg.ui.savedNoCommit);
}

async function deleteSkill(data) {
  if (!data) return;
  if (!(await askConfirm(fill(cfg.ui.deleteSkillPrompt, { name: data.name }), cfg.ui.confirmDelete))) return;
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
      el('content').innerHTML = '<p class="empty">' + esc(cfg.ui.emptyPickSkill) + '</p>';
      return;
    }
    // Пустой редактор: скачивать пока нечего, вкладок истории ещё нет.
    showFileHead(cfg.ui.newSkill, cfg.ui.notSaved, false, false);
    el('content').innerHTML = skillForm();
    fillSkill(null);
    // Новый скилл ещё никому не принадлежит, кроме автора: шаринг появится после
    // сохранения, когда у скилла будет файл.
    if (el('skill-share-row')) el('skill-share-row').hidden = true;
    el('skill-save').onclick = guard(() => saveSkill(null));
    if (el('skill-write')) el('skill-write').onclick = guard(writeForMe);
    // Начинать тут логично с идеи: поля ниже заполнятся сами.
    (el('skill-idea') || el('skill-name')).focus();
    return;
  }

  // Свой скилл открывается без владельца в адресе: это старый контракт, и он
  // должен продолжать работать. Чужой — с owner: иначе два одинаковых id
  // не различить.
  const skillUrl = cfg.owner && cfg.owner !== cfg.user
    ? endpoint('skill', { id: cfg.file, owner: cfg.owner })
    : endpoint('skill', { id: cfg.file });
  const data = await api(skillUrl);
  // Дата изменения — день, а не метка времени: в шапке рядом с путём и числом
  // файлов часы только шумят.
  const byWhom = data.ownerIsMe ? '' : ' · ' + fill(cfg.ui.skillTagFrom, { owner: data.owner });
  const state = data.enabled ? cfg.ui.skillEnabled : cfg.ui.skillDisabled;
  const meta = data.id + byWhom + ' · ' + state + ' · ' + countLabel(data.files, cfg.ui.filesWord) +
    ' · ' + cfg.ui.changedOn + ' ' + day(String(data.modified).slice(0, 10)) + (data.problem ? ' · ⚠ ' + data.problem : '');
  // Чужой скилл — только для чтения: редактор показывает содержимое, но поля
  // выключены. Включить/выключить его себе можно: это личный переключатель, а не
  // правка чужого файла. Историю чужого репозитория не показываем: она про файлы,
  // которых у получателя нет.
  const editable = data.canEdit !== false;
  // У чужого скилла нет ни истории, ни скачивания: и то и другое ходит в личный
  // репозиторий, а файл лежит в общем снимке, который только читается. У своего
  // выключенного скачивание тоже не предлагаем: файл лежит в .disabled/, а
  // маршрут файла ищет его в корне.
  showFileHead(data.name, meta, editable, editable && data.enabled);
  if (cfg.tab === 'history' && editable) {
    await renderHistory();
    return;
  }
  const banner = editable
    ? ''
    : '<p class="hint">' + esc(fill(cfg.ui.skillOwnerBanner, { owner: data.owner })) + '</p>';
  el('content').innerHTML = banner + skillForm();
  fillSkill(data);
  // Корневой SKILL.md — не отдельный скилл, а весь каталог: делиться им нельзя.
  if (el('skill-share-row')) el('skill-share-row').hidden = !editable || data.id === 'SKILL.md';
  if (!editable) {
    ['skill-name', 'skill-description', 'skill-body', 'skill-hidden'].forEach((id) => { el(id).disabled = true; });
    el('skill-save').hidden = true;
    el('skill-delete').hidden = true;
    skillStatus(fill(cfg.ui.skillReadOnly, { owner: data.owner }));
    return;
  }
  el('skill-save').onclick = guard(() => saveSkill(data.id));
  el('skill-delete').onclick = guard(() => deleteSkill(data));
  if (el('skill-share')) el('skill-share').onchange = guard(() => toggleShare(el('skill-share')));
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
  if (!response.ok) throw new Error(cfg.ui.downloadFailedPrefix + response.status);
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
    '<button id="clear"' + (selection.size ? '' : ' hidden') + '>' + esc(cfg.ui.clearSelection) + '</button>' +
    '<button class="danger" id="remove"' + (selection.size ? '' : ' hidden') + '>' + esc(fill(cfg.ui.deleteCount, { n: selection.size })) + '</button></div>' +
    '<div class="rows">' + rows + '</div>' +
    (data.capped ? '<p class="note">' + esc(cfg.ui.cappedNote) + '</p>' : '');

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
    ? fill(cfg.ui.selectedOf, { n: selection.size, total: data.total })
    : fill(cfg.ui.selectRows, { n: data.total, word: plural(data.total, cfg.ui.entriesWord) });
}

function updateBar(data) {
  const bar = el('bar');
  bar.classList.toggle('on', selection.size > 0);
  bar.querySelector('.grow').textContent = barText(data);
  el('clear').hidden = !selection.size;
  el('remove').hidden = !selection.size;
  el('remove').textContent = fill(cfg.ui.deleteCount, { n: selection.size });
}

async function removeSelected(data) {
  const lines = [...selection].sort((a, b) => a - b);
  if (!lines.length) return;
  const what = lines.length === 1 ? cfg.ui.entryOne : cfg.ui.entryManyPrefix + lines.length;
  if (!(await askConfirm(fill(cfg.ui.removeMemoryPrompt, { what }), cfg.ui.confirmRemove))) return;
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
    : '<p class="empty">' + esc(cfg.mode === 'skills' ? cfg.ui.emptyHistorySkills : cfg.ui.emptyHistoryFile) + '</p>';
  el('content').querySelectorAll('.commit').forEach((node) => node.onclick = guard(() => showCommit(node.dataset.hash, node)));
}

/** Дифф открывается под коммитом: до этого в колонке видно саму историю. */
async function showCommit(hash, node) {
  el('content').querySelectorAll('.commit').forEach((other) => other.classList.toggle('active', other === node));
  const data = await api(endpoint('show', { commit: hash }));
  node.insertAdjacentHTML('afterend',
    '<div class="diff"><pre class="diff">' + esc(data.patch || cfg.ui.emptyDiff) + '</pre>' +
    '<div class="diff-actions"><button class="primary" id="revert">' + esc(cfg.ui.revert) + '</button>' +
    '<button data-close>' + esc(cfg.ui.close) + '</button></div></div>');

  const diff = node.nextElementSibling;
  diff.querySelector('[data-close]').onclick = (event) => {
    event.stopPropagation();
    diff.remove();
    node.classList.remove('active');
  };
  diff.querySelector('#revert').onclick = guard(async () => {
    if (!(await askConfirm(fill(cfg.ui.revertCommitPrompt, { hash: hash.slice(0, 8) }), cfg.ui.confirmRevert))) return;
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
  // Скачать можно любой файл раздела — и память, и SKILL.md: это чтение, а не
  // правка, и упирается оно в те же проверки пути, что и остальные запросы.
  el('download').hidden = !download;
}

async function renderContent() {
  // У скиллов своя правая колонка: там редактор, а не записи с галочками.
  if (cfg.mode === 'skills') {
    await renderSkill();
    return;
  }
  // «Пользователь» — форма настроек: у неё нет ни файла, ни записей, поэтому она
  // рисуется целиком здесь и больше никуда не ходит.
  if (cfg.mode === 'profile') {
    await renderProfile();
    return;
  }
  const path = cfg.file;
  if (!path) {
    showFileHead(null, null, false);
    el('content').innerHTML = '<p class="empty">' + esc(cfg.ui.emptyPickFile) + '</p>';
    return;
  }

  // Картинку тянем байтами и показываем как <img>: base64 в JSON раздул бы ответ
  // втрое, а картинки бывают на сотни килобайт.
  if (isImage(path)) {
    showFileHead(path, cfg.ui.imageMeta, false);
    const response = await fetch(endpoint('file', { path, raw: '1' }));
    if (!response.ok) { el('content').innerHTML = '<p class="empty">' + esc(cfg.ui.emptyImage) + '</p>'; return; }
    const url = URL.createObjectURL(await response.blob());
    el('content').innerHTML = '<img class="plot" alt="' + esc(path) + '">';
    el('content').querySelector('img').src = url;
    return;
  }

  const data = await api(endpoint('entries', { path }));
  showFileHead(path, countLabel(data.total, cfg.ui.entriesWord), true);
  if (cfg.tab === 'history') await renderHistory();
  else renderEntries(data);
}

// ── настройки: пользователь ──────────────────────────────────────────────────
// Две независимые настройки языка: ответы и интерфейс. Сохраняем сразу по клику —
// отдельная кнопка «Сохранить» у переключателя из двух вариантов только заставляет
// гадать, применилось ли. Статус пишем туда же, где человек смотрит.
async function renderProfile() {
  const data = await api('/panel/profile/api');
  // Поля uiLanguage может не быть (старый сервер, заглушка в тесте): панель должна
  // открыться, а не остаться пустой из-за отсутствующего ключа.
  const languages = data.languages || ['ru', 'en'];
  const labels = data.labels || {};
  const uiLanguages = data.uiLanguages || languages;
  const uiLabels = data.uiLabels || labels;

  const choice = (name, codes, codeLabels, current) =>
    '<div class="choice" data-choice="' + name + '">' + codes.map((code) =>
      '<label class="' + (code === current ? 'on' : '') + '" data-code="' + esc(code) + '">' +
        '<input type="radio" name="' + name + '" value="' + esc(code) + '"' + (code === current ? ' checked' : '') + '>' +
        '<b>' + esc(codeLabels[code] || code) + '</b>' +
        '<small>' + esc(code) + '</small>' +
      '</label>',
    ).join('') + '</div>';

  el('content').innerHTML =
    '<div class="lead-box">' +
      '<p class="field-label">' + esc(cfg.ui.answerLanguageLabel) + '</p>' +
      choice('language', languages, labels, data.language) +
      '<p class="hint" id="profile-status">' + esc(cfg.ui.answerLanguageHint) + '</p>' +
    '</div>' +
    '<div class="lead-box">' +
      '<p class="field-label">' + esc(cfg.ui.interfaceLanguageLabel) + '</p>' +
      choice('uiLanguage', uiLanguages, uiLabels, data.uiLanguage || cfg.ui.lang) +
      '<p class="hint" id="ui-status">' + esc(cfg.ui.interfaceLanguageHint) + '</p>' +
    '</div>';

  const bind = (name, statusId, saved) => {
    el('content').querySelectorAll('[data-choice="' + name + '"] input').forEach((input) => {
      input.onchange = guard(async () => {
        const status = el(statusId);
        status.textContent = cfg.ui.saving;
        try {
          await api('/panel/profile/api', { method: 'POST', body: JSON.stringify({ [name]: input.value }) });
          el('content').querySelectorAll('[data-choice="' + name + '"] label').forEach((label) =>
            label.classList.toggle('on', label.dataset.code === input.value));
          saved(input.value);
        } catch (error) {
          status.textContent = cfg.ui.saveFailedPrefix + error.message;
        }
      });
    });
  };

  bind('language', 'profile-status', (value) => {
    cfg.language = value;
    // Следующая реплика поднимает pi заново: AGENTS.md читается при старте.
    el('profile-status').textContent = cfg.ui.savedAnswer;
  });
  // Язык интерфейса меняет всю страницу, включая разметку, которую рисует сервер.
  // Перезагрузка — самый честный способ переключить её разом, без второго словаря
  // на клиенте.
  bind('uiLanguage', 'ui-status', () => location.reload());
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
  showFileHead(cfg.ui.searchTitle, fill(cfg.ui.searchMeta, { query, n: data.hits.length }), false, false);
  el('content').innerHTML = data.hits.length
    ? '<div class="files">' + data.hits.map((hit) =>
        '<div class="hit" data-path="' + esc(hit.path) + '"><b>' + esc(hit.path) + ':' + hit.line + '</b><div>' + esc(hit.text) + '</div></div>',
      ).join('') + '</div>'
    : '<p class="empty">' + esc(cfg.ui.emptyNoResults) + '</p>';
  el('content').querySelectorAll('.hit').forEach((node) => node.onclick = guard(() => go({ file: node.dataset.path, tab: 'notes' })));
}

/** Поиск по скиллам: находка открывает сам скилл, а не строку в файле. */
async function searchSkills(query) {
  const data = await api(endpoint('search', { q: query }));
  showFileHead(cfg.ui.searchTitle, fill(cfg.ui.searchMeta, { query, n: data.hits.length }), false, false);
  el('content').innerHTML = data.hits.length
    ? '<div class="files">' + data.hits.map((hit) =>
        '<div class="hit" data-id="' + esc(hit.id) + '"><b>' + esc(hit.name) + ':' + hit.line + '</b><div>' + esc(hit.text) + '</div></div>',
      ).join('') + '</div>'
    : '<p class="empty">' + esc(cfg.ui.emptyNoResults) + '</p>';
  el('content').querySelectorAll('.hit').forEach((node) => node.onclick = guard(() => go({ file: node.dataset.id, fresh: false, tab: 'notes' })));
}

el('tabs').querySelectorAll('.tab').forEach((tab) => tab.onclick = guard((event) => {
  event.preventDefault();
  go({ tab: tab.dataset.tab });
}));
// Строки поиска нет у настроек: раздел — форма, а не список файлов. Без проверки
// el('q') возвращает null, и присваивание onkeydown валит весь скрипт — до того,
// как страница нарисует хоть что-нибудь. Та же ловушка была со скиллами.
if (el('q')) el('q').onkeydown = (event) => { if (event.key === 'Enter') guard(doSearch)(); };
// «Новый скилл» — это адрес, а не скрытое состояние: ссылку на пустой редактор
// можно переслать, а «назад» возвращает к списку.
if (el('new-skill')) el('new-skill').onclick = guard(() => go({ file: null, fresh: true, tab: 'notes' }));

(async () => {
  document.title = '${PANEL_TITLE} · ' + cfg.user;
  await Promise.all([loadCounts(), cfg.mode === 'skills' ? loadSkills() : cfg.mode === 'profile' ? Promise.resolve() : loadFiles(), renderContent()]);
})().catch(fail);
</script>`, sessionUiLanguage(session));
}

/** Экранирование для недоверенных значений: имя человека из заголовка и тексты отказа. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
