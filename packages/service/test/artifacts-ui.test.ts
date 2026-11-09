// Страница раздела и публичный просмотр: разметка и клиентский скрипт.
//
// Скрипт здесь по-настоящему компилируется и один раз исполняется: опечатка в
// бэкслешах ломает всю страницу, а тест разметки этого не видит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { artifactsPage, publicArtifactPage } from '../src/control/artifacts-ui.ts';
import type { PanelSession } from '../src/control/ui.ts';
import type { Artifact } from '../src/artifacts.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [
    { id: 'memory', label: 'Память' },
    { id: 'skills', label: 'Скиллы' },
    { id: 'mcp', label: 'MCP' },
    { id: 'profile', label: 'Пользователь' },
  ],
  scopes: { personal: 'memory', shared: 'memory' },
  model: 'icarus-core-2',
  storage: 'git · local',
};

const OPTIONS = {
  artifact: 'plan',
  counts: { artifacts: 3, personal: 4, skills: 5, mcp: 2 },
};

test('страница: глобальный список, поиск, права и публичная ссылка', () => {
  const html = artifactsPage(SESSION, OPTIONS);
  assert.match(html, /<title>Icarus Control Panel<\/title>/);
  assert.match(html, /АРТЕФАКТЫ/);
  assert.match(html, /id="art-list"/);
  assert.match(html, /id="q"[^>]*placeholder="Поиск по артефактам"/);
  assert.match(html, /"artifact":"plan"/);
  assert.doesNotMatch(html, /"workspace"/, 'workspace-переключателя больше нет');
  assert.doesNotMatch(html, /id="art-workspace"/);
  assert.match(html, /<p class="nav-title">НАСТРОЙКИ<\/p>/);
  assert.doesNotMatch(html, /БИБЛИОТЕКА/);
  assert.match(html, /href="\/panel\/memory"/);
  assert.match(html, /id="art-share"/);
  assert.match(html, /id="art-share-modal"/);
  assert.match(html, /id="art-share-link"/);
  assert.doesNotMatch(html, /id="art-unpublish"/, 'отзыв ссылки живёт в диалоге «Поделиться»');
  assert.match(html, /id="art-history"/);
  assert.match(html, /id="art-history-panel"/);
  assert.match(html, /id="art-chat"/);
  assert.match(html, /id="art-chat-panel"/);
  assert.match(html, /id="art-chat-input"/);
  assert.match(html, /id="art-chat-send"/);
  assert.match(html, /id="art-chat-close"/);
  assert.match(html, /id="art-preview"/);
  assert.match(html, /id="art-preview-restore"/);
  assert.match(html, /id="acl-me"/);
  assert.match(html, /id="acl-family"/);
  assert.match(html, /id="acl-family"[^>]*><option value="none">нет доступа<\/option>/, 'нет доступа — уровень по умолчанию');
  assert.match(html, /id="acl-public"[^>]*><option value="none">нет доступа<\/option><option value="read">чтение<\/option>/, 'публично можно только читать');
  assert.match(html, /id="acl-copy"[^>]*aria-label="Копировать ссылку"[^>]*><svg/, 'копирование — иконка');
  assert.match(html, /id="art-bare"/);
  assert.match(html, /id="art-download"/);
  assert.match(html, /id="art-delete"/);
});

