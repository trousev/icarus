// Страница раздела и публичный просмотр: разметка и клиентский скрипт.
//
// Скрипт здесь по-настоящему компилируется: опечатка в бэкслешах ломает всю
// страницу, а тест разметки этого не видит.
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
  workspace: 'talk',
  artifact: 'plan',
  workspaces: [
    { slug: 'talk', name: 'Разговор' },
    { slug: 'private', name: 'Приватный' },
  ],
  counts: { artifacts: 3, personal: 4, skills: 5, mcp: 2 },
};

test('страница: список в сайдбаре, поиск и действия над артефактом', () => {
  const html = artifactsPage(SESSION, OPTIONS);
  assert.match(html, /<title>Icarus Control Panel<\/title>/);
  assert.match(html, /АРТЕФАКТЫ/);
  assert.match(html, /id="art-list"/);
  assert.match(html, /id="q"[^>]*placeholder="Поиск по артефактам"/);
  assert.match(html, /"artifact":"plan"/);
  assert.match(html, /"workspace":"talk"/);
  assert.match(html, /"artifacts":3/);
  // Меню настроек — тот же плоский список, что и на остальных страницах,
  // без отдельных «библиотек».
  assert.doesNotMatch(html, /<p class="nav-title">БИБЛИОТЕКА<\/p>/);
  assert.match(html, /<p class="nav-title">НАСТРОЙКИ<\/p>/);
  assert.match(html, /href="\/panel\/memory"/);
  // Кнопки действий: ссылка, «без панели», скачать, удалить.
  assert.match(html, /id="art-link"/);
  assert.match(html, /id="art-unpublish"/, 'ссылку можно отозвать');
  assert.match(html, /id="art-bare"/);
  assert.match(html, /id="art-download"/);
  assert.match(html, /id="art-delete"/);
  assert.match(html, /workspace <select id="art-workspace"/);
});

test('клиентский скрипт страницы компилируется и знает оба рендера', () => {
  const html = artifactsPage(SESSION, OPTIONS);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 3, 'конфиг, markdown и клиент едут отдельными скриптами');
  assert.doesNotThrow(() => new Function(scripts.join('\n')), 'скрипт страницы не компилируется');
  const client = scripts[scripts.length - 1];
  assert.match(client, /artLoadList/);
  assert.match(client, /artMakeLink/);
  assert.match(client, /artUnpublish/);
  assert.match(client, /artDelete/);
  assert.match(client, /artifactMarkdown/);
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
    publicId: 'abcdefghijklmnopqrstuvwx',
    urls: {
      panel: 'https://icarus.example/panel/artifacts?workspace=talk&artifact=plan',
      raw: 'https://icarus.example/panel/artifacts/raw/talk/plan/index.md',
      public: 'https://icarus.example/a/probe/talk/plan/abcdefghijklmnopqrstuvwx/',
      bare: 'https://icarus.example/a/probe/talk/plan/abcdefghijklmnopqrstuvwx/?bare=1',
    },
    ...overrides,
  };
}

test('публичная страница: markdown рендерится, html — в песочнице, картинка — сама', () => {
  const md = publicArtifactPage(artifact(), '# План на четверг\n\n1. Стендап\n');
  assert.match(md, /План на четверг/);
  assert.match(md, /ПУБЛИЧНЫЙ АРТЕФАКТ/);
  assert.match(md, /public-doc/);
  assert.match(md, /artifactMarkdown/);

  const html = publicArtifactPage(
    artifact({
      type: 'html',
      typeLabel: 'HTML-страница',
      entry: 'index.html',
      urls: {
        panel: 'x',
        raw: 'https://icarus.example/panel/artifacts/raw/talk/report/index.html',
        public: 'https://icarus.example/a/probe/talk/report/idididididididididididid/',
        bare: 'https://icarus.example/a/probe/talk/report/idididididididididididid/?bare=1',
      },
    }),
    null,
  );
  assert.match(html, /<iframe class="art-frame"[^>]*sandbox="[^"]*allow-scripts/);
  assert.match(html, /src="https:\/\/icarus\.example\/a\/probe\/talk\/report\/idididididididididididid\/index\.html"/);
  assert.match(html, /Без панели/);

  const image = publicArtifactPage(
    artifact({
      type: 'image',
      typeLabel: 'Изображение',
      entry: 'index.svg',
      urls: {
        panel: 'x',
        raw: 'https://icarus.example/panel/artifacts/raw/talk/gift/index.svg',
        public: 'https://icarus.example/a/probe/talk/gift/idididididididididididid/',
        bare: 'https://icarus.example/a/probe/talk/gift/idididididididididididid/?bare=1',
      },
    }),
    null,
  );
  assert.match(image, /<div class="art-image"><img src="[^"]*index\.svg"/);
  assert.doesNotMatch(image, /<iframe/);
});

test('скрипт страницы исполняется: список рисуется, markdown открывается', async () => {
  const html = artifactsPage(SESSION, OPTIONS);
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
  const item = artifact();
  // У страницы нет ни pi, ни сети: отдаём ровно два ответа, которые она просит.
  const payloads: Record<string, unknown> = {
    list: { workspace: 'talk', workspaces: OPTIONS.workspaces, total: 3, items: [item] },
    read: { artifact: item, content: '# План на четверг\n\n1. Стендап\n', aiContent: 'Расписание' },
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
  const location = { href: 'http://panel/panel/artifacts', pathname: '/panel/artifacts', search: '?workspace=talk&artifact=plan' };
  const history = { replaceState() {} };
  // В браузере location висит на window; linkedom его не заводит.
  Object.defineProperty(window, 'location', { value: location, configurable: true });

  let crashed: string | null = null;
  try {
    const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', scripts.join('\n'));
    run(window, document, window.fetch, window.URL, location, history);
    // Клиент асинхронный: даём ему доиграть два запроса.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } catch (error) {
    crashed = String(error);
  }
  assert.equal(crashed, null, 'скрипт раздела не должен падать');
  assert.match(document.getElementById('art-list')?.textContent ?? '', /План на четверг/);
  assert.match(document.getElementById('art-view')?.innerHTML ?? '', /<h1>План на четверг<\/h1>/);
  assert.match(document.getElementById('art-name')?.textContent ?? '', /index\.md/);
});
