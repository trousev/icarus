// UI language is a separate setting from response language.
//
// Idea 11 conflated three things: response language, UI language and memory language. Here
// the boundary between the first two is guarded: they live in one profile but change
// independently, survive a reload and do not leak into each other. Memory language is not
// translated at all — this is verified by the fact that only the response language goes
// into AGENTS.md, while the panel shows memory files as is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths, type IcarusConfig } from '../src/config.ts';
import {
  DEFAULT_UI_LANGUAGE,
  languageOf,
  profilePath,
  readProfile,
  UI_LANGUAGES,
  uiLanguageOf,
  writeProfile,
} from '../src/profile.ts';
import { languageRule, prepareUser } from '../src/workspace.ts';
import { panelStrings } from '../src/control/strings.ts';
import { panelHtml, sessionStrings, sessionUiLanguage, type PanelSession } from '../src/control/ui.ts';
import { chatPage } from '../src/control/chat-ui.ts';
import { mcpPage } from '../src/control/mcp-ui.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function asUser(userId = 'probe'): Record<string, string> {
  return { [PANEL_USER_HEADER]: userId };
}

async function withServer(
  handler: (base: string, config: IcarusConfig, bumped: string[]) => Promise<void>,
  overrides: Partial<IcarusConfig> = {},
): Promise<void> {
  const config = makeConfig({ users: [probe('probe'), probe('probe2')], ...overrides });
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

function save(base: string, body: unknown, userId = 'probe'): Promise<Response> {
  return fetch(`${base}/panel/profile/api`, {
    method: 'POST',
    headers: { ...asUser(userId), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('the profile stores UI language separately from response language', () => {
  const config = makeConfig();

  writeProfile(config, probe(), { language: 'en', uiLanguage: 'ru' });
  assert.equal(languageOf(config, probe()), 'en', 'ответы — английские');
  assert.equal(uiLanguageOf(config, probe()), 'ru', 'интерфейс — русский');

  // And vice versa: the settings are independent, not "one for both".
  writeProfile(config, probe(), { language: 'ru', uiLanguage: 'en' });
  assert.equal(languageOf(config, probe()), 'ru', 'ответы — русские');
  assert.equal(uiLanguageOf(config, probe()), 'en', 'интерфейс — английский');

  assert.deepEqual(readProfile(config, probe()), { language: 'ru', uiLanguage: 'en' });
});

test('an old profile.json without uiLanguage leaves the UI Russian', () => {
  const config = makeConfig();
  const file = profilePath(config, probe());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // This is what the profile looked like before this setting: only the response language.
  fs.writeFileSync(file, 'language: en\n');

  assert.deepEqual(readProfile(config, probe()), { language: 'en', uiLanguage: 'ru' });
  assert.equal(uiLanguageOf(config, probe()), DEFAULT_UI_LANGUAGE);
  assert.equal(languageOf(config, probe()), 'en', 'язык ответов из старого профиля не потерялся');
});

test('an unknown UI locale falls back to Russian, responses are not corrupted', () => {
  const config = makeConfig();
  const file = profilePath(config, probe());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'language: en\nuiLanguage: klingon\n');

  assert.equal(uiLanguageOf(config, probe()), 'ru');
  assert.equal(languageOf(config, probe()), 'en', 'чужой uiLanguage не сбрасывает язык ответов');
});

test('UI language does not go into the prompt and does not change responses', () => {
  const config = makeConfig();
  writeProfile(config, probe(), { language: 'ru', uiLanguage: 'en' });
  prepareUser(config, probe());

  const agents = fs.readFileSync(userPaths(config, probe()).agentsMd, 'utf8');
  // Only the RESPONSE language goes into the prompt. The English UI is a panel setting
  // and has nothing to do with the persona and the language of messages.
  assert.match(agents, /Отвечай на языке: \*\*Russian\*\*/);
  assert.doesNotMatch(agents, /English/, 'интерфейс не подменил язык ответов');
  assert.match(languageRule('ru'), /Отвечай на языке: \*\*Russian\*\*/);
});

test('the ru and en dictionaries diverge neither in keys nor in empty strings', () => {
  const ru = panelStrings('ru');
  const en = panelStrings('en');

  // A flat list of paths: the type already obliges EN and RU to have one set of keys, but
  // at runtime this is worth checking — the dictionary is edited by hand, and "forgot a string"
  // happens exactly on a new key, not on an old one.
  const collect = (value: unknown, prefix = ''): Array<[string, string]> =>
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]): Array<[string, string]> => {
      const name = prefix ? `${prefix}.${key}` : key;
      if (typeof item === 'string') return [[name, item]];
      if (Array.isArray(item)) {
        return item.flatMap((entry, index) =>
          typeof entry === 'string' ? [[`${name}[${index}]`, entry] as [string, string]] : collect(entry, `${name}[${index}]`),
        );
      }
      return collect(item, name);
    });
  const ruStrings = collect(ru);
  const enStrings = collect(en);
  assert.deepEqual(enStrings.map(([name]) => name).sort(), ruStrings.map(([name]) => name).sort(), 'ключи совпадают');

  for (const [name, value] of [...ruStrings, ...enStrings]) {
    assert.ok(value.trim().length > 0, `пустая строка: ${name}`);
  }

  // The main labels are actually translated, not left in Russian.
  assert.equal(ru.sectionMemory, 'Память');
  assert.equal(en.sectionMemory, 'Memory');
  assert.equal(ru.newChat, 'Новый чат');
  assert.equal(en.newChat, 'New chat');
  assert.equal(ru.answerLanguageLabel, 'ЯЗЫК ОТВЕТОВ');
  assert.equal(en.answerLanguageLabel, 'ANSWER LANGUAGE');
  assert.equal(en.interfaceLanguageLabel, 'INTERFACE LANGUAGE');
  // Ready-made queries are also panel labels: their count must match.
  assert.equal(en.suggestions.length, ru.suggestions.length);
});

test('an unknown session language yields Russian strings, not an empty panel', () => {
  const session: PanelSession = {
    user: 'probe',
    sections: [{ id: 'memory', label: 'Память' }],
    scopes: { personal: 'memory', shared: 'memory' },
    uiLanguage: 'de',
  };
  assert.equal(sessionUiLanguage(session), 'ru');
  assert.equal(sessionStrings(session).sectionMemory, 'Память');

  // And the server-side markup does not crash on a foreign locale.
  const html = panelHtml(session, { section: 'memory', scope: 'personal' });
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /ПАМЯТЬ АГЕНТА/);
});