test('клиентский скрипт страницы компилируется и знает права', () => {
  const html = artifactsPage(SESSION, OPTIONS);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 3, 'конфиг, markdown и клиент едут отдельными скриптами');
  assert.doesNotThrow(() => new Function(scripts.join('\n')), 'скрипт страницы не компилируется');
  const client = scripts.find((script) => script.includes('artLoadList')) ?? '';
  assert.ok(client, 'клиент раздела едет отдельным скриптом');
  assert.match(client, /artLoadList/);
  assert.match(client, /artOpenShare/);
  assert.match(client, /artChangeAcl/);
  assert.match(client, /artChangePublic/);
  assert.match(client, /artCopyLink/);
  assert.match(client, /artOpenHistory/);
  assert.match(client, /artPreviewVersion/);
  assert.match(client, /artRestorePreview/);
  assert.match(client, /artDelete/);
  assert.match(client, /artifactMarkdown/);

  const chat = scripts.find((script) => script.includes('artChatSend')) ?? '';
  assert.ok(chat, 'клиент чата едет отдельным скриптом');
  assert.match(chat, /artChatOpen/);
  assert.match(chat, /artChatSend/);
  assert.match(chat, /panel\/api\/chat\/send/);
  assert.match(chat, /panel\/artifacts\/api\/chat/);
  assert.match(chat, /artChatRefreshArtifact/);
});

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    name: 'plan',
    title: 'План на четверг',
    type: 'markdown',
    typeLabel: 'Markdown-документ',
    entry: 'index.md',
    size: 513,
    updatedAt: '2026-11-06T22:01:00.000Z',
    summary: 'Расписание дня.',
    ai: true,
    files: ['index.md', 'index.ai.md'],
    owner: 'probe',
    acl: { me: 'admin', family: 'read' },
    access: 'admin',
    canRead: true,
    canWrite: true,
    canManage: true,
    publicId: 'abcdefghijklmnopqrstuvwx',
    urls: {
      panel: 'https://icarus.example/panel/artifacts?artifact=plan',
      raw: 'https://icarus.example/panel/artifacts/raw/plan/index.md',
      public: 'https://icarus.example/a/plan/abcdefghijklmnopqrstuvwx/',
      bare: 'https://icarus.example/a/plan/abcdefghijklmnopqrstuvwx/?bare=1',
    },
    ...overrides,
  };
}

/**
 * Страница артефакта с уже открытым боковым чатом. Маршруты ищутся по подстроке
 * пути; `{ stream: [...] }` отдаёт NDJSON-поток, остальное — JSON. Всё, что не
 * задано, отвечает как обычная панель: список, чтение артефакта и пустая история.
 */
async function openArtifactChat(
  routes: Record<string, (url: string, init?: RequestInit) => unknown> = {},
) {
  const html = artifactsPage(SESSION, OPTIONS);
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
  const item = artifact();
  const calls: Array<{ url: string; body: string }> = [];
  const chat = {
    id: 'web-art-1',
    title: 'Правка · План на четверг',
    workspace: 'talk',
    channel: 'web',
    readOnly: false,
    createdAt: '2026-11-06T22:01:00.000Z',
    updatedAt: '2026-11-06T22:02:00.000Z',
    preview: '',
  };
  const fallback = (path: string): unknown => {
    if (path.includes('/panel/artifacts/api/list')) return { total: 1, items: [item] };
    if (path.includes('/panel/artifacts/api/read')) {
      return { artifact: item, content: '# План на четверг\n', aiContent: 'Расписание дня.' };
    }
    if (path.includes('/panel/artifacts/api/chat')) return { chatId: chat.id, title: chat.title };
    if (path.includes('/panel/api/chat/history')) return { chat, messages: [], live: false };
    return {};
  };

  window.fetch = async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push({ url: path, body: String(init?.body ?? '') });
    const route = Object.entries(routes).find(([key]) => path.includes(key))?.[1];
    const data = route ? route(path, init) : fallback(path);
    if (data && typeof data === 'object' && 'stream' in data) {
      const lines = (data as { stream: string[] }).stream;
      let at = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/x-ndjson; charset=utf-8' },
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: async () =>
              at < lines.length
                ? { value: new TextEncoder().encode(lines[at++] + '\n'), done: false }
                : { done: true },
          }),
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => data ?? {},
    };
  };
  window.URL.createObjectURL = () => 'blob:x';
  const location = { href: 'http://panel/panel/artifacts', pathname: '/panel/artifacts', search: '?artifact=plan' };
  Object.defineProperty(window, 'location', { value: location, configurable: true });
  const history = { replaceState() {} };

  const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', scripts.join('\n'));
  run(window, document, window.fetch, window.URL, location, history);
  await new Promise((resolve) => setTimeout(resolve, 20));

  document.getElementById('art-chat')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const input = document.getElementById('art-chat-input');
  const pressEnter = () => {
    const event = document.createEvent('Event');
    event.initEvent('keydown', true, true);
    Object.defineProperty(event, 'key', { value: 'Enter' });
    input?.dispatchEvent(event);
  };
  return { document, calls, input, pressEnter };
}

