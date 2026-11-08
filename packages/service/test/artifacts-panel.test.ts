// Раздел «Артефакты» в панели и публичный просмотр — через живой HTTP-сервер.
//
// Артефакты глобальные: список один, без workspace. Здесь проверяется весь путь:
// чтение за SSO, права, создание и отзыв ссылки, публичный маршрут, ассеты и
// корзина. Модель и докер не нужны.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { DEFAULT_ACL, artifactsRoot, writeAcl } from '../src/artifacts.ts';
import { commitArtifact, ensureArtifactRepos } from '../src/artifacts-git.ts';
import type { FolderAcl } from '../src/artifacts.ts';
import type { IcarusConfig } from '../src/config.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function asUser(userId = 'probe'): Record<string, string> {
  return { [PANEL_USER_HEADER]: userId };
}

function seed(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function item(config: IcarusConfig, slug: string, files: Record<string, string | Buffer>, acl: FolderAcl = DEFAULT_ACL, owner = 'probe'): string {
  const dir = path.join(artifactsRoot(config), slug);
  seed(dir, files);
  writeAcl(dir, owner, acl);
  return dir;
}

async function withServer(handler: (base: string, config: IcarusConfig) => Promise<void>): Promise<void> {
  const config = makeConfig({ users: [probe('probe'), probe('probe2')] });
  item(config, 'plan', {
    'index.md': '# План на четверг\n\n1. Стендап команды.\n\n> Стоматолог перенесён.\n',
    'index.ai.md': '# План на четверг\n\nРасписание дня: стендап, демо, ревью.\n',
  });
  item(config, 'report', {
    'index.html': '<!doctype html><html><head><title>Отчёт</title><link rel="stylesheet" href="style.css"></head><body><h1>Атлас</h1></body></html>',
    'style.css': 'body { color: red }',
    'css/nested.css': 'p { color: blue }',
    'index.ai.md': '# Отчёт по «Атласу»\n\nГотовность 87%.\n',
  });
  item(config, 'gift', {
    'index.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    'index.ai.md': '# Идеи подарка\n\nТри идеи для Анны.\n',
  });
  // Без ACL — не артефакт, в глобальный список не попадает.
  seed(path.join(artifactsRoot(config), 'raw'), { 'index.md': '# Без прав', 'index.ai.md': '# Без прав' });
  await ensureArtifactRepos(config);

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

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

test('страница раздела: глобальный список, поиск и открытый артефакт', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/artifacts?artifact=plan`, { headers: asUser() });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /__ARTIFACTS_CFG__/);
    assert.match(html, /"artifact":"plan"/);
    assert.doesNotMatch(html, /"workspace"/, 'workspace-переключателя больше нет');
    assert.match(html, /Поиск по артефактам/);
    assert.match(html, /<p class="nav-title">НАСТРОЙКИ<\/p>/);
    assert.doesNotMatch(html, /БИБЛИОТЕКА/);
    assert.match(html, /id="art-list"/);
    assert.match(html, /id="art-acl"/, 'права доступны из панели');
    assert.match(html, /id="art-history"/, 'история версий доступна из панели');
    assert.match(html, /id="art-history-panel"/);
    assert.match(html, /id="art-preview"/);
    assert.match(html, /id="art-total"/);
  });
});

test('API: глобальный список, чтение и описание для ИИ', async () => {
  await withServer(async (base) => {
    const list = (await (await api(base, 'list')).json()) as {
      total: number;
      items: Array<{ name: string; type: string; title: string; ai: boolean; owner: string }>;
    };
    assert.equal(list.total, 3);
    assert.deepEqual(list.items.map((item) => item.name).sort(), ['gift', 'plan', 'report']);
    const plan = list.items.find((item) => item.name === 'plan')!;
    assert.equal(plan.type, 'markdown');
    assert.equal(plan.title, 'План на четверг');
    assert.equal(plan.ai, true);
    assert.equal(plan.owner, 'probe');

    const read = (await (await api(base, 'read?artifact=plan')).json()) as {
      content: string;
      aiContent: string;
      path: string;
      artifact: { urls: { panel: string }; canManage: boolean; files: string[] };
    };
    assert.match(read.content, /# План на четверг/);
    assert.match(read.aiContent, /Расписание дня/);
    assert.equal(read.artifact.files.includes('.git'), false, 'служебный .git не показывается');
    assert.equal(read.path, '/artifacts/plan/index.md');
    assert.match(read.artifact.urls.panel, /\/panel\/artifacts\?artifact=plan$/);
    assert.equal(read.artifact.canManage, true);

    assert.equal((await api(base, 'read?artifact=raw')).status, 404, 'без ACL артефакта нет');
    assert.equal((await api(base, 'read?artifact=nope')).status, 404);
  });
});

test('публичная ссылка открывает артефакт без входа, старый адрес уводит на новый', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { artifact: 'plan' })).json()) as {
      urls: { public: string; bare: string };
    };
    assert.match(linked.urls.public, /\/a\/plan\/[A-Za-z0-9_-]{16,}\/$/);

    const page = await fetch(`${base}${pathOf(linked.urls.public)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /План на четверг/);
    assert.match(html, /ПУБЛИЧНЫЙ АРТЕФАКТ/);
    assert.match(html, /public-doc/);
    assert.match(html, /Стендап команды/);
    assert.doesNotMatch(html, /id="art-list"/);

    const bare = await fetch(`${base}${pathOf(linked.urls.bare)}`);
    assert.equal(bare.status, 200);
    const bareHtml = await bare.text();
    assert.doesNotMatch(bareHtml, /ПУБЛИЧНЫЙ АРТЕФАКТ/);
    assert.match(bareHtml, /<main class="wrap" id="doc">/);

    // Совместимость: старый /a/<человек>/<workspace>/<slug>/<id>/ редиректит.
    const old = linked.urls.public.replace('/a/plan/', '/a/probe/talk/plan/');
    const redirect = await fetch(`${base}${pathOf(old)}`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), pathOf(linked.urls.public));

    const noSlash = await fetch(`${base}${pathOf(linked.urls.public).replace(/\/$/, '')}`, { redirect: 'manual' });
    assert.equal(noSlash.status, 302);
  });
});

