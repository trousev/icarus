// Chat page: the panel's main screen — dialogs, empty state and composer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPage } from '../src/control/chat-ui.ts';
import type { PanelSession } from '../src/control/ui.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [
    { id: 'memory', label: 'Память' },
    { id: 'skills', label: 'Скиллы' },
  ],
  scopes: { personal: 'memory', shared: 'memory' },
  model: 'deepseek-v4-flash',
  storage: 'git · local',
};

test('message styles ship as a shared file — the artifact edit chat uses the same one', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The feed, bubble, trace and .md moved into chat-messages.css: one file
  // for two places. If it breaks, the AI reply in the side panel drifts from the chat.
  assert.match(html, /\.turn \{ display: flex; gap: 10px; margin-bottom: 20px; \}/);
  assert.match(html, /\.turn\.user \.bubble/);
  assert.match(html, /\.md \{ font-size: 14px; line-height: 1\.65; word-break: break-word; \}/);
  assert.match(html, /\.trace \{ background: var\(--panel\); border: 1px solid var\(--line\)/);
  assert.match(html, /@keyframes pulse/);
});

test('the conversation header is labeled with the channel of the last message', () => {
  // One session per panel and Telegram: the history file doesn't show who spoke
  // last, so the service remembers the channel and the panel shows it in the header.
  const html = chatPage(SESSION, { chatId: 'telegram-42', enabled: true });
  assert.match(html, /id="chat-via"/);
  assert.match(html, /\.chat-via \{/, 'стиль метки едет в страницу');
  assert.match(html, /последняя реплика · /, 'клиент умеет подписывать канал');
  assert.match(html, /Разговор общий с Telegram/, 'панель честно говорит, что ответ не уедет в Telegram');
});

test('the chat is a feed with a composer and dialogs, not a settings table', () => {
  const html = chatPage(SESSION, { chatId: 'web-1', enabled: true });

  assert.match(html, /id="new-chat"/);
  assert.match(html, /Чем займёмся\?/);
  assert.match(html, /id="chat-input"/);
  assert.match(html, /id="chat-files"/, 'файл можно приложить');
  assert.match(html, /id="chat-attach"/, 'кнопка приложения');
  assert.match(html, /Поиск по названиям/);
  assert.match(html, /id="chat-list"/);
  assert.match(html, /id="chat-locked"/, 'у внешнего разговора есть плашка «только для чтения»');
  assert.match(html, /id="chat-status"/, 'статус сверху говорит, можно ли писать');
  assert.match(html, /href="\/panel\/memory"[^>]*><span>Настройки<\/span>/, 'в чате один вход в настройки');
  assert.doesNotMatch(html, /data-settings=/, 'списка разделов настроек в сайдбаре чата больше нет');
  assert.doesNotMatch(html, /settings-pane|settings-tabs|settings-frame/, 'настроек поверх чата с табами больше нет');
  assert.match(html, /\/panel\/api\/chat\/image/, 'локальные картинки отдаёт сервер');
  assert.match(html, /md-image/, 'markdown-картинки рисуются');
  // The renderer is wired in before the client: `markdown` is a plain global function.
  const rendererAt = html.indexOf('function imageSrc');
  const clientAt = html.indexOf('function assistantHtml');
  assert.ok(rendererAt > 0 && rendererAt < clientAt, 'markdown едет в страницу до чата');
  assert.match(html, /noopener noreferrer/, 'внешние ссылки открываются в новой вкладке');
  assert.match(html, /"chatId":"web-1"/);
  assert.match(html, /"enabled":true/);
  assert.doesNotMatch(html, /демо-режим/i, 'чат настоящий, без имитации');
});

test('the archive is a section of the same sidebar, not a separate page', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The conversation is hidden from view but not lost: the section is collapsed, the same list is inside,
  // and the counter is visible even when collapsed.
  assert.match(html, /id="archive-toggle"/);
  assert.match(html, /id="archive-list"[^>]*hidden/, 'по умолчанию архив свёрнут');
  assert.match(html, /id="archive-count"[^>]*hidden/, 'счётчик появляется только когда есть что считать');
  assert.match(html, /id="toggle-archive"[^>]*disabled/, 'в черновике архивировать нечего');
  assert.match(html, /id="chat-archived-tag"[^>]*hidden/, 'метка «в архиве» скрыта у обычного разговора');
});

test('in the chat sidebar "Artifacts" and "Settings" are on the same level', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Settings sections live on their own page; the chat has two doors on the same level.
  const links = [...html.matchAll(/class="side-link"[^>]*>/g)];
  assert.equal(links.length, 2, 'артефакты и настройки, без списка разделов');
  assert.match(html, /href="\/panel\/artifacts"[^>]*><span>Артефакты<\/span>/);
  assert.match(html, /href="\/panel\/memory"[^>]*><span>Настройки<\/span>/);
  assert.doesNotMatch(html, /<p class="side-title">/, 'заголовков групп нет');
});

test('clicking an empty spot in the sidebar does not collapse the dialogs column', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The padding around "ДИАЛОГИ" is just background: the panel only collapses on the cross,
  // otherwise any passing click on the sidebar closes it.
  assert.doesNotMatch(html, /el\('chat-side'\)\.addEventListener/, 'сайдбар не ловит клики фоном');
  assert.match(html, /el\('close-side'\)\.onclick = closeMenu/, 'крестик по-прежнему закрывает меню');
});

