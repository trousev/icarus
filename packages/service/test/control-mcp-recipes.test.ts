// Каталог рецептов MCP: валидность описаний, подстановка в форму и добавление.
//
// Тест намеренно не ходит в сеть: рецепт — это описание, а не живой сервер.
// Проверяем то, что панель обещает человеку: команда и транспорт подставлены,
// ключи только из env/заголовков, значений секретов в каталоге нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths } from '../src/config.ts';
import { prepareUser } from '../src/workspace.ts';
import { readStore, storePaths } from '../src/mcp/registry.ts';
import {
  MCP_RECIPES,
  RECIPE_CHECKED_AT,
  RECIPE_RULE,
  RECIPE_SKIPPED,
  recipeById,
  recipeEditor,
} from '../src/mcp/recipes.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

const USERS = [probe('probe'), probe('probe2')];

function headers(userId?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(userId === undefined ? {} : { [PANEL_USER_HEADER]: userId }) };
}

type Editor = ReturnType<typeof recipeEditor>;

async function withServer(
  run: (base: string, config: ReturnType<typeof makeConfig>) => Promise<void>,
  overrides: Parameters<typeof makeConfig>[0] = {},
): Promise<void> {
  const config = makeConfig({ users: USERS, ...overrides });
  for (const user of config.users) prepareUser(config, user);
  const registry = { bumpResources: () => 0, oneShot: async () => '', list: () => [] };
  const server = createServer(config, registry as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  config.url = base;
  try {
    await run(base, config);
  } finally {
    server.close();
  }
}

const get = (base: string, route: string, user = 'probe') => fetch(`${base}${route}`, { headers: headers(user) });

const post = (base: string, user: string, route: string, body: Record<string, unknown>) =>
  fetch(`${base}/panel/mcp/${route}`, { method: 'POST', headers: headers(user), body: JSON.stringify(body) });

/** Тело, какое соберёт форма после подстановки рецепта: ключи пустые. */
function formBody(editor: Editor): Record<string, unknown> {
  return {
    name: editor.server.name,
    description: editor.server.description,
    transport: editor.server.transport,
    url: editor.server.url ?? '',
    command: editor.server.command ?? '',
    args: (editor.server.args ?? []).join('\n'),
    auth: editor.server.auth,
    headers: editor.server.headers ?? {},
    env: editor.server.env ?? {},
    credentialHeaders: {},
    credentialEnv: {},
    // Как форма: имена ключей из рецепта едут вместе с описанием, значения — нет.
    expectsHeaders: editor.expectsHeaders,
    expectsEnv: editor.expectsEnv,
    shared: false,
  };
}

function piMcp(config: ReturnType<typeof makeConfig>, userId: string): { mcpServers: Record<string, Record<string, unknown>> } {
  const file = path.join(userPaths(config, probe(userId)).piAgent, 'mcp.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
}

test('каталог: id и имена уникальны, команда и транспорт сходятся, обязательные поля на месте', () => {
  assert.ok(MCP_RECIPES.length >= 6, 'рецептов должно хватать на кандидатов из идеи');
  assert.equal(new Set(MCP_RECIPES.map((recipe) => recipe.id)).size, MCP_RECIPES.length, 'id уникальны');
  assert.equal(new Set(MCP_RECIPES.map((recipe) => recipe.name)).size, MCP_RECIPES.length, 'имена уникальны');

  for (const recipe of MCP_RECIPES) {
    assert.match(recipe.id, /^[a-z][a-z0-9-]{1,40}$/, `${recipe.id}: id — строчная латиница и дефис`);
    assert.ok(recipe.name.trim() !== '' && recipe.name.length <= 80, `${recipe.id}: имя влезает в карточку`);
    assert.ok(recipe.category.trim() !== '', `${recipe.id}: категория нужна для бейджа`);
    assert.ok(recipe.description.length > 0 && recipe.description.length <= 600, `${recipe.id}: описание до 600`);
    assert.ok(recipe.when.length >= 20, `${recipe.id}: «когда нужен» — это не заглушка`);

    if (recipe.transport === 'stdio') {
      assert.equal(recipe.url, undefined, `${recipe.id}: у stdio нет адреса`);
      assert.ok(recipe.command && recipe.command.trim() !== '', `${recipe.id}: у stdio есть команда`);
      assert.ok((recipe.args ?? []).length > 0, `${recipe.id}: у stdio есть аргументы`);
      assert.notEqual(recipe.auth, 'oauth', `${recipe.id}: OAuth не бывает у stdio`);
      assert.equal(recipe.secretKind, 'env', `${recipe.id}: ключи stdio живут в env`);
    } else {
      assert.equal(recipe.command, undefined, `${recipe.id}: у HTTP нет команды`);
      assert.ok(recipe.url !== undefined, `${recipe.id}: у HTTP есть адрес`);
      assert.match(recipe.url ?? '', /^https?:\/\//, `${recipe.id}: адрес http(s)`);
      assert.equal(recipe.secretKind, 'header', `${recipe.id}: ключи HTTP живут в заголовке`);
    }

    if (recipe.secrets.length > 0 && !recipe.secretsOptional) {
      assert.equal(recipe.auth, 'headers', `${recipe.id}: обязательные ключи — значит, нужна авторизация`);
    } else {
      assert.equal(recipe.auth, 'none', `${recipe.id}: без ключей (или они необязательные) авторизация не нужна`);
    }
    for (const secret of recipe.secrets) {
      assert.ok(secret.name.trim() !== '', `${recipe.id}: у ключа есть имя`);
      assert.ok(secret.hint.trim() !== '', `${recipe.id}: у ключа есть подсказка, где его взять`);
      assert.match(secret.name, /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, `${recipe.id}: имя ключа — имя переменной/заголовка`);
    }
    for (const [name, value] of Object.entries(recipe.env ?? {})) {
      assert.ok(value !== '', `${recipe.id}.${name}: пустую переменную окружения форма всё равно выбросит`);
    }

    assert.ok(recipe.requires.length > 0, `${recipe.id}: честно перечислено, что нужно снаружи`);
    assert.ok(recipe.steps.length > 0, `${recipe.id}: есть шаги`);
    assert.ok(recipe.trouble.length > 0, `${recipe.id}: есть «если не поднялся»`);
    assert.match(recipe.docs, /^https:\/\//, `${recipe.id}: документация по https`);
    assert.match(recipe.checkedAt, /^\d{4}-\d{2}-\d{2}$/, `${recipe.id}: дата проверки`);
    // Каталог собран 09.11; новый рецепт могли проверить позже — важно, что не раньше.
    assert.ok(recipe.checkedAt >= RECIPE_CHECKED_AT, `${recipe.id}: дата проверки не раньше каталога`);
  }

  assert.ok(RECIPE_RULE.includes('раз в неделю'), 'критерий отбора виден в тексте правила');
  assert.ok(RECIPE_SKIPPED.includes('Банки'), 'отказ от банков объяснён, а не забыт');
});

test('в рецептах нет значений секретов: только имена и подсказки', () => {
  const suspicious = [/sk-[A-Za-z0-9]{8,}/, /Bearer\s+[A-Za-z0-9._-]{12,}/, /(?:password|token|secret)\s*[:=]\s*\S{8,}/i];
  for (const recipe of MCP_RECIPES) {
    const json = JSON.stringify(recipe);
    for (const pattern of suspicious) {
      assert.doesNotMatch(json, pattern, `${recipe.id}: похоже на вписанный секрет (${pattern})`);
    }
    const editor = recipeEditor(recipe);
    assert.deepEqual(
      editor.credentialEnv,
      recipe.secretKind === 'env' ? recipe.secrets.map((secret) => secret.name) : [],
      `${recipe.id}: в env попадают только имена ключей`,
    );
    assert.deepEqual(
      editor.credentialHeaders,
      recipe.secretKind === 'header' ? recipe.secrets.map((secret) => secret.name) : [],
      `${recipe.id}: в заголовки попадают только имена ключей`,
    );
    assert.deepEqual(editor.server.env, recipe.env, `${recipe.id}: постоянные env — РОВНО из рецепта`);
    assert.equal(editor.oauth, null, `${recipe.id}: OAuth-рецептов в каталоге нет`);
    assert.equal(editor.global, false, `${recipe.id}: рецепт — личный сервер, а не общий из конфига`);
  }
});

test('GET /panel/mcp/recipes отдаёт правило, каталог и дату проверки', async () => {
  await withServer(async (base) => {
    const response = await get(base, '/panel/mcp/recipes');
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      recipes: Array<{ id: string; secrets: Array<Record<string, unknown>> }>;
      rule: string;
      skipped: string;
      checkedAt: string;
    };
    assert.equal(data.rule, RECIPE_RULE);
    assert.equal(data.skipped, RECIPE_SKIPPED);
    assert.equal(data.checkedAt, RECIPE_CHECKED_AT);
    assert.equal(data.recipes.length, MCP_RECIPES.length);
    for (const recipe of data.recipes) {
      for (const secret of recipe.secrets) {
        assert.ok(Object.hasOwn(secret, 'name'), 'у ключа есть имя');
        assert.equal(Object.hasOwn(secret, 'value'), false, 'значения секрета в каталоге нет');
      }
    }
  });
});

test('GET /panel/mcp/recipe подставляет команду, транспорт и имена ключей', async () => {
  await withServer(async (base) => {
    const response = await get(base, '/panel/mcp/recipe?id=proton-mail');
    assert.equal(response.status, 200);
    const editor = (await response.json()) as Editor;
    assert.equal(editor.recipe.id, 'proton-mail');
    assert.equal(editor.server.name, 'Proton Mail');
    assert.equal(editor.server.transport, 'stdio');
    assert.equal(editor.server.command, 'npx');
    assert.deepEqual(editor.server.args, ['-y', '--package=proton-mail-bridge-client', 'proton-mail-bridge-mcp']);
    assert.equal(editor.server.env?.PROTONMAIL_IMAP_PORT, '1143');
    assert.deepEqual(editor.credentialEnv, ['PROTONMAIL_USERNAME', 'PROTONMAIL_PASSWORD']);
    assert.deepEqual(editor.credentialHeaders, []);

    const home = (await (await get(base, '/panel/mcp/recipe?id=homeassistant')).json()) as Editor;
    assert.equal(home.server.transport, 'streamable-http');
    assert.equal(home.server.url, 'http://homeassistant.local:8123/api/mcp');
    assert.deepEqual(home.credentialHeaders, ['Authorization']);
    assert.deepEqual(home.credentialEnv, []);

    const weather = (await (await get(base, '/panel/mcp/recipe?id=weather-dublin')).json()) as Editor;
    assert.equal(weather.server.auth, 'none');
    assert.deepEqual(weather.credentialEnv, []);

    const missing = await get(base, '/panel/mcp/recipe?id=no-such-recipe');
    assert.equal(missing.status, 404);
    assert.equal(recipeById('no-such-recipe'), undefined);
  });
});

test('рецепт добавляется как обычный сервер: пока ключей нет, модели его не обещают', async () => {
  await withServer(async (base, config) => {
    const editor = (await (await get(base, '/panel/mcp/recipe?id=proton-mail')).json()) as Editor;
    const response = await fetch(`${base}/panel/mcp/add`, {
      method: 'POST',
      headers: headers('probe'),
      body: JSON.stringify(formBody(editor)),
    });
    assert.equal(response.status, 200);
    const created = (await response.json()) as { server: { id: string; ready: boolean; credentialEnv: string[] } };
    assert.equal(created.server.ready, false, 'без ключей сервер добавлен, но не готов');
    assert.deepEqual(created.server.credentialEnv, ['PROTONMAIL_USERNAME', 'PROTONMAIL_PASSWORD']);

    const servers = (await (await get(base, '/panel/mcp/servers')).json()) as {
      servers: Array<{ id: string; name: string; ready: boolean }>;
      ready: number;
    };
    assert.deepEqual(servers.servers.map((server) => server.name), ['Proton Mail']);
    assert.equal(servers.ready, 0);

    // Готового доступа нет — сервера нет и в mcp.json: иначе модель получила бы
    // инструменты, которые молча падают на каждом вызове.
    assert.equal(piMcp(config, 'probe').mcpServers[created.server.id], undefined);

    // Человек вводит ключи — теперь сервер готов и уезжает в контейнер.
    const saved = await post(base, 'probe', 'credentials', {
      id: created.server.id,
      env: { PROTONMAIL_USERNAME: 'me@proton.me', PROTONMAIL_PASSWORD: 'bridge-pass' },
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { server: { ready: boolean } }).server.ready, true);

    const entry = piMcp(config, 'probe').mcpServers[created.server.id];
    assert.ok(entry, 'сервер попал в mcp.json');
    assert.equal(entry.command, 'npx');
    assert.deepEqual(entry.args, ['-y', '--package=proton-mail-bridge-client', 'proton-mail-bridge-mcp']);
    const env = entry.env as Record<string, string>;
    assert.equal(env.PROTONMAIL_IMAP_PORT, '1143', 'несекретные настройки рецепта доехали');
    assert.equal(env.PROTONMAIL_PASSWORD, 'bridge-pass', 'ключ доезжает до сервера, иначе он бесполезен');

    // Но в реестре описаний ключа нет: он живёт отдельным файлом 0600.
    const paths = storePaths(config);
    assert.equal(fs.readFileSync(paths.registry, 'utf8').includes('bridge-pass'), false, 'в registry.json ключа нет');
    assert.equal(fs.readFileSync(paths.credentials, 'utf8').includes('bridge-pass'), true, 'в credentials.json ключ есть');
    assert.equal(readStore(config).servers[created.server.id]?.credentialEnv?.length, 2, 'имена ключей пережили сохранение');
  });
});

test('рецепт без ключей добавляется готовым: погода с metric и basic', async () => {
  await withServer(async (base, config) => {
    const editor = (await (await get(base, '/panel/mcp/recipe?id=weather-dublin')).json()) as Editor;
    const response = await fetch(`${base}/panel/mcp/add`, {
      method: 'POST',
      headers: headers('probe'),
      body: JSON.stringify(formBody(editor)),
    });
    assert.equal(response.status, 200);
    const created = (await response.json()) as { server: { id: string; ready: boolean; enabled: boolean } };
    assert.equal(created.server.ready, true, 'ключи не нужны — сервер готов сразу');
    assert.equal(created.server.enabled, true, 'владельцу сервер включён сразу');

    assert.deepEqual(readStore(config).credentials, {}, 'у погоды нечего хранить в секретах');
    const entry = piMcp(config, 'probe').mcpServers[created.server.id];
    assert.equal((entry.env as Record<string, string>).WEATHER_UNITS, 'metric');
    assert.equal((entry.env as Record<string, string>).ENABLED_TOOLS, 'basic');
  });
});


test('рецепт OPDS: адрес каталога в env, запуск ленивый', async () => {
  const recipe = recipeById('opds');
  assert.ok(recipe, 'рецепт OPDS в каталоге');
  assert.equal(recipe.category, 'книги');
  assert.equal(recipe.transport, 'stdio');
  assert.equal(recipe.command, 'node');
  assert.deepEqual(recipe.args, ['/opt/icarus/tools/opds-mcp/server.mjs']);
  assert.ok(recipe.env?.OPDS_URL, 'адрес каталога — несекретная настройка в env');
  assert.deepEqual(
    recipe.secrets.map((secret) => secret.name),
    ['OPDS_USER', 'OPDS_PASSWORD', 'OPDS_TOKEN'],
    'ключи закрытого каталога — секреты, а не переменные описания',
  );
  assert.equal(recipe.secretsOptional, true, 'открытый каталог работает и без ключей');
  assert.equal(recipe.auth, 'none');

  await withServer(async (base, config) => {
    const editor = (await (await get(base, '/panel/mcp/recipe?id=opds')).json()) as Editor;
    const response = await fetch(`${base}/panel/mcp/add`, {
      method: 'POST',
      headers: headers('probe'),
      body: JSON.stringify(formBody(editor)),
    });
    assert.equal(response.status, 200);
    const created = (await response.json()) as { server: { id: string; ready: boolean } };
    assert.equal(created.server.ready, true, 'ключей нет — каталог готов сразу');

    const entry = piMcp(config, 'probe').mcpServers[created.server.id];
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, ['/opt/icarus/tools/opds-mcp/server.mjs']);
    assert.equal(entry.lifecycle, 'lazy', 'сервер стартует по требованию, а не при старте pi');
    assert.deepEqual(entry.env, { OPDS_URL: recipe.env?.OPDS_URL }, 'адрес каталога доехал до сервера');
  });
});

test('Кинозал — обычный рецепт: четыре env-ключа, ленивый, без ручного mcp.arr', async () => {
  const recipe = recipeById('kinozal');
  assert.ok(recipe, 'рецепт кинозала есть в каталоге');
  assert.equal(recipe.category, 'медиа');
  assert.equal(recipe.transport, 'stdio');
  assert.equal(recipe.command, 'node');
  assert.deepEqual(recipe.args, ['/opt/icarus/tools/arr-mcp/server.mjs'], 'сервер едет в контейнер из репозитория');
  assert.equal(recipe.secretKind, 'env');
  assert.deepEqual(
    recipe.secrets.map((secret) => secret.name),
    ['ARR_RADARR_URL', 'ARR_RADARR_KEY', 'ARR_SONARR_URL', 'ARR_SONARR_KEY'],
    'адреса и ключи вводит человек: в рецепте только имена',
  );

  await withServer(async (base, config) => {
    const editor = (await (await get(base, '/panel/mcp/recipe?id=kinozal')).json()) as Editor;
    assert.deepEqual(editor.server.env, undefined, 'несекретных значений в рецепте нет — адреса у каждого свои');
    assert.deepEqual(editor.credentialEnv, ['ARR_RADARR_URL', 'ARR_RADARR_KEY', 'ARR_SONARR_URL', 'ARR_SONARR_KEY']);

    const added = await fetch(`${base}/panel/mcp/add`, {
      method: 'POST',
      headers: headers('probe'),
      body: JSON.stringify(formBody(editor)),
    });
    assert.equal(added.status, 200);
    const created = (await added.json()) as { server: { id: string; ready: boolean } };
    assert.equal(created.server.ready, false, 'без ключей сервер добавлен, но не готов');

    // Одной пары достаточно: Radarr без Sonarr — рабочая настройка, а пустые
    // значения формы не должны превращаться в пустые переменные в контейнере.
    const saved = await post(base, 'probe', 'credentials', {
      id: created.server.id,
      env: {
        ARR_RADARR_URL: 'http://radarr:7878',
        ARR_RADARR_KEY: 'radarr-key',
        ARR_SONARR_URL: '',
        ARR_SONARR_KEY: '',
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { server: { ready: boolean } }).server.ready, true);

    const entry = piMcp(config, 'probe').mcpServers[created.server.id];
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, ['/opt/icarus/tools/arr-mcp/server.mjs']);
    assert.equal(entry.lifecycle, 'lazy', 'рецепт не тянет инструменты в каждый разговор');
    const env = entry.env as Record<string, string>;
    assert.equal(env.ARR_RADARR_URL, 'http://radarr:7878');
    assert.equal(env.ARR_RADARR_KEY, 'radarr-key', 'ключ доезжает до сервера');
    assert.equal(env.ARR_SONARR_URL, undefined, 'пустая вторая пара не уезжает в контейнер');
  });
});
test('Видео в блог-пост — обычный рецепт: ключей не просит, ленивый, берёт ключ Икара', async () => {
  const recipe = recipeById('video-blog');
  assert.ok(recipe, 'рецепт видео в блог-пост есть в каталоге');
  assert.equal(recipe.category, 'медиа');
  assert.equal(recipe.transport, 'stdio');
  assert.equal(recipe.command, 'node');
  assert.deepEqual(recipe.args, ['/opt/icarus/tools/video-blog-mcp/server.mjs'], 'сервер едет в контейнер из репозитория');
  assert.deepEqual(recipe.secrets, [], 'отдельных ключей нет: работает на DEEPINFRA_API_KEY Икара');
  assert.equal(recipe.auth, 'none');
  assert.ok(recipe.env?.VIDEO_BLOG_ASR_MODEL, 'модель расшифровки видна и меняется в форме');
  assert.ok(recipe.env?.VIDEO_BLOG_LLM_MODEL, 'модель редактора видна и меняется в форме');
  assert.ok(
    recipe.requires.some((line) => line.includes('DEEPINFRA_API_KEY')),
    'сказано, чей это ключ, а не «нужен ключ вообще»',
  );

  await withServer(async (base, config) => {
    const editor = (await (await get(base, '/panel/mcp/recipe?id=video-blog')).json()) as Editor;
    assert.deepEqual(editor.expectsEnv, [], 'форма ничего не просит у человека');

    const added = await fetch(`${base}/panel/mcp/add`, {
      method: 'POST',
      headers: headers('probe'),
      body: JSON.stringify(formBody(editor)),
    });
    assert.equal(added.status, 200);
    const created = (await added.json()) as { server: { id: string; ready: boolean } };
    assert.equal(created.server.ready, true, 'ключей нет — сервер готов сразу');

    const entry = piMcp(config, 'probe').mcpServers[created.server.id];
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, ['/opt/icarus/tools/video-blog-mcp/server.mjs']);
    assert.equal(entry.lifecycle, 'lazy', 'рецепт не тянет инструменты в каждый разговор');
    assert.deepEqual(entry.env, recipe.env, 'несекретные настройки доехали до сервера');
  });
});
test('страница MCP рисует каталог рецептов, а не только список серверов', async () => {
  await withServer(async (base) => {
    const response = await get(base, '/panel/mcp');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="mcp-recipes"/);
    assert.match(html, /id="mcp-rule"/);
    assert.match(html, /id="mcp-skipped"/);
    assert.match(html, /\/panel\/mcp\/recipes/, 'клиент знает, откуда читать каталог');
    // Рецепты приезжают клиентом и в HTML не вшиваются: страница не должна
    // пухнуть от описаний, которые нужны только разделу MCP.
    assert.doesNotMatch(html, /proton-mail-bridge-mcp/);
  });
});

