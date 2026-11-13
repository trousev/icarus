// The control panel page: one HTML, no build and no dependencies.
//
// There is no password login here and there shouldn't be: the panel sits behind an SSO proxy, and all its
// requests are ordinary same-origin browser requests, to which the proxy itself attaches
// the name of the logged-in person. That's why the link has neither a key nor a token: if a person wasn't named
// by the proxy, the page honestly explains what's missing (see PanelDenial).
//
// The layout is a sidebar with sections, a row with breadcrumbs and search, and the section content.
// The server serves the frame and the section title, while lists, entries and history arrive from
// /panel/api/* already in the browser: for a person with a dozen memory files the page must
// open instantly, not wait while the service walks all the memory and git.
//
// State lives in the address (?scope=…&file=…&tab=…), so a link to a specific
// entry or file history can be forwarded, and the browser's "back" works as it should.
import { panelStrings, type PanelStrings } from './strings.ts';
import { DEFAULT_UI_LANGUAGE, isUiLanguage, type UiLanguage } from '../profile.ts';

export type PanelSection = { id: string; label: string };

/** The interface language from the session. An unknown or missing value means Russian. */
export function sessionUiLanguage(session: PanelSession): UiLanguage {
  return isUiLanguage(session.uiLanguage) ? session.uiLanguage : DEFAULT_UI_LANGUAGE;
}

export const sessionStrings = (session: PanelSession): PanelStrings => panelStrings(sessionUiLanguage(session));

/** Access denial: what happened and what to do about it. */
export type PanelDenial = { status: 401 | 403; message: string; hint: string };

export type PanelSession = {
  user: string;
  sections: PanelSection[];
  scopes: Record<string, 'memory' | 'skills' | 'profile'>;
  /** Scope labels: each has its own name, and there's no point inventing them in the browser. */
  scopeLabels?: Record<string, string>;
  /** Model and storage — what a person uses to check they're looking at the right panel. */
  model?: string;
  storage?: string;
  /** Whether there's anyone to write a skill for: the local panel has no model container. */
  draftSkills?: boolean;
  /** Whether an admin: the "Keys" section in the sidebar exists only for them. */
  admin?: boolean;
  /** This person's answer language: "ru" or "en". The "User" section is what deals with it. */
  language?: string;
  /** The panel interface language: a separate setting, "ru" or "en". */
  uiLanguage?: string;
};

export type PanelView = PanelSession | PanelDenial;

/** What's open in the section: the scope, the file and the tab inside the file. */
export type PanelPage = {
  section: string;
  scope?: string;
  file?: string;
  /** The owner of the open skill: for a shared one it's someone else's and can't be edited. */
  owner?: string;
  /** An empty editor of a new skill: the file doesn't exist yet, but the page does. */
  fresh?: boolean;
  tab?: 'notes' | 'history';
};

/**
 * The scope label. The server sends it already in the person's language; here only a
 * fallback remains for old calls and tests without `scopeLabels`.
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
 * The page shell: document head and styles are the same for everyone. `lang` is the interface
 * language: hyphenation, speech and how the browser searches the page depend on it.
 */
export function shell(body: string, lang: string = DEFAULT_UI_LANGUAGE): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PANEL_TITLE}</title>
<!-- The icon is drawn right here: the panel pulls no external files, and without
     it the browser asks for /favicon.ico on every open and gets a 404. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%237aa2f7'/%3E%3Ctext x='16' y='23' font-size='20' font-family='sans-serif' font-weight='bold' fill='%230f1116' text-anchor='middle'%3EI%3C/text%3E%3C/svg%3E">
