// Control panel behind an SSO proxy: the header names the person, it doesn't open someone else's data,
// and without a header the panel explains that it must stand behind a proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import { commitAll } from '../src/control/git.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function seed(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** This is what a request that reached the service through Authelia looks like: it named the person. */
function asUser(userId?: string): Record<string, string> {
  return userId === undefined ? {} : { [PANEL_USER_HEADER]: userId };
}

async function withServer(
  handler: (base: string, config: IcarusConfig) => Promise<void>,
  overrides: Partial<IcarusConfig> = {},
): Promise<void> {
  const config = makeConfig({
    users: [probe('probe'), probe('probe2')],
    ...overrides,
  });
  seed(userPaths(config, probe('probe')).memory, {
    'identity.md': '# Кто\n- Живёт в Москве\n',
    'people/barsik.md': '- Кот, рыжий\n',
  });
  seed(userPaths(config, probe('probe2')).memory, { 'secret.md': '- Чужой секрет\n' });
  seed(userPaths(config, probe('probe')).sharedMemory, { 'family.md': '- Общий факт\n' });

  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, config);
  } finally {
    server.close();
  }
}

function api(base: string, userId: string | undefined, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/panel/api/${route}`, {
    ...init,
    headers: { ...asUser(userId), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

test('without the proxy header the panel denies access and explains where to look for the cause', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel`);
    assert.equal(page.status, 401);
    const html = await page.text();
    assert.match(html, /Remote-User/, 'сказано, какого заголовка не хватает');
    assert.match(html, /SSO-прокси/, 'сказано, за чем панель должна стоять');
    assert.match(html, /panel\.devUser/, 'сказано, как запустить локально');

    const api401 = await fetch(`${base}/panel/api/files`);
    assert.equal(api401.status, 401);
    const body = (await api401.json()) as { error?: { message?: string } };
    assert.match(String(body.error?.message), /Remote-User/);
  });
});

test('the header names the person: the panel opens under one\'s own name', async () => {
  await withServer(async (base) => {
    // The panel root is chat: that's the main screen. Old links to a memory file
    // still lead to memory.
    const root = await fetch(`${base}/panel`, { headers: asUser('probe'), redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/panel/chat');

    const legacy = await fetch(`${base}/panel?file=identity.md`, { headers: asUser('probe'), redirect: 'manual' });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), '/panel/memory?scope=personal&file=identity.md');

    const chat = await fetch(`${base}/panel/chat`, { headers: asUser('probe') });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /Чем займёмся\?/, 'корень — чат, а не настройки');

    const response = await fetch(`${base}/panel/memory?scope=personal`, { headers: asUser('probe') });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Icarus Control Panel/);
    assert.match(html, /"user":"probe"/, 'в странице — имя вошедшего: его назвал прокси');
    assert.match(html, /Icarus \/ Память \/ <b>Личная<\/b>/, 'крошки знают, где мы');
    assert.doesNotMatch(html, /panel\.devUser/, 'объяснять отказ нечего: доступ есть');
  });
});

test('the domain root redirects to the panel', async () => {
  await withServer(async (base) => {
    const response = await fetch(base, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/panel');
  });
});

test('the section decides the scope: skills don\'t pretend to be memory and vice versa', async () => {
  await withServer(async (base) => {
    // The scope is not honored before the section: `/panel/memory?scope=maple` used
    // to open someone else's catalog under the memory heading. Now an unfamiliar scope
    // is personal memory, and it doesn't open any fifth root.
    const personalInMemory = (await (
      await fetch(`${base}/panel/memory/files?scope=maple`, { headers: asUser('probe') })
    ).json()) as { scope: string; mode: string; files: Array<{ path: string }> };
    assert.equal(personalInMemory.scope, 'personal', 'незнакомая область — это личная память');
    assert.equal(personalInMemory.mode, 'memory');
    assert.deepEqual(personalInMemory.files.map((file) => file.path).sort(), ['identity.md', 'people/barsik.md']);

    // Skills have no scope at all: whatever is in scope, the section returns skills,
    // not someone else's catalog. Skills also can't declare a scope of their own.
    const skills = (await (
      await fetch(`${base}/panel/skills/files?scope=maple`, { headers: asUser('probe') })
    ).json()) as { scope: string; mode: string; skills: unknown[] };
    assert.equal(skills.scope, 'skills');
    assert.equal(skills.mode, 'skills');
    assert.deepEqual(skills.skills, [], 'пустой каталог скиллов — это пустой список скиллов');

    const state = (await (await api(base, 'probe', 'state')).json()) as { scopes: string[] };
    assert.deepEqual(state.scopes, ['personal', 'shared']);
  });
});

test('the panel denies access to a stranger instead of showing empty memory', async () => {
  await withServer(async (base) => {
    // The person exists in LDAP, but not in users: config.yaml — that's exactly what we must say.
    const page = await fetch(`${base}/panel`, { headers: asUser('stranger') });
    assert.equal(page.status, 403);
    assert.match(await page.text(), /«stranger» не заведён в Icarus/);

    const response = await api(base, 'stranger', 'files');
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error?: { message?: string } };
    assert.match(String(body.error?.message), /ICARUS_USERS/);
  });
});

