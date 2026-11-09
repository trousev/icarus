// Язык интерфейса — отдельная настройка от языка ответов.
//
// Идея 11 слипала три вещи: язык ответов, язык интерфейса и язык памяти. Тут
// охраняется граница между первыми двумя: они живут в одном профиле, но меняются
// порознь, переживают перезагрузку и не протекают друг в друга. Язык памяти не
// переводится вовсе — это проверяется тем, что в AGENTS.md уезжает только язык
// ответов, а файлы памяти панель показывает как есть.
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

test('профиль хранит язык интерфейса отдельно от языка ответов', () => {
  const config = makeConfig();

  writeProfile(config, probe(), { language: 'en', uiLanguage: 'ru' });
  assert.equal(languageOf(config, probe()), 'en', 'ответы — английские');
  assert.equal(uiLanguageOf(config, probe()), 'ru', 'интерфейс — русский');

  // И наоборот: настройки независимы, а не «одна на двоих».
  writeProfile(config, probe(), { language: 'ru', uiLanguage: 'en' });
  assert.equal(languageOf(config, probe()), 'ru', 'ответы — русские');
  assert.equal(uiLanguageOf(config, probe()), 'en', 'интерфейс — английский');

  assert.deepEqual(readProfile(config, probe()), { language: 'ru', uiLanguage: 'en' });
});

test('старый profile.json без uiLanguage оставляет интерфейс русским', () => {
  const config = makeConfig();
  const file = profilePath(config, probe());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Так выглядел профиль до этой настройки: только язык ответов.
  fs.writeFileSync(file, 'language: en\n');

  assert.deepEqual(readProfile(config, probe()), { language: 'en', uiLanguage: 'ru' });
  assert.equal(uiLanguageOf(config, probe()), DEFAULT_UI_LANGUAGE);
  assert.equal(languageOf(config, probe()), 'en', 'язык ответов из старого профиля не потерялся');
});

test('неизвестная локаль интерфейса — русский, ответы не портятся', () => {
  const config = makeConfig();
  const file = profilePath(config, probe());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'language: en\nuiLanguage: klingon\n');

  assert.equal(uiLanguageOf(config, probe()), 'ru');
  assert.equal(languageOf(config, probe()), 'en', 'чужой uiLanguage не сбрасывает язык ответов');
});

test('язык интерфейса не уезжает в промпт и не меняет ответы', () => {
  const config = makeConfig();
  writeProfile(config, probe(), { language: 'ru', uiLanguage: 'en' });
  prepareUser(config, probe());

  const agents = fs.readFileSync(userPaths(config, probe()).agentsMd, 'utf8');
  // В промпт едет только язык ОТВЕТОВ. Английский интерфейс — настройка панели,
  // к характеру и языку реплик отношения не имеет.
  assert.match(agents, /Отвечай на языке: \*\*Russian\*\*/);
  assert.doesNotMatch(agents, /English/, 'интерфейс не подменил язык ответов');
  assert.match(languageRule('ru'), /Отвечай на языке: \*\*Russian\*\*/);
});

test('словари ru и en не разъезжаются ни по ключам, ни по пустым строкам', () => {
  const ru = panelStrings('ru');
  const en = panelStrings('en');

  // Плоский список путей: тип уже обязывает EN и RU иметь один набор ключей, но
  // на рантайме это стоит проверить — словарь правят руками, и «забыл строку»
  // случается ровно на новом ключе, а не на старом.
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

  // Главные подписи действительно переведены, а не оставлены русскими.
  assert.equal(ru.sectionMemory, 'Память');
  assert.equal(en.sectionMemory, 'Memory');
  assert.equal(ru.newChat, 'Новый чат');
  assert.equal(en.newChat, 'New chat');
  assert.equal(ru.answerLanguageLabel, 'ЯЗЫК ОТВЕТОВ');
  assert.equal(en.answerLanguageLabel, 'ANSWER LANGUAGE');
  assert.equal(en.interfaceLanguageLabel, 'INTERFACE LANGUAGE');
  // Готовые запросы — тоже подписи панели: их количество должно совпадать.
  assert.equal(en.suggestions.length, ru.suggestions.length);
});