test('the panel can be collapsed only on small screens', () => {
  const html = chatPage(SESSION, { enabled: true });
  // On a wide screen the dialogs column is always there: neither ☰, nor ×, nor a
  // "collapsed" mode, otherwise the panel disappears for good.
  assert.doesNotMatch(html, /side-collapsed/, 'на широком экране нет сворачивания');
  assert.match(html, /\.side-close \{ display: none;/, 'крестик скрыт по умолчанию');
  assert.match(
    html,
    /@media \(max-width: 900px\)[\s\S]*?\.menu-btn, \.side-close \{ display: inline-block; \}/,
    'на узком экране ☰ и × снова видны',
  );
});

test('the scrollbar in the dialog list is thin and flush with the right edge', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The list overflows into the panel padding: the bar touches its edge instead of hanging
  // in the air, so the thickness can be half as much.
  assert.match(html, /\.chat-list \{[\s\S]*?margin-right: -12px/, 'полоса прижата к границе панели');
  assert.match(html, /\.chat-list \{[\s\S]*?scrollbar-gutter: stable/, 'место под полосу не прыгает');
  assert.match(html, /\.chat-list::-webkit-scrollbar \{ width: 4px; \}/, 'в списке полоса 4px, а не 8px');
  assert.match(html, /\.chat-scroll::-webkit-scrollbar \{ width: 8px; \}/, 'ленту не трогаем');
});

test('the scrollbar in the input field is thin and flush with the right edge', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The field overflows into the frame padding, like the dialog list: the bar touches the edge
  // instead of hanging in the middle of the field next to the button. That's why the buttons sit on top of the field.
  assert.match(html, /\.composer-box textarea \{[\s\S]*?margin-right: -9px/, 'полоса прижата к границе рамки');
  assert.match(html, /\.composer-box textarea \{[\s\S]*?scrollbar-gutter: stable/, 'место под полосу не прыгает');
  assert.match(html, /\.composer-box textarea::-webkit-scrollbar \{ width: 4px; \}/, 'в поле полоса 4px');
  assert.match(
    html,
    /\.composer-actions \{[\s\S]*?position: absolute;/,
    'кнопки не отнимают у поля правый край',
  );
  assert.match(html, /\.composer-box \{[\s\S]*?position: relative/, 'рамка держит кнопки внутри себя');
});

test('the sidebar width is draggable and remembered', () => {
  const html = chatPage(SESSION, { enabled: true });
  // A handle on the right edge: the column follows --side-w, on a narrow screen there is no handle.
  assert.match(html, /id="side-resizer"/, 'у границы есть ручка');
  assert.match(html, /grid-template-columns: var\(--side-w\) minmax\(0, 1fr\)/, 'колонка следует за шириной');
  assert.match(html, /localStorage\.setItem\(SIDE_WIDTH_KEY/, 'ширина переживает перезагрузку');
  assert.match(html, /\.side-resizer \{ display: none; \}/, 'на узком экране ручки нет');
});

test('to the right of the chat is the workspace files panel', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The panel is the third grid column: tree, preview and width/height handles.
  assert.match(html, /id="files-panel"/, 'панель есть в разметке');
  assert.match(html, /id="toggle-files"/, 'кнопка в шапке открывает её');
  assert.match(html, /id="files-tree"/, 'дерево файлов');
  assert.match(html, /id="files-preview"/, 'предпросмотр файла');
  assert.match(html, /id="files-resizer"/, 'ширина тянется');
  assert.match(html, /id="files-split"/, 'высота предпросмотра тянется');
  assert.doesNotMatch(html, /class="files-head"/, 'шапки нет: те же имя и путь дублирует дерево');
  assert.match(html, /id="files-close"/, 'на узком экране панель закрывается своим крестиком');
  assert.match(html, /\.files-close \{ display: none; \}/, 'на широком крестик не дублирует шапку');
  assert.match(
    html,
    /@media \(max-width: 1100px\)[\s\S]*?\.files-close \{ display: grid;/,
    'и появляется только в выдвижном режиме',
  );
  assert.match(html, /class="fdel"/, 'у каждой строки есть корзина');
  assert.match(html, /cfg\.ui\.deleteLabel \+ ' ' \+ entry\.name/, 'корзина подписана именем файла');
  assert.match(html, /function askDeleteEntry/, 'удаление спрашивает подтверждение');
  assert.match(html, /class="files-send"/, 'рядом со скачиванием есть кнопка «В чат»');
  assert.match(html, /Послать агенту/, 'кнопка вставки пути подписана');
  assert.match(html, /class="files-copy"/, 'текст из предпросмотра копируется в буфер');
  assert.match(html, /Скопировать содержимое в буфер обмена/, 'кнопка копирования подписана');
  assert.match(html, /function copyPreviewContent/, 'копирование вынесено в отдельную функцию');
  assert.match(html, /function insertPathIntoChat/, 'путь вставляется, а не переписывает поле');
  assert.match(html, /status === 409/, 'непустая папка подтверждается после ответа сервера');
  assert.match(
    html,
    /\.chat-app\.files-open \{ grid-template-columns: var\(--side-w\) minmax\(0, 1fr\) var\(--files-w\); \}/,
    'открытая панель занимает третью колонку',
  );
  assert.match(html, /\/panel\/api\/workspace-files/, 'дерево и предпросмотр ходят в свой API');
  assert.match(html, /icarus\.files-open/, 'открытость переживает перезагрузку');
  assert.match(html, /icarus\.files-w/, 'ширина тоже');
  assert.match(html, /const FILES_WIDTH_MAX = 1440/, 'потолок вдвое выше: панель можно растянуть на полэкрана');
  assert.match(html, /aria-valuemax="1440"/, 'ручка знает новый потолок');
  assert.match(html, /@media \(max-width: 1100px\)/, 'на среднем экране панель выдвигается поверх чата');
  // Search and highlighting are the other half of the "workspace browsing" idea: a file is found
  // by a chunk of text without knowing the folder, and the code in the preview is read visually.
  assert.match(html, /id="files-search"/, 'в панели есть поиск по файлам');
  assert.match(html, /function runFilesSearch/, 'поиск ходит в свой маршрут');
  assert.match(html, /class="srow/, 'находки рисуются строками результата');
  assert.match(html, /function searchSnippet/, 'совпадение подсвечивается в куске строки');
  assert.match(html, /filesUrl\(slug, 'search'/, 'маршрут поиска — search, а не дерево');
  assert.match(html, /function highlightCode/, 'код в предпросмотре подсвечивается');
  assert.match(html, /\.files-code \.tok-keyword/, 'у токенов есть цвета');
  const highlightAt = html.indexOf('function highlightCode');
  const clientAt = html.indexOf('function assistantHtml');
  assert.ok(highlightAt > 0 && highlightAt < clientAt, 'подсветка едет в страницу до клиента');
});

test('a new chat is a draft: the workspace is chosen right in it', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The button opens a new chat right away, and the workspace choice lives in its empty
  // state: the folder can be changed before the first message without losing the draft.
  assert.match(html, /id="draft-wrap" hidden/, 'черновик спрятан до клика');
  assert.match(html, /id="draft-item"/, 'у черновика своя строка в списке');
  assert.match(html, /el\('new-chat'\)\.onclick = \(\) => startDraft\(\)/, 'клик по кнопке сразу открывает новый чат');
  assert.match(html, /function startDraft\(workspace = defaultWorkspace\)/, 'workspace выбирается в черновике');
  assert.match(html, /function startDraft[\s\S]*?renderPicker\(\)/, 'в новом чате виден выбор workspace');
  assert.match(html, /function openWorkspace[\s\S]*?draftWorkspace = slug/, 'папку можно сменить до первого сообщения');
  assert.doesNotMatch(html, /function showPicker/, 'отдельного экрана выбора больше нет');
  assert.match(
    html,
    /body: JSON\.stringify\(\{ workspace: draftWorkspace \}\)/,
    'разговор создаётся сразу в выбранной папке',
  );
  assert.match(html, /async function createChat/, 'создание вынесено в отдельную функцию');
  assert.doesNotMatch(html, /newChat\(/, 'мгновенного создания больше нет');
  // The button and the draft are the same row height, otherwise the list jumps.
  assert.match(html, /--side-row: 58px/, 'высота строки задана один раз');
  assert.match(html, /\.new-chat \{[\s\S]*?height: var\(--side-row\)/, 'кнопка высотой со строку списка');
  assert.match(html, /\.draft-wrap \.chat-item \{[^}]*height: var\(--side-row\)/, 'черновик той же высоты');
});

test('the workspace chooser screen is aligned to the heading and has no extra label', () => {
  const html = chatPage(SESSION, { enabled: true });
  // "WORKSPACES" duplicated the heading, and the shared paragraph centering of the empty
  // chat pushed the explanation to the right of "Выберите workspace".
  assert.doesNotMatch(html, /ws-kicker/, 'подпись WORKSPACES убрана');
  assert.doesNotMatch(html, /\.chat-empty p \{/, 'общее правило абзацев не задевает выбор workspace');
  assert.match(html, /\.chat-empty > p \{/, 'центрируется только текст пустого чата');
});

test('there is no extra heading above the dialog list', () => {
  const html = chatPage(SESSION, { enabled: true });
  // "New chat" and conversations right away: the "ДИАЛОГИ" label duplicated the obvious.
  assert.doesNotMatch(html, /dialogs-head/, 'заголовок убран, список начинается сразу');
  assert.doesNotMatch(html, /chat-count/, 'счётчика тоже нет');
});

test('the chat client script compiles', () => {
  const html = chatPage(SESSION, { enabled: true });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test('without pi the composer is honestly disabled', () => {
  const html = chatPage(SESSION, { enabled: false });
  assert.match(html, /id="chat-input"[^>]*disabled/);
  assert.match(html, /чат недоступен/);
  assert.match(html, /"enabled":false/);
});

test('the chat page pulls no external files and brings no gaps', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(html, /Bearer |authorization/i, 'доступ решает SSO-прокси');
});

test('a reply can be stopped midway: the "stop" button in place of "send"', () => {
  const html = chatPage(SESSION, { chatId: 'web-1', enabled: true });
  assert.match(html, /id="chat-stop"/, 'в композере есть кнопка остановки');
  assert.match(html, /\/panel\/api\/chat\/abort/, 'она ходит в abort, а не просто прячется');
  assert.match(html, /function setLive/, 'показ кнопки переключается вместе с живым потоком');
});

test('a run in someone else\'s conversation does not lock the panel', () => {
  const html = chatPage(SESSION, { chatId: 'web-1', enabled: true });
  // The lock is gone: switching conversations and starting a new chat no longer depend on
  // whether a run is going somewhere. There used to be `if (streaming) return` in four places.
  assert.doesNotMatch(html, /if \(!id \|\| streaming\) return/, 'открыть другой разговор можно всегда');
  assert.doesNotMatch(html, /function startDraft[^]*?if \(streaming\) return/, 'новый чат заводится при чужом ходе');
  assert.doesNotMatch(html, /async function openWorkspace[^]*?if \(streaming\) return/, 'папка тоже переключается');
  // Busyness still blocks sending — but only in YOUR OWN conversation.
  assert.match(html, /busyChats\.has\(currentId\)/, 'в занятый разговор не пишем');
});

test('the bulletin reports on other people\'s runs: start, finish and a state snapshot', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /\/panel\/api\/chat\/events/, 'панель подписана на сводку');
  assert.match(html, /\/panel\/api\/chat\/status/, 'и сверяется снимком после переподключения');
  assert.match(html, /new EventSource/, 'сводка едет штатным EventSource');
  assert.match(html, /event\.type === 'busy'/, 'старт хода поднимает отметку');
  assert.match(html, /event\.type !== 'idle'/, 'финал её снимает');
});

test('the sidebar shows where a run is going and where there is something unread', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /class="chat-dot/, 'точка рисуется строкой списка');
  assert.match(html, /\.chat-dot\.busy/, 'жёлтая — ход идёт');
  assert.match(html, /\.chat-dot\.unread/, 'зелёная — есть непрочитанное');
  assert.match(html, /function markUnread/, 'зелёная ставится, когда ответ пришёл в неоткрытый разговор');
  assert.match(html, /function markRead/, 'и гаснет при открытии');
  assert.match(html, /icarus\.unread/, 'непрочитанное живёт в localStorage');
  assert.match(html, /function pruneUnread/, 'удалённые разговоры не оставляют вечную точку');
});

test('leaving a conversation does not abandon the run, it unsubscribes from the stream', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /function detachLive/, 'подписка снимается отдельно от остановки');
  assert.match(html, /liveAbort\.abort\(\)/, 'чтение потока рвётся, чтобы не читать в пустоту');
  // Stopping a run is still an explicit `stopStream` with a call to abort.
  assert.match(html, /async function stopStream/, 'стоп остался отдельной кнопкой');
});

test('subagents in the chat are shown as a live list, not a single line', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /function subagentsHtml/, 'список детей рисуется отдельно');
  assert.match(html, /step-update/, 'клиент понимает обновления шага');
  assert.match(html, /\.sub-step\.running/, 'у работающего ребёнка свой вид');
  assert.match(html, /details class="sub-actions"/, 'шаги ребёнка — вложенный раскрывающийся список');
  assert.match(html, /data-sub=/, 'раскрытое состояние привязано к конкретному ребёнку');
  assert.match(html, /последние /, 'если шагов больше, чем влезло, подпись честная');
});

test('search and page fetching are distinguished in the trace', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The step class is built from the tool: CSS paints the "PAGE" differently based on it.
  assert.match(html, /tool-' \+/, 'шаг знает свой инструмент');
  assert.match(html, /\.trace-step\.tool-web_fetch \.trace-label/, 'у извлечения свой цвет подписи');
});

test('there is no second progress screen under the input field: the trace already has it', () => {
  const html = chatPage(SESSION, { enabled: true });
  // The line under the composer remains for refusals and confirmations ("no more than 8
  // attachments", "stopped — you can keep writing"). What Icarus is doing right now,
  // it no longer narrates: steps, commands and subagents are visible in the trace.
  assert.match(html, /id="chat-note"/, 'место для отказа под полем ввода есть');
  assert.doesNotMatch(html, /chat-working/, 'строки «что сейчас происходит» больше нет');
  assert.doesNotMatch(html, /setNote\(\(event\.step\.label/, 'шаг не переписывается под композером');
  assert.doesNotMatch(html, /субагенты: /, 'счёт субагентов не дублируется мелким текстом');
  assert.doesNotMatch(html, /Икар отвечает…/, '«отвечает…» внизу тоже лишнее');
  assert.match(html, /не больше ' \+ MAX_FILES/, 'отказ по вложениям по-прежнему виден');
});

/* ── the chat client for real ────────────────────────────────────────────────
   Checking markup and function names is not enough: an error like `if (streaming)` instead of
   `if (streaming())` is invisible in the markup but breaks the panel. So we execute the
   script in the DOM — with network and EventSource stubs — and watch what it does. */
import { parseHTML } from 'linkedom';

/**
 * A route response that must be returned as a stream rather than JSON: `text`/`done` —
 * exactly as the server sends them in NDJSON. Without this the end of streaming cannot be checked.
 */
function streamReply(...lines: string[]) {
  return { stream: lines };
}

/** A route response that must fail (e.g. the run already finished). */
function failedReply(status = 404, body: unknown = {}) {
  return { failure: { status, body } };
}

/** Harness: the chat page, a fetch stub and an intercepted bulletin. */
async function driveChat(
  options: {
    chatId?: string;
    /** What to answer for routes; key is a path substring, value receives the url and init. */
    routes?: Record<string, (url: string, init?: RequestInit) => unknown>;
  } = {},
) {
  const html = chatPage(SESSION, { chatId: options.chatId, enabled: true });
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')].map((node) => node.textContent ?? '').filter(Boolean);

  const calls: string[] = [];
  const requests: { method: string; url: string }[] = [];
  const store = new Map<string, string>();
  /** What the panel put on the clipboard: the copy button is checked from here. */
  const clipboard: string[] = [];
  const globals = window as unknown as Record<string, unknown>;
  window.URL.createObjectURL = () => 'blob:x';
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // linkedom lacks scrollIntoView, and the panel scrolls the list to the new folder's field.
  (window.Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  // The chat script is a plain browser one: it reads `window.location`, not an argument.
  globals.location = { href: 'http://panel/panel/chat', search: '', pathname: '/panel/chat' };
  globals.history = { replaceState() {} };
  globals.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };

  window.fetch = async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push(path);
    requests.push({ method: init?.method || 'GET', url: path });
    const route = Object.entries(options.routes || {}).find(([key]) => path.includes(key))?.[1];
    const body = route ? route(path, init) : {};
    if (body && typeof body === 'object' && 'stream' in body) {
      const chunks = (body as { stream: string[] }).stream;
      let at = 0;
      return {
        ok: true,
        headers: { get: () => 'application/x-ndjson; charset=utf-8' },
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: async () =>
              at < chunks.length
                ? { value: new TextEncoder().encode(chunks[at++] + '\n'), done: false }
                : { done: true },
          }),
        },
      };
    }
    if (body && typeof body === 'object' && 'failure' in body) {
      const { status, body: failed } = (body as { failure: { status: number; body: unknown } }).failure;
      return {
        ok: false,
        status,
        statusText: 'Not Found',
        headers: { get: () => 'application/json' },
        json: async () => failed,
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      };
    }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => body,
      body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    };
  };

  /** Bulletin: what the panel listens to — we keep the last instance. */
  let bulletin: { onopen?: () => void; onmessage?: (message: { data: string }) => void } | null = null;
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      bulletin = this as unknown as typeof bulletin;
    }
  }
  globals.EventSource = FakeEventSource;

  const code = scripts.join('\n');
  const run = new Function(
    'window',
    'document',
    'fetch',
    'URL',
    'location',
    'history',
    'localStorage',
    'navigator',
    code,
  );
  const browserClipboard = {
    clipboard: { writeText: async (text: string) => void clipboard.push(text) },
  };
  run(
    window,
    document,
    window.fetch,
    window.URL,
    globals.location,
    globals.history,
    globals.localStorage,
    browserClipboard,
  );
  // The script is async: we let microtasks and timers run.
  await new Promise((resolve) => setTimeout(resolve, 40));

  return {
    document,
    window,
    calls,
    requests,
    store,
    clipboard,
    /** Play a bulletin event the way the server would. */
    event: (payload: Record<string, unknown>) => bulletin?.onmessage?.({ data: JSON.stringify(payload) }),
    sidebar: () => document.getElementById('chat-list')?.innerHTML ?? '',
    /** Reply bodies in the feed: as many cards as a person sees. */
    bodies: () => document.querySelectorAll('.turn.assistant').length,
    /** We look for a piece of the conversation right in the feed. */
    messages: () => document.getElementById('chat-messages')?.innerHTML ?? '',
  };
}

test('the panel opens with someone else\'s conversation busy and does not fall over', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: ['web-2'] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }, { id: 'web-2', title: 'Долгий таск' }] }),
    },
  });

  // Conversation web-2 is running: only it is marked, the rest are not.
  assert.match(app.sidebar(), /chat-dot busy/, 'занятый разговор помечен жёлтой точкой');
  const dots = [...app.sidebar().matchAll(/chat-dot (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(dots, ['busy'], 'единственная точка — на работающем разговоре');
});

test('a reply in an unopened conversation sets a green dot, opening it clears it', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }, { id: 'web-2', title: 'Долгий таск' }] }),
    },
  });

  // The run in web-2 finished while the person was looking at web-1.
  app.event({ userId: 'probe', chatId: 'web-2', type: 'idle', chat: { id: 'web-2', title: 'Долгий таск' } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(app.sidebar(), /chat-dot unread/, 'непрочитанный ответ помечен зелёной точкой');
  const stored = JSON.parse(app.store.get('icarus.unread') || '[]');
  assert.ok(stored.includes('web-2'), 'непрочитанное переживёт перезагрузку: оно в localStorage');
});