test('публичная страница: markdown рендерится, html — в песочнице, картинка — сама', () => {
  const md = publicArtifactPage(artifact(), '# План на четверг\n\n1. Стендап\n');
  assert.match(md, /План на четверг/);
  assert.match(md, /ПУБЛИЧНЫЙ АРТЕФАКТ/);
  assert.match(md, /public-doc/);
  assert.match(md, /artifactMarkdown/);
  assert.match(md, /владелец/);

  const html = publicArtifactPage(
    artifact({
      type: 'html',
      typeLabel: 'HTML-страница',
      entry: 'index.html',
      urls: {
        panel: 'x',
        raw: 'https://icarus.example/panel/artifacts/raw/report/index.html',
        public: 'https://icarus.example/a/report/idididididididididididid/',
        bare: 'https://icarus.example/a/report/idididididididididididid/?bare=1',
      },
    }),
    null,
  );
  assert.match(html, /<iframe class="art-frame"[^>]*sandbox="[^"]*allow-scripts/);
  assert.match(html, /src="https:\/\/icarus\.example\/a\/report\/idididididididididididid\/index\.html"/);
  assert.match(html, /Без панели/);

  const image = publicArtifactPage(
    artifact({
      type: 'image',
      typeLabel: 'Изображение',
      entry: 'index.svg',
      urls: {
        panel: 'x',
        raw: 'https://icarus.example/panel/artifacts/raw/gift/index.svg',
        public: 'https://icarus.example/a/gift/idididididididididididid/',
        bare: 'https://icarus.example/a/gift/idididididididididididid/?bare=1',
      },
    }),
    null,
  );
  assert.match(image, /<div class="art-image"><img src="[^"]*index\.svg"/);
  assert.doesNotMatch(image, /<iframe/);
});

test('скрипт страницы исполняется: глобальный список рисуется, markdown открывается', async () => {
  const html = artifactsPage(SESSION, OPTIONS);
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
  const item = artifact();
  const payloads: Record<string, unknown> = {
    list: { total: 1, items: [item] },
    read: { artifact: item, content: '# План на четверг\n\n1. Стендап\n', aiContent: 'Расписание' },
    history: {
      artifact: item,
      current: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      history: [
        { hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', short: 'bbbbbbb', date: '2026-11-06T22:01:00.000Z', subject: 'artifact: write index.md' },
        { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', short: 'aaaaaaa', date: '2026-11-06T21:01:00.000Z', subject: 'artifact: initial version' },
      ],
    },
    preview: {
      artifact: item,
      content: '# Старая версия\n\n1. Было раньше\n',
      aiContent: 'Старое описание',
      current: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      commit: {
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        short: 'aaaaaaa',
        date: '2026-11-06T21:01:00.000Z',
        subject: 'artifact: initial version',
      },
    },
  };
  window.fetch = async (url: string) => {
    const key = Object.keys(payloads).find((name) => String(url).includes(name));
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => payloads[key ?? 'list'],
    };
  };
  window.URL.createObjectURL = () => 'blob:x';
  const location = { href: 'http://panel/panel/artifacts', pathname: '/panel/artifacts', search: '?artifact=plan' };
  const history = { replaceState() {} };
  Object.defineProperty(window, 'location', { value: location, configurable: true });

  let crashed: string | null = null;
  try {
    const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', scripts.join('\n'));
    run(window, document, window.fetch, window.URL, location, history);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } catch (error) {
    crashed = String(error);
  }
  assert.equal(crashed, null, 'скрипт раздела не должен падать');
  assert.match(document.getElementById('art-list')?.textContent ?? '', /План на четверг/);
  assert.match(document.getElementById('art-view')?.innerHTML ?? '', /<h1>План на четверг<\/h1>/);
  assert.match(document.getElementById('art-name')?.textContent ?? '', /index\.md/);

  document.getElementById('art-history')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.getElementById('art-history-panel')?.hidden, false);
  assert.match(document.getElementById('art-history-list')?.textContent ?? '', /запись index\.md/);
  assert.match(document.getElementById('art-history-list')?.textContent ?? '', /начальная версия/);
  assert.doesNotMatch(document.getElementById('art-history-list')?.innerHTML ?? '', /art-history-restore/, 'в списке нет кнопок отката');

  document.querySelector('[data-commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]')?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.getElementById('art-preview')?.hidden, false);
  assert.match(document.getElementById('art-preview-meta')?.textContent ?? '', /начальная версия/);
  assert.match(document.getElementById('art-view')?.innerHTML ?? '', /Старая версия/);
  assert.equal(document.getElementById('art-preview-restore')?.hidden, false);
});

