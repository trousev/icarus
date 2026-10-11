// Раздел скиллов в панели: человек пишет скилл, Икар получает его следующим ходом.
//
// Тест идёт через живой HTTP-сервер, а не через хранилище: панель тут — автор
// скиллов, и проверять надо весь путь целиком — запрос, файл в каталоге, который
// читает pi, коммит в истории и пометку «ресурсы обновились», из-за которой живая
// сессия pi пересобирается со свежим каталогом.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths, type IcarusConfig, type UserConfig } from '../src/config.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

/** Так выглядит запрос, дошедший до сервиса через Authelia: он и назвал человека. */
function asUser(userId?: string): Record<string, string> {
  return userId === undefined ? {} : { [PANEL_USER_HEADER]: userId };
}

/**
 * Заглушка реестра сессий. Панель зовёт её за двумя вещами: отметить обновление
 * ресурсов и — кнопкой «напиши за меня» — спросить модель разово. Второе есть
 * только у того реестра, которому есть чем отвечать: `answer` включает `oneShot`.
 */
function makeRegistry(answer?: string | (() => Promise<string>)) {
  const bumped: string[] = [];
  const asked: Array<{ user: string; prompt: string }> = [];
  return {
    bumped,
    asked,
    bumpResources(userId: string) {
      bumped.push(userId);
      return bumped.length;
    },
    ...(answer === undefined
      ? {}
      : {
          async oneShot(user: UserConfig, prompt: string) {
            asked.push({ user: user.id, prompt });
            return typeof answer === 'function' ? answer() : answer;
          },
        }),
  };
}

async function withServer(
  handler: (base: string, config: IcarusConfig, registry: ReturnType<typeof makeRegistry>) => Promise<void>,
  options: { overrides?: Partial<IcarusConfig>; answer?: string | (() => Promise<string>); draftSkills?: boolean } = {},
): Promise<void> {
  const config = makeConfig({ users: [probe('probe'), probe('probe2')], ...options.overrides });
  const registry = makeRegistry(options.answer);
  const server = createServer(config, registry as never, { draftSkills: options.draftSkills });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, config, registry);
  } finally {
    server.close();
  }
}