test('the bulletin raises and clears the yellow dot on someone else\'s conversation', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }, { id: 'web-2', title: 'Долгий таск' }] }),
    },
  });

  app.event({ userId: 'probe', chatId: 'web-2', type: 'busy' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(app.sidebar(), /chat-dot busy/, 'начали думать — точка зажглась');

  app.event({ userId: 'probe', chatId: 'web-2', type: 'idle', chat: { id: 'web-2', title: 'Долгий таск' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(app.sidebar(), /chat-dot unread/, 'кончили — жёлтая сменилась зелёной');
  assert.doesNotMatch(app.sidebar(), /chat-dot busy/, 'жёлтой больше нет');
});

test('the panel subscribes to the bulletin and checks against a state snapshot', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
    },
  });

  assert.ok(app.calls.some((call) => call.includes('/panel/api/chat/status')), 'снимок занятости спрошен при входе');
});

test('returning to a running run does not duplicate the reply in the feed', async () => {
  // A real return: the history opened, the live stream was picked up, the person left
  // and came back. Previously each subscription added its own body — and the same
  // reply hung in the feed as many times as you entered it.
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: ['web-1'] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: true,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
    },
  });
  assert.equal(app.bodies(), 1, 'идущий ход рисует ровно одно тело');

  // The person left for another conversation — the card stays in the feed in its place,
  // not thrown out, and the subscription is removed.
  app.document.querySelector('[data-id="web-1"]').onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Came back — the same run, not a second reply.
  app.document.querySelector('[data-id="web-1"]').onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(app.bodies(), 1, 'второй вход в тот же ход подхватывает то же тело');
});

