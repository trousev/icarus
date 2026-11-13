// Panel scripts are actually executed.
//
// Why this is needed. The panel is a single HTML with an embedded script, and it reaches into page
// elements directly (`el('q').onkeydown`). If a section is absent from the page, the element is
// null, the assignment throws, and the script dies BEFORE it draws anything:
// the person sees a blank screen rather than an error. This is exactly what happened with the "Profile" settings:
// the language picker form was written, but the page stayed blank because of the search line
// that the section does not have.
//
// A markup check does not catch this: the test looks at HTML, but JS is what crashes. So here the
// script is actually executed in the DOM — with fetch stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { panelHtml, type PanelSession } from '../src/control/ui.ts';
import { keysPage } from '../src/control/keys-ui.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [
    { id: 'memory', label: 'Память' },
    { id: 'skills', label: 'Скиллы' },
    { id: 'mcp', label: 'MCP' },
    { id: 'profile', label: 'Пользователь' },
  ],
  scopes: { personal: 'memory', shared: 'memory' },
  scopeLabels: { personal: 'Личная', shared: 'Семейная' },
  model: 'deepseek-v4-flash',
  storage: 'git · local',
  language: 'ru',
};

/** API stub: the panel calls state and the route of the open section. */
function fakeFetch(url: string, payloads: Record<string, unknown> = {}) {
  const path = String(url);
  const body = Object.entries(payloads).find(([key]) => path.includes(key))?.[1];
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => body ?? {},
  };
}

type Run = { crashed: string | null; calls: string[]; content: string };

/** Execute the page script in the DOM and return what it did to content. */
async function run(section: string, options: { payloads?: Record<string, unknown> } = {}): Promise<Run> {
  const html = panelHtml(SESSION, { section });
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')].map((node) => node.textContent ?? '').filter(Boolean);

  const calls: string[] = [];
  window.fetch = async (url: string) => {
    calls.push(String(url));
    return fakeFetch(url, options.payloads);
  };
  window.URL.createObjectURL = () => 'blob:x';

  let crashed: string | null = null;
  try {
    // The trailing `</script>` in the source cuts the literal — we join with a newline.
    const code = scripts.join('\n');
    const run = new Function(
      'window',
      'document',
      'fetch',
      'URL',
      'location',
      'history',
      code,
    );
    run(
      window,
      document,
      window.fetch,
      window.URL,
      { href: `http://panel/panel/${section}`, search: '' },
      { replaceState() {} },
    );
  } catch (error) {
    crashed = error instanceof Error ? error.message : String(error);
  }
  // Wait for microtasks: the script is async, but the network here is instantaneous.
  await new Promise((resolve) => setTimeout(resolve, 30));

  return { crashed, calls, content: document.getElementById('content')?.innerHTML ?? '' };
}

test('the "Profile" settings draw the language picker form', async () => {
  const result = await run('profile', {
    payloads: {
      '/panel/profile/api': { language: 'ru', languages: ['ru', 'en'], labels: { ru: 'Русский', en: 'English' } },
    },
  });

  assert.equal(result.crashed, null, `скрипт упал: ${result.crashed}`);
  assert.match(result.content, /class="choice"/, 'переключатель нарисован');
  assert.match(result.content, /Русский/);
  assert.match(result.content, /English/);
  assert.match(result.content, /ЯЗЫК ОТВЕТОВ/);
  // The form is drawn from server data, not from constants in the browser.
  assert.ok(result.calls.some((call) => call.includes('/panel/profile/api')), 'язык спрошен у сервера');
});

