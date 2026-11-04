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
  assert.match(html, /href="\/panel\/memory"/, 'настройки памяти доступны из чата');
  assert.match(html, /href="\/panel\/skills"/, 'настройки скиллов тоже');
  assert.match(html, /id="settings-pane"/, 'настройки открываются поверх чата, не уводя со страницы');
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

test('ширина сайдбара тянется и запоминается', () => {
  const html = chatPage(SESSION, { enabled: true });
  // Ручка на правой границе: колонка следует за --side-w, настройки открываются
  // от её края, на узком экране ручки нет.
  assert.match(html, /id="side-resizer"/, 'у границы есть ручка');
  assert.match(html, /grid-template-columns: var\(--side-w\) minmax\(0, 1fr\)/, 'колонка следует за шириной');
  assert.match(html, /left: var\(--side-w\)/, 'настройки открываются от края панели');
  assert.match(html, /localStorage\.setItem\(SIDE_WIDTH_KEY/, 'ширина переживает перезагрузку');
  assert.match(html, /\.side-resizer \{ display: none; \}/, 'на узком экране ручки нет');
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

/** Стенд: страница чата, заглушка fetch и перехваченная сводка. */
async function driveChat(
  options: {
    chatId?: string;
    /** Что отвечать на маршруты; ключ — подстрока пути. */
    routes?: Record<string, () => unknown>;
  } = {},
) {
  const html = chatPage(SESSION, { chatId: options.chatId, enabled: true });
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')].map((node) => node.textContent ?? '').filter(Boolean);

  const calls: string[] = [];
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

  window.fetch = async (url: string) => {
    const path = String(url);
    calls.push(path);
    const route = Object.entries(options.routes || {}).find(([key]) => path.includes(key))?.[1];
    const body = route ? route() : {};
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
    calls,
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

test('idle из сводки убирает живую плашку, а запись разговора остаётся одна', async () => {
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
  assert.equal(app.bodies(), 1, 'ход идёт — тело на месте');

  app.event({ userId: 'probe', chatId: 'web-1', type: 'idle', chat: { id: 'web-1', title: 'Разговор' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.bodies(), 0, 'ход кончился — плашка убрана, её место занимает запись разговора');
});