test('idle from the bulletin does not erase an already shown reply', async () => {
  // The same old recurrence: `idle` comes over the bulletin, `done` over the conversation stream, these
  // are different connections, and the bulletin arrives first. Previously `idle` threw the live
  // card out of the feed on the assumption that "the conversation record would replace it", but the record
  // was never redrawn — the reply disappeared until the page reloaded.
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: ['web-1'] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: true,
      }),
      '/panel/api/chat/stream': () =>
        streamReply(JSON.stringify({ type: 'text', text: 'ответ, который нельзя терять' })),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
    },
  });
  assert.equal(app.bodies(), 1, 'ход идёт — тело на месте');
  assert.match(app.messages(), /ответ, который нельзя терять/, 'текст уже достримился');

  app.event({ userId: 'probe', chatId: 'web-1', type: 'idle', chat: { id: 'web-1', title: 'Разговор' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.bodies(), 1, 'запись разговора — это и есть та же плашка, вторую не рисуем');
  assert.match(app.messages(), /ответ, который нельзя терять/, 'ответ остался в ленте после idle');
});

test('the end of streaming leaves the reply in the feed instead of hiding it until reload', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
      '/panel/api/chat/send': () =>
        streamReply(
          JSON.stringify({ type: 'text', text: 'готово: ' }),
          JSON.stringify({ type: 'text', text: 'ответ целиком' }),
          JSON.stringify({ type: 'done', chat: { id: 'web-1', title: 'Разговор' } }),
        ),
    },
  });

  app.document.getElementById('chat-input').value = 'привет';
  app.document.getElementById('chat-send').onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.match(app.messages(), /ответ целиком/, 'после done ответ остался на экране');
  assert.ok(app.messages().includes('привет'), 'и реплика человека тоже');
  assert.equal(app.bodies(), 1, 'одно тело ответа, без дублей');
});