test('a section URL with a trailing slash opens, and a broken body is a rejection, not a crash', async () => {
  await withServer(async (base) => {
    // A browser or a person appends a trailing slash just because: the section must not disappear because of it.
    const slash = await fetch(`${base}/panel/memory/`, { headers: asUser('probe') });
    assert.equal(slash.status, 200);
    assert.match(await slash.text(), /Icarus Control Panel/);

    const broken = await fetch(`${base}/panel/memory/forget-many`, {
      method: 'POST',
      headers: { ...asUser('probe'), 'content-type': 'application/json' },
      body: '{это не json',
    });
    assert.equal(broken.status, 400, 'битый запрос — отказ, а не исключение посреди обработки');
  });
});

test('the page doesn\'t call native confirm and its script compiles', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/panel/memory`, { headers: asUser('probe') })).text();

    // The browser suppresses native modals if the tab is not active, and confirm() silently
    // returns false — the "forget"/"revert" buttons stop working. A custom dialog
    // is required, and window.confirm in the code is a regression.
    assert.doesNotMatch(html, /[^.\w]confirm\(/, 'нативный confirm вернулся');
    assert.match(html, /askConfirm/, 'своего диалога подтверждения нет');

    // The script is assembled from a template literal with escaping: a typo in the backslashes
    // breaks the whole page, and the tests don't see it. Compilation catches this immediately.
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'в странице нет скрипта');
    assert.doesNotThrow(() => new Function(script), 'скрипт панели не компилируется');
  });
});

test('the panel shows only the person\'s own memory', async () => {
  await withServer(async (base) => {
    const state = (await (await api(base, 'probe', 'state')).json()) as {
      sections: Array<{ id: string; label: string }>;
      scopes: string[];
      modes: Record<string, string>;
    };
    assert.deepEqual(
      state.sections,
      [
        { id: 'memory', label: 'Память' },
        { id: 'skills', label: 'Скиллы' },
        { id: 'mcp', label: 'MCP' },
        { id: 'tasks', label: 'Задачи' },
        { id: 'profile', label: 'Пользователь' },
      ],
      'разделы панели приходят из сервиса',
    );
    // There are exactly two memory scopes: skills are a separate section with their own root.
    assert.deepEqual(state.scopes, ['personal', 'shared'], 'скиллы не область памяти');
    assert.deepEqual(state.modes, { personal: 'memory', shared: 'memory' });

    const files = (await (await api(base, 'probe', 'files?scope=personal')).json()) as {
      user: string;
      files: Array<{ path: string }>;
    };
    assert.equal(files.user, 'probe');
    const paths = files.files.map((file) => file.path).sort();
    assert.deepEqual(paths, ['identity.md', 'people/barsik.md']);

    // Someone else's file can't be fetched: the person is set by the header, not by the request.
    const alien = await api(base, 'probe', 'file?scope=personal&path=secret.md');
    assert.equal(alien.status, 404);
  });
});

test('memory entries come with dates from the history, and a batch is removed with a single commit', async () => {
  await withServer(async (base, config) => {
    const memory = userPaths(config, probe('probe')).memory;
    // Memory lives in git: entry dates are the dates of the commits that touched them.
    assert.equal(await commitAll(memory, 'memory: разбор разговора'), true);

    const data = (await (await api(base, 'probe', 'entries?scope=personal&path=identity.md')).json()) as {
      total: number;
      entries: Array<{ line: number; kind: string; date: string | null }>;
    };
    assert.equal(data.total, 1);
    assert.deepEqual(
      data.entries.map((entry) => [entry.line, entry.kind]),
      [
        [1, 'heading'],
        [2, 'note'],
      ],
    );
    assert.match(String(data.entries[1].date), /^\d{4}-\d{2}-\d{2}$/, 'у записи есть дата коммита');

    // A heading is not an entry: removing it means removing the whole section along with its entries.
    const heading = await api(base, 'probe', 'forget-many', {
      method: 'POST',
      body: JSON.stringify({ scope: 'personal', path: 'identity.md', lines: [1] }),
    });
    assert.equal(heading.status, 400);
    assert.match(String(((await heading.json()) as { error: { message: string } }).error.message), /не запись/);

    const removal = await api(base, 'probe', 'forget-many', {
      method: 'POST',
      body: JSON.stringify({ scope: 'personal', path: 'identity.md', lines: [2] }),
    });
    assert.equal(removal.status, 200);
    assert.equal(((await removal.json()) as { removed: number }).removed, 1);
    assert.doesNotMatch(String(fs.readFileSync(path.join(memory, 'identity.md'))), /Москве/, 'запись убрана');

    // Removing a batch is also a memory edit, and therefore a commit visible in the history.
    const commits = (await (await api(base, 'probe', 'history?scope=personal')).json()) as {
      commits: Array<{ subject: string }>;
    };
    assert.match(commits.commits[0].subject, /убрать записей/);
  });
});

test('file history shows commits with line counts, and does not read someone else\'s paths', async () => {
  await withServer(async (base, config) => {
    const memory = userPaths(config, probe('probe')).memory;
    assert.equal(await commitAll(memory, 'memory: разбор разговора'), true);
    fs.appendFileSync(path.join(memory, 'identity.md'), '- Тишина после 23:00\n');
    assert.equal(await commitAll(memory, 'memory: дописал предпочтение'), true);

    const history = (await (
      await api(base, 'probe', 'file-history?scope=personal&path=identity.md')
    ).json()) as { commits: Array<{ subject: string; added: number; removed: number; hash: string }> };
    assert.equal(history.commits.length, 2);
    assert.match(history.commits[0].subject, /дописал предпочтение/);
    assert.equal(history.commits[0].added, 1, 'в панели видно, сколько строк прибавил коммит');
    assert.ok(history.commits[0].hash.length >= 40);

    // We don't show the history of someone else's file: the path is checked the same way as on read.
    const alien = (await (
      await api(base, 'probe', 'file-history?scope=personal&path=secret.md')
    ).json()) as { commits: unknown[] };
    assert.deepEqual(alien.commits, []);
  });
});

test('the file downloads as a file: name in the header, bytes as is', async () => {
  await withServer(async (base, config) => {
    const memory = userPaths(config, probe('probe')).memory;
    // Cyrillic in a name is not uncommon (projects/здоровье.md), and it can't be in the ASCII
    // variant of the header: the name must be sent twice.
    fs.writeFileSync(path.join(memory, 'projects.md'), '- Проверка\n');
    fs.mkdirSync(path.join(memory, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(memory, 'projects', 'здоровье.md'), '- По состоянию на 21.09.2026 — всё хорошо\n');

    const text = await fetch(`${base}/panel/memory/file?scope=personal&path=identity.md&download=1`, {
      headers: asUser('probe'),
    });
    assert.equal(text.status, 200);
    assert.match(String(text.headers.get('content-disposition')), /^attachment; filename="identity\.md"/);
    assert.match(String(await text.text()), /Живёт в Москве/, 'содержимое отдаётся как есть');

    const cyrillic = await fetch(
      `${base}/panel/memory/file?scope=personal&path=${encodeURIComponent('projects/здоровье.md')}&download=1`,
      { headers: asUser('probe') },
    );
    const disposition = String(cyrillic.headers.get('content-disposition'));
    assert.match(disposition, /filename="________\.md"/, 'ASCII-вариант без кириллицы');
    assert.match(disposition, /filename\*=UTF-8''%D0%B7%D0%B4%D0%BE%D1%80%D0%BE%D0%B2%D1%8C%D0%B5\.md/, 'имя целиком — в UTF-8');

    // Downloading is a read, not an edit: the path checks here are the same.
    const alien = await fetch(`${base}/panel/memory/file?scope=personal&path=secret.md&download=1`, {
      headers: asUser('probe'),
    });
    assert.equal(alien.status, 404);
    assert.equal(
      (await fetch(`${base}/panel/memory/file?scope=personal&path=../../etc/passwd.md&download=1`, {
        headers: asUser('probe'),
      })).status,
      404,
      'за пределы раздела скачивание не выводит',
    );
  });
});

test('user spoofing in the request is ignored — only the header sets the person', async () => {
  await withServer(async (base) => {
    const response = await api(base, 'probe', 'files?scope=personal&user=probe2');
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

test('the old personal pass in the link is not needed and breaks nothing', async () => {
  await withServer(async (base) => {
    // Links from the chat remain in people's bookmarks: the t parameter is simply ignored,
    // and the proxy still names the person.
    const page = await fetch(`${base}/panel?t=probe%3A123%3Adeadbeef`, { headers: asUser('probe') });
    assert.equal(page.status, 200);
  });
});

test('panel.devUser grants access without a proxy, but the proxy word is stronger', async () => {
  const config = { panel: { userHeader: PANEL_USER_HEADER, devUser: 'probe' } };
  await withServer(async (base, _config) => {
    const local = await fetch(`${base}/panel/api/state`);
    assert.equal(local.status, 200);
    assert.equal(((await local.json()) as { user: string }).user, 'probe', 'локально — человек из конфига');

    const throughProxy = await api(base, 'probe2', 'state');
    assert.equal(((await throughProxy.json()) as { user: string }).user, 'probe2', 'прокси называет человека сам');
  }, config);
});

test('family memory is accessible but remains shared', async () => {
  await withServer(async (base) => {
    const shared = await api(base, 'probe', 'file?scope=shared&path=family.md');
    assert.equal(shared.status, 200);
    const body = (await shared.json()) as { content: string };
    assert.match(body.content, /Общий факт/);
  });
});

test('a memory file is deleted entirely by a commit and returned by a revert', async () => {
  await withServer(async (base, config) => {
    const memory = userPaths(config, probe('probe')).memory;
    const barsik = path.join(memory, 'people/barsik.md');
    // Memory lives in git: by the time of deletion the file is already in the parsing history —
    // otherwise there would be nothing to return with a revert, and the deletion would be irreversible.
    assert.equal(await commitAll(memory, 'memory: разбор разговора'), true);

    const deletion = await api(base, 'probe', 'delete', {
      method: 'POST',
      body: JSON.stringify({ scope: 'personal', path: 'people/barsik.md' }),
    });
    assert.equal(deletion.status, 200);
    const body = (await deletion.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.equal(fs.existsSync(barsik), false, 'файл удалён с диска');

    // Deletion is an ordinary memory edit: the commit is visible in the history, and it can be reverted.
    const commits = (await (await api(base, 'probe', 'history?scope=personal')).json()) as {
      commits: Array<{ hash: string; subject: string }>;
    };
    assert.match(commits.commits[0].subject, /удалить файл/);
    const revert = await api(base, 'probe', 'revert', {
      method: 'POST',
      body: JSON.stringify({ scope: 'personal', commit: commits.commits[0].hash }),
    });
    assert.equal(revert.status, 200);
    assert.equal(fs.existsSync(barsik), true, 'откат вернул файл');
  });
});

test('file deletion: someone else\'s, non-markdown and directory escape are rejected', async () => {
  await withServer(async (base) => {
    const attempt = (body: Record<string, unknown>) =>
      api(base, 'probe', 'delete', { method: 'POST', body: JSON.stringify(body) });

    assert.equal((await attempt({ scope: 'personal', path: '../../etc/passwd.md' })).status, 400);
    assert.equal((await attempt({ scope: 'personal', path: 'notes.txt' })).status, 400, 'чужой формат не трогаем');
    assert.equal((await attempt({ scope: 'personal', path: 'secret.md' })).status, 400, 'чужого файла не видно');
    assert.equal((await attempt({ scope: 'personal', path: '' })).status, 400);
  });
});

test('the old "settings over chat" link leads to the section page', async () => {
  // Settings are no longer opened in an iframe: they have their own page and their own menu
  // in the left panel. Bookmarks with `?settings=` must not hit an empty chat.
  await withServer(async (base) => {
    const legacy = await fetch(`${base}/panel/chat?settings=memory`, {
      headers: asUser('probe'),
      redirect: 'manual',
    });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), '/panel/memory');

    const unknown = await fetch(`${base}/panel/chat?settings=nope`, {
      headers: asUser('probe'),
      redirect: 'manual',
    });
    assert.equal(unknown.status, 200, 'неизвестный раздел редиректом не притворяемся');
  });
});
