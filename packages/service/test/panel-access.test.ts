// Панель памяти по личной ссылке: без пропуска не пускает, с пропуском показывает
// ровно своего человека, а чужой id в запросе ничего не меняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import { containerEnv } from '../src/docker/spec.ts';
import { derivePanelKey, signPanelCredential } from '../../extensions/lib/panel-link.ts';
import { makeConfig, PANEL_SECRET, probe } from './fixtures.ts';

function seed(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function tokenFor(userId: string, ttlMs = 60_000): string {
  return signPanelCredential(derivePanelKey(PANEL_SECRET, userId), userId, Date.now() + ttlMs);
}

async function withServer(
  handler: (base: string, config: IcarusConfig) => Promise<void>,
): Promise<void> {
  const config = makeConfig({ users: [probe('probe'), probe('probe2')] });
  seed(userPaths(config, probe('probe')).memory, {
    'identity.md': '# Кто\n- Живёт в Москве\n',
    'people/barsik.md': '- Кот, рыжий\n',
  });
  seed(userPaths(config, probe('probe2')).memory, { 'secret.md': '- Чужой секрет\n' });
  seed(userPaths(config, probe('probe')).sharedMemory, { 'family.md': '- Общий факт\n' });

  const server = createServer(config, {} as never, PANEL_SECRET);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, config);
  } finally {
    server.close();
  }
}

function api(base: string, token: string, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/panel/api/${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

test('без ссылки панель не пускает и объясняет, где её взять', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel`);
    assert.equal(page.status, 401);
    assert.match(await page.text(), /Попроси Икара/);

    const api401 = await fetch(`${base}/panel/api/files`);
    assert.equal(api401.status, 401);
    const body = (await api401.json()) as { error?: { message?: string } };
    assert.match(String(body.error?.message), /истекла/);
  });
});

test('личная ссылка открывает страницу со своим именем', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/panel?t=${encodeURIComponent(tokenFor('probe'))}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Икар · память/);
    assert.doesNotMatch(html, /Попроси Икара/);
  });
});

test('страница не зовёт нативные confirm и её скрипт компилируется', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/panel?t=${encodeURIComponent(tokenFor('probe'))}`)).text();

    // Нативные модалки браузер глушит, если вкладка не активна, и confirm() молча
    // возвращает false — кнопки «забыть»/«откатить» перестают работать. Свой диалог
    // обязателен, а window.confirm в коде — регресс.
    assert.doesNotMatch(html, /[^.\w]confirm\(/, 'нативный confirm вернулся');
    assert.match(html, /askConfirm/, 'своего диалога подтверждения нет');

    // Скрипт собирается из template literal с экранированием: опечатка в бэкслешах
    // ломает всю страницу, а тесты её не видят. Компиляция ловит такое сразу.
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'в странице нет скрипта');
    assert.doesNotThrow(() => new Function(script), 'скрипт панели не компилируется');
  });
});

test('личная ссылка показывает только память своего человека', async () => {
  await withServer(async (base) => {
    const token = tokenFor('probe');

    const state = await (await api(base, token, 'state')).json();
    assert.deepEqual(state, { user: 'probe', scopes: ['personal', 'shared'] });

    const files = (await (await api(base, token, 'files?scope=personal')).json()) as {
      user: string;
      files: Array<{ path: string }>;
    };
    assert.equal(files.user, 'probe');
    const paths = files.files.map((file) => file.path).sort();
    assert.deepEqual(paths, ['identity.md', 'people/barsik.md']);

    // Чужого файла по своей ссылке не достать.
    const alien = await api(base, token, 'file?scope=personal&path=secret.md');
    assert.equal(alien.status, 404);
  });
});

test('подмена user в запросе игнорируется — человека задаёт только ссылка', async () => {
  await withServer(async (base) => {
    const token = tokenFor('probe');
    const response = await api(base, token, 'files?scope=personal&user=probe2');
    assert.equal(response.status, 200);
    const body = (await response.json()) as { user: string; files: Array<{ path: string }> };
    assert.equal(body.user, 'probe', 'user из query не влияет');
    assert.deepEqual(
      body.files.map((file) => file.path).sort(),
      ['identity.md', 'people/barsik.md'],
      'видны файлы probe, а не probe2',
    );
  });
});

test('семейная память доступна по личной ссылке, но остаётся общей', async () => {
  await withServer(async (base) => {
    const token = tokenFor('probe');
    const shared = await api(base, token, 'file?scope=shared&path=family.md');
    assert.equal(shared.status, 200);
    const body = (await shared.json()) as { content: string };
    assert.match(body.content, /Общий факт/);
  });
});

test('протухшая, подделанная и чужая ссылка не проходят', async () => {
  await withServer(async (base) => {
    assert.equal((await api(base, tokenFor('probe', -1000), 'files')).status, 401, 'срок вышел');

    const alienKey = derivePanelKey('чужой-секрет', 'probe');
    const forged = signPanelCredential(alienKey, 'probe', Date.now() + 60_000);
    assert.equal((await api(base, forged, 'files')).status, 401, 'подпись не сошлась');

    assert.equal((await api(base, tokenFor('stranger'), 'files')).status, 401, 'такого человека нет в конфиге');
  });
});

test('ключ, который уезжает в контейнер, открывает панель у сервиса', async () => {
  await withServer(async (base, config) => {
    // Ровно та связка, что в бою: compose кладёт в контейнер ICARUS_PANEL_KEY,
    // Икар подписывает им ссылку, сервис проверяет её своим секретом.
    const key = containerEnv(config, probe('probe'), PANEL_SECRET).ICARUS_PANEL_KEY;
    const token = signPanelCredential(key, 'probe', Date.now() + 60_000);

    const state = await api(base, token, 'state');
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { user: 'probe', scopes: ['personal', 'shared'] });
  });
});
