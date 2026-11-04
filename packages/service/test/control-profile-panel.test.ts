// Раздел «Пользователь» в панели: одна настройка — язык ответов.
//
// Тест идёт через живой HTTP-сервер: важно проверить весь путь целиком — запрос
// панели, файл профиля, AGENTS.md, который уедет в контейнер человека. Язык
// бесполезен, если сохранился, но не доехал до промпта.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import { readProfile } from '../src/profile.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function asUser(userId?: string): Record<string, string> {
  return userId === undefined ? {} : { [PANEL_USER_HEADER]: userId };
}

async function withServer(
  handler: (base: string, config: IcarusConfig, bumped: string[]) => Promise<void>,
  overrides: Partial<IcarusConfig> = {},
): Promise<void> {
  const config = makeConfig({ users: [probe('probe'), probe('probe2')], ...overrides });
  // Отмечаем вызовы bump: смена языка обязана сказать реестру, что окружение
  // изменилось, иначе живая сессия pi держит прежний AGENTS.md до перезапуска.
  const bumped: string[] = [];
  const registry = { bumpResources: (id: string) => (bumped.push(id), bumped.length) };
  const server = createServer(config, registry as never, {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, config, bumped);
  } finally {
    server.close();
  }
}

function get(base: string, userId = 'probe'): Promise<Response> {
  return fetch(`${base}/panel/profile/api`, { headers: asUser(userId) });
}

function save(base: string, body: unknown, userId = 'probe'): Promise<Response> {
  return fetch(`${base}/panel/profile/api`, {
    method: 'POST',
    headers: { ...asUser(userId), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('раздел «Пользователь» есть в сайдбаре и открывается', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/profile`, { headers: asUser('probe') });
    assert.equal(page.status, 200);
    const html = await page.text();

    assert.match(html, /Пользователь/, 'раздел виден в сайдбаре');
    assert.match(html, /renderProfile/, 'страница знает про свой рендер');
    assert.match(html, /id="count-profile"|Пользователь/, 'пункт навигации отрисован');
    // Поиска и списка файлов у настроек нет: это форма, а не раздел памяти.
    assert.doesNotMatch(html, /id="q" placeholder="Поиск по памяти"/);
  });
});

test('GET /panel/profile/api отдаёт текущий язык и варианты', async () => {
  await withServer(async (base) => {
    const response = await get(base);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.user, 'probe');
    assert.equal(body.language, 'ru', 'по умолчанию русский');
    assert.deepEqual(body.languages, ['ru', 'en']);
    assert.equal((body.labels as Record<string, string>).en, 'English');
  });
});

test('умолчание из конфига доезжает до панели', async () => {
  await withServer(async (base) => {
    const body = (await (await get(base)).json()) as Record<string, unknown>;
    assert.equal(body.language, 'en');
  }, { userLanguage: 'en' });
});

test('сохранение языка пишет профиль и доезжает до AGENTS.md', async () => {
  await withServer(async (base, config) => {
    const saved = await save(base, { language: 'en' });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { user: 'probe', language: 'en' });

    // Файл профиля — на диске человека, рядом с памятью.
    assert.deepEqual(readProfile(config, probe('probe')), { language: 'en' });

    // И главное: следующий старт контейнера положит в AGENTS.md требование
    // отвечать по-английски. Без этого настройка была бы кнопкой в пустоту.
    const { prepareUser } = await import('../src/workspace.ts');
    prepareUser(config, probe('probe'));
    const agents = fs.readFileSync(userPaths(config, probe('probe')).agentsMd, 'utf8');
    // Проверяем лестницу, а не одну фразу: имя языка полное, кода в промпте нет.
    assert.match(agents, /ПО УМОЛЧАНИЮ ВСЕГДА ОТВЕЧАЙ НА ЯЗЫКЕ: English/);
    assert.doesNotMatch(agents, /\ben\b/, 'код языка в промпт не попадает');
  });
});

test('язык одного человека не трогает другого', async () => {
  await withServer(async (base, config) => {
    await save(base, { language: 'en' }, 'probe');
    const second = (await (await get(base, 'probe2')).json()) as Record<string, unknown>;
    assert.equal(second.language, 'ru', 'у второго своё умолчание');

    assert.equal(readProfile(config, probe('probe'))?.language, 'en');
    assert.equal(readProfile(config, probe('probe2')), undefined);
  });
});

test('чужой язык и битое тело отклоняются, профиль не портится', async () => {
  await withServer(async (base, config) => {
    const bad = await save(base, { language: 'klingon' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: { message: string } }).error.message, /ru, en/);
    assert.equal(readProfile(config, probe('probe')), undefined, 'ничего не записалось');

    const empty = await save(base, {});
    assert.equal(empty.status, 400);

    // Язык uppercase тоже не проходит: панель шлёт ровно то, что отдала в GET.
    const upper = await save(base, { language: 'EN' });
    assert.equal(upper.status, 400);
  });
});

test('человека называет прокси: без заголовка и без devUser — отказ', async () => {
  await withServer(async (base) => {
    // devUser в тестовом конфиге не задан — значит, назвать человека нечем, и
    // сервис обязан отказать, а не открыть профиль первого попавшегося.
    const response = await fetch(`${base}/panel/profile/api`, { headers: {} });
    assert.equal(response.status, 401);
  });
});

test('раздел «Пользователь» не открывает файлов памяти', async () => {
  await withServer(async (base) => {
    // Список файлов у настроек запрашивать нечего: раздел — форма, и корень у него
    // не каталог памяти. Проверяем, что чужой сущности там не появилось.
    const files = await fetch(`${base}/panel/profile/files`, { headers: asUser('probe') });
    assert.equal(files.status, 404, 'файлов у раздела нет');
  });
});

test('смена языка поднимает сессию заново, повтор — нет', async () => {
  await withServer(async (base, _config, bumped) => {
    // Язык живёт в AGENTS.md, а его pi читает при старте сессии. Без этой пометки
    // человек сохранил бы английский и услышал прежний русский — ровно то, что
    // и случилось на проде.
    await save(base, { language: 'en' });
    assert.deepEqual(bumped, ['probe'], 'смена языка помечает ресурсы обновлёнными');

    // Тот же язык второй раз — перезапускать сессию незачем: это потеря контекста.
    await save(base, { language: 'en' });
    assert.deepEqual(bumped, ['probe'], 'повторное сохранение того же языка не трогает сессию');

    // А другой человек — своя пометка.
    await save(base, { language: 'en' }, 'probe2');
    assert.deepEqual(bumped, ['probe', 'probe2']);
  });
});
