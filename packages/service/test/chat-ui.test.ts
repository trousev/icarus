// Страница чата: главный экран панели — диалоги, пустое состояние и композер.
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

test('чат — это лента с композером и диалогами, а не таблица настроек', () => {
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
  // Разметка подключается раньше клиента: `markdown` — обычная глобальная функция.
  const rendererAt = html.indexOf('function imageSrc');
  const clientAt = html.indexOf('function assistantHtml');
  assert.ok(rendererAt > 0 && rendererAt < clientAt, 'markdown едет в страницу до чата');
  assert.match(html, /noopener noreferrer/, 'внешние ссылки открываются в новой вкладке');
  assert.match(html, /"chatId":"web-1"/);
  assert.match(html, /"enabled":true/);
  assert.doesNotMatch(html, /демо-режим/i, 'чат настоящий, без имитации');
});

test('в сайдбаре чата «Артефакты» и «Настройки» — на одном уровне', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Разделы настроек живут на своей странице; в чате — две двери одного уровня.
  const links = [...html.matchAll(/class="side-link"[^>]*>/g)];
  assert.equal(links.length, 2, 'артефакты и настройки, без списка разделов');
  assert.match(html, /href="\/panel\/artifacts"[^>]*><span>Артефакты<\/span>/);
  assert.match(html, /href="\/panel\/memory"[^>]*><span>Настройки<\/span>/);
  assert.doesNotMatch(html, /<p class="side-title">/, 'заголовков групп нет');
});

test('клик по пустому месту сайдбара не сворачивает колонку диалогов', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Отступы вокруг «ДИАЛОГИ» — просто фон: панель сворачивает только крестик,
  // иначе любая мимоходная клика по сайдбару закрывает его.
  assert.doesNotMatch(html, /el\('chat-side'\)\.addEventListener/, 'сайдбар не ловит клики фоном');
  assert.match(html, /el\('close-side'\)\.onclick = closeMenu/, 'крестик по-прежнему закрывает меню');
});