test('кнопка «Чат» открывает панель и читает историю разговора артефакта', async () => {
  const html = artifactsPage(SESSION, OPTIONS);
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
  const item = artifact();
  const calls: string[] = [];
  const answer = (data: unknown) => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => data,
  });
  window.fetch = async (url: string) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/panel/artifacts/api/list')) return answer({ total: 1, items: [item] });
    if (path.includes('/panel/artifacts/api/read')) {
      return answer({ artifact: item, content: '# План на четверг\n', aiContent: 'Расписание дня.' });
    }
    if (path.includes('/panel/artifacts/api/chat')) {
      return answer({ chatId: 'web-art-1', title: 'Правка · План на четверг' });
    }
    if (path.includes('/panel/api/chat/history')) {
      return answer({
        chat: {
          id: 'web-art-1',
          title: 'Правка · План на четверг',
          workspace: 'talk',
          channel: 'web',
          readOnly: false,
          createdAt: '2026-11-06T22:01:00.000Z',
          updatedAt: '2026-11-06T22:02:00.000Z',
          preview: '',
        },
        messages: [
          { role: 'user', text: 'Добавь заголовок', timestamp: '2026-11-06T22:01:00.000Z' },
          { role: 'assistant', text: 'Добавил заголовок.', timestamp: '2026-11-06T22:02:00.000Z' },
        ],
        live: false,
      });
    }
    return answer({});
  };
  window.URL.createObjectURL = () => 'blob:x';
  const location = { href: 'http://panel/panel/artifacts', pathname: '/panel/artifacts', search: '?artifact=plan' };
  const history = { replaceState() {} };
  Object.defineProperty(window, 'location', { value: location, configurable: true });

  const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', scripts.join('\n'));
  run(window, document, window.fetch, window.URL, location, history);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const button = document.getElementById('art-chat');
  assert.equal(button?.hasAttribute('disabled'), false, 'у владельца с write кнопка доступна');
  button?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(document.getElementById('art-chat-panel')?.hidden, false, 'панель чата открылась');
  assert.ok(calls.some((call) => call.includes('/panel/artifacts/api/chat')), 'разговор создан на сервере');
  assert.ok(calls.some((call) => call.includes('/panel/api/chat/history')), 'история запрошена');
  const log = document.getElementById('art-chat-log');
  assert.match(log?.textContent ?? '', /Добавь заголовок/);
  assert.match(log?.textContent ?? '', /Добавил заголовок/);

  // Ответ ИИ — это .md без пузыря, как в основном чате. Пустой пузырь ответа
  // (он висел под шагом, пока модель думала) и был багом боковой панели.
  assert.equal(log?.querySelectorAll('.turn.assistant .md').length, 1, 'ответ живёт в .md');
  assert.equal(log?.querySelector('.turn.assistant .md')?.textContent, 'Добавил заголовок.');
  assert.equal(log?.querySelector('.art-chat-bubble'), null, 'старого пузыря ответа нет');
  assert.ok(log?.querySelector('.turn.assistant .avatar'), 'у ответа аватар, как в основном чате');
  assert.ok(log?.querySelector('.turn.user .bubble'), 'реплика человека — в пузыре');
  assert.equal(log?.querySelector('.turn.assistant .typing')?.hasAttribute('hidden'), true);
});