test('panel sections survive script execution', async () => {
  // Memory calls its own routes — we also check that the edit for profile
  // did not break an ordinary section.
  const result = await run('memory', {
    payloads: { '/panel/memory/files': { files: [], total: 0 } },
  });
  assert.equal(result.crashed, null, `скрипт упал: ${result.crashed}`);
  assert.ok(result.calls.some((call) => call.includes('/panel/memory/files')));
});
test('the keys page draws search routing and check buttons', async () => {
  const session: PanelSession = { ...SESSION, sections: [{ id: 'keys', label: 'Ключи' }] };
  const html = keysPage(session);
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')].map((node) => node.textContent ?? '').filter(Boolean);

  const bannedUntil = new Date(Date.now() + 3600_000).toISOString();
  const payload = {
    user: 'probe',
    admin: true,
    groups: [{ id: 'search', label: 'Поиск' }],
    keys: [
      { name: 'SERPAPI_API_KEY', label: 'Поиск — SerpApi', description: 'выдача Google', group: 'search',
        present: false, source: 'none', hint: '' },
    ],
    search: {
      current: 'serpapi',
      usage: { days: 7, since: '2026-11-01', through: '2026-11-07' },
      providers: [
        { id: 'serpapi', label: 'SerpApi', keyName: 'SERPAPI_API_KEY', present: true, current: true,
          bannedUntil: null, banReason: null, broken: false, fails: 0, lastError: null, lastErrorAt: null,
          usage: { ok: 12, fail: 3 } },
        { id: 'brave', label: 'Brave', keyName: 'BRAVE_API_KEY', present: true, current: false,
          bannedUntil, banReason: 'credits', broken: false, fails: 3, lastError: 'HTTP 429', lastErrorAt: null },
        { id: 'you', label: 'You.com', keyName: 'YOU_API_KEY', present: false, current: false,
          optional: true, note: 'Ключа нет, и он не нужен: поиск идёт через бесплатный MCP.',
          bannedUntil: null, banReason: null, broken: true, fails: 60, lastError: null, lastErrorAt: null },
        { id: 'you-free', label: 'You.com · бесплатный MCP', keyName: '', keyless: true, present: true,
          current: false, optional: false, note: '100 поисков в сутки без регистрации.',
          bannedUntil: null, banReason: null, broken: false, fails: 0,
          lastError: null, lastErrorAt: null },
      ],
      fetch: {
        current: 'exa',
        providers: [
          { id: 'exa', label: 'Exa Contents', keyName: 'EXA_API_KEY', present: true, current: true,
            bannedUntil: null, banReason: null, broken: false, fails: 0, lastError: null, lastErrorAt: null },
          { id: 'tavily', label: 'Tavily Extract', keyName: 'TAVILY_API_KEY', present: false, current: false,
            bannedUntil: null, banReason: null, broken: false, fails: 0, lastError: null, lastErrorAt: null },
        ],
      },
    },
  };
  window.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => payload });

  let crashed: string | null = null;
  try {
    const code = scripts.join('\n');
    const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', code);
    run(window, document, window.fetch, window.URL, { href: 'http://panel/panel/keys', search: '' }, { replaceState() {} });
  } catch (error) {
    crashed = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));

  const content = document.getElementById('keys-list')?.innerHTML ?? '';
  assert.equal(crashed, null, `скрипт упал: ${crashed}`);
  assert.match(content, /МАРШРУТИЗАЦИЯ/);
  assert.match(content, /текущий/);
  assert.match(content, /ключ сломан/);
  assert.match(content, /data-check="serpapi"/);
  assert.match(content, /data-check="brave"/);
  assert.match(content, /ИЗВЛЕЧЕНИЕ/, 'блок извлечения страниц нарисован');
  assert.match(content, /data-check="exa" data-capability="fetch"/, 'проверка извлечения знает свою возможность');
  assert.match(content, /data-edit-key="SERPAPI_API_KEY"/, 'из сводки можно задать ключ');
  assert.match(content, /data-edit-key="YOU_API_KEY">Задать/, 'у отсутствующего ключа кнопка «Задать»');
  assert.match(content, /за 7 дней: <b>12<\/b> успехов · <b>3<\/b> отказа/, 'видно, сколько ключ отдал и сколько отказал');
  assert.match(content, /за 7 дней: не звали/, 'у незваного ключа честный ноль');
  assert.match(content, /data-check="you-free"/, 'провайдера без ключа тоже можно проверить');
  assert.match(content, /<code>без ключа<\/code><span class="pill own">работает<\/span>/, 'статус бесплатного — «работает», а не второе «без ключа»');
  assert.match(content, /100 поисков в сутки/, 'под названием видно, чем провайдер ограничен');
  assert.match(content, /<span class="pill env">необязателен<\/span>/, 'You.com без ключа — не «нет ключа», а «необязателен»');
  assert.match(content, /он не нужен: поиск идёт через бесплатный MCP/, 'и объяснено почему');
  assert.doesNotMatch(content, /data-edit-key=""/, 'у провайдера без ключа нечего задавать');

  // "Set" opens an input form in the key row rather than staying silent.
  const setButton = [...document.querySelectorAll('[data-edit-key]')].find(
    (node) => (node as unknown as { dataset: Record<string, string> }).dataset.editKey === 'SERPAPI_API_KEY',
  ) as unknown as { onclick: () => void };
  setButton.onclick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(document.getElementById('value-SERPAPI_API_KEY'), 'форма ввода открылась');
});