test('the run ended between history and subscription — the feed re-reads itself', async () => {
  // A race: history said `live`, but `/chat/stream` already 404s — the run was just
  // recorded. Without re-reading the feed the reply is invisible until reload.
  let historyCalls = 0;
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => {
        historyCalls += 1;
        const chat = { id: 'web-1', title: 'Разговор', workspace: 'talk' };
        if (historyCalls === 1) return { chat, messages: [], live: true };
        return {
          chat,
          messages: [
            { role: 'user', text: 'привет' },
            { role: 'assistant', text: 'ответ, который уже записан', timestamp: new Date().toISOString() },
          ],
          live: false,
        };
      },
      '/panel/api/chat/stream': () => failedReply(404),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
    },
  });

  assert.match(app.messages(), /ответ, который уже записан/, 'записанный ответ подтянулся без F5');
  assert.equal(app.bodies(), 1, 'пустая плашка-пустышка выброшена, остался только ответ');
});

test('files panel: tree, folder expansion and markdown preview', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      // The long route comes first: otherwise the short key would intercept it too.
      '/panel/api/workspace-files/read': () => ({
        file: {
          name: 'AGENTS.md',
          path: 'projects/AGENTS.md',
          dir: false,
          size: 42,
          mtime: '',
          type: 'MARKDOWN',
          image: false,
        },
        kind: 'markdown',
        text: '# Проект\n\nВложенные инструкции.\n\n| шаг | кто |\n| --- | --- |\n| миграция | Дмитрий |',
        download: '/panel/api/workspace-files/raw?workspace=talk&path=projects%2FAGENTS.md&download=1',
      }),
      '/panel/api/workspace-files': (url: string) => {
        const query = new URLSearchParams(String(url).split('?')[1] || '');
        const at = query.get('path') || '';
        return {
          workspace: { slug: 'talk', name: 'Разговор', path: '~/icarus/workspaces/talk' },
          path: at,
          entries:
            at === 'projects'
              ? [
                  {
                    name: 'AGENTS.md',
                    path: 'projects/AGENTS.md',
                    dir: false,
                    size: 42,
                    mtime: '',
                    type: 'MARKDOWN',
                    image: false,
                  },
                ]
              : [
                  {
                    name: 'AGENTS.md',
                    path: 'AGENTS.md',
                    dir: false,
                    size: 12,
                    mtime: '',
                    type: 'MARKDOWN',
                    image: false,
                  },
                  { name: 'projects', path: 'projects', dir: true, size: 0, mtime: '', type: '', image: false },
                ],
          truncated: false,
        };
      },
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
    },
  });

  app.document.getElementById('toggle-files').onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(app.store.get('icarus.files-open'), '1', 'открытость панели запоминается');

  const tree = app.document.getElementById('files-tree');
  assert.match(tree.innerHTML, /class="files-root"/, 'над деревом — подпись корня');
  assert.match(tree.innerHTML, /workspaces\/talk/, 'и его папка на диске');
  assert.match(tree.innerHTML, /AGENTS\.md/);
  assert.match(tree.innerHTML, /projects\//, 'папки видны');
  assert.match(tree.innerHTML, /class="ftype">MARKDOWN/, 'тип файла подписан');

  const folder = app.document.querySelector('.frow[data-path="projects"]');
  folder?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(tree.innerHTML, /projects\/AGENTS\.md/, 'папка раскрылась и подгрузила содержимое');

  const file = app.document.querySelector('.frow[data-path="projects/AGENTS.md"]');
  file?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));

  const preview = app.document.getElementById('files-preview');
  assert.match(preview.innerHTML, /projects\/AGENTS\.md/, 'в предпросмотре видно путь файла');
  assert.match(preview.innerHTML, /Вложенные инструкции/, 'markdown отрисован, а не лежит текстом');
  assert.match(preview.innerHTML, /<table>/, 'таблица из markdown — настоящая таблица');
  assert.match(preview.innerHTML, /<th>шаг<\/th>/, 'шапка таблицы на месте');
  assert.match(preview.innerHTML, /<td>миграция<\/td>/, 'строка таблицы на месте');
  assert.ok(
    app.document.getElementById('files-panel').classList.contains('has-preview'),
    'предпросмотр занимает нижнюю половину панели',
  );

  // "To chat" is insertion, not sending: what's typed stays, the path is appended.
  const composer = app.document.getElementById('chat-input');
  composer.value = 'Проверь ';
  app.document.querySelector('.files-send')?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  assert.equal(composer.value, 'Проверь projects/AGENTS.md', 'путь вставлен, набранное сохранено');
  app.document.querySelector('.files-send')?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  assert.equal(
    composer.value,
    'Проверь projects/AGENTS.md projects/AGENTS.md',
    'повторная вставка не переписывает прошлое',
  );

  // Clicking the selected file again gives the tree back the full panel height.
  app.document
    .querySelector('.frow[data-path="projects/AGENTS.md"]')
    ?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(preview.innerHTML, '', 'предпросмотр спрятан');
  assert.ok(!app.document.getElementById('files-panel').classList.contains('has-preview'));

  app.document.getElementById('toggle-files').onclick?.();
  assert.equal(app.store.get('icarus.files-open'), '0', 'закрытие тоже запоминается');
});

test('content copying is available for text but not for an image', async () => {
  const markdown = '# Проект\n\nТекст файла.';
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/workspace-files/read': (url: string) => {
        const query = new URLSearchParams(String(url).split('?')[1] || '');
        return query.get('path') === 'logo.png'
          ? {
              file: { name: 'logo.png', path: 'logo.png', dir: false, size: 10, mtime: '', type: 'PNG', image: true },
              kind: 'image',
              url: '/panel/api/workspace-files/raw?workspace=talk&path=logo.png',
              download: '/panel/api/workspace-files/raw?workspace=talk&path=logo.png&download=1',
            }
          : {
              file: { name: 'plan.md', path: 'plan.md', dir: false, size: 10, mtime: '', type: 'MARKDOWN', image: false },
              kind: 'markdown',
              text: markdown,
              download: '/panel/api/workspace-files/raw?workspace=talk&path=plan.md&download=1',
            };
      },
      '/panel/api/workspace-files': () => ({
        workspace: { slug: 'talk', name: 'Разговор', path: '~/icarus/workspaces/talk' },
        path: '',
        entries: [
          { name: 'logo.png', path: 'logo.png', dir: false, size: 10, mtime: '', type: 'PNG', image: true },
          { name: 'plan.md', path: 'plan.md', dir: false, size: 10, mtime: '', type: 'MARKDOWN', image: false },
        ],
        truncated: false,
      }),
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
    },
  });

  app.document.getElementById('toggle-files').onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const preview = app.document.getElementById('files-preview');
  app.document
    .querySelector('.frow[data-path="plan.md"]')
    ?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(preview.querySelector('.files-copy'), 'у markdown кнопка копирования есть');

  preview.querySelector('.files-copy')?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The raw markdown goes to the clipboard: rendered html is useless when pasting into an editor.
  assert.equal(app.clipboard.at(-1), markdown, 'скопирован исходный текст, а не html');
  assert.ok(
    preview.querySelector('.files-copy')?.classList.contains('copied'),
    'после клика иконка подтверждает копирование',
  );

  app.document
    .querySelector('.frow[data-path="logo.png"]')
    ?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(preview.querySelector('.files-copy'), null, 'картинку в буфер не копируют — кнопки нет');
  assert.ok(preview.querySelector('.files-dl'), 'скачивание у картинки осталось');
});

