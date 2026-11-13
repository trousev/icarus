// The "User" section in the panel: one setting — the response language.
//
// The test goes through a live HTTP server: it is important to check the whole path
// end to end — the panel request, the profile file, the AGENTS.md that will go into
// the human's container. Language is useless if it was saved but did not reach the prompt.
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
  // We mark bump calls: changing the language must tell the registry that the
  // environment has changed, otherwise a live pi session keeps the old AGENTS.md until restart.
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

test('the "User" section is in the sidebar and opens', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/panel/profile`, { headers: asUser('probe') });
    assert.equal(page.status, 200);
    const html = await page.text();

    assert.match(html, /Пользователь/, 'раздел виден в сайдбаре');
    assert.match(html, /renderProfile/, 'страница знает про свой рендер');
    assert.match(html, /id="count-profile"|Пользователь/, 'пункт навигации отрисован');
    // The settings have no search or file list: this is a form, not a memory section.
    assert.doesNotMatch(html, /id="q" placeholder="Поиск по памяти"/);
  });
});

test('GET /panel/profile/api returns the current language and options', async () => {
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

test('the default from the config reaches the panel', async () => {
  await withServer(async (base) => {
    const body = (await (await get(base)).json()) as Record<string, unknown>;
    assert.equal(body.language, 'en');
  }, { userLanguage: 'en' });
});

test('saving the language writes the profile and reaches AGENTS.md', async () => {
  await withServer(async (base, config) => {
    const saved = await save(base, { language: 'en' });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { user: 'probe', language: 'en', uiLanguage: 'ru' });

    // The profile file is on the human's disk, next to the memory.
    assert.deepEqual(readProfile(config, probe('probe')), { language: 'en', uiLanguage: 'ru' });

    // And most importantly: the next container start will put the requirement to
    // answer in English into AGENTS.md. Without this the setting would be a button into the void.
    const { prepareUser } = await import('../src/workspace.ts');
    prepareUser(config, probe('probe'));
    const agents = fs.readFileSync(userPaths(config, probe('probe')).agentsMd, 'utf8');
    // We check the requirement, not one phrase: the language name is full, no code in the prompt.
    assert.match(agents, /Отвечай на языке: \*\*English\*\*/);
    assert.doesNotMatch(agents, /\ben\b/, 'код языка в промпт не попадает');
  });
});

test('one person\'s language does not touch another\'s', async () => {
  await withServer(async (base, config) => {
    await save(base, { language: 'en' }, 'probe');
    const second = (await (await get(base, 'probe2')).json()) as Record<string, unknown>;
    assert.equal(second.language, 'ru', 'у второго своё умолчание');

    assert.equal(readProfile(config, probe('probe'))?.language, 'en');
    assert.equal(readProfile(config, probe('probe2')), undefined);
  });
});

test('a foreign language and a broken body are rejected, the profile is not corrupted', async () => {
  await withServer(async (base, config) => {
    const bad = await save(base, { language: 'klingon' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: { message: string } }).error.message, /ru, en/);
    assert.equal(readProfile(config, probe('probe')), undefined, 'ничего не записалось');

    const empty = await save(base, {});
    assert.equal(empty.status, 400);

    // An uppercase language does not pass either: the panel sends exactly what it returned in GET.
    const upper = await save(base, { language: 'EN' });
    assert.equal(upper.status, 400);
  });
});

test('the proxy names the human: without the header and without devUser — refusal', async () => {
  await withServer(async (base) => {
    // devUser is not set in the test config — so there is nothing to name the human with, and
    // the service must refuse rather than open the profile of whoever comes first.
    const response = await fetch(`${base}/panel/profile/api`, { headers: {} });
    assert.equal(response.status, 401);
  });
});

test('the "User" section does not open memory files', async () => {
  await withServer(async (base) => {
    // There is no file list for the settings to request: the section is a form, and its root
    // is not the memory directory. We check that no foreign entity appeared there.
    const files = await fetch(`${base}/panel/profile/files`, { headers: asUser('probe') });
    assert.equal(files.status, 404, 'файлов у раздела нет');
  });
});

test('changing the language restarts the session, repeating it does not', async () => {
  await withServer(async (base, _config, bumped) => {
    // The language lives in AGENTS.md, and pi reads it at session start. Without this
    // mark the human would save English and hear the old Russian — exactly what
    // happened in production.
    await save(base, { language: 'en' });
    assert.deepEqual(bumped, ['probe'], 'смена языка помечает ресурсы обновлёнными');

    // The same language a second time — there is no point restarting the session: it loses context.
    await save(base, { language: 'en' });
    assert.deepEqual(bumped, ['probe'], 'повторное сохранение того же языка не трогает сессию');

    // And another person — their own mark.
    await save(base, { language: 'en' }, 'probe2');
    assert.deepEqual(bumped, ['probe', 'probe2']);
  });
});
