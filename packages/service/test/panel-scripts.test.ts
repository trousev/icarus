// Скрипты панели исполняются по-настоящему.
//
// Зачем это нужно. Панель — один HTML со встроенным скриптом, и он лезет в элементы
// страницы напрямую (`el('q').onkeydown`). Если раздела на странице нет — элемент
// null, присваивание падает, и скрипт умирает ДО того, как нарисует хоть что-нибудь:
// человек видит пустой экран, а не ошибку. Так и случилось с настройками «Пользователь»:
// форма выбора языка была написана, но страница оставалась пустой из-за строки поиска,
// которой у раздела нет.
//
// Проверка разметки такое не ловит: тест смотрит на HTML, а падает JS. Поэтому здесь
// скрипт действительно исполняется в DOM — с заглушками fetch.
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
    { id: 'maple', label: 'Математика' },
    { id: 'profile', label: 'Пользователь' },
  ],
  scopes: { personal: 'memory', shared: 'memory' },
  scopeLabels: { personal: 'Личная', shared: 'Семейная' },
  model: 'deepseek-v4-flash',
  storage: 'git · local',
  language: 'ru',
};

/** Заглушка API: панель ходит в state и в маршрут открытого раздела. */
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

/** Исполнить скрипт страницы в DOM и вернуть, что он сделал с content. */
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
    // Хвост `</script>` в исходнике обрывает литерал — склеиваем с новой строки.
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
  // Ждём микрозадачи: скрипт асинхронный, но сеть тут мгновенная.
  await new Promise((resolve) => setTimeout(resolve, 30));

  return { crashed, calls, content: document.getElementById('content')?.innerHTML ?? '' };
}

test('настройки «Пользователь» рисуют форму выбора языка', async () => {
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
  // Форма нарисована по данным сервера, а не из констант в браузере.
  assert.ok(result.calls.some((call) => call.includes('/panel/profile/api')), 'язык спрошен у сервера');
});

test('разделы панели переживают запуск скрипта', async () => {
  // Память ходит в свои маршруты — заодно проверяем, что правка ради профиля
  // не сломала обычный раздел.
  const result = await run('memory', {
    payloads: { '/panel/memory/files': { files: [], total: 0 } },
  });
  assert.equal(result.crashed, null, `скрипт упал: ${result.crashed}`);
  assert.ok(result.calls.some((call) => call.includes('/panel/memory/files')));
});
test('страница ключей рисует маршрутизацию поиска и кнопки проверки', async () => {
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

  // «Задать» открывает форму ввода в строке ключа, а не молчит.
  const setButton = [...document.querySelectorAll('[data-edit-key]')].find(
    (node) => (node as unknown as { dataset: Record<string, string> }).dataset.editKey === 'SERPAPI_API_KEY',
  ) as unknown as { onclick: () => void };
  setButton.onclick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(document.getElementById('value-SERPAPI_API_KEY'), 'форма ввода открылась');
});