// Ради этого всё и затевалось: два OPDS-каталога с разными настройками сразу.
test('два сервера одного рецепта живут одновременно и не перетирают друг друга', async () => {
  await withServer(async (base, config) => {
    const recipe = recipeById('opds');
    assert.ok(recipe);
    const gutenberg = formBody(recipeEditor(recipe));
    const home = formBody(recipeEditor(recipe));
    (home.env as Record<string, string>).OPDS_URL = 'http://calibre.local:8080/opds/';
    // Закрытый каталог: у него свои ключи, у открытого — своих нет.
    home.credentialEnv = { OPDS_USER: 'icarus', OPDS_PASSWORD: 'demo-pass' };

    const first = (await (await post(base, 'probe', 'add', gutenberg)).json()) as { server: { id: string } };
    const second = (await (await post(base, 'probe', 'add', home)).json()) as { server: { id: string } };
    assert.equal(first.server.id, 'opds-katalog');
    assert.notEqual(second.server.id, first.server.id, 'второй сервер получил свой id');

    const opdsOf = (id: string) =>
      (piMcp(config, 'probe').mcpServers[id]?.env as Record<string, string> | undefined)?.OPDS_URL;
    assert.equal(opdsOf(first.server.id), 'https://www.gutenberg.org/ebooks.opds/');
    assert.equal(opdsOf(second.server.id), 'http://calibre.local:8080/opds/');
    assert.equal(
      (piMcp(config, 'probe').mcpServers[second.server.id]?.env as Record<string, string>).OPDS_USER,
      'icarus',
      'ключи закрытого каталога уехали только ему',
    );
    assert.equal(
      (piMcp(config, 'probe').mcpServers[first.server.id]?.env as Record<string, string>).OPDS_USER,
      undefined,
      'открытому каталогу чужой логин не достался',
    );
    const credentials = JSON.parse(fs.readFileSync(storePaths(config).credentials, 'utf8')) as Record<
      string,
      Record<string, { env?: Record<string, string> }>
    >;
    assert.deepEqual(Object.keys(credentials.probe ?? {}), [second.server.id], 'секреты лежат под своим сервером');

    // Панель показывает адрес, иначе два OPDS в списке выглядели бы одинаково.
    const views = (await (await get(base, '/panel/mcp/servers')).json()) as {
      servers: Array<{ id: string; target: string }>;
    };
    assert.match(views.servers.find((item) => item.id === first.server.id)?.target ?? '', /gutenberg\.org/);
    assert.match(views.servers.find((item) => item.id === second.server.id)?.target ?? '', /calibre\.local/);

    const agents = fs.readFileSync(userPaths(config, probe('probe')).agentsMd, 'utf8');
    for (const id of [first.server.id, second.server.id]) {
      assert.match(agents, new RegExp('`' + id + '`'), `${id}: сервер в AGENTS.md`);
    }

    // Правка одного — только его: у второго адрес остаётся прежним.
    const repointed = formBody(recipeEditor(recipe));
    (repointed.env as Record<string, string>).OPDS_URL = 'http://other.local:8080/opds/';
    const updated = await post(base, 'probe', 'update', { id: second.server.id, ...repointed });
    assert.equal(updated.status, 200);
    assert.equal(opdsOf(first.server.id), 'https://www.gutenberg.org/ebooks.opds/');
    assert.equal(opdsOf(second.server.id), 'http://other.local:8080/opds/');
    assert.equal(
      (piMcp(config, 'probe').mcpServers[second.server.id]?.env as Record<string, string>).OPDS_USER,
      'icarus',
      'правка адреса не стёрла личные ключи',
    );
  });
});