test('tables in messages and preview have their own styles and scrolling', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /function isTableDivider/, 'markdown чата умеет таблицы');
  assert.match(html, /class="md-table"/, 'таблица оборачивается в блок с прокруткой');
  assert.match(html, /\.md \.md-table \{[\s\S]*?overflow-x: auto/, 'широкая таблица прокручивается сама');
  assert.match(html, /\.md \.md-table table \{[\s\S]*?border-collapse: collapse/, 'у таблицы есть рамки');
  assert.match(html, /\.md \.md-table th, \.md \.md-table td/, 'ячейки подписаны');
});

test('deletion: a file asks, an empty folder does not, a non-empty one does', async () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
  const deleted = new Set<string>();
  const top = [
    {
      name: 'AGENTS.md',
      path: 'AGENTS.md',
      dir: false,
      size: 5,
      mtime: '',
      type: 'MARKDOWN',
      image: false,
      removable: false,
    },
    { name: 'empty', path: 'empty', dir: true, size: 0, mtime: '', type: '', image: false },
    { name: 'plan.txt', path: 'plan.txt', dir: false, size: 3, mtime: '', type: 'TEXT', image: false },
    { name: 'projects', path: 'projects', dir: true, size: 0, mtime: '', type: '', image: false },
  ];
  const nested = [
    { name: 'AGENTS.md', path: 'projects/AGENTS.md', dir: false, size: 5, mtime: '', type: 'MARKDOWN', image: false },
  ];

  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/workspace-files': (url: string, init?: RequestInit) => {
        const parsed = new URL(String(url), 'http://panel');
        const at = parsed.searchParams.get('path') || '';
        if (init?.method === 'DELETE') {
          // A non-empty folder without force refuses exactly the way the server does.
          if (at === 'projects' && parsed.searchParams.get('force') !== '1') {
            return { failure: { status: 409, body: { error: { message: 'папка не пуста' } } } };
          }
          deleted.add(at);
          return { ok: true };
        }
        return {
          workspace: { slug: 'talk', name: 'Разговор', path: '~/icarus/stand/users/trousev/workspaces/talk' },
          path: at,
          entries: (at === 'projects' ? nested : top).filter((entry) => !deleted.has(entry.path)),
          truncated: false,
        };
      },
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
    },
  });

  const clickDelete = (path: string) => {
    app.document
      .querySelector(`.frow[data-path="${path}"] .fdel`)
      ?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  };
  const deletes = () => app.requests.filter((request) => request.method === 'DELETE');

  app.document.getElementById('toggle-files').onclick?.();
  await wait();

  // The root AGENTS.md holds workspace instructions: it has no trash can at all.
  assert.ok(app.document.querySelector('.frow[data-path="AGENTS.md"]'), 'AGENTS.md виден в дереве');
  assert.equal(
    app.document.querySelector('.frow[data-path="AGENTS.md"] .fdel'),
    null,
    'корневой AGENTS.md нельзя удалить — корзины нет',
  );
  assert.ok(app.document.querySelector('.frow[data-path="plan.txt"] .fdel'), 'у обычного файла корзина есть');

  // A file always asks. Cancelling means not a single request.
  clickDelete('plan.txt');
  await wait(20);
  let modal = app.document.querySelector('.ws-modal');
  assert.ok(modal, 'перед удалением файла есть подтверждение');
  assert.match(modal.innerHTML, /Удалить файл\?/);
  modal.querySelector('[data-cancel]').onclick?.();
  await wait(20);
  assert.equal(app.document.querySelector('.ws-modal'), null, 'окно закрылось');
  assert.equal(deletes().length, 0, 'отмена ничего не удаляет');

  // Confirmed — the file disappeared from the tree and the request went out without force.
  clickDelete('plan.txt');
  await wait(20);
  modal = app.document.querySelector('.ws-modal');
  modal.querySelector('[data-ok]').onclick?.();
  await wait(80);
  assert.ok(deletes().some((request) => request.url.includes('path=plan.txt')));
  assert.equal(app.document.querySelector('.frow[data-path="plan.txt"]'), null, 'строка файла пропала');

  // An empty folder is deleted immediately: no dialog, but a request.
  const beforeEmpty = deletes().length;
  clickDelete('empty');
  await wait(80);
  assert.equal(app.document.querySelector('.ws-modal'), null, 'пустую папку не подтверждаем');
  assert.ok(deletes().length > beforeEmpty, 'запрос на удаление пустой папки ушёл');
  assert.equal(app.document.querySelector('.frow[data-path="empty"]'), null, 'пустая папка пропала');

  // A non-empty folder: the server answers 409, the panel asks, then repeats with force.
  clickDelete('projects');
  await wait(80);
  modal = app.document.querySelector('.ws-modal');
  assert.ok(modal, 'непустая папка без подтверждения не удаляется');
  assert.match(modal.innerHTML, /не пуста/);
  assert.ok(
    deletes().some((request) => request.url.includes('path=projects') && !request.url.includes('force=1')),
    'первый запрос — без force',
  );
  modal.querySelector('[data-cancel]').onclick?.();
  await wait(20);
  assert.equal(
    app.document.querySelector('.frow[data-path="projects"]')?.dataset.dir,
    '1',
    'после отмены папка на месте',
  );

  clickDelete('projects');
  await wait(80);
  modal = app.document.querySelector('.ws-modal');
  modal.querySelector('[data-ok]').onclick?.();
  await wait(100);
  assert.ok(
    deletes().some((request) => request.url.includes('path=projects') && request.url.includes('force=1')),
    'после подтверждения — запрос с force',
  );
  assert.equal(app.document.querySelector('.frow[data-path="projects"]'), null, 'непустая папка удалена');
});

/* ── commands in the web chat ────────────────────────────────────────────────
   Previously only Telegram parsed commands, and "/stats" from the panel went to pi
   as a regular message. Here we check that the palette shows both its own commands
   and pi's commands, and that execution does not turn into a model run. */

/** Synthetic keypress: linkedom does not support KeyboardEvent, and `key` is needed. */
function pressKey(app: Awaited<ReturnType<typeof driveChat>>, input: unknown, key: string) {
  const event = app.document.createEvent('Event');
  event.initEvent('keydown', true, true);
  Object.defineProperty(event, 'key', { value: key });
  (input as { dispatchEvent(event: unknown): boolean }).dispatchEvent(event);
}

test('the palette shows its own commands right away, and pi commands after get_commands', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
      '/panel/api/chat/commands': () => ({
        commands: [{ name: 'skill:demo', description: 'демо-скилл', source: 'skill' }],
      }),
    },
  });

  const input = app.document.getElementById('chat-input');
  input.value = '/';
  input.dispatchEvent(new app.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 40));

  const palette = app.document.getElementById('cmd-palette');
  assert.equal(palette.hidden, false, 'по «/» палитра открывается');
  assert.match(palette.innerHTML, /\/help/, 'свои команды видны без запроса');
  assert.match(palette.innerHTML, /\/compact/);
  assert.match(palette.innerHTML, /\/skill:demo/, 'команда pi приехала из get_commands');
  assert.match(palette.innerHTML, /скилл/, 'источник команды подписан');

  // Arrow down and Enter complete the command but do not send it.
  pressKey(app, input, 'ArrowDown');
  pressKey(app, input, 'Enter');
  assert.equal(input.value, '/compact ');
  assert.equal(palette.hidden, true, 'выбор закрывает палитру');
  assert.ok(!app.calls.some((url) => url.includes('/chat/send')), 'отправки не было');
});

