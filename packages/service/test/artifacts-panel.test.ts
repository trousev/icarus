// Раздел «Артефакты» в панели и публичный просмотр — через живой HTTP-сервер.
//
// Здесь проверяется весь путь: список и чтение за SSO, создание ссылки, страница
// артефакта без входа, режим «без панели», ассеты и корзина. Модель и докер не
// нужны: артефакты — это файлы в workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function asUser(userId = 'probe'): Record<string, string> {
  return { [PANEL_USER_HEADER]: userId };
}

function artifactsRoot(config: IcarusConfig, workspace = 'talk'): string {
  return path.join(userPaths(config, probe('probe')).workspaces, workspace, 'artifacts');
}

function seed(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

async function withServer(handler: (base: string, config: IcarusConfig) => Promise<void>): Promise<void> {
  const config = makeConfig({ users: [probe('probe'), probe('probe2')] });
  seed(artifactsRoot(config), {
    'plan/index.md': '# План на четверг\n\n1. Стендап команды.\n\n> Стоматолог перенесён.\n',
    'plan/index.ai.md': '# План на четверг\n\nРасписание дня: стендап, демо, ревью.\n',
    'report/index.html': '<!doctype html><html><head><title>Отчёт</title><link rel="stylesheet" href="style.css"></head><body><h1>Атлас</h1></body></html>',
    'report/style.css': 'body { color: red }',
    'report/index.ai.md': '# Отчёт по «Атласу»\n\nГотовность 87%.\n',
    'gift/index.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    'gift/index.ai.md': '# Идеи подарка\n\nТри идеи для Анны.\n',
  });
  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, config);
  } finally {
    server.close();
  }
}