<style>
  :root { color-scheme: dark; --bg:#0f1116; --side:#13161d; --panel:#1b1f28; --raise:#20242e;
          --line:#262b36; --text:#e6e8ec; --dim:#8b93a1; --accent:#7aa2f7; --accent-soft:#1e2a44; --danger:#f7768e;
          --busy:#e0af68; --unread:#9ece6a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  button { font:inherit; cursor:pointer; }
  .app { display:grid; grid-template-columns:250px 1fr; min-height:100vh; }

  /* Sidebar: on the left the panel sections and a note on what this panel runs on. */
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
  /* Back to chat — as a separate button: it's an exit from settings, not another section. */
  .nav-box { display:flex; flex-direction:column; }
  .nav-back { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line);
              border-radius:8px; background:var(--panel); color:var(--text); text-decoration:none; font-size:13px; }
  .nav-back:hover { border-color:var(--accent); background:var(--raise); }
  .nav-sep { border:0; border-top:1px solid var(--line); margin:16px 0; }
  .foot { margin-top:auto; display:flex; flex-direction:column; gap:8px; color:var(--dim); font-size:12px; }
  .foot div { display:flex; justify-content:space-between; gap:10px; }

  /* Top row: where we are, search across sections, and the agent state. */
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

  /* Scopes: personal, family, math. The number by a scope is how many files it has. */
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
  /* Settings have no file column: a single card spanning the full width. */
  .cols.single { grid-template-columns:minmax(0,1fr); }
  /* Language choice: a switch row, not a dropdown — there are two options,
     and both must be visible at once. */
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
  /* Two language settings — two blocks: the line between them prevents reading them as one. */
  .lead-box + .lead-box { border-top:1px solid var(--line); }
  .lead-box h3 { font-size:17px; margin:0 0 7px; }

  /* Right column: the open file in full — with head, tabs and entries. */
  .file-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; padding:16px 18px 12px; }
  /* While no file is open, a head with an empty name only takes up space. */
  .file-head[hidden] { display:none; }
  /* Tabs and "Download" — in one corner: tabs switch, the button grabs the file. */
  .head-actions { display:flex; gap:8px; align-items:center; flex:0 0 auto; }
  .head-actions [hidden] { display:none; }
  .file-head strong { font-family:ui-monospace, monospace; font-size:15px; }
  .meta { color:var(--dim); font-size:12px; margin-top:4px; }
  .tabs { display:flex; gap:4px; background:var(--raise); border-radius:9px; padding:3px; }
  /* display:flex is stronger than the hidden attribute, so we hide the tabs with an explicit rule. */
  .tabs[hidden] { display:none; }
  .tab { padding:6px 14px; border-radius:7px; color:var(--dim); text-decoration:none; font-size:13px; }
  .tab.active { background:var(--accent); color:#0f1116; }
  .file-body { padding:0 18px 18px; }

  /* The action bar appears only when there's a selection: we don't keep empty buttons. */
  .bar { display:flex; gap:12px; align-items:center; padding:11px 12px; margin-bottom:10px;
         border:1px solid var(--line); border-radius:9px; color:var(--dim); }
  .bar.on { background:var(--accent-soft); border-color:var(--accent); color:var(--text); }
  .bar .grow { flex:1; }
  .bar button, .btn { background:var(--raise); color:var(--text); border:1px solid var(--line);
                      border-radius:8px; padding:7px 14px; }
  .bar button:hover, .btn:hover { border-color:var(--accent); }
  /* While the model is writing, we don't press the button a second time: it's a minute and someone else's token. */
  button:disabled { opacity:.55; cursor:default; }
  button:disabled:hover { border-color:var(--line); }
  /* A validation failure in the skill editor: visible right where the "Save" button is. */
  #skill-status.bad { color:var(--danger); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#0f1116; font-weight:500; }
  button.danger { color:var(--danger); }
  button.danger:hover { border-color:var(--danger); }
  button.solid { background:var(--danger); border-color:var(--danger); color:#0f1116; }

  .rows { display:flex; flex-direction:column; }
  /* We align the row by the baseline: checkbox, number and text on one line,
     otherwise the number and checkbox float above the text. The number and date use the same font size and
     line height as the text: then they share a baseline. */
  .row { display:flex; gap:14px; align-items:baseline; padding:11px 8px; border-radius:8px; }
  .row:hover { background:var(--raise); }
  .row.sel { background:var(--accent-soft); }
  /* A checkbox has no baseline: it's not in the text flow, so we pull it
     to the row manually — otherwise it hangs above the text and number. */
  .row input { margin:0; position:relative; top:3px; width:15px; height:15px;
               accent-color:var(--accent); flex:0 0 auto; cursor:pointer; }
  .num { color:var(--dim); font:12px/1.6 ui-monospace, monospace; width:26px; flex:0 0 auto;
         user-select:none; -webkit-user-select:none; }
  .row-text { flex:1; min-width:0; word-break:break-word; }
  .date { color:var(--dim); font-size:12px; white-space:nowrap; }
  /* A section heading is not an entry: it has no checkbox, and there's no way to touch it. */
  .row.heading { background:var(--raise); cursor:default; }
  .row.heading .row-text { font-weight:500; }
  .row.plain { cursor:default; }
  .row.plain .row-text { color:var(--dim); }
  .plus { color:#4ade80; font:12px/1.6 ui-monospace, monospace; }
  .minus { color:var(--danger); font:12px/1.6 ui-monospace, monospace; }

  /* History: a commit and the lines for this file — a click opens the diff. */
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
  /* A skill in the list is a name and a one-line description: the model uses the description to decide
     when to open the skill, so in the list it matters more than the file size. */
  .file.skill .grow { white-space:normal; }
  .file.skill b { display:block; font-weight:500; }
  .file.skill .grow small { display:block; margin:2px 0 0; font-family:ui-sans-serif, system-ui, sans-serif;
                            font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .file .flag { color:var(--danger); margin-left:12px; cursor:help; }
  /* The status and owner of a skill in the list: enabled/disabled and "shared/received" —
     the same two things as with MCP, so they look familiar. */
  .file.skill.off .grow { opacity:.55; }
  .file .tags { display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex:0 0 auto; }
  .tag { display:inline-block; padding:1px 7px; border-radius:5px; font-size:10px; letter-spacing:.02em;
         background:var(--raise); color:var(--dim); white-space:nowrap; }
  .tag.on { background:#16301f; color:#9ece6a; }
  .tag.off { background:#33222a; color:var(--danger); }
  .tag.shared { background:var(--accent-soft); color:var(--accent); }
  /* The switch is the same as in forms: small, so it doesn't argue with the description. */
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

  /* The skill editor: fields instead of line-by-line entries — here you write the whole file. */
  .field { display:flex; flex-direction:column; gap:7px; padding:0 0 14px; }
  .field label { color:var(--dim); font-size:10px; letter-spacing:.14em; }
  .field input[type=text], .field textarea { background:var(--bg); border:1px solid var(--line);
      border-radius:9px; color:var(--text); font:inherit; padding:10px 12px; width:100%; }
  .field input[type=text] { font-family:ui-monospace, monospace; }
  .field textarea { resize:vertical; font:13px/1.7 ui-monospace, monospace; }
  .field textarea:focus, .field input[type=text]:focus { outline:none; border-color:var(--accent); }
  .field textarea#skill-body { min-height:320px; }
  /* "Write for me": as a separate block, because it's a different way to start a skill —
     not "fill in the fields", but "tell the idea, the fields will fill in themselves". */
  .generator { border:1px solid var(--line); border-radius:11px; padding:14px 14px 4px;
               margin:0 0 16px; background:var(--bg); }
  .generator .field textarea { background:var(--panel); min-height:auto; font:inherit; }
  .generator .row { display:flex; gap:10px; align-items:center; padding:0 0 12px; }
  .generator .row .grow { flex:1; color:var(--dim); font-size:12px; }
  .hint { color:var(--dim); font-size:12px; margin:0; padding:0 0 14px; }
  /* The caption for a settings block — the same style as the card headings. */
  .field-label { color:var(--dim); font-size:10px; letter-spacing:.14em; margin:0 0 10px; }
  .check { display:flex; gap:9px; align-items:center; color:var(--dim); font-size:13px; padding:0 0 16px; }
  /* display:flex is stronger than the hidden attribute, so we hide the sharing row explicitly. */
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
 * Denial: the proxy didn't name the person (401), or named someone who isn't in the config (403).
 * This is not a login form — the panel can't log anyone in — but an explanation of where to look for the cause.
 */
function denialPage(denial: PanelDenial): string {
  return shell(`<div class="banner">
  <h1>${PANEL_TITLE}</h1>
  <p class="about">${escapeHtml(denial.message)}</p>
  <p class="about">${escapeHtml(denial.hint)}</p>
</div>`);
}

/**
 * The settings sidebar: the way back to chat, a divider and the sections themselves. The same on
 * every settings page — otherwise their menu drifts from section to section.
 */
export function settingsAside(
  session: PanelSession,
  active: string,
  options: { scope?: string; foot?: Array<[string, string]> } = {},
): string {
  const ui = sessionStrings(session);
  const nav = session.sections
    .map((item) => {
      // Memory remembers the open scope: coming back from another section, the person
      // should land in the same personal or family memory, not the first one.
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
  // "User" is not a file list but a form. It needs neither a file column
  // nor search, so it draws its own right column entirely.
  const profile = page.section === 'profile';
  // The mode is a property of the section. It decides which routes the page calls and how
  // the right column is rendered: memory is edited line by line, skills as a file.
  const mode = skills ? 'skills' : profile ? 'profile' : 'memory';
  const sectionLabel = session.sections.find((item) => item.id === page.section)?.label ?? ui.sectionMemory;
  const title = skills ? ui.sectionSkills : profile ? ui.sectionProfile : scopeLabel(session, scope);
  const about = skills ? ui.aboutSkills : profile ? ui.aboutProfile : ui.aboutMemory;
  // Memory stays in the language of the context. The English interface must not create
  // the impression that it's about to be translated: we state the decision right in the section.
  const memoryNote =
    !skills && !profile && ui.lang !== 'ru' ? `<p class="hint">${escapeHtml(ui.memoryLanguageNote)}</p>` : '';
  // Breadcrumbs don't repeat the heading when the section is named the same: "Skills / Skills"
  // says nothing.
  const breadcrumbs = [`Icarus`, sectionLabel, ...(skills || profile ? [] : [title])];

  // The scope in the link belongs to memory only: skills have no scope of their own, and
  // `?scope=personal` in their address is exactly that confusion where the section showed
  // personal memory under its own heading.
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
    // For one's own skill the owner is the person, for a shared one it's the author. By
    // this field the panel decides whether to show the editor or read-only.
    owner: page.owner ?? session.user,
    fresh: Boolean(page.fresh),
    tab: page.tab === 'history' ? 'history' : 'notes',
    mode,
    scopes,
    // Whether there's anyone to write a skill. The local panel comes up without a
    // model container — there's no button at all, not "present but always fails".
    draftSkills: Boolean(session.draftSkills),
    labels: Object.fromEntries(scopes.map((name) => [name, scopeLabel(session, name)])),
    // Client script strings: the same dictionary as the server markup, so that
    // "Loading…" in the template and "Nothing found" after a search don't drift apart.
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

// Requests go as they are, without auth headers: the panel sits behind an SSO proxy,
// and it identifies the person by its own session cookie. Not JSON came back — so instead of
// an API response the browser got a login page: the session expired, and that must be told
// to the person rather than showing "Unexpected token <".
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
// A number with a word: Russian needs three forms ("1 skill", "2 skills", "11 skills"),
// English gets by with two. The forms come from the panel dictionary, the rule is here.
const plural = (n, words) => {
  if (cfg.ui.lang !== 'ru') return n === 1 ? words.one : words.many;
  const tens = n % 100, ones = n % 10;
  if (tens >= 11 && tens <= 14) return words.many;
  if (ones === 1) return words.one;
  if (ones >= 2 && ones <= 4) return words.few;
  return words.many;
};
// Substitution into a dictionary template: "{n} {word}" and the like. Without regexes: the strings
// come from JSON, and there's nothing to escape here.
const fill = (template, values) =>
  Object.entries(values).reduce((text, [key, value]) => text.split('{' + key + '}').join(String(value)), template);
const countLabel = (n, words) => fill(cfg.ui.countLabel, { n, word: plural(n, words) });
// Request address: the section sets the root, the scope refines memory. Skills and
// math have no scope, and scope in their requests would only be confusing.
const endpoint = (name, extra = {}) => {
  const query = cfg.mode === 'memory' ? { scope: cfg.scope, ...extra } : { ...extra };
  const suffix = new URLSearchParams(query).toString();
  return '/panel/' + cfg.section + '/' + name + (suffix ? '?' + suffix : '');
};

// The address is the state: the file, the tab and the empty editor are visible in the link,
// and "back" works.
function go(patch) {
  const next = { scope: cfg.scope, file: cfg.file, owner: cfg.owner, tab: cfg.tab, fresh: cfg.fresh, ...patch };
  const query = new URLSearchParams();
  // Only memory has a scope in the address: skills and math have none at all.
  if (cfg.mode === 'memory') query.set('scope', next.scope);
  if (next.file) query.set('file', next.file);
  // We write the owner only for someone else's skill: for one's own it's a redundant parameter
  // that would also break old links to "my skill".
  if (next.file && next.owner && next.owner !== cfg.user) query.set('owner', next.owner);
  if (next.fresh) query.set('new', '1');
  if (next.file && next.tab === 'history') query.set('tab', 'history');
  const suffix = query.toString();
  location.href = '/panel/' + cfg.section + (suffix ? '?' + suffix : '');
}

// Our own dialog instead of window.confirm: the browser mutes native modals if
// the tab isn't active, and the native confirm silently returns false — the buttons "don't work".
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

// Shared handler: any API error must be visible, not swallowed.
// We pass the event into the action: tab handlers call preventDefault themselves,
// and without the argument they crashed on "event is undefined" instead of navigating.
const guard = (action) => async (event) => {
  if (event && event.preventDefault) event.preventDefault();
  try { await action(event); } catch (error) { fail(error); }
};
function fail(error) {
  el('content').innerHTML = '<p class="empty">' + esc(cfg.ui.errorPrefix) + esc(error && error.message ? error.message : error) + '</p>';
}

// Counters for scopes and sections: how many files each has. Updated after edits.
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
  // We group files by shelf: in memory these are meaningful sections (people, matters,
  // journal), and a flat list of three dozen files would be unreadable.
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

// ── skills ───────────────────────────────────────────────────────────────────
// A skill is not a file in the list but a unit of work: a name, a description and an instruction.
// That's why the list shows skills (with the description — the model uses it to decide when
// to open the skill), and the right column is an editor for the whole file.
/** Skill badges: whose it is, whether it's enabled and whether it's broken. */
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
    // The root SKILL.md is the skills directory itself: it can't be disabled by moving.
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

/** The switch in the list: enable/disable a skill for yourself without opening the editor. */
async function toggleSkill(input) {
  const row = input.closest('.file');
  const owner = row.dataset.owner || cfg.user;
  const payload = { id: row.dataset.id, enabled: input.checked };
  if (owner !== cfg.user) payload.owner = owner;
  input.disabled = true;
  try {
    await api(endpoint('toggle'), { method: 'POST', body: JSON.stringify(payload) });
    await Promise.all([loadCounts(), loadSkills()]);
    // This same skill is open — the editor must show the new status.
    if (row.dataset.id === cfg.file && owner === cfg.owner && !cfg.fresh) await renderSkill();
  } catch (error) {
    // It didn't work — we put the checkbox back so it doesn't lie about the state.
    input.checked = !input.checked;
    throw error;
  } finally {
    input.disabled = false;
  }
}

/** The editor markup: static, fillSkill substitutes the values. */
function skillForm() {
  // The "write for me" block — only for a new skill and only when there's someone to write.
  // For an open skill it would mean "rewrite mine", which is a different button.
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
    // Sharing — only for one's own skill. Someone else's has no such row: the owner decides.
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

/** Share or hide the open skill: the same as the badge in the list, but in human terms. */
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
 * "Write for me": one request — and the fields are filled with a draft.
 *
 * Nothing appears on disk until then: the draft lives in the form, and the file and commit
 * are made by "Save". That way the person sees exactly what will go to Icarus and can fix it.
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
    // The name didn't come out — we take the person to where something is needed from them.
    (draft.name ? el('skill-body') : el('skill-name')).focus();
  } catch (error) {
    skillStatus(cfg.ui.skillWriteFailed + (error && error.message ? error.message : error), true);
  } finally {
    button.disabled = false;
  }
}

/** Saving: the file, the commit and the "resources updated" mark — in one request. */
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
    // We show a validation failure as a status line, not instead of the editor: otherwise
    // along with "no description" the text the person just wrote would disappear too.
    skillStatus(cfg.ui.saveFailedPrefix + (error && error.message ? error.message : error), true);
    return;
  }

  // From here we live at the address of the saved skill: the name could have changed, and
  // the directory moved with it — a reload would return the person to the old link.
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
 * The right column in the skills section: the empty editor of a new skill, the editor
 * of the open one, or the history — the same as for memory.
 */
async function renderSkill() {
  if (!cfg.file) {
    if (!cfg.fresh) {
      showFileHead(null, null, false);
      el('content').innerHTML = '<p class="empty">' + esc(cfg.ui.emptyPickSkill) + '</p>';
      return;
    }
    // Empty editor: there's nothing to download yet, and there are no history tabs yet.
    showFileHead(cfg.ui.newSkill, cfg.ui.notSaved, false, false);
    el('content').innerHTML = skillForm();
    fillSkill(null);
    // A new skill belongs to no one but the author yet: sharing will appear after
    // saving, when the skill has a file.
    if (el('skill-share-row')) el('skill-share-row').hidden = true;
    el('skill-save').onclick = guard(() => saveSkill(null));
    if (el('skill-write')) el('skill-write').onclick = guard(writeForMe);
    // It makes sense to start with the idea here: the fields below will fill in themselves.
    (el('skill-idea') || el('skill-name')).focus();
    return;
  }

  // One's own skill opens without an owner in the address: this is an old contract, and it
  // must keep working. Someone else's — with owner: otherwise two identical ids
  // can't be told apart.
  const skillUrl = cfg.owner && cfg.owner !== cfg.user
    ? endpoint('skill', { id: cfg.file, owner: cfg.owner })
    : endpoint('skill', { id: cfg.file });
  const data = await api(skillUrl);
  // The modification date is a day, not a timestamp: in the head, next to the path and the number
  // of files, the hours are just noise.
  const byWhom = data.ownerIsMe ? '' : ' · ' + fill(cfg.ui.skillTagFrom, { owner: data.owner });
  const state = data.enabled ? cfg.ui.skillEnabled : cfg.ui.skillDisabled;
  const meta = data.id + byWhom + ' · ' + state + ' · ' + countLabel(data.files, cfg.ui.filesWord) +
    ' · ' + cfg.ui.changedOn + ' ' + day(String(data.modified).slice(0, 10)) + (data.problem ? ' · ⚠ ' + data.problem : '');
  // Someone else's skill is read-only: the editor shows the content, but the fields
  // are disabled. You can still enable/disable it for yourself: that's a personal switch, not
  // an edit of someone else's file. We don't show the history of someone else's repository: it's about files
  // the recipient doesn't have.
  const editable = data.canEdit !== false;
  // Someone else's skill has neither history nor download: both go to the personal
  // repository, while the file lies in a shared snapshot that is read-only. For one's own
  // disabled skill we also don't offer download: the file lies in .disabled/, and
  // the file route looks for it in the root.
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
  // The root SKILL.md is not a separate skill but the whole directory: it can't be shared.
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

// Download is a request for bytes plus <a download>, not a navigation by address: navigating
// would take the person off the page, and a failed download would leave them with a blank
// tab instead of the panel. The server returns the name in a header anyway —
// the page doesn't parse it but takes the last path segment, which it already knows.
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
  // We release the blob right after the click: there's no point keeping a copy of the file in memory.
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
});

// ── memory entries ────────────────────────────────────────────────────────────
// A file line is an entry with a checkbox, a section heading, or just text.
// The selection lives in the browser and goes nowhere until "delete" is pressed.
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

// ── file history ────────────────────────────────────────────────────────────
// For memory the history is per open file, for skills it's for the whole directory: a skill is
// a directory, and the commit "skill «pirate-mode»" reads better than the history of its SKILL.md.
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

/** The diff opens under the commit: before that the column shows the history itself. */
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
// ── what to show in the right column ────────────────────────────────────────────

/**
 * The head of the open file: the name, the caption and the tabs. While there's no file, there's none either —
 * an empty head with a dash only confuses.
 *
 * Download is enabled separately: a new skill has a name but no file yet, and
 * a "Download" button on an empty editor would promise something that doesn't exist.
 */
function showFileHead(path, meta, tabs, download = Boolean(path)) {
  el('file-head').hidden = !path;
  el('file-name').textContent = path || '';
  el('file-meta').textContent = meta || '';
  el('tabs').hidden = !tabs;
  // Any file of the section can be downloaded — both memory and SKILL.md: this is a read, not
  // an edit, and it runs into the same path checks as the other requests.
  el('download').hidden = !download;
}

async function renderContent() {
  // Skills have their own right column: there it's the editor, not entries with checkboxes.
  if (cfg.mode === 'skills') {
    await renderSkill();
    return;
  }
  // "User" is a settings form: it has neither a file nor entries, so it
  // is drawn entirely here and doesn't go anywhere else.
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

  // We pull the image as bytes and show it as <img>: base64 in JSON would bloat the response
  // threefold, and images can be hundreds of kilobytes.
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

// ── settings: user ──────────────────────────────────────────────────
// Two independent language settings: answers and interface. We save immediately on click —
// a separate "Save" button for a two-option switch only makes one
// guess whether it applied. We write the status where the person is looking.
async function renderProfile() {
  const data = await api('/panel/profile/api');
  // The uiLanguage field may be missing (old server, stub in a test): the panel must
  // open, not stay empty because of a missing key.
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
    // The next turn starts pi anew: AGENTS.md is read at startup.
    el('profile-status').textContent = cfg.ui.savedAnswer;
  });
  // The interface language changes the whole page, including the markup the server renders.
  // A reload is the most honest way to switch it all at once, without a second dictionary
  // on the client.
  bind('uiLanguage', 'ui-status', () => location.reload());
}

// ── search ────────────────────────────────────────────────────────────────────
// The search box searches the open section: in memory — by entries, in skills — by their
// files, in math — by journals. Promising "across memory and skills" at once would
// be a lie: the section doesn't read other people's roots.
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

/** Skill search: a hit opens the skill itself, not a line in a file. */
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
// Settings have no search box: the section is a form, not a file list. Without the check,
// el('q') returns null, and assigning onkeydown crashes the whole script — before
// the page draws anything at all. The same trap existed with skills.
if (el('q')) el('q').onkeydown = (event) => { if (event.key === 'Enter') guard(doSearch)(); };
// "New skill" is an address, not hidden state: a link to the empty editor
// can be forwarded, and "back" returns to the list.
if (el('new-skill')) el('new-skill').onclick = guard(() => go({ file: null, fresh: true, tab: 'notes' }));

(async () => {
  document.title = '${PANEL_TITLE} · ' + cfg.user;
  await Promise.all([loadCounts(), cfg.mode === 'skills' ? loadSkills() : cfg.mode === 'profile' ? Promise.resolve() : loadFiles(), renderContent()]);
})().catch(fail);
</script>`, sessionUiLanguage(session));
}

/** Escaping for untrusted values: the person's name from a header and denial texts. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