test('/clear в боковом чате — команда чата, а не реплика модели', async () => {
  const stand = await openArtifactChat({
    '/panel/api/chat/command': () => ({ handled: true, text: 'Начали с чистого листа.', cleared: true }),
  });

  if (!stand.input) throw new Error('нет поля ввода бокового чата');
  stand.input.value = '/clear';
  stand.pressEnter();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const command = stand.calls.find((call) => call.url.includes('/panel/api/chat/command'));
  assert.deepEqual(JSON.parse(command?.body ?? '{}'), { chatId: 'web-art-1', text: '/clear' });
  assert.equal(
    stand.calls.some((call) => call.url.includes('/panel/api/chat/send')),
    false,
    'команда не должна уезжать модели как текст',
  );
  assert.match(stand.document.getElementById('art-chat-log')?.textContent ?? '', /Контекст очищен/);
  assert.match(stand.document.getElementById('art-chat-note')?.textContent ?? '', /Контекст чистый/);
  assert.equal(stand.input.value, '', 'поле очищено после команды');
});

test('команда pi в боковом чате уезжает в разговор обычной репликой', async () => {
  const stand = await openArtifactChat({
    '/panel/api/chat/command': () => ({ handled: false }),
    '/panel/api/chat/send': () => ({
      stream: [JSON.stringify({ type: 'text', text: 'скилл сработал' }), JSON.stringify({ type: 'done' })],
    }),
  });

  if (!stand.input) throw new Error('нет поля ввода бокового чата');
  stand.input.value = '/skill:demo покажи';
  stand.pressEnter();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(stand.calls.some((call) => call.url.includes('/panel/api/chat/command')), 'сервер спросили');
  const sent = stand.calls.filter((call) => call.url.includes('/panel/api/chat/send'));
  assert.equal(sent.length, 1, 'после отказа сервера реплика ушла в pi');
  assert.equal(JSON.parse(sent[0]?.body ?? '{}').text, '/skill:demo покажи');
  assert.match(stand.document.getElementById('art-chat-log')?.textContent ?? '', /скилл сработал/);
});