test('a chat command is executed by the server and answers with a card, not a model run', async () => {
  const commands: Array<Record<string, unknown>> = [];
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [{ role: 'user', text: 'привет' }],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
      '/panel/api/chat/commands': () => ({ commands: [] }),
      '/panel/api/chat/command': (_url, init) => {
        commands.push(JSON.parse(String(init?.body)));
        return { handled: true, text: 'Токенов всего: 150.' };
      },
      '/panel/api/chat/send': () => streamReply(JSON.stringify({ type: 'text', text: 'не должно случиться' })),
    },
  });

  const input = app.document.getElementById('chat-input');
  input.value = '/stats';
  input.dispatchEvent(new app.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  pressKey(app, input, 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(commands.length, 1, 'команда ушла на сервер один раз');
  assert.deepEqual(commands[0], { chatId: 'web-1', text: '/stats' });
  assert.match(app.messages(), /Токенов всего: 150/, 'ответ команды виден в ленте');
  assert.match(app.messages(), /\/stats/, 'и подписан самой командой');
  assert.ok(!app.calls.some((url) => url.includes('/chat/send')), 'в модель команда не уходила');
  assert.equal(input.value, '', 'поле очищено после выполнения');
});

test('a pi command is not intercepted: it goes to the conversation as a regular message', async () => {
  const commands: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
      '/panel/api/chat/commands': () => ({ commands: [{ name: 'skill:demo', description: 'демо' }] }),
      '/panel/api/chat/command': (_url, init) => {
        commands.push(JSON.parse(String(init?.body)));
        return { handled: false };
      },
      '/panel/api/chat/send': (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return streamReply(JSON.stringify({ type: 'text', text: 'скилл сработал' }));
      },
    },
  });

  const input = app.document.getElementById('chat-input');
  input.value = '/skill:demo покажи';
  input.dispatchEvent(new app.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  pressKey(app, input, 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(commands[0], { chatId: 'web-1', text: '/skill:demo покажи' });
  assert.equal(sent.length, 1, 'после отказа сервера реплика ушла в pi');
  assert.equal(sent[0]?.text, '/skill:demo покажи');
  assert.match(app.messages(), /скилл сработал/);
});

test('/clear keeps the old feed and draws a context boundary', async () => {
  let historyCalls = 0;
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => {
        historyCalls += 1;
        return {
          chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
          messages: [{ role: 'user', text: 'старая реплика' }],
          live: false,
        };
      },
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
      '/panel/api/chat/commands': () => ({ commands: [] }),
      '/panel/api/chat/command': () => ({
        handled: true,
        text: 'Начали с чистого листа.',
        cleared: true,
      }),
    },
  });

  const input = app.document.getElementById('chat-input');
  input.value = '/clear';
  input.dispatchEvent(new app.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  pressKey(app, input, 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(historyCalls, 1, 'ленту не перечитываем: старая история на месте');
  assert.match(app.messages(), /старая реплика/, 'старое сообщение осталось выше границы');
  assert.match(app.messages(), /turn divider/, 'нарисована граница контекста');
  assert.match(app.messages(), /Контекст очищен/);
});

test('/rename updates the header and sidebar without reloading the feed', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [{ role: 'user', text: 'старая реплика' }],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Разговор' }] }),
      '/panel/api/chat/commands': () => ({ commands: [] }),
      '/panel/api/chat/command': () => ({
        handled: true,
        text: 'Теперь этот разговор называется «Налоги».',
        title: 'Налоги',
      }),
    },
  });

  const input = app.document.getElementById('chat-input');
  input.value = '/rename Налоги';
  input.dispatchEvent(new app.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  pressKey(app, input, 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(app.document.getElementById('chat-title').textContent, 'Налоги', 'шапка обновилась');
  assert.match(app.sidebar(), /Налоги/, 'сайдбар тоже');
  assert.match(app.messages(), /Теперь этот разговор называется «Налоги»/, 'ответ команды виден');
  assert.match(app.messages(), /старая реплика/, 'лента не перечитывалась');
});

test('folders in the menu: grouping, moving from the menu and collapsed state', async () => {
  const posted: string[] = [];
  const folder = { id: 'f-work', name: 'Работа', createdAt: '2026-11-01T10:00:00.000Z', collapsed: false };
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({
        chats: [
          { id: 'web-1', title: 'Разговор', folder: 'f-work' },
          { id: 'web-2', title: 'Долгий таск' },
        ],
      }),
      '/panel/api/folders': (url, init) => {
        const method = init?.method || 'GET';
        if (method === 'GET') return { folders: [folder] };
        posted.push(method + ' ' + url + ' ' + String(init?.body ?? ''));
        // Create returns a new folder, edit returns the same one with a new state.
        if (method === 'POST') return { folder: { ...folder, id: 'f-home', name: 'Дом' } };
        return { folder: { ...folder, collapsed: true } };
      },
      '/panel/api/chat/folder': (url, init) => {
        posted.push((init?.method || 'GET') + ' ' + url + ' ' + String(init?.body ?? ''));
        return { ok: true };
      },
    },
  });

  // Two shelves: a folder with a conversation and "Inbox" for all the rest.
  assert.match(app.sidebar(), /folder-name">Работа/);
  assert.match(app.sidebar(), /folder-name">Входящие/);
  assert.match(app.sidebar(), /chat-item-title">Разговор/);

  // "⋯" on a conversation opens the menu: folders and "Inbox" are the same move, but without a mouse.
  app.document.querySelector('.chat-more[data-id="web-1"]')?.click();
  const menu = app.document.getElementById('chat-menu');
  assert.ok(menu, 'кнопка «⋯» открывает меню переноса');
  assert.match(menu.innerHTML, /Работа/, 'в меню есть папка');
  menu.querySelector('button[data-folder=""]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    posted.some((call) => call.includes('/panel/api/chat/folder') && call.includes('"folder":null')),
    'перенос во «Входящие» ушёл на сервер',
  );
  assert.equal(app.document.getElementById('chat-menu'), null, 'меню закрылось после выбора');

  // Clicking the heading collapses the folder: the server remembers the state, not the browser.
  (app.document.querySelector('.folder-head[data-folder="f-work"]') as unknown as { click: () => void }).click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    posted.some((call) => call.includes('PATCH') && call.includes('"collapsed":true')),
    'свёрнутость сохраняется на сервере',
  );
  assert.match(app.sidebar(), /folder-head collapsed/);

  // A new folder is created as a row in the list, without a modal.
  app.document.getElementById('new-folder')?.click();
  const input = app.document.getElementById('folder-new-name');
  assert.ok(input, 'по «+ Папка» появляется поле имени');
  (input as unknown as { value: string }).value = 'Дом';
  input.dispatchEvent(new app.window.Event('input'));
  pressKey(app, input, 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    posted.some((call) => call.includes('POST') && call.includes('/panel/api/folders') && call.includes('Дом')),
    'папка создана через API',
  );
  assert.match(app.sidebar(), /folder-name">Дом/);
});

test('search shows matches even in a collapsed folder', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      // The server searches by title, the panel just draws the response: here it is always one.
      '/panel/api/chats': () => ({
        chats: [{ id: 'web-1', title: 'Сводка по «Атласу»', folder: 'f-work' }],
      }),
      '/panel/api/folders': () => ({
        folders: [{ id: 'f-work', name: 'Работа', createdAt: '2026-11-01T10:00:00.000Z', collapsed: true }],
      }),
    },
  });

  // A collapsed folder must not hide what was found: otherwise "nothing found" is
  // a lie, the match simply lies on a closed shelf.
  assert.doesNotMatch(app.sidebar(), /chat-item-title">Сводка/, 'до поиска папка свёрнута');
  const search = app.document.getElementById('chat-search') as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  };
  search.value = 'Атлас';
  search.dispatchEvent(new app.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 320));

  assert.match(app.sidebar(), /chat-item-title">Сводка по «Атласу»/, 'найденное видно и в свёрнутой папке');
});