test('публичный HTML живёт в песочнице и отдаёт свои ассеты', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { artifact: 'report' })).json()) as { urls: { public: string } };
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

    assert.equal((await fetch(`${base}${basePath}.git/config`)).status, 404, '.git не отдаётся публично');

    const css = await fetch(`${base}${basePath}style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(await css.text(), 'body { color: red }');

    const nested = await fetch(`${base}${basePath}css/nested.css`);
    assert.equal(nested.status, 200, 'вложенный ассет не должен выглядеть старой ссылкой');
    assert.equal(await nested.text(), 'p { color: blue }');
  });
});

test('картинка в режиме «без панели» — это сам файл, а не страница', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { artifact: 'gift' })).json()) as { urls: { bare: string } };
    const bare = await fetch(`${base}${pathOf(linked.urls.bare)}`);
    assert.equal(bare.status, 200);
    assert.match(bare.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(await bare.text(), /<svg/);
  });
});

test('права: family read не управляет, family write пишет, family admin управляет', async () => {
  await withServer(async (base, config) => {
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 403);
    assert.equal((await post(base, 'delete', { artifact: 'plan' }, 'probe2')).status, 403);
    assert.equal((await post(base, 'acl', { artifact: 'plan', acl: { me: 'admin', family: 'read' } }, 'probe2')).status, 403);

    // family write: чтение и запись файлов, но не управление.
    const planDir = path.join(artifactsRoot(config), 'plan');
    writeAcl(planDir, 'probe', { me: 'admin', family: 'write' });
    const list = (await (await api(base, 'list', {}, 'probe2')).json()) as { items: Array<{ name: string; access: string; canWrite: boolean; canManage: boolean }> };
    const plan = list.items.find((item) => item.name === 'plan')!;
    assert.equal(plan.access, 'write');
    assert.equal(plan.canWrite, true);
    assert.equal(plan.canManage, false);
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 403);

    // family admin: управляет.
    writeAcl(planDir, 'probe', { me: 'admin', family: 'admin' });
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 200);
    const acl = await post(base, 'acl', { artifact: 'plan', acl: { me: 'admin', family: 'read' } }, 'probe2');
    assert.equal(acl.status, 200);
    const changed = (await acl.json()) as { artifact: { acl: { family: string } } };
    assert.equal(changed.artifact.acl.family, 'read');
  });
});

test('ACL: владелец меняет me/family, кривой уровень — 400', async () => {
  await withServer(async (base, config) => {
    const saved = await post(base, 'acl', { artifact: 'plan', acl: { me: 'write', family: 'write' } });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { artifact: { acl: { me: string; family: string }; canManage: boolean } };
    assert.deepEqual(body.artifact.acl, { me: 'write', family: 'write' });
    assert.equal(body.artifact.canManage, true, 'владелец не теряет управление');

    // none — законный уровень для семьи: артефакт снова становится личным.
    const hidden = await post(base, 'acl', { artifact: 'plan', acl: { me: 'admin', family: 'none' } });
    assert.equal(hidden.status, 200);
    const hiddenBody = (await hidden.json()) as { artifact: { acl: { family: string } } };
    assert.equal(hiddenBody.artifact.acl.family, 'none');
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 403);
    const familyList = (await (await api(base, 'list', {}, 'probe2')).json()) as { items: Array<{ name: string }> };
    assert.equal(familyList.items.some((item) => item.name === 'plan'), false, 'none скрывает артефакт из чужого списка');
    assert.equal((await api(base, 'read?artifact=plan', {}, 'probe2')).status, 403);
    assert.equal((await api(base, 'history?artifact=plan', {}, 'probe2')).status, 403);

    // Владельцу none выставить нельзя, иначе артефакт пропадёт из его списка.
    const ownerNone = await post(base, 'acl', { artifact: 'plan', acl: { me: 'none', family: 'none' } });
    assert.equal(ownerNone.status, 400);
    writeAcl(path.join(artifactsRoot(config), 'plan'), 'probe', DEFAULT_ACL);

    const bad = await post(base, 'acl', { artifact: 'plan', acl: { me: 'root', family: 'read' } });
    assert.equal(bad.status, 400);
  });
});

test('ссылка отзывается; чужой publicId не открывается', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { artifact: 'plan' })).json()) as { urls: { public: string } };
    const publicPath = pathOf(linked.urls.public);
    const wrong = publicPath.replace(/\/([A-Za-z0-9_-]{16,})\/$/, `/${'x'.repeat(24)}/`);
    assert.equal((await fetch(`${base}${wrong}`)).status, 404);

    await post(base, 'unpublish', { artifact: 'plan' });
    assert.equal((await fetch(`${base}${publicPath}`)).status, 404);
  });
});

test('файлы панели требуют SSO', async () => {
  await withServer(async (base) => {
    const raw = '/panel/artifacts/raw/plan/index.md';
    assert.equal((await fetch(`${base}${raw}`)).status, 401);
    const withUser = await fetch(`${base}${raw}`, { headers: asUser() });
    assert.equal(withUser.status, 200);
    assert.match(await withUser.text(), /# План на четверг/);
    assert.equal((await fetch(`${base}/panel/artifacts/raw/plan/.git/config`, { headers: asUser() })).status, 404);
  });
});

test('удаление артефакта убирает его из списка, но оставляет в корзине', async () => {
  await withServer(async (base, config) => {
    const deleted = await post(base, 'delete', { artifact: 'gift' });
    assert.equal(deleted.status, 200);
    const result = (await deleted.json()) as { ok: boolean; trashed: string };
    assert.equal(result.ok, true);
    assert.match(result.trashed, /^gift-/);
    const after = (await (await api(base, 'list')).json()) as { items: Array<{ name: string }> };
    assert.equal(after.items.some((item) => item.name === 'gift'), false);
    assert.equal(fs.existsSync(path.join(artifactsRoot(config), '.trash', result.trashed, 'index.svg')), true);
  });
});


test('история версий: список, откат и права', async () => {
  await withServer(async (base, config) => {
    const planDir = path.join(artifactsRoot(config), 'plan');
    const initial = (await (await api(base, 'history?artifact=plan')).json()) as {
      current: string;
      history: Array<{ hash: string; subject: string }>;
    };
    assert.equal(initial.history.length, 1);
    assert.equal(initial.history[0]!.subject, 'artifact: initial version');
    assert.equal(initial.current, initial.history[0]!.hash);

    fs.writeFileSync(path.join(planDir, 'index.md'), '# План v2\n');
    fs.writeFileSync(path.join(planDir, 'second.md'), 'потом уберём\n');
    await commitArtifact(planDir, 'artifact: write index.md');

    const changed = (await (await api(base, 'history?artifact=plan')).json()) as {
      current: string;
      history: Array<{ hash: string; subject: string }>;
    };
    assert.equal(changed.history.length, 2);
    assert.equal(changed.history[0]!.subject, 'artifact: write index.md');

    // family read видит историю, но не может вернуть.
    writeAcl(planDir, 'probe', { me: 'admin', family: 'read' });
    assert.equal((await api(base, 'history?artifact=plan', {}, 'probe2')).status, 200);
    const denied = await post(base, 'restore', { artifact: 'plan', commit: initial.current }, 'probe2');
    assert.equal(denied.status, 403);

    const restored = await post(base, 'restore', { artifact: 'plan', commit: initial.current });
    assert.equal(restored.status, 200);
    assert.equal(fs.readFileSync(path.join(planDir, 'index.md'), 'utf8'), '# План на четверг\n\n1. Стендап команды.\n\n> Стоматолог перенесён.\n');
    assert.equal(fs.existsSync(path.join(planDir, 'second.md')), false);

    const read = (await (await api(base, 'read?artifact=plan')).json()) as { content: string };
    assert.match(read.content, /Стендап команды/);

    const after = (await (await api(base, 'history?artifact=plan')).json()) as { history: Array<{ subject: string }> };
    assert.match(after.history[0]!.subject, /^artifact: restore /);
  });
});

test('история: мусорный хеш — 400, чужой артефакт — 404', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, 'restore', { artifact: 'plan', commit: 'не-хеш' })).status, 400);
    assert.equal((await post(base, 'restore', { artifact: 'plan', commit: 'deadbeef' })).status, 400);
    assert.equal((await api(base, 'history?artifact=nope')).status, 404);
    assert.equal((await post(base, 'restore', { artifact: 'nope', commit: 'deadbeef' })).status, 404);
  });
});


test('предпросмотр версии: контент и ассеты без отката', async () => {
  await withServer(async (base, config) => {
    const planDir = path.join(artifactsRoot(config), 'plan');
    const initial = (await (await api(base, 'history?artifact=plan')).json()) as { current: string };
    fs.writeFileSync(path.join(planDir, 'index.md'), '# План v2\n');
    await commitArtifact(planDir, 'artifact: write index.md');

    const preview = (await (await api(base, `preview?artifact=plan&commit=${initial.current}`)).json()) as {
      content: string;
      aiContent: string;
      artifact: { title: string; urls: { raw: string }; files: string[] };
      commit: { hash: string; subject: string };
    };
    assert.equal(preview.commit.hash, initial.current);
    assert.match(preview.artifact.title, /План на четверг/);
    assert.match(preview.content, /Стендап команды/);
    assert.match(preview.aiContent, /Расписание дня/);
    assert.equal(preview.artifact.files.includes('.git'), false);

    // Предпросмотр ничего не откатывает.
    const current = (await (await api(base, 'read?artifact=plan')).json()) as { content: string };
    assert.match(current.content, /План v2/);

    const rawPath = pathOf(preview.artifact.urls.raw);
    assert.equal((await fetch(`${base}${rawPath}`)).status, 401, 'версия тоже за SSO');
    const raw = await fetch(`${base}${rawPath}`, { headers: asUser() });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(await raw.text(), /Стендап команды/);

    const versionBase = `/panel/artifacts/version/plan/${initial.current}/`;
    assert.equal((await fetch(`${base}${versionBase}.git/config`, { headers: asUser() })).status, 404);
    assert.equal((await api(base, `preview?artifact=plan&commit=deadbeef`)).status, 400);
  });
});


test('предпросмотр HTML-версии отдаёт index и относительные ассеты', async () => {
  await withServer(async (base) => {
    const hist = (await (await api(base, 'history?artifact=report')).json()) as {
      current: string;
      history: Array<{ hash: string }>;
    };
    const commit = hist.history[0]!.hash;
    const preview = (await (await api(base, `preview?artifact=report&commit=${commit}`)).json()) as {
      artifact: { type: string; entry: string; urls: { raw: string } };
    };
    assert.equal(preview.artifact.type, 'html');
    assert.equal(preview.artifact.entry, 'index.html');
    const basePath = pathOf(preview.artifact.urls.raw).replace(/index\.html$/, '');
    const page = await fetch(`${base}${basePath}index.html`, { headers: asUser() });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Атлас/);
    const css = await fetch(`${base}${basePath}style.css`, { headers: asUser() });
    assert.equal(css.status, 200);
    assert.equal(await css.text(), 'body { color: red }');
  });
});
