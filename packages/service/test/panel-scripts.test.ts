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