test('неизвестный язык сессии даёт русские строки, а не пустую панель', () => {
  const session: PanelSession = {
    user: 'probe',
    sections: [{ id: 'memory', label: 'Память' }],
    scopes: { personal: 'memory', shared: 'memory' },
    uiLanguage: 'de',
  };
  assert.equal(sessionUiLanguage(session), 'ru');
  assert.equal(sessionStrings(session).sectionMemory, 'Память');

  // И серверная разметка не падает на чужой локали.
  const html = panelHtml(session, { section: 'memory', scope: 'personal' });
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /ПАМЯТЬ АГЕНТА/);
});

test('разметка панели и чата переключается на английский', () => {
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
  // Память не переводится — панель честно подписывает, почему заголовки русские.
  assert.match(memory, /Memory files are written in Russian/);

  const chat = chatPage(session, { enabled: true });
  assert.match(chat, /<html lang="en">/);
  assert.match(chat, /New chat/);
  assert.match(chat, /Search by title/);
  assert.match(chat, /What shall we do\?/);
  assert.match(chat, /Message Icarus\.\.\./);
  // Новые разделы из main тоже в словаре: папки, архив, очередь, панель файлов.
  assert.match(chat, /Folder/);
  assert.match(chat, /Archive/);
  assert.match(chat, /Queued: 0/);
  assert.match(chat, /Interrupt and send/);
  assert.match(chat, /Search files/);
  assert.doesNotMatch(chat, />\s*Папка\s*<|>\s*Архив\s*<|В очереди: 0|placeholder="Поиск по файлам"/);
  // Каталог рецептов MCP — отдельная страница с тем же языком интерфейса.
  const mcp = mcpPage(session);
  assert.match(mcp, /Recipes/);
  assert.match(mcp, /Add MCP/);
  assert.match(mcp, /MY SERVERS/);
  assert.doesNotMatch(mcp, />\s*Рецепты\s*<|>\s*Добавить MCP\s*<|>\s*МОИ СЕРВЕРЫ\s*</);
  // Русский вариант того же места — контроль, что это не совпадение.
  const ru = panelHtml({ ...session, uiLanguage: 'ru', sections: [{ id: 'memory', label: 'Память' }] }, { section: 'memory' });
  assert.match(ru, /<html lang="ru">/);
  assert.match(ru, /ПАМЯТЬ АГЕНТА/);
  assert.doesNotMatch(ru, /Memory files are written in Russian/);
});

test('GET /panel/profile/api отдаёт обе настройки и их списки', async () => {
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

test('переключение интерфейса не трогает ответы и не перезапускает сессию', async () => {
  await withServer(async (base, config, bumped) => {
    // Смена языка ответов — это повод поднять pi заново: AGENTS.md читается стартом.
    await save(base, { language: 'en' });
    assert.deepEqual(bumped, ['probe'], 'смена языка ответов пометила ресурсы');

    // А интерфейс живёт только в панели: сессию из-за него не рвём.
    const switched = await save(base, { uiLanguage: 'en' });
    assert.equal(switched.status, 200);
    assert.deepEqual(bumped, ['probe'], 'язык интерфейса не перезапускает разговор');

    assert.deepEqual(readProfile(config, probe()), { language: 'en', uiLanguage: 'en' });
    const body = (await (await fetch(`${base}/panel/profile/api`, { headers: asUser() })).json()) as Record<string, unknown>;
    assert.equal(body.language, 'en', 'язык ответов не сбросился');
    assert.equal(body.uiLanguage, 'en');

    // Обратно тоже по одному полю: язык интерфейса переживает смену ответов.
    await save(base, { language: 'ru' });
    assert.deepEqual(bumped, ['probe', 'probe']);
    assert.deepEqual(readProfile(config, probe()), { language: 'ru', uiLanguage: 'en' });
  });
});

test('неизвестный язык интерфейса отклоняется, профиль не портится', async () => {
  await withServer(async (base, config) => {
    const bad = await save(base, { uiLanguage: 'klingon' });
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: { message: string } };
    assert.match(body.error.message, /ru, en/);
    assert.equal(readProfile(config, probe()), undefined, 'ничего не записалось');

    // Пустое тело тоже отказ: менять нечего, и молча писать умолчания нельзя.
    const empty = await save(base, {});
    assert.equal(empty.status, 400);
  });
});

test('страница раздела и чат приезжают уже на выбранном языке', async () => {
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

    // Второй человек не наследует чужой интерфейс: настройка личная.
    const other = await (await fetch(`${base}/panel/memory`, { headers: asUser('probe2') })).text();
    assert.match(other, /<html lang="ru">/);
    assert.match(other, /ПАМЯТЬ АГЕНТА/);
  });
});
