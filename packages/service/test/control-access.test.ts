// Панель управления за SSO-прокси: человека называет заголовок, чужого он не открывает,
// а без заголовка панель объясняет, что обязана стоять за прокси.
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

/** Так выглядит запрос, дошедший до сервиса через Authelia: он и назвал человека. */
function asUser(userId?: string): Record<string, string> {
  return userId === undefined ? {} : { [PANEL_USER_HEADER]: userId };
}

async function withServer(
  handler: (base: string, config: IcarusConfig) => Promise<void>,
  overrides: Partial<IcarusConfig> = {},
): Promise<void> {
  const config = makeConfig({
    users: [probe('probe'), probe('probe2')],
    // Maple настроен: у панели появляется третий раздел — математика.
    mcp: { maple: { command: 'node', args: ['/opt/icarus/tools/maple-mcp/server.mjs'] } },
    ...overrides,
  });
  seed(userPaths(config, probe('probe')).memory, {
    'identity.md': '# Кто\n- Живёт в Москве\n',
    'people/barsik.md': '- Кот, рыжий\n',
  });
  seed(userPaths(config, probe('probe2')).memory, { 'secret.md': '- Чужой секрет\n' });
  seed(userPaths(config, probe('probe')).sharedMemory, { 'family.md': '- Общий факт\n' });
  // Расчёты Maple: журнал сессии и график. Панель показывает их в разделе математики.
  seed(userPaths(config, probe('probe')).maple, {
    'osc.jsonl': '{"t":"2026-09-21T10:00:00.000Z","code":"sol:=dsolve(diff(y(x),x)=y(x)):"}\n',
    '0123456789abcdef.gif': 'GIF89a',
  });
  seed(userPaths(config, probe('probe2')).maple, { 'чужой.jsonl': '{"code":"secret"}:\n' });

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

test('без заголовка прокси панель не пускает и объясняет, где искать причину', async () => {
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

test('человека называет заголовок: панель открывается со своим именем', async () => {
  await withServer(async (base) => {
    // Старый адрес ведёт на память: он и раньше её открывал, и в закладках он есть.
    const root = await fetch(`${base}/panel`, { headers: asUser('probe'), redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/panel/memory?scope=personal');

    const response = await fetch(`${base}/panel/memory?scope=personal`, { headers: asUser('probe') });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Icarus Control Panel/);
    assert.match(html, /"user":"probe"/, 'в странице — имя вошедшего: его назвал прокси');
    assert.match(html, /Icarus \/ Память \/ <b>Личная<\/b>/, 'крошки знают, где мы');
    assert.doesNotMatch(html, /panel\.devUser/, 'объяснять отказ нечего: доступ есть');

    // Раздел математики — свой адрес, и там та же панель.
    const maple = await fetch(`${base}/panel/maple?scope=maple`, { headers: asUser('probe') });
    assert.equal(maple.status, 200);
    assert.match(await maple.text(), /Icarus \/ <b>Математика<\/b>/);
  });
});

test('корень домена уводит в панель', async () => {
  await withServer(async (base) => {
    const response = await fetch(base, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/panel');
  });
});

test('незнакомого человека панель не пускает, а не показывает пустую память', async () => {
  await withServer(async (base) => {
    // Человек есть в LDAP, но его нет в users: config.yaml — сказать надо именно это.
    const page = await fetch(`${base}/panel`, { headers: asUser('stranger') });
    assert.equal(page.status, 403);
    assert.match(await page.text(), /«stranger» не заведён в Icarus/);

    const response = await api(base, 'stranger', 'files');
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error?: { message?: string } };
    assert.match(String(body.error?.message), /ICARUS_USERS/);
  });
});

test('адрес раздела с хвостовым слэшем открывается, а битое тело — отказ, не падение', async () => {
  await withServer(async (base) => {
    // Браузер и человек дописывают слэш просто так: раздел от этого не должен пропадать.
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

test('страница не зовёт нативные confirm и её скрипт компилируется', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/panel/memory`, { headers: asUser('probe') })).text();

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

test('панель показывает только память своего человека', async () => {
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
        { id: 'maple', label: 'Математика' },
      ],
      'разделы панели приходят из сервиса',
    );
    assert.deepEqual(state.scopes, ['personal', 'shared', 'maple']);
    assert.deepEqual(state.modes, { personal: 'memory', shared: 'memory', maple: 'maple' });

    const files = (await (await api(base, 'probe', 'files?scope=personal')).json()) as {
      user: string;
      files: Array<{ path: string }>;
    };
    assert.equal(files.user, 'probe');
    const paths = files.files.map((file) => file.path).sort();
    assert.deepEqual(paths, ['identity.md', 'people/barsik.md']);

    // Чужого файла не достать: человека задаёт заголовок, а не запрос.
    const alien = await api(base, 'probe', 'file?scope=personal&path=secret.md');
    assert.equal(alien.status, 404);
  });
});

test('записи памяти приезжают с датами из истории, а пачка удаляется одним коммитом', async () => {
  await withServer(async (base, config) => {
    const memory = userPaths(config, probe('probe')).memory;
    // Память живёт в git: даты записей — это даты коммитов, которые их тронули.
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

    // Заголовок — не запись: снести его значит снести весь раздел вместе с записями.
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

    // Удаление пачки — тоже правка памяти, а значит коммит, который видно в истории.
    const commits = (await (await api(base, 'probe', 'history?scope=personal')).json()) as {
      commits: Array<{ subject: string }>;
    };
    assert.match(commits.commits[0].subject, /убрать записей/);
  });
});

test('история файла показывает коммиты с числом строк, а чужие пути не читает', async () => {
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

    // Историю чужого файла не показываем: путь проверяется так же, как при чтении.
    const alien = (await (
      await api(base, 'probe', 'file-history?scope=personal&path=secret.md')
    ).json()) as { commits: unknown[] };
    assert.deepEqual(alien.commits, []);
  });
});

test('файл скачивается как файл: имя в заголовке, байты как есть', async () => {
  await withServer(async (base, config) => {
    const memory = userPaths(config, probe('probe')).memory;
    // Кириллица в имени — не редкость (projects/здоровье.md), а в ASCII-варианте
    // заголовка её быть не может: имя обязано уехать дважды.
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

    // График Maple: скачивание не должно превращать картинку в текст.
    const plot = await fetch(`${base}/panel/maple/file?scope=maple&path=0123456789abcdef.gif&download=1`, {
      headers: asUser('probe'),
    });
    assert.equal(plot.headers.get('content-type'), 'image/gif');
    assert.equal(await plot.text(), 'GIF89a', 'байты те же, что и у <img>');

    // Скачивание — это чтение, а не правка: проверки пути тут те же.
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

test('подмена user в запросе игнорируется — человека задаёт только заголовок', async () => {
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

test('старый личный пропуск в ссылке не нужен и ничего не ломает', async () => {
  await withServer(async (base) => {
    // Ссылки из чата остались у людей в закладках: параметр t просто игнорируется,
    // а человека по-прежнему называет прокси.
    const page = await fetch(`${base}/panel?t=probe%3A123%3Adeadbeef`, { headers: asUser('probe') });
    assert.equal(page.status, 200);
  });
});

test('panel.devUser пускает без прокси, но слово прокси сильнее', async () => {
  const config = { panel: { userHeader: PANEL_USER_HEADER, devUser: 'probe' } };
  await withServer(async (base, _config) => {
    const local = await fetch(`${base}/panel/api/state`);
    assert.equal(local.status, 200);
    assert.equal(((await local.json()) as { user: string }).user, 'probe', 'локально — человек из конфига');

    const throughProxy = await api(base, 'probe2', 'state');
    assert.equal(((await throughProxy.json()) as { user: string }).user, 'probe2', 'прокси называет человека сам');
  }, config);
});

test('семейная память доступна, но остаётся общей', async () => {
  await withServer(async (base) => {
    const shared = await api(base, 'probe', 'file?scope=shared&path=family.md');
    assert.equal(shared.status, 200);
    const body = (await shared.json()) as { content: string };
    assert.match(body.content, /Общий факт/);
  });
});

test('файл памяти удаляется целиком коммитом и возвращается откатом', async () => {
  await withServer(async (base, config) => {
    const memory = userPaths(config, probe('probe')).memory;
    const barsik = path.join(memory, 'people/barsik.md');
    // Память живёт в git: к моменту удаления файл уже в истории разбора — иначе
    // возвращать откатом было бы нечего, и удаление оказалось бы необратимым.
    assert.equal(await commitAll(memory, 'memory: разбор разговора'), true);

    const deletion = await api(base, 'probe', 'delete', {
      method: 'POST',
      body: JSON.stringify({ scope: 'personal', path: 'people/barsik.md' }),
    });
    assert.equal(deletion.status, 200);
    const body = (await deletion.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.equal(fs.existsSync(barsik), false, 'файл удалён с диска');

    // Удаление — обычная правка памяти: коммит видно в истории, и он откатывается.
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

test('удаление файла: чужое, не-markdown и выход из каталога не проходят', async () => {
  await withServer(async (base) => {
    const attempt = (body: Record<string, unknown>) =>
      api(base, 'probe', 'delete', { method: 'POST', body: JSON.stringify(body) });

    assert.equal((await attempt({ scope: 'personal', path: '../../etc/passwd.md' })).status, 400);
    assert.equal((await attempt({ scope: 'personal', path: 'osc.jsonl' })).status, 400, 'чужой формат не трогаем');
    assert.equal((await attempt({ scope: 'personal', path: 'secret.md' })).status, 400, 'чужого файла не видно');
    assert.equal((await attempt({ scope: 'personal', path: '' })).status, 400);
  });
});

test('раздел математики показывает расчёты Maple, но не даёт их править', async () => {
  await withServer(async (base) => {
    const files = (await (await api(base, 'probe', 'files?scope=maple')).json()) as {
      mode: string;
      files: Array<{ path: string }>;
    };
    assert.equal(files.mode, 'maple', 'раздел математики помечен как read-only');
    assert.deepEqual(files.files.map((file) => file.path).sort(), ['0123456789abcdef.gif', 'osc.jsonl']);

    const journal = await api(base, 'probe', 'file?scope=maple&path=osc.jsonl');
    assert.equal(journal.status, 200);
    assert.match(String(((await journal.json()) as { content: string }).content), /dsolve/);

    // График — байтами, а не строкой в JSON: так его показывает <img> в панели.
    const plot = await api(base, 'probe', 'file?scope=maple&path=0123456789abcdef.gif&raw=1');
    assert.equal(plot.status, 200);
    assert.equal(plot.headers.get('content-type'), 'image/gif');
    assert.equal(await plot.text(), 'GIF89a');

    // Журнал сессии — это код, из которого Maple восстанавливает состояние:
    // построчная правка через панель его сломала бы.
    const forget = await api(base, 'probe', 'forget', {
      method: 'POST',
      body: JSON.stringify({ scope: 'maple', path: 'osc.jsonl', line: '{' }),
    });
    assert.equal(forget.status, 400);
    const revert = await api(base, 'probe', 'revert', {
      method: 'POST',
      body: JSON.stringify({ scope: 'maple', commit: 'deadbee' }),
    });
    assert.equal(revert.status, 400);
    // Удалить журнал целиком — тоже правка, и в математике её быть не должно.
    const remove = await api(base, 'probe', 'delete', {
      method: 'POST',
      body: JSON.stringify({ scope: 'maple', path: 'osc.jsonl' }),
    });
    assert.equal(remove.status, 400);

    // Новые маршруты разделов читают то же самое и так же не дают править Maple:
    // раздел в адресе сильнее области в запросе.
    const journalEntries = (await (
      await fetch(`${base}/panel/maple/entries?scope=maple&path=osc.jsonl`, { headers: asUser('probe') })
    ).json()) as { entries: Array<{ text: string }>; capped: boolean };
    assert.equal(journalEntries.capped, false);
    assert.match(journalEntries.entries.map((entry) => entry.text).join('\n'), /dsolve/);

    const sneaky = await fetch(`${base}/panel/maple/forget-many`, {
      method: 'POST',
      headers: { ...asUser('probe'), 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'personal', path: 'osc.jsonl', lines: [1] }),
    });
    assert.equal(sneaky.status, 400, 'математика правится только со стороны Maple');

    // И чужого человека в математике тоже не видно.
    assert.equal((await api(base, 'probe', 'file?scope=maple&path=чужой.jsonl')).status, 404);
  });
});

test('панель не отдаёт журнал Maple как память', async () => {
  await withServer(async (base) => {
    // Каталоги разные: файл математики в личной памяти не открывается вовсе.
    assert.equal((await api(base, 'probe', 'file?scope=personal&path=osc.jsonl')).status, 404);
    // И наоборот: markdown памяти не притворяется расчётом Maple.
    assert.equal((await api(base, 'probe', 'file?scope=maple&path=identity.md')).status, 404);
  });
});

test('без Maple в конфиге раздела математики нет и через API', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  seed(userPaths(config, probe('probe')).maple, { 'osc.jsonl': '{}\n' });
  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const base = `http://127.0.0.1:${port}`;
    const state = (await (await api(base, 'probe', 'state')).json()) as { scopes: string[] };
    assert.deepEqual(state.scopes, ['personal', 'shared'], 'выключенный раздел не предлагается');
    // Старые файлы на диске остались — но доступа к ним у панели быть не должно.
    assert.equal((await api(base, 'probe', 'files?scope=maple')).status, 404);
  } finally {
    server.close();
  }
});