/** Запрос в раздел скиллов: раздел в адресе, человек — в заголовке. */
function call(base: string, route: string, init: RequestInit = {}, userId = 'probe'): Promise<Response> {
  return fetch(`${base}/panel/skills/${route}`, {
    ...init,
    headers: { ...asUser(userId), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function post(base: string, route: string, body: unknown, userId = 'probe'): Promise<Response> {
  return call(base, route, { method: 'POST', body: JSON.stringify(body) }, userId);
}

function skillsRoot(config: IcarusConfig, user: UserConfig): string {
  return userPaths(config, user).skills;
}

const DRAFT = {
  name: 'pirate-mode',
  description: 'Use when the user asks to speak like a pirate.',
  body: '# Как рычать\n\n1. Говори «йо-хо-хо».',
};

test('скилл из панели ложится в каталог pi, в историю и поднимает сессии', async () => {
  await withServer(async (base, config, registry) => {
    const saved = await post(base, 'save', DRAFT);
    assert.equal(saved.status, 200);
    const result = (await saved.json()) as { ok: boolean; id: string; committed: boolean; commit: string };
    assert.equal(result.ok, true);
    assert.equal(result.id, 'pirate-mode/SKILL.md');
    assert.equal(result.committed, true, 'сохранение скилла — это коммит');
    assert.match(result.commit, /^[0-9a-f]{40}$/, 'панель отдаёт хеш, чтобы человек видел коммит');

    // Файл лежит там, откуда его читает pi: каталог скиллов человека.
    const file = path.join(skillsRoot(config, probe('probe')), 'pirate-mode', 'SKILL.md');
    assert.equal(fs.existsSync(file), true);
    assert.match(fs.readFileSync(file, 'utf8'), /name: pirate-mode/);
    assert.equal(fs.existsSync(path.join(skillsRoot(config, probe('probe')), '.git')), true, 'скиллы под git');

    // Живой разговор узнает о скилле не сам: каталог pi читает при старте, поэтому
    // панель обязана отметить, что ресурсы человека обновились.
    assert.deepEqual(registry.bumped, ['probe'], 'сессии человека помечены как устаревшие');

    const list = (await (await call(base, 'files')).json()) as {
      skills: Array<{ id: string; name: string; description: string }>;
    };
    assert.deepEqual(list.skills.map((skill) => [skill.id, skill.name]), [['pirate-mode/SKILL.md', 'pirate-mode']]);
    assert.equal(list.skills[0].description, DRAFT.description);

    const one = (await (await call(base, 'skill?id=pirate-mode/SKILL.md')).json()) as {
      body: string;
      bundle: Array<{ path: string }>;
    };
    assert.match(one.body, /йо-хо-хо/);
    assert.deepEqual(one.bundle.map((file) => file.path), ['pirate-mode/SKILL.md']);
  });
});

test('скилл без описания панель не записывает: pi пропустил бы его молча', async () => {
  await withServer(async (base, config) => {
    const refused = await post(base, 'save', { ...DRAFT, description: '  ' });
    assert.equal(refused.status, 400);
    const body = (await refused.json()) as { error?: { message?: string } };
    assert.match(String(body.error?.message), /описани/i);
    assert.equal(fs.existsSync(path.join(skillsRoot(config, probe('probe')), 'pirate-mode')), false);

    // Имя проверяется там же: оно становится именем каталога, а «../» в нём —
    // это запись мимо каталога скиллов.
    const evil = await post(base, 'save', { ...DRAFT, name: '../evil' });
    assert.equal(evil.status, 400);
  });
});

test('чужого скилла через свою сессию не открыть и не тронуть', async () => {
  await withServer(async (base) => {
    await post(base, 'save', DRAFT, 'probe2');

    const mine = (await (await call(base, 'files')).json()) as { skills: unknown[] };
    assert.deepEqual(mine.skills, [], 'у probe своих скиллов нет');

    const alien = await call(base, 'skill?id=pirate-mode/SKILL.md');
    assert.equal(alien.status, 404, 'чужой каталог панель не читает');

    const escape = await call(base, 'skill?id=../../probe2/pi-agent/skills/pirate-mode/SKILL.md');
    assert.equal(escape.status, 404, 'за пределы своего каталога не выпускает');

    const withoutHeader = await fetch(base + '/panel/skills/files');
    assert.equal(withoutHeader.status, 401, 'без заголовка прокси раздела нет');
  });
});

test('удаление скилла — коммит, и откат возвращает его вместе с бандлом', async () => {
  await withServer(async (base, config, registry) => {
    await post(base, 'save', DRAFT);
    const root = skillsRoot(config, probe('probe'));
    fs.mkdirSync(path.join(root, 'pirate-mode', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pirate-mode', 'scripts', 'run.sh'), '#!/bin/sh\n');
    // Бандл дописан уже после сохранения: скилл — это каталог, и файлы рядом с ним
    // принадлежат ему, а не панели, поэтому в коммит удаления они попадают как есть.
    const removed = await post(base, 'delete', { id: 'pirate-mode/SKILL.md' });
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'pirate-mode')), false);

    const history = (await (await call(base, 'history')).json()) as {
      commits: Array<{ hash: string; short: string; author: string; subject: string; added: number; removed: number }>;
    };
    assert.match(history.commits[0].subject, /удалить «pirate-mode»/);
    // История скиллов приезжает той же формы, что история файла памяти: панель
    // рисует их одной вёрсткой, и пропавшее поле выглядело бы в ней как «undefined».
    const saved = history.commits.find((commit) => /скилл «pirate-mode»/.test(commit.subject));
    assert.ok(saved, 'коммит сохранения есть в истории');
    assert.match(saved.short, /^[0-9a-f]{7,}$/);
    assert.equal(saved.author, 'Icarus');
    assert.ok(saved.added >= 3, `в коммите сохранения ждём строки скилла, а не ${saved.added}`);

    const reverted = await post(base, 'revert', { commit: history.commits[0].hash });
    assert.equal(reverted.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'pirate-mode', 'SKILL.md')), true, 'скилл вернулся');
    assert.equal(fs.existsSync(path.join(root, 'pirate-mode', 'scripts', 'run.sh')), true, 'бандл вернулся вместе с ним');
    assert.deepEqual(registry.bumped, ['probe', 'probe', 'probe'], 'каждое изменение — повод пересобрать сессию');
  });
});

test('SKILL.md скачивается как файл, а поиск находит скилл по содержимому', async () => {
  await withServer(async (base) => {
    await post(base, 'save', DRAFT);

    const download = await call(base, 'file?path=pirate-mode/SKILL.md&download=1');
    assert.equal(download.status, 200);
    assert.match(String(download.headers.get('content-disposition')), /SKILL\.md/);
    assert.match(await download.text(), /йо-хо-хо/);

    const found = (await (await call(base, 'search?q=' + encodeURIComponent('йо-хо-хо'))).json()) as {
      hits: Array<{ id: string; name: string; text: string }>;
    };
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0].name, 'pirate-mode');
    assert.match(found.hits[0].text, /йо-хо-хо/);
  });
});

test('страница раздела — редактор скиллов, а не список файлов памяти', async () => {
  await withServer(async (base) => {
    const response = await fetch(base + '/panel/skills', { headers: asUser('probe') });
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /id="new-skill"/, 'кнопка нового скилла есть на странице');
    assert.match(html, /id="skill-body"/, 'тело SKILL.md правится тут же');
    assert.match(html, /id="skill-description"/, 'описание — отдельное поле: по нему модель и решает');
    assert.match(html, /СКИЛЛЫ АГЕНТА/);
    // Раздел живёт в сайдбаре рядом с памятью и без области в адресе: области — это
    // про память, у скиллов её нет.
    assert.match(html, /href="\/panel\/skills"/);
    assert.doesNotMatch(html, /href="\/panel\/skills\?/);

    // Скрипт собирается из template literal: опечатка в бэкслешах ломает страницу
    // целиком, а глазами такое не видно. Компиляция ловит сразу.
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'в странице нет скрипта');
    assert.doesNotThrow(() => new Function(script), 'скрипт раздела скиллов не компилируется');
  });
});