test('стили ответа и трассировки у бокового чата — общие с основным чатом', () => {
  const html = artifactsPage(SESSION, OPTIONS);
  assert.match(html, /\.turn\.user \.bubble/, 'пузырь человека — из общего файла');
  assert.match(html, /\.md \{ font-size: 14px/, 'типографика ответа — из общего файла');
  assert.match(html, /\.trace \{ background: var\(--panel\)/, 'карточка шагов — из общего файла');
  assert.match(html, /\.art-chat-log \.typing:not\(\[hidden\]\)/, '«думает» — пузырь');
  assert.doesNotMatch(html, /\.art-chat-bubble/, 'у ответа пузыря больше нет');
});

test('кнопка «Поделиться»: права меняются сразу, публичное чтение даёт ссылку', async () => {
  const html = artifactsPage(SESSION, OPTIONS);
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
  const item = artifact();
  const calls: Array<{ url: string; body: string }> = [];
  // linkedom отдаёт select.value только на чтение: для теста даём обычный
  // сеттер, как в браузере, иначе клиент не может выставить выбранный уровень.
  for (const id of ['acl-me', 'acl-family', 'acl-public']) {
    const select = document.getElementById(id);
    const options = [...select.querySelectorAll('option')];
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: () => options.find((option) => option.selected)?.value ?? '',
      set: (value: string) => {
        const chosen = options.find((option) => option.value === value);
        if (chosen) chosen.selected = true;
      },
    });
  }
  const answer = (data: unknown) => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => data,
  });
  window.fetch = async (url: string, init?: { body?: string }) => {
    const path = String(url);
    calls.push({ url: path, body: String(init?.body ?? '') });
    if (path.includes('/panel/artifacts/api/list')) return answer({ total: 1, items: [item] });
    if (path.includes('/panel/artifacts/api/read')) {
      return answer({ artifact: item, content: '# План на четверг\n', aiContent: 'Расписание дня.' });
    }
    if (path.includes('/panel/artifacts/api/link')) {
      return answer({ artifact: { ...item, publicId: 'abcdefghijklmnopqrstuvwx' }, urls: item.urls });
    }
    if (path.includes('/panel/artifacts/api/acl')) {
      return answer({ artifact: { ...item, acl: { me: 'admin', family: 'write' } }, urls: item.urls });
    }
    if (path.includes('/panel/artifacts/api/unpublish')) {
      const urls = { panel: item.urls.panel, raw: item.urls.raw };
      return answer({ artifact: { ...item, publicId: undefined, urls }, urls });
    }
    return answer({});
  };
  const location = { href: 'http://panel/panel/artifacts', pathname: '/panel/artifacts', search: '?artifact=plan' };
  const history = { replaceState() {} };
  Object.defineProperty(window, 'location', { value: location, configurable: true });

  const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', scripts.join('\n'));
  run(window, document, window.fetch, window.URL, location, history);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const share = document.getElementById('art-share');
  assert.equal(share?.hasAttribute('disabled'), false, 'владелец может поделиться');
  share?.dispatchEvent(new window.Event('click'));
  assert.equal(document.getElementById('art-share-modal')?.hidden, false, 'диалог открылся');
  assert.equal(document.getElementById('acl-me')?.value, 'admin');
  assert.equal(document.getElementById('acl-family')?.value, 'read');
  assert.equal(document.getElementById('art-share-link')?.hidden, false, 'ссылка уже есть и показана');
  assert.match(document.getElementById('acl-link')?.value ?? '', /\/a\/plan\/abcdefghijklmnopqrstuvwx\//);
  assert.match(document.getElementById('acl-public-hint')?.textContent ?? '', /чтение/);

  const family = document.getElementById('acl-family');
  family.value = 'write';
  family.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const aclCall = calls.find((call) => call.url.includes('/panel/artifacts/api/acl'));
  assert.ok(aclCall, 'смена уровня семьи ушла на сервер');
  assert.deepEqual(JSON.parse(aclCall.body).acl, { me: 'admin', family: 'write' });
  assert.match(document.getElementById('art-share-note')?.textContent ?? '', /Права сохранены/);

  const isPublic = document.getElementById('acl-public');
  isPublic.value = 'none';
  isPublic.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => call.url.includes('/panel/artifacts/api/unpublish')), 'выключение публики отзывает ссылку');
  assert.equal(document.getElementById('art-share-link')?.hidden, true, 'без публичного чтения ссылки нет');
  assert.equal(document.getElementById('acl-public')?.value, 'none');

  isPublic.value = 'read';
  isPublic.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => call.url.includes('/panel/artifacts/api/link')), 'включение публики создаёт ссылку');
  assert.equal(document.getElementById('art-share-link')?.hidden, false);
  assert.match(document.getElementById('acl-link')?.value ?? '', /\/a\/plan\/abcdefghijklmnopqrstuvwx\//);
});

// Адрес элемента из предпросмотра: та же панель, только HTML-артефакт.
const HTML_REF = 'main.page/section.hero/h1.title';