/* ── archive ─────────────────────────────────────────────────────────────────
   The archive is not deletion: the conversation leaves the daily list, but the history
   stays, and you can bring it back from there too. We check on the live client. */
type FakeChat = { id: string; title: string; workspace: string; preview: string };

/** Chat server stub: the list and the history share one set of archive flags. */
function archiveRoutes(all: FakeChat[], archived: Set<string>) {
  return {
    '/panel/api/chat/status': () => ({ busy: [] }),
    '/panel/api/chat/archive': (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { chatId: string; archived?: boolean };
      const next = body.archived !== false;
      if (next) archived.add(body.chatId);
      else archived.delete(body.chatId);
      return { chat: { id: body.chatId, archived: next } };
    },
    '/panel/api/chat/history': (url: string) => {
      const id = new URL(url, 'http://panel').searchParams.get('id');
      const chat = all.find((item) => item.id === id) ?? all[0];
      return { chat: { ...chat, archived: archived.has(chat.id) }, messages: [], live: false };
    },
    '/panel/api/chats': (url: string) => {
      const wantArchive = url.includes('archived=1');
      const list = all.filter((chat) => archived.has(chat.id) === wantArchive);
      return { chats: list.map((chat) => ({ ...chat, archived: archived.has(chat.id) })), total: list.length };
    },
  };
}

const архиве = (app: Awaited<ReturnType<typeof driveChat>>, id: string) =>
  app.document.getElementById(id);

test('"To archive" removes the conversation from the list instead of deleting it', async () => {
  const archived = new Set<string>();
  const all: FakeChat[] = [
    { id: 'web-1', title: 'Налоги', workspace: 'talk', preview: 'Разбери документы' },
    { id: 'web-2', title: 'Отпуск', workspace: 'talk', preview: 'Куда поехать' },
  ];
  const app = await driveChat({ chatId: 'web-1', routes: archiveRoutes(all, archived) });

  assert.match(app.sidebar(), /Налоги/, 'до архива разговор в списке');
  архиве(app, 'toggle-archive').click();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.doesNotMatch(app.sidebar(), /Налоги/, 'архивный ушёл из ежедневного списка');
  assert.match(app.sidebar(), /Отпуск/, 'остальные разговоры на месте');
  assert.ok(
    app.requests.some((request) => request.method === 'POST' && request.url.includes('/panel/api/chat/archive')),
    'архив — это отметка на сервере, а не локальная хитрость',
  );
  assert.equal(архиве(app, 'archive-count').textContent, '1', 'счётчик виден и в свёрнутой секции');
  assert.equal(архиве(app, 'archive-button-label').textContent, 'Вернуть', 'кнопка предлагает вернуть разговор');

  архиве(app, 'archive-toggle').click();
  assert.match(архиве(app, 'archive-list').innerHTML, /Налоги/, 'разговор лежит в архиве');
  assert.match(архиве(app, 'archive-list').innerHTML, /data-restore/, 'и его можно вернуть');
});

test('an archived conversation opens from the archive and returns to the daily list', async () => {
  const archived = new Set(['web-old']);
  const all: FakeChat[] = [
    { id: 'web-1', title: 'Новый', workspace: 'talk', preview: 'привет' },
    { id: 'web-old', title: 'Прошлогодний план', workspace: 'talk', preview: 'старое' },
  ];
  const app = await driveChat({ chatId: 'web-1', routes: archiveRoutes(all, archived) });

  assert.doesNotMatch(app.sidebar(), /Прошлогодний план/, 'архивный не висит в обычном списке');
  архиве(app, 'archive-toggle').click();
  const row = app.document.querySelector('#archive-list .chat-item');
  assert.ok(row, 'строка архива есть');
  assert.match(row?.innerHTML ?? '', /Прошлогодний план/);
  row?.click();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(архиве(app, 'chat-title').textContent, 'Прошлогодний план', 'архивный разговор открылся');
  assert.equal(архиве(app, 'chat-archived-tag').hidden, false, 'шапка говорит, что разговор в архиве');
  assert.equal(архиве(app, 'archive-button-label').textContent, 'Вернуть');

  архиве(app, 'toggle-archive').click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(app.sidebar(), /Прошлогодний план/, 'вернулся в ежедневный список');
  assert.equal(архиве(app, 'archive-count').textContent, '0', 'в архиве пусто');
  assert.equal(архиве(app, 'chat-archived-tag').hidden, true, 'метка в шапке снята');
});

test('the conversation name in the list is edited with a pencil and Enter', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Разговор', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': (_url, init) =>
        init?.method === 'PATCH'
          ? {
              chat: {
                id: 'web-1',
                title: 'Налоги',
                createdAt: '2026-11-01T10:00:00.000Z',
                channel: 'web',
                workspace: 'talk',
                readOnly: false,
              },
            }
          : { chats: [{ id: 'web-1', title: 'Разговор' }, { id: 'web-2', title: 'Долгий таск' }] },
    },
  });

  // The pencil lives on the list row: double-clicking the name does the same thing.
  const pencil = app.document.querySelector('.chat-rename') as unknown as {
    onclick: (event: { stopPropagation(): void }) => void;
  };
  assert.ok(pencil, 'у строки списка есть карандаш');
  pencil.onclick({ stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const input = app.document.querySelector('.chat-item-input') as unknown as { value: string } | null;
  assert.ok(input, 'вместо строки — поле ввода');
  input.value = 'Налоги';
  pressKey(app, input, 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(
    app.requests.some((request) => request.method === 'PATCH' && request.url.includes('/panel/api/chats')),
    'новое имя ушло на сервер',
  );
  assert.equal(app.document.getElementById('chat-title')?.textContent, 'Налоги', 'шапка обновилась');
  assert.match(app.sidebar(), /Налоги/, 'и строка списка тоже');
  assert.doesNotMatch(app.sidebar(), /chat-item-input/, 'поле закрылось');
});

test('a name invented by the model arrives via the bulletin and changes the header on the fly', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      '/panel/api/chat/status': () => ({ busy: [] }),
      '/panel/api/chat/history': () => ({
        chat: { id: 'web-1', title: 'Привет', workspace: 'talk' },
        messages: [],
        live: false,
      }),
      '/panel/api/chats': () => ({ chats: [{ id: 'web-1', title: 'Привет' }] }),
    },
  });

  app.event({
    userId: 'probe',
    chatId: 'web-1',
    type: 'title',
    chat: {
      id: 'web-1',
      title: 'Настройка памяти Икара',
      createdAt: '2026-11-01T10:00:00.000Z',
      channel: 'web',
      workspace: 'talk',
      readOnly: false,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(app.document.getElementById('chat-title')?.textContent, 'Настройка памяти Икара');
  assert.match(app.sidebar(), /Настройка памяти Икара/);
  assert.equal(app.document.title, 'Icarus · Настройка памяти Икара', 'заголовок вкладки тоже');
});