test('свернуть панель можно только на мелких экранах', () => {
  const html = chatPage(SESSION, { enabled: true });
  // На широком экране колонка диалогов всегда на месте: ни ☰, ни ×, ни режима
  // «свёрнуто», иначе панель безвозвратно пропадает.
  assert.doesNotMatch(html, /side-collapsed/, 'на широком экране нет сворачивания');
  assert.match(html, /\.side-close \{ display: none;/, 'крестик скрыт по умолчанию');
  assert.match(
    html,
    /@media \(max-width: 900px\)[\s\S]*?\.menu-btn, \.side-close \{ display: inline-block; \}/,
    'на узком экране ☰ и × снова видны',
  );
});

test('скролл в списке диалогов — тонкий и в стык с правой границей', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Список выезжает в padding панели: полоса касается её границы, а не висит
  // в воздухе, поэтому и толщину можно позволить вдвое меньше.
  assert.match(html, /\.chat-list \{[\s\S]*?margin-right: -12px/, 'полоса прижата к границе панели');
  assert.match(html, /\.chat-list \{[\s\S]*?scrollbar-gutter: stable/, 'место под полосу не прыгает');
  assert.match(html, /\.chat-list::-webkit-scrollbar \{ width: 4px; \}/, 'в списке полоса 4px, а не 8px');
  assert.match(html, /\.chat-scroll::-webkit-scrollbar \{ width: 8px; \}/, 'ленту не трогаем');
});

test('скролл в поле ввода — тонкий и в стык с правой границей', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Поле выезжает в padding рамки, как список диалогов: полоса касается границы,
  // а не висит посреди поля рядом с кнопкой. Кнопки поэтому стоят поверх поля.
  assert.match(html, /\.composer-box textarea \{[\s\S]*?margin-right: -9px/, 'полоса прижата к границе рамки');
  assert.match(html, /\.composer-box textarea \{[\s\S]*?scrollbar-gutter: stable/, 'место под полосу не прыгает');
  assert.match(html, /\.composer-box textarea::-webkit-scrollbar \{ width: 4px; \}/, 'в поле полоса 4px');
  assert.match(html, /\.send, \.stop \{ position: absolute;/, 'кнопки не отнимают у поля правый край');
  assert.match(html, /\.composer-box \{[\s\S]*?position: relative/, 'рамка держит кнопки внутри себя');
});

test('ширина сайдбара тянется и запоминается', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Ручка на правой границе: колонка следует за --side-w, на узком экране ручки нет.
  assert.match(html, /id="side-resizer"/, 'у границы есть ручка');
  assert.match(html, /grid-template-columns: var\(--side-w\) minmax\(0, 1fr\)/, 'колонка следует за шириной');
  assert.match(html, /localStorage\.setItem\(SIDE_WIDTH_KEY/, 'ширина переживает перезагрузку');
  assert.match(html, /\.side-resizer \{ display: none; \}/, 'на узком экране ручки нет');
});

test('справа у чата — панель файлов рабочей папки', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Панель — третья колонка сетки: дерево, предпросмотр и ручки ширины/высоты.
  assert.match(html, /id="files-panel"/, 'панель есть в разметке');
  assert.match(html, /id="toggle-files"/, 'кнопка в шапке открывает её');
  assert.match(html, /id="files-tree"/, 'дерево файлов');
  assert.match(html, /id="files-preview"/, 'предпросмотр файла');
  assert.match(html, /id="files-resizer"/, 'ширина тянется');
  assert.match(html, /id="files-split"/, 'высота предпросмотра тянется');
  assert.match(html, /id="files-close"/, 'панель можно закрыть');
  assert.match(html, /class="fdel"/, 'у каждой строки есть корзина');
  assert.match(html, /aria-label="Удалить /, 'корзина подписана именем файла');
  assert.match(html, /function askDeleteEntry/, 'удаление спрашивает подтверждение');
  assert.match(html, /class="files-send"/, 'рядом со скачиванием есть кнопка «В чат»');
  assert.match(html, /Послать агенту/, 'кнопка вставки пути подписана');
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
});

test('новый чат — черновик: workspace выбирается прямо в нём', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Кнопка сразу открывает новый чат, а выбор workspace'а живёт в его пустом
  // состоянии: папку можно менять до первого сообщения, не теряя черновик.
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
  // Кнопка и черновик — одна и та же высота строки, иначе список прыгает.
  assert.match(html, /--side-row: 58px/, 'высота строки задана один раз');
  assert.match(html, /\.new-chat \{[\s\S]*?height: var\(--side-row\)/, 'кнопка высотой со строку списка');
  assert.match(html, /\.draft-wrap \.chat-item \{[^}]*height: var\(--side-row\)/, 'черновик той же высоты');
});

test('экран выбора workspace выровнен по заголовку и без лишней подписи', () => {
  const html = chatPage(SESSION, { enabled: true });
  // «WORKSPACES» дублировала заголовок, а общее центрирование абзацев пустого
  // чата сдвигало пояснение вправо от «Выберите workspace».
  assert.doesNotMatch(html, /ws-kicker/, 'подпись WORKSPACES убрана');
  assert.doesNotMatch(html, /\.chat-empty p \{/, 'общее правило абзацев не задевает выбор workspace');
  assert.match(html, /\.chat-empty > p \{/, 'центрируется только текст пустого чата');
});

test('над списком диалогов нет лишнего заголовка', () => {
  const html = chatPage(SESSION, { enabled: true });
  // «Новый чат» и сразу разговоры: подпись «ДИАЛОГИ» дублировала очевидное.
  assert.doesNotMatch(html, /dialogs-head/, 'заголовок убран, список начинается сразу');
  assert.doesNotMatch(html, /chat-count/, 'счётчика тоже нет');
});

test('клиентский скрипт чата компилируется', () => {
  const html = chatPage(SESSION, { enabled: true });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test('без pi композер честно выключен', () => {
  const html = chatPage(SESSION, { enabled: false });
  assert.match(html, /id="chat-input"[^>]*disabled/);
  assert.match(html, /чат недоступен/);
  assert.match(html, /"enabled":false/);
});

test('страница чата не тянет внешних файлов и не приносит пропусков', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(html, /Bearer |authorization/i, 'доступ решает SSO-прокси');
});

test('ответ можно остановить на середине: кнопка «стоп» на месте «отправить»', () => {
  const html = chatPage(SESSION, { chatId: 'web-1', enabled: true });
  assert.match(html, /id="chat-stop"/, 'в композере есть кнопка остановки');
  assert.match(html, /\/panel\/api\/chat\/abort/, 'она ходит в abort, а не просто прячется');
  assert.match(html, /function setLive/, 'показ кнопки переключается вместе с живым потоком');
});

test('ход в чужом разговоре не запирает панель', () => {
  const html = chatPage(SESSION, { chatId: 'web-1', enabled: true });
  // Замок снят: переключение разговоров и новый чат больше не зависят от того,
  // идёт ли где-то ход. Раньше тут стояли `if (streaming) return` в четырёх местах.
  assert.doesNotMatch(html, /if \(!id \|\| streaming\) return/, 'открыть другой разговор можно всегда');
  assert.doesNotMatch(html, /function startDraft[^]*?if \(streaming\) return/, 'новый чат заводится при чужом ходе');
  assert.doesNotMatch(html, /async function openWorkspace[^]*?if \(streaming\) return/, 'папка тоже переключается');
  // Занятость по-прежнему останавливает отправку — но только в СВОЁМ разговоре.
  assert.match(html, /busyChats\.has\(currentId\)/, 'в занятый разговор не пишем');
});

test('сводка рассказывает про чужие ходы: старт, финал и снимок состояния', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /\/panel\/api\/chat\/events/, 'панель подписана на сводку');
  assert.match(html, /\/panel\/api\/chat\/status/, 'и сверяется снимком после переподключения');
  assert.match(html, /new EventSource/, 'сводка едет штатным EventSource');
  assert.match(html, /event\.type === 'busy'/, 'старт хода поднимает отметку');
  assert.match(html, /event\.type !== 'idle'/, 'финал её снимает');
});

test('в сайдбаре видно, где идёт ход и где есть непрочитанное', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /class="chat-dot/, 'точка рисуется строкой списка');
  assert.match(html, /\.chat-dot\.busy/, 'жёлтая — ход идёт');
  assert.match(html, /\.chat-dot\.unread/, 'зелёная — есть непрочитанное');
  assert.match(html, /function markUnread/, 'зелёная ставится, когда ответ пришёл в неоткрытый разговор');
  assert.match(html, /function markRead/, 'и гаснет при открытии');
  assert.match(html, /icarus\.unread/, 'непрочитанное живёт в localStorage');
  assert.match(html, /function pruneUnread/, 'удалённые разговоры не оставляют вечную точку');
});

test('уход из разговора не бросает ход, а отписывается от потока', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /function detachLive/, 'подписка снимается отдельно от остановки');
  assert.match(html, /liveAbort\.abort\(\)/, 'чтение потока рвётся, чтобы не читать в пустоту');
  // Остановка хода — это по-прежнему явный `stopStream` с походом в abort.
  assert.match(html, /async function stopStream/, 'стоп остался отдельной кнопкой');
});

test('субагенты в чате видны живым списком, а не одной строкой', () => {
  const html = chatPage(SESSION, { enabled: true });
  assert.match(html, /function subagentsHtml/, 'список детей рисуется отдельно');
  assert.match(html, /step-update/, 'клиент понимает обновления шага');
  assert.match(html, /\.sub-step\.running/, 'у работающего ребёнка свой вид');
  assert.match(html, /details class="sub-actions"/, 'шаги ребёнка — вложенный раскрывающийся список');
  assert.match(html, /data-sub=/, 'раскрытое состояние привязано к конкретному ребёнку');
  assert.match(html, /последние /, 'если шагов больше, чем влезло, подпись честная');
});

test('поиск и открытие страницы различаются в трассировке', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Класс шага строится из инструмента: по нему CSS красит «СТРАНИЦУ» иначе.
  assert.match(html, /tool-' \+/, 'шаг знает свой инструмент');
  assert.match(html, /\.trace-step\.tool-web_fetch \.trace-label/, 'у извлечения свой цвет подписи');
});

test('под полем ввода нет второго экрана прогресса: он и так в трассировке', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Строка под композером осталась для отказов и подтверждений («не больше 8
  // вложений», «остановил — можно писать дальше»). Что Икар делает прямо сейчас,
  // она больше не пересказывает: шаги, команды и субагенты видны в трассировке.
  assert.match(html, /id="chat-note"/, 'место для отказа под полем ввода есть');
  assert.doesNotMatch(html, /chat-working/, 'строки «что сейчас происходит» больше нет');
  assert.doesNotMatch(html, /setNote\(\(event\.step\.label/, 'шаг не переписывается под композером');
  assert.doesNotMatch(html, /субагенты: /, 'счёт субагентов не дублируется мелким текстом');
  assert.doesNotMatch(html, /Икар отвечает…/, '«отвечает…» внизу тоже лишнее');
  assert.match(html, /не больше ' \+ MAX_FILES/, 'отказ по вложениям по-прежнему виден');
});

/* ── клиент чата по-настоящему ───────────────────────────────────────────────
   Разметку и имена функций проверять мало: ошибка вроде `if (streaming)` вместо
   `if (streaming())` в разметке не видна, а панель ломает. Поэтому исполняем
   скрипт в DOM — с заглушками сети и EventSource — и смотрим, что он делает. */
import { parseHTML } from 'linkedom';

/**
 * Ответ маршрута, который надо отдать не JSON-ом, а потоком: `text`/`done` —
 * ровно так, как их шлёт сервер в NDJSON. Без этого конец стриминга не проверить.
 */
function streamReply(...lines: string[]) {
  return { stream: lines };
}

/** Ответ маршрута, который должен провалиться (например, ход уже кончился). */
function failedReply(status = 404, body: unknown = {}) {
  return { failure: { status, body } };
}

/** Стенд: страница чата, заглушка fetch и перехваченная сводка. */
async function driveChat(
  options: {
    chatId?: string;
    /** Что отвечать на маршруты; ключ — подстрока пути, значение получает адрес и init. */
    routes?: Record<string, (url: string, init?: RequestInit) => unknown>;
  } = {},
) {
  const html = chatPage(SESSION, { chatId: options.chatId, enabled: true });
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')].map((node) => node.textContent ?? '').filter(Boolean);

  const calls: string[] = [];
  const requests: { method: string; url: string }[] = [];
  const store = new Map<string, string>();
  const globals = window as unknown as Record<string, unknown>;
  window.URL.createObjectURL = () => 'blob:x';
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // Скрипт чата — обычный браузерный: он читает `window.location`, а не аргумент.
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

  /** Сводка: то, что панель слушает, — храним последний экземпляр. */
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
  const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', 'localStorage', code);
  run(window, document, window.fetch, window.URL, globals.location, globals.history, globals.localStorage);
  // Скрипт асинхронный: даём микрозадачам и таймерам пройти.
  await new Promise((resolve) => setTimeout(resolve, 40));

  return {
    document,
    window,
    calls,
    requests,
    store,
    /** Проиграть событие сводки, как это сделал бы сервер. */
    event: (payload: Record<string, unknown>) => bulletin?.onmessage?.({ data: JSON.stringify(payload) }),
    sidebar: () => document.getElementById('chat-list')?.innerHTML ?? '',
    /** Тела ответа в ленте: столько плашек, сколько видит человек. */
    bodies: () => document.querySelectorAll('.turn.assistant').length,
    /** Кусок разговора ищем прямо в ленте. */
    messages: () => document.getElementById('chat-messages')?.innerHTML ?? '',
  };
}

test('панель открывается с занятым чужим разговором и никуда не падает', async () => {
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

  // Разговор web-2 в работе: он один и помечен, остальные — нет.
  assert.match(app.sidebar(), /chat-dot busy/, 'занятый разговор помечен жёлтой точкой');
  const dots = [...app.sidebar().matchAll(/chat-dot (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(dots, ['busy'], 'единственная точка — на работающем разговоре');
});

test('ответ в неоткрытый разговор ставит зелёную точку, открытие её гасит', async () => {
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

  // Ход в web-2 встал, пока человек смотрел web-1.
  app.event({ userId: 'probe', chatId: 'web-2', type: 'idle', chat: { id: 'web-2', title: 'Долгий таск' } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(app.sidebar(), /chat-dot unread/, 'непрочитанный ответ помечен зелёной точкой');
  const stored = JSON.parse(app.store.get('icarus.unread') || '[]');
  assert.ok(stored.includes('web-2'), 'непрочитанное переживёт перезагрузку: оно в localStorage');
});

test('сводка поднимает и снимает жёлтую точку на чужом разговоре', async () => {
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

test('панель подписана на сводку и сверяется снимком состояния', async () => {
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

test('возврат в идущий ход не удваивает ответ в ленте', async () => {
  // Настоящий возврат: история открылась, живой поток подхватился, человек ушёл
  // и вернулся. Раньше каждая подписка добавляла своё тело — и один и тот же
  // ответ висел в ленте столько раз, сколько раз туда заходили.
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

  // Человек ушёл в другой разговор — плашка остаётся в ленте на своём месте,
  // а не выбрасывается, и подписка снята.
  app.document.querySelector('[data-id="web-1"]').onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Вернулся — тот же самый ход, а не второй ответ.
  app.document.querySelector('[data-id="web-1"]').onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(app.bodies(), 1, 'второй вход в тот же ход подхватывает то же тело');
});

test('idle из сводки не стирает уже показанный ответ', async () => {
  // Тот самый рецидив: `idle` идёт по сводке, `done` — по потоку разговора, это
  // разные соединения, и сводка успевает первой. Раньше `idle` выбрасывал живую
  // плашку из ленты в расчёте, что «запись разговора заменит её», но запись
  // никто не перерисовывал — ответ исчезал до перезагрузки страницы.
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

test('конец стриминга оставляет ответ в ленте, а не прячет до перезагрузки', async () => {
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

test('ход кончился между историей и подпиской — лента перечитывается сама', async () => {
  // Гонка: история сказала `live`, а `/chat/stream` уже 404 — ход только что
  // записан. Без перечитывания ленты ответа не видно до перезагрузки.
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

test('панель файлов: дерево, раскрытие папки и markdown-предпросмотр', async () => {
  const app = await driveChat({
    chatId: 'web-1',
    routes: {
      // Длинный маршрут идёт первым: короткий ключ иначе перехватил бы и его.
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
        text: '# Проект\n\nВложенные инструкции.',
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
  assert.equal(app.document.getElementById('files-ws').textContent, 'Разговор', 'в шапке имя workspace');
  assert.match(
    app.document.getElementById('files-ws-path').textContent || '',
    /workspaces\/talk/,
    'и его папка на диске',
  );

  const tree = app.document.getElementById('files-tree');
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
  assert.ok(
    app.document.getElementById('files-panel').classList.contains('has-preview'),
    'предпросмотр занимает нижнюю половину панели',
  );

  // «В чат» — вставка, а не отправка: набранное остаётся, путь дописывается.
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

  // Повторный клик по выбранному файлу возвращает дереву всю высоту панели.
  app.document
    .querySelector('.frow[data-path="projects/AGENTS.md"]')
    ?.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(preview.innerHTML, '', 'предпросмотр спрятан');
  assert.ok(!app.document.getElementById('files-panel').classList.contains('has-preview'));

  app.document.getElementById('files-close').onclick?.();
  assert.equal(app.store.get('icarus.files-open'), '0', 'закрытие тоже запоминается');
});

test('удаление: файл спрашивает, пустая папка — нет, непустая — да', async () => {
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
          // Непустая папка без force отказывает ровно так, как это делает сервер.
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

  // Корневой AGENTS.md — инструкции workspace: корзины у него нет вовсе.
  assert.ok(app.document.querySelector('.frow[data-path="AGENTS.md"]'), 'AGENTS.md виден в дереве');
  assert.equal(
    app.document.querySelector('.frow[data-path="AGENTS.md"] .fdel'),
    null,
    'корневой AGENTS.md нельзя удалить — корзины нет',
  );
  assert.ok(app.document.querySelector('.frow[data-path="plan.txt"] .fdel'), 'у обычного файла корзина есть');

  // Файл всегда спрашивает. Отмена — ни одного запроса.
  clickDelete('plan.txt');
  await wait(20);
  let modal = app.document.querySelector('.ws-modal');
  assert.ok(modal, 'перед удалением файла есть подтверждение');
  assert.match(modal.innerHTML, /Удалить файл\?/);
  modal.querySelector('[data-cancel]').onclick?.();
  await wait(20);
  assert.equal(app.document.querySelector('.ws-modal'), null, 'окно закрылось');
  assert.equal(deletes().length, 0, 'отмена ничего не удаляет');

  // Подтвердили — файл исчез из дерева и запрос ушёл без force.
  clickDelete('plan.txt');
  await wait(20);
  modal = app.document.querySelector('.ws-modal');
  modal.querySelector('[data-ok]').onclick?.();
  await wait(80);
  assert.ok(deletes().some((request) => request.url.includes('path=plan.txt')));
  assert.equal(app.document.querySelector('.frow[data-path="plan.txt"]'), null, 'строка файла пропала');

  // Пустая папка удаляется сразу: окна нет, запрос есть.
  const beforeEmpty = deletes().length;
  clickDelete('empty');
  await wait(80);
  assert.equal(app.document.querySelector('.ws-modal'), null, 'пустую папку не подтверждаем');
  assert.ok(deletes().length > beforeEmpty, 'запрос на удаление пустой папки ушёл');
  assert.equal(app.document.querySelector('.frow[data-path="empty"]'), null, 'пустая папка пропала');

  // Непустая папка: сервер отвечает 409, панель спрашивает, потом повторяет с force.
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