async function htmlStand(options: { canWrite?: boolean; textStatus?: number } = {}) {
  const html = artifactsPage(SESSION, OPTIONS);
  const { document, window } = parseHTML(html);
  const win = window as any;
  const scripts = [...document.querySelectorAll('script')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
  const item = artifact({
    name: 'report',
    type: 'html',
    typeLabel: 'HTML-страница',
    entry: 'index.html',
    files: ['index.html', 'index.ai.md'],
    canWrite: options.canWrite ?? true,
    urls: {
      panel: 'https://icarus.example/panel/artifacts?artifact=report',
      raw: 'https://icarus.example/panel/artifacts/raw/report/index.html',
    },
  });
  const calls: Array<{ url: string; body: string }> = [];
  const answer = (data: unknown, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
  });
  win.fetch = async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push({ url: path, body: String(init?.body ?? '') });
    if (path.includes('/panel/artifacts/api/list')) return answer({ total: 1, items: [item] });
    if (path.includes('/panel/artifacts/api/refs')) {
      return answer({
        artifact: item,
        refs: [{ ref: HTML_REF, tag: 'h1', quote: 'Атлас', editable: true }],
        base: 'base-1',
        changed: true,
      });
    }
    if (path.includes('/panel/artifacts/api/text')) {
      if (options.textStatus) {
        return answer({ error: { message: 'артефакт успел измениться — обнови предпросмотр' } }, options.textStatus);
      }
      return answer({ ok: true, artifact: item, ref: HTML_REF, before: 'Атлас', base: 'base-2' });
    }
    if (path.includes('/panel/artifacts/api/read')) {
      return answer({ artifact: item, content: null, aiContent: 'Отчёт по «Атласу».' });
    }
    if (path.includes('/panel/artifacts/api/chat')) {
      return answer({ chatId: 'web-art-1', title: 'Правка · Отчёт' });
    }
    if (path.includes('/panel/api/chat/send')) {
      const lines = [JSON.stringify({ type: 'text', text: 'Готово' }), JSON.stringify({ type: 'done' })];
      let at = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/x-ndjson; charset=utf-8' },
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: async () =>
              at < lines.length
                ? { value: new TextEncoder().encode(lines[at++] + '\n'), done: false }
                : { done: true },
          }),
        },
      };
    }
    if (path.includes('/panel/api/chat/history')) {
      return answer({
        chat: {
          id: 'web-art-1',
          title: 'Правка · Отчёт',
          workspace: 'talk',
          channel: 'web',
          readOnly: false,
          createdAt: '2026-11-06T22:01:00.000Z',
          updatedAt: '2026-11-06T22:02:00.000Z',
          preview: '',
        },
        messages: [],
        live: false,
      });
    }
    return answer({});
  };
  win.URL.createObjectURL = () => 'blob:x';
  const location = { href: 'http://panel/panel/artifacts', pathname: '/panel/artifacts', search: '?artifact=report' };
  Object.defineProperty(win, 'location', { value: location, configurable: true });
  const history = { replaceState() {} };

  const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', scripts.join('\n'));
  run(win, document, win.fetch, win.URL, location, history);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { document, win, calls };
}