function api(base: string, route: string, init: RequestInit = {}, userId = 'probe'): Promise<Response> {
  return fetch(`${base}/panel/artifacts/api/${route}`, {
    ...init,
    headers: { ...asUser(userId), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function post(base: string, route: string, body: unknown, userId = 'probe'): Promise<Response> {
  return api(base, route, { method: 'POST', body: JSON.stringify(body) }, userId);
}

/** Публичную ссылку отдаёт сервис со своим внешним адресом; тесту нужен путь. */
function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

test('страница раздела: список, поиск и открытый артефакт из ссылки', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/artifacts?workspace=talk&artifact=plan`, { headers: asUser() });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /__ARTIFACTS_CFG__/);
    assert.match(html, /"artifact":"plan"/);
    assert.match(html, /"workspace":"talk"/);
    assert.match(html, /Поиск по артефактам/);
    // Меню — прежний плоский список «Настройки», без новых групп.
    assert.match(html, /<p class="nav-title">НАСТРОЙКИ<\/p>/);
    assert.doesNotMatch(html, /БИБЛИОТЕКА/);
    assert.match(html, /id="art-list"/);
    assert.match(html, /id="art-total"/);
    // Никаких пропусков: человека называет SSO-прокси.
    assert.doesNotMatch(html, /парол/i);
  });
});

test('API: список, чтение и описание для ИИ', async () => {
  await withServer(async (base) => {
    const list = (await (await api(base, 'list?workspace=talk')).json()) as {
      workspace: string;
      total: number;
      items: Array<{ name: string; type: string; title: string; ai: boolean }>;
    };
    assert.equal(list.workspace, 'talk');
    assert.equal(list.total, 3);
    assert.deepEqual(
      list.items.map((item) => item.name).sort(),
      ['gift', 'plan', 'report'],
    );
    const plan = list.items.find((item) => item.name === 'plan')!;
    assert.equal(plan.type, 'markdown');
    assert.equal(plan.title, 'План на четверг');
    assert.equal(plan.ai, true);

    const read = (await (await api(base, 'read?workspace=talk&artifact=plan')).json()) as {
      content: string;
      aiContent: string;
      path: string;
      artifact: { urls: { panel: string } };
    };
    assert.match(read.content, /# План на четверг/);
    assert.match(read.aiContent, /Расписание дня/);
    assert.match(read.path, /~\/icarus\/workspaces\/talk\/artifacts\/plan\/index\.md$/);
    assert.match(read.artifact.urls.panel, /\/panel\/artifacts\?/);

    const missing = await api(base, 'read?workspace=talk&artifact=nope');
    assert.equal(missing.status, 404);
  });
});

test('публичная ссылка открывает артефакт без входа, а «без панели» — сам файл', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { workspace: 'talk', artifact: 'plan' })).json()) as {
      urls: { public: string; bare: string };
    };
    assert.match(linked.urls.public, /\/a\/probe\/talk\/plan\/[A-Za-z0-9_-]{16,}\/$/);

    // Панель: заголовок, тип и отрендеренный markdown.
    const page = await fetch(`${base}${pathOf(linked.urls.public)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /План на четверг/);
    assert.match(html, /ПУБЛИЧНЫЙ АРТЕФАКТ/);
    assert.match(html, /public-doc/);
    assert.match(html, /Стендап команды/, 'markdown едет в страницу');
    assert.doesNotMatch(html, /id="art-list"/, 'чужого списка на публичной странице нет');

    // «Без панели»: без сайдбара и шапки, только документ.
    const bare = await fetch(`${base}${pathOf(linked.urls.bare)}`);
    assert.equal(bare.status, 200);
    const bareHtml = await bare.text();
    assert.doesNotMatch(bareHtml, /ПУБЛИЧНЫЙ АРТЕФАКТ/);
    assert.match(bareHtml, /<main class="wrap" id="doc">/);

    // Ссылка на папку без слеша уводит на канонический адрес со слешем.
    const noSlash = await fetch(`${base}${pathOf(linked.urls.public).replace(/\/$/, '')}`, {
      redirect: 'manual',
    });
    assert.equal(noSlash.status, 302);
    assert.match(noSlash.headers.get('location') ?? '', /\/$/);
  });
});

test('публичный HTML живёт в песочнице и отдаёт свои ассеты относительными путями', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { workspace: 'talk', artifact: 'report' })).json()) as {
      urls: { public: string };
    };
    const basePath = pathOf(linked.urls.public);

    const page = await fetch(`${base}${basePath}`);
    const html = await page.text();
    assert.match(html, /<iframe class="art-frame"[^>]*sandbox="[^"]*allow-scripts/);
    assert.match(html, /src="[^"]*index\.html"/);

    const file = await fetch(`${base}${basePath}index.html`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type') ?? '', /text\/html/);
    assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.match(await file.text(), /Атлас/);

    const css = await fetch(`${base}${basePath}style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(await css.text(), 'body { color: red }');

    const traversal = await fetch(`${base}${basePath}../../../../etc/passwd`);
    assert.equal(traversal.status, 404);
  });
});

test('картинка в режиме «без панели» — это сам файл, а не страница', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { workspace: 'talk', artifact: 'gift' })).json()) as {
      urls: { bare: string };
    };
    const bare = await fetch(`${base}${pathOf(linked.urls.bare)}`);
    assert.equal(bare.status, 200);
    assert.match(bare.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(await bare.text(), /<svg/);
  });
});

test('ссылка отзывается, а чужой id и чужой человек не открываются', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { workspace: 'talk', artifact: 'plan' })).json()) as {
      urls: { public: string };
    };
    const publicPath = pathOf(linked.urls.public);

    const wrongId = publicPath.replace(/\/([A-Za-z0-9_-]{16,})\/$/, `/${'x'.repeat(24)}/`);
    assert.equal((await fetch(`${base}${wrongId}`)).status, 404);

    // Тот же путь, но человек другой: артефакт ему не принадлежит.
    const foreign = publicPath.replace('/a/probe/', '/a/probe2/');
    assert.equal((await fetch(`${base}${foreign}`)).status, 404);

    await post(base, 'unpublish', { workspace: 'talk', artifact: 'plan' });
    assert.equal((await fetch(`${base}${publicPath}`)).status, 404, 'отозванная ссылка больше не работает');
  });
});

test('файлы панели требуют SSO, а публичные — только ссылку', async () => {
  await withServer(async (base) => {
    const raw = `/panel/artifacts/raw/talk/plan/index.md`;
    assert.equal((await fetch(`${base}${raw}`)).status, 401);

    const withUser = await fetch(`${base}${raw}`, { headers: asUser() });
    assert.equal(withUser.status, 200);
    assert.match(await withUser.text(), /# План на четверг/);

    const foreign = await fetch(`${base}${raw}`, { headers: asUser('probe2') });
    assert.equal(foreign.status, 404, 'чужой workspace не читается');
  });
});

test('удаление артефакта убирает его из списка, но оставляет в корзине', async () => {
  await withServer(async (base, config) => {
    const before = (await (await api(base, 'list?workspace=talk')).json()) as { items: Array<{ name: string }> };
    assert.equal(before.items.some((item) => item.name === 'gift'), true);

    const deleted = await post(base, 'delete', { workspace: 'talk', artifact: 'gift' });
    assert.equal(deleted.status, 200);
    const result = (await deleted.json()) as { ok: boolean; trashed: string };
    assert.equal(result.ok, true);
    assert.match(result.trashed, /^gift-/);

    const after = (await (await api(base, 'list?workspace=talk')).json()) as { items: Array<{ name: string }> };
    assert.equal(after.items.some((item) => item.name === 'gift'), false);
    const trash = path.join(artifactsRoot(config), '.trash', result.trashed);
    assert.equal(fs.existsSync(path.join(trash, 'index.svg')), true);
  });
});

test('неизвестный workspace и несуществующий артефакт — 404, а не 500', async () => {
  await withServer(async (base) => {
    assert.equal((await api(base, 'list?workspace=nope')).status, 404);
    assert.equal((await api(base, 'read?workspace=talk&artifact=nope')).status, 404);
    assert.equal((await post(base, 'link', { workspace: 'talk', artifact: 'nope' })).status, 404);
  });
});