test('the panel and chat markup switches to English', () => {
  const session: PanelSession = {
    user: 'probe',
    sections: [
      { id: 'memory', label: 'Memory' },
      { id: 'skills', label: 'Skills' },
      { id: 'profile', label: 'Profile' },
    ],
    scopes: { personal: 'memory', shared: 'memory' },
    scopeLabels: { personal: 'Personal', shared: 'Family' },
    uiLanguage: 'en',
    language: 'ru',
  };

  const memory = panelHtml(session, { section: 'memory', scope: 'personal' });
  assert.match(memory, /<html lang="en">/);
  assert.match(memory, /AGENT MEMORY/);
  assert.match(memory, /Search memory/);
  assert.match(memory, /Personal/);
  // Memory is not translated — the panel honestly labels why the headings are Russian.
  assert.match(memory, /Memory files are written in Russian/);

  const chat = chatPage(session, { enabled: true });
  assert.match(chat, /<html lang="en">/);
  assert.match(chat, /New chat/);
  assert.match(chat, /Search by title/);
  assert.match(chat, /What shall we do\?/);
  assert.match(chat, /Message Icarus\.\.\./);
  // New sections from main are also in the dictionary: folders, archive, queue, file panel.
  assert.match(chat, /Folder/);
  assert.match(chat, /Archive/);
  assert.match(chat, /Queued: 0/);
  assert.match(chat, /Interrupt and send/);
  assert.match(chat, /Search files/);
  assert.doesNotMatch(chat, />\s*Папка\s*<|>\s*Архив\s*<|В очереди: 0|placeholder="Поиск по файлам"/);
  // The MCP recipe catalog is a separate page with the same UI language.
  const mcp = mcpPage(session);
  assert.match(mcp, /Recipes/);
  assert.match(mcp, /Add MCP/);
  assert.match(mcp, /MY SERVERS/);
  assert.doesNotMatch(mcp, />\s*Рецепты\s*<|>\s*Добавить MCP\s*<|>\s*МОИ СЕРВЕРЫ\s*</);
  // The Russian variant of the same place is a control that this is not a coincidence.
  const ru = panelHtml({ ...session, uiLanguage: 'ru', sections: [{ id: 'memory', label: 'Память' }] }, { section: 'memory' });
  assert.match(ru, /<html lang="ru">/);
  assert.match(ru, /ПАМЯТЬ АГЕНТА/);
  assert.doesNotMatch(ru, /Memory files are written in Russian/);
});