async function pickOn(stand: Awaited<ReturnType<typeof htmlStand>>) {
  stand.document.getElementById('art-pick')?.dispatchEvent(new stand.win.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('выбор элемента: адрес и цитата уезжают в боковой чат', async () => {
  const stand = await htmlStand();
  const { document, win, calls } = stand;
  const pick = document.getElementById('art-pick');
  assert.equal(pick?.hasAttribute('disabled'), false, 'у HTML с правом записи выбор доступен');

  await pickOn(stand);
  assert.ok(calls.some((call) => call.url.includes('/panel/artifacts/api/refs')), 'исходник размечен');
  assert.match(document.getElementById('art-view')?.innerHTML ?? '', /index\.html\?pick=1/);
  assert.equal(pick?.getAttribute('aria-pressed'), 'true');
  assert.match(document.getElementById('art-note')?.textContent ?? '', /Разметил элементы: 1/);

  win.artPickHandle({ type: 'ref', ref: HTML_REF, quote: 'Атлас', tag: 'h1' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(document.getElementById('art-chat-panel')?.hidden, false, 'чат открылся сам');
  assert.equal(document.getElementById('art-chat-ref')?.hidden, false, 'чип со ссылкой виден');
  assert.equal(document.getElementById('art-chat-ref-path')?.textContent, HTML_REF);
  assert.equal(document.getElementById('art-chat-ref-quote')?.textContent, '«Атлас»');
  assert.equal(
    document.getElementById('art-chat-input')?.getAttribute('placeholder'),
    'Что сделать с этим элементом?',
  );

  assert.equal(
    win.artChatCompose('сделай компактнее', { ref: HTML_REF, quote: 'Атлас' }),
    '> Элемент артефакта `' + HTML_REF + '` (data-icarus-ref в исходнике) — «Атлас»\n\nсделай компактнее',
  );

  document.getElementById('art-chat-ref-clear')?.dispatchEvent(new win.Event('click'));
  assert.equal(document.getElementById('art-chat-ref')?.hidden, true, '«убрать из ссылки» снимает чип');
});

test('правка текста из предпросмотра пишется в исходник с отпечатком версии', async () => {
  const stand = await htmlStand();
  const { document, win, calls } = stand;
  await pickOn(stand);

  // Открытие чата не должно сбрасывать отпечаток: иначе правка после ссылки
  // уезжает с пустым base и сервер честно отказывает.
  win.artPickHandle({ type: 'ref', ref: HTML_REF, quote: 'Атлас', tag: 'h1' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  win.artPickHandle({ type: 'text', ref: HTML_REF, text: 'Атлас 2' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const saved = calls.filter((call) => call.url.includes('/panel/artifacts/api/text'));
  assert.equal(saved.length, 1, 'одна запись — один маршрут');
  assert.deepEqual(JSON.parse(saved[0]!.body), {
    artifact: 'report',
    ref: HTML_REF,
    text: 'Атлас 2',
    base: 'base-1',
  });
  assert.match(document.getElementById('art-note')?.textContent ?? '', /Текст сохранён/);
  assert.ok(
    calls.filter((call) => call.url.includes('/panel/artifacts/api/read')).length >= 2,
    'после записи предпросмотр перечитан',
  );
});

test('отказ сохранения виден в панели, а не притворяется успехом', async () => {
  const stand = await htmlStand({ textStatus: 409 });
  const { document, win } = stand;
  await pickOn(stand);

  win.artPickHandle({ type: 'text', ref: HTML_REF, text: 'Атлас 2' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(document.getElementById('art-note')?.textContent ?? '', /Не сохранилось/);
  assert.match(document.getElementById('art-note')?.textContent ?? '', /измениться/);
});

test('без права записи выбор элемента недоступен', async () => {
  const stand = await htmlStand({ canWrite: false });
  assert.equal(stand.document.getElementById('art-pick')?.hasAttribute('disabled'), true);
  await pickOn(stand);
  assert.equal(
    stand.calls.some((call) => call.url.includes('/panel/artifacts/api/refs')),
    false,
    'даже запрос разметки не уходит',
  );
});

test('ссылка уезжает в сообщение вместе с задачей и снимается после отправки', async () => {
  const stand = await htmlStand();
  const { document, win, calls } = stand;
  await pickOn(stand);
  win.artPickHandle({ type: 'ref', ref: HTML_REF, quote: 'Атлас', tag: 'h1' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const input = document.getElementById('art-chat-input');
  input.value = 'сделай компактнее';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  const enter = document.createEvent('Event');
  enter.initEvent('keydown', true, true);
  Object.defineProperty(enter, 'key', { value: 'Enter' });
  input.dispatchEvent(enter);
  await new Promise((resolve) => setTimeout(resolve, 80));

  const sent = calls.filter((call) => call.url.includes('/panel/api/chat/send'));
  assert.equal(sent.length, 1, 'реплика ушла одним сообщением');
  assert.equal(
    JSON.parse(sent[0]!.body).text,
    '> Элемент артефакта `' + HTML_REF + '` (data-icarus-ref в исходнике) — «Атлас»\n\nсделай компактнее',
  );
  assert.equal(document.getElementById('art-chat-ref')?.hidden, true, 'после отправки чип убран');
  assert.match(document.getElementById('art-chat-log')?.textContent ?? '', /Элемент артефакта/);
});
