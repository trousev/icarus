// The "Artifacts" section in the panel and public viewing — through a live HTTP server.
//
// Artifacts are global: a single list, without workspace. This exercises the whole path:
// reading behind SSO, permissions, creating and revoking a link, the public route, assets and
// the trash. No model or docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { DEFAULT_ACL, artifactsRoot, writeAcl } from '../src/artifacts.ts';
import { commitArtifact, ensureArtifactRepos } from '../src/artifacts-git.ts';
import { updateChatTitles } from '../src/sessions/chats.ts';
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
  // Without an ACL — not an artifact, does not appear in the global list.
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

test('section page: global list, search and an open artifact', async () => {
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
    assert.match(html, /id="art-share"/, 'права и ссылка доступны из панели');
    assert.match(html, /id="art-history"/, 'история версий доступна из панели');
    assert.match(html, /id="art-history-panel"/);
    assert.match(html, /id="art-preview"/);
    assert.match(html, /id="art-total"/);
  });
});

test('API: global list, reading and the description for AI', async () => {
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

test('the public link opens the artifact without login, the old address redirects to the new one', async () => {
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

    // Compatibility: the old /a/<person>/<workspace>/<slug>/<id>/ redirects.
    const old = linked.urls.public.replace('/a/plan/', '/a/probe/talk/plan/');
    const redirect = await fetch(`${base}${pathOf(old)}`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), pathOf(linked.urls.public));

    const noSlash = await fetch(`${base}${pathOf(linked.urls.public).replace(/\/$/, '')}`, { redirect: 'manual' });
    assert.equal(noSlash.status, 302);
  });
});

test('public HTML lives in a sandbox and serves its own assets', async () => {
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

test('an image in "no panel" mode is the file itself, not a page', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { artifact: 'gift' })).json()) as { urls: { bare: string } };
    const bare = await fetch(`${base}${pathOf(linked.urls.bare)}`);
    assert.equal(bare.status, 200);
    assert.match(bare.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(await bare.text(), /<svg/);
  });
});

test('permissions: family read cannot manage, family write can write, family admin can manage', async () => {
  await withServer(async (base, config) => {
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 403);
    assert.equal((await post(base, 'delete', { artifact: 'plan' }, 'probe2')).status, 403);
    assert.equal((await post(base, 'acl', { artifact: 'plan', acl: { me: 'admin', family: 'read' } }, 'probe2')).status, 403);

    // family write: reading and writing files, but not managing.
    const planDir = path.join(artifactsRoot(config), 'plan');
    writeAcl(planDir, 'probe', { me: 'admin', family: 'write' });
    const list = (await (await api(base, 'list', {}, 'probe2')).json()) as { items: Array<{ name: string; access: string; canWrite: boolean; canManage: boolean }> };
    const plan = list.items.find((item) => item.name === 'plan')!;
    assert.equal(plan.access, 'write');
    assert.equal(plan.canWrite, true);
    assert.equal(plan.canManage, false);
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 403);

    // family admin: manages.
    writeAcl(planDir, 'probe', { me: 'admin', family: 'admin' });
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 200);
    const acl = await post(base, 'acl', { artifact: 'plan', acl: { me: 'admin', family: 'read' } }, 'probe2');
    assert.equal(acl.status, 200);
    const changed = (await acl.json()) as { artifact: { acl: { family: string } } };
    assert.equal(changed.artifact.acl.family, 'read');
  });
});

test('ACL: the owner changes me/family, a malformed level — 400', async () => {
  await withServer(async (base, config) => {
    const saved = await post(base, 'acl', { artifact: 'plan', acl: { me: 'write', family: 'write' } });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { artifact: { acl: { me: string; family: string }; canManage: boolean } };
    assert.deepEqual(body.artifact.acl, { me: 'write', family: 'write' });
    assert.equal(body.artifact.canManage, true, 'владелец не теряет управление');

    // none — a legitimate level for the family: the artifact becomes personal again.
    const hidden = await post(base, 'acl', { artifact: 'plan', acl: { me: 'admin', family: 'none' } });
    assert.equal(hidden.status, 200);
    const hiddenBody = (await hidden.json()) as { artifact: { acl: { family: string } } };
    assert.equal(hiddenBody.artifact.acl.family, 'none');
    assert.equal((await post(base, 'link', { artifact: 'plan' }, 'probe2')).status, 403);
    const familyList = (await (await api(base, 'list', {}, 'probe2')).json()) as { items: Array<{ name: string }> };
    assert.equal(familyList.items.some((item) => item.name === 'plan'), false, 'none скрывает артефакт из чужого списка');
    assert.equal((await api(base, 'read?artifact=plan', {}, 'probe2')).status, 403);
    assert.equal((await api(base, 'history?artifact=plan', {}, 'probe2')).status, 403);

    // The owner cannot be set to none, otherwise the artifact would disappear from their list.
    const ownerNone = await post(base, 'acl', { artifact: 'plan', acl: { me: 'none', family: 'none' } });
    assert.equal(ownerNone.status, 400);
    writeAcl(path.join(artifactsRoot(config), 'plan'), 'probe', DEFAULT_ACL);

    const bad = await post(base, 'acl', { artifact: 'plan', acl: { me: 'root', family: 'read' } });
    assert.equal(bad.status, 400);
  });
});