test('«напиши за меня»: идея уезжает модели, черновик возвращается в редактор', async () => {
  const draft = JSON.stringify({
    name: 'Voice Notes',
    description: 'Разбирает голосовые сообщения и складывает расшифровку в журнал.',
    body: '# Как разбирать голосовые\n\n1. Расшифруй.\n2. Положи в journal/.\n',
  });

  await withServer(
    async (base, config, registry) => {
      const response = await post(base, 'draft', { idea: 'разбирать голосовые в текст и складывать в журнал' });
      assert.equal(response.status, 200);
      const result = (await response.json()) as { name: string; description: string; body: string };

      assert.equal(result.name, 'voice-notes', 'имя приведено к правилам');
      assert.match(result.body, /Расшифруй/);

      // Модель спрашивают там же, где живут ключи и pi, — и от имени того человека,
      // чья панель открыта.
      assert.equal(registry.asked.length, 1);
      assert.equal(registry.asked[0].user, 'probe');
      assert.match(registry.asked[0].prompt, /разбирать голосовые в текст и складывать в журнал/);

      // Черновик — только черновик: на диске до «Сохранить» ничего не появляется.
      const root = userPaths(config, probe('probe')).skills;
      assert.equal(fs.existsSync(path.join(root, 'voice-notes')), false, 'файл пишет сохранение, а не генерация');
      const list = (await (await call(base, 'files')).json()) as { skills: unknown[] };
      assert.deepEqual(list.skills, []);
    },
    { answer: draft },
  );
});

test('имя из черновика не занимает чужое: занятое получает номер', async () => {
  await withServer(
    async (base) => {
      await post(base, 'save', DRAFT);
      const response = await post(base, 'draft', { idea: 'то же самое, но другими словами' });
      assert.equal(response.status, 200);
      const result = (await response.json()) as { name: string; note?: string };
      assert.equal(result.name, 'pirate-mode-2');
      assert.match(String(result.note), /занято/);
    },
    { answer: JSON.stringify({ name: 'pirate-mode', description: 'ок', body: 'тело' }) },
  );
});

test('пустая идея и простыня до модели не доезжают', async () => {
  await withServer(
    async (base, _config, registry) => {
      assert.equal((await post(base, 'draft', { idea: '   ' })).status, 400, 'пустую идею модели не отправляем');
      assert.equal((await post(base, 'draft', { idea: 'х'.repeat(4001) })).status, 400, 'и простыню тоже');
      assert.deepEqual(registry.asked, [], 'на отказ модель не звали');
    },
    { answer: 'не важно' },
  );
});

test('модель ответила болтовнёй — панель говорит это словами, а не падает', async () => {
  await withServer(
    async (base) => {
      const response = await post(base, 'draft', { idea: 'что-нибудь' });
      assert.equal(response.status, 502);
      const body = (await response.json()) as { error?: { message?: string } };
      assert.match(String(body.error?.message), /JSON/);
    },
    { answer: 'Извини, не могу помочь.' },
  );
});

test('модель не ответила вовсе — это тоже не падение панели', async () => {
  await withServer(
    async (base) => {
      const response = await post(base, 'draft', { idea: 'что-нибудь' });
      assert.equal(response.status, 502);
      const body = (await response.json()) as { error?: { message?: string } };
      assert.match(String(body.error?.message), /не ответила/);
    },
    { answer: () => Promise.reject(new Error('модель не ответила за 90000 мс')) },
  );
});

test('без контейнера с моделью кнопки нет и маршрут честно отказывает', async () => {
  await withServer(
    async (base) => {
      const response = await post(base, 'draft', { idea: 'что-нибудь' });
      assert.equal(response.status, 501);
      const body = (await response.json()) as { error?: { message?: string } };
      assert.match(String(body.error?.message), /некому/);

      const html = await (await fetch(base + '/panel/skills?new=1', { headers: asUser('probe') })).text();
      // Разметку редактора собирает скрипт, поэтому «кнопки нет» проверяем по тому,
      // что панель знает, писать ли ей: без этого блок был бы, но всегда отказывал.
      assert.match(html, /"draftSkills":false/, 'панель знает, что писать некому');
      assert.match(html, /cfg\.draftSkills && !cfg\.file/, 'блок рисуется только когда есть кому писать');
      assert.match(html, /id="skill-body"/, 'остальной редактор на месте');
    },
    { draftSkills: false },
  );
});