test('GET /panel/profile/api returns both settings and their lists', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/panel/profile/api`, { headers: asUser() });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.language, 'ru');
    assert.equal(body.uiLanguage, 'ru', 'интерфейс по умолчанию русский');
    assert.deepEqual(body.uiLanguages, [...UI_LANGUAGES]);
    assert.equal((body.uiLabels as Record<string, string>).en, 'English');
  });
});

test('switching the UI does not touch responses and does not restart the session', async () => {
  await withServer(async (base, config, bumped) => {
    // Changing the response language is a reason to bring pi up again: AGENTS.md is read at startup.
    await save(base, { language: 'en' });
    assert.deepEqual(bumped, ['probe'], 'смена языка ответов пометила ресурсы');

    // The UI lives only in the panel: we do not tear down the session because of it.
    const switched = await save(base, { uiLanguage: 'en' });
    assert.equal(switched.status, 200);
    assert.deepEqual(bumped, ['probe'], 'язык интерфейса не перезапускает разговор');

    assert.deepEqual(readProfile(config, probe()), { language: 'en', uiLanguage: 'en' });
    const body = (await (await fetch(`${base}/panel/profile/api`, { headers: asUser() })).json()) as Record<string, unknown>;
    assert.equal(body.language, 'en', 'язык ответов не сбросился');
    assert.equal(body.uiLanguage, 'en');

    // Back as well, one field at a time: the UI language survives a response language change.
    await save(base, { language: 'ru' });
    assert.deepEqual(bumped, ['probe', 'probe']);
    assert.deepEqual(readProfile(config, probe()), { language: 'ru', uiLanguage: 'en' });
  });
});

test('an unknown UI language is rejected, the profile is not corrupted', async () => {
  await withServer(async (base, config) => {
    const bad = await save(base, { uiLanguage: 'klingon' });
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: { message: string } };
    assert.match(body.error.message, /ru, en/);
    assert.equal(readProfile(config, probe()), undefined, 'ничего не записалось');

    // An empty body is also a rejection: there is nothing to change, and silently writing defaults is not allowed.
    const empty = await save(base, {});
    assert.equal(empty.status, 400);
  });
});

test('the section page and the chat arrive already in the selected language', async () => {
  await withServer(async (base, config) => {
    writeProfile(config, probe(), { language: 'ru', uiLanguage: 'en' });

    const memory = await (await fetch(`${base}/panel/memory`, { headers: asUser() })).text();
    assert.match(memory, /<html lang="en">/);
    assert.match(memory, /AGENT MEMORY/);
    assert.match(memory, /Memory files are written in Russian/);
    assert.doesNotMatch(memory, /ПАМЯТЬ АГЕНТА/);

    const chat = await (await fetch(`${base}/panel/chat`, { headers: asUser() })).text();
    assert.match(chat, /<html lang="en">/);
    assert.match(chat, /Search by title/);
    assert.match(chat, /"lang":"en"/, 'клиент получил английский словарь');

    // A second person does not inherit someone else's UI: the setting is personal.
    const other = await (await fetch(`${base}/panel/memory`, { headers: asUser('probe2') })).text();
    assert.match(other, /<html lang="ru">/);
    assert.match(other, /ПАМЯТЬ АГЕНТА/);
  });
});