test('the link is revoked; an alien publicId does not open', async () => {
  await withServer(async (base) => {
    const linked = (await (await post(base, 'link', { artifact: 'plan' })).json()) as { urls: { public: string } };
    const publicPath = pathOf(linked.urls.public);
    const wrong = publicPath.replace(/\/([A-Za-z0-9_-]{16,})\/$/, `/${'x'.repeat(24)}/`);
    assert.equal((await fetch(`${base}${wrong}`)).status, 404);

    await post(base, 'unpublish', { artifact: 'plan' });
    assert.equal((await fetch(`${base}${publicPath}`)).status, 404);
  });
});

test('panel files require SSO', async () => {
  await withServer(async (base) => {
    const raw = '/panel/artifacts/raw/plan/index.md';
    assert.equal((await fetch(`${base}${raw}`)).status, 401);
    const withUser = await fetch(`${base}${raw}`, { headers: asUser() });
    assert.equal(withUser.status, 200);
    assert.match(await withUser.text(), /# План на четверг/);
    assert.equal((await fetch(`${base}/panel/artifacts/raw/plan/.git/config`, { headers: asUser() })).status, 404);
  });
});

test('deleting an artifact removes it from the list but keeps it in the trash', async () => {
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


test('version history: list, rollback and permissions', async () => {
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

    // family read sees the history but cannot roll back.
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

test('history: a garbage hash — 400, an alien artifact — 404', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, 'restore', { artifact: 'plan', commit: 'не-хеш' })).status, 400);
    assert.equal((await post(base, 'restore', { artifact: 'plan', commit: 'deadbeef' })).status, 400);
    assert.equal((await api(base, 'history?artifact=nope')).status, 404);
    assert.equal((await post(base, 'restore', { artifact: 'nope', commit: 'deadbeef' })).status, 404);
  });
});


test('version preview: content and assets without rollback', async () => {
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

    // The preview rolls nothing back.
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


test('previewing an HTML version serves index and relative assets', async () => {
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


test('edit chat: one conversation per artifact and only with write permission', async () => {
  await withServer(async (base, config) => {
    const first = await post(base, 'chat', { artifact: 'plan' });
    assert.equal(first.status, 200);
    const one = (await first.json()) as { chatId: string; title: string };
    assert.match(one.chatId, /^web-/);
    assert.match(one.title, /Правка · План на четверг/);

    // Reopening returns the same conversation rather than creating a second one.
    const again = (await (await post(base, 'chat', { artifact: 'plan' })).json()) as { chatId: string };
    assert.equal(again.chatId, one.chatId);

    // A /rename in the shared chat must not be rolled back on the next panel open.
    updateChatTitles(config, probe(), new Map([[one.chatId, 'Налоги']]));
    const renamed = (await (await post(base, 'chat', { artifact: 'plan' })).json()) as { title: string };
    assert.equal(renamed.title, 'Налоги', 'ручное имя служебного чата переживает повторное открытие');

    const chats = JSON.parse(
      fs.readFileSync(path.join(config.dataDir, 'users', 'probe', 'chats.json'), 'utf8'),
    ) as { chats: Array<{ id: string; artifact?: string; workspace: string }> };
    const record = chats.chats.find((chat) => chat.id === one.chatId);
    assert.equal(record?.artifact, 'plan');
    assert.equal(record?.workspace, 'talk');

    // Permissions are checked up front: a read-only artifact does not open a chat.
    item(config, 'viewonly', { 'index.md': '# Только смотреть\n', 'index.ai.md': '# Только смотреть\n' }, {
      me: 'read',
      family: 'read',
    });
    assert.equal((await post(base, 'chat', { artifact: 'viewonly' })).status, 403);
    assert.equal((await post(base, 'chat', { artifact: 'nope' })).status, 404);
  });
});


test('element refs: annotation, text edit and the version in history', async () => {
  await withServer(async (base, config) => {
    const file = path.join(artifactsRoot(config), 'report', 'index.html');

    const first = await post(base, 'refs', { artifact: 'report' });
    assert.equal(first.status, 200);
    const annotated = (await first.json()) as {
      refs: Array<{ ref: string; tag: string; quote: string; editable: boolean }>;
      base: string;
      changed: boolean;
      artifact: { canWrite: boolean };
    };
    assert.equal(annotated.changed, true, 'первый проход размечает файл');
    assert.equal(annotated.artifact.canWrite, true);
    const h1 = annotated.refs.find((item) => item.ref === 'h1');
    assert.ok(h1, 'у заголовка появился адрес');
    assert.equal(h1.tag, 'h1');
    assert.equal(h1.quote, 'Атлас');
    assert.equal(h1.editable, true);
    assert.match(fs.readFileSync(file, 'utf8'), /<h1 data-icarus-ref="h1">Атлас<\/h1>/);

    // Re-enabling element picking commits nothing.
    const again = (await (await post(base, 'refs', { artifact: 'report' })).json()) as {
      changed: boolean;
      base: string;
    };
    assert.equal(again.changed, false);
    assert.equal(again.base, annotated.base);

    const saved = await post(base, 'text', {
      artifact: 'report',
      ref: 'h1',
      text: 'Атлас 2',
      base: annotated.base,
    });
    assert.equal(saved.status, 200);
    const result = (await saved.json()) as { before: string; base: string };
    assert.equal(result.before, 'Атлас');
    assert.notEqual(result.base, annotated.base);
    assert.match(fs.readFileSync(file, 'utf8'), /<h1 data-icarus-ref="h1">Атлас 2<\/h1>/);

    const history = (await (await api(base, 'history?artifact=report')).json()) as {
      history: Array<{ subject: string }>;
    };
    assert.equal(history.history[0]!.subject, 'artifact: edit h1');
    assert.equal(history.history[1]!.subject, 'artifact: разметка элементов');
  });
});

test('text edit: a stale fingerprint, an alien ref and read-only — rejected', async () => {
  await withServer(async (base, config) => {
    const dir = path.join(artifactsRoot(config), 'report');
    const file = path.join(dir, 'index.html');
    const annotated = (await (await post(base, 'refs', { artifact: 'report' })).json()) as { base: string };

    // A ref from another artifact: no such ref here.
    const foreign = await post(base, 'text', {
      artifact: 'report',
      ref: 'main.page/section.hero/h1.title',
      text: 'Из чужой страницы',
      base: annotated.base,
    });
    assert.equal(foreign.status, 409);
    assert.match(fs.readFileSync(file, 'utf8'), /Атлас/);

    // The AI rewrote the file in the meantime: the fingerprint does not match — we do not apply the edit.
    fs.writeFileSync(file, '<html><body><h1>Уже другое</h1></body></html>');
    const stale = await post(base, 'text', {
      artifact: 'report',
      ref: 'h1',
      text: 'Из старой версии',
      base: annotated.base,
    });
    assert.equal(stale.status, 409);
    assert.match(fs.readFileSync(file, 'utf8'), /Уже другое/);

    // Without write permission you cannot annotate or edit, even if you can read.
    writeAcl(dir, 'probe', { me: 'admin', family: 'read' });
    assert.equal((await post(base, 'refs', { artifact: 'report' }, 'probe2')).status, 403);
    assert.equal(
      (await post(base, 'text', { artifact: 'report', ref: 'h1', text: 'Чужое', base: 'deadbeefdeadbeef' }, 'probe2'))
        .status,
      403,
    );

    // A Markdown artifact has no refs: this is not a permissions error but a different type.
    assert.equal((await post(base, 'refs', { artifact: 'plan' })).status, 400);
  });
});

test('preview with element picking: the script is only in the response, the file is unchanged', async () => {
  await withServer(async (base, config) => {
    const file = path.join(artifactsRoot(config), 'report', 'index.html');
    await post(base, 'refs', { artifact: 'report' });
    const before = fs.readFileSync(file, 'utf8');

    const plain = await fetch(`${base}/panel/artifacts/raw/report/index.html`, { headers: asUser() });
    assert.doesNotMatch(await plain.text(), /icarus-artifacts-pick/);

    const pick = await fetch(`${base}/panel/artifacts/raw/report/index.html?pick=1`, { headers: asUser() });
    assert.equal(pick.status, 200);
    assert.match(pick.headers.get('content-type') ?? '', /text\/html/);
    assert.match(pick.headers.get('content-security-policy') ?? '', /sandbox/);
    const html = await pick.text();
    assert.match(html, /Атлас/);
    assert.match(html, /icarus-artifacts-pick/, 'скрипт выбора доехал в ответ');
    assert.match(html, /postMessage/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'исходник на диске не тронут');

    // Element picking is the artifacts panel, not the public link.
    assert.equal((await fetch(`${base}/panel/artifacts/raw/report/index.html?pick=1`)).status, 401);
  });
});
