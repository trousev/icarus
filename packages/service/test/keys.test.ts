// Раздел «Ключи»: правит только админ, значения не уезжают в браузер, а сохранённый
// ключ сразу доезжает до auth.json людей и следующей сессии pi.
//
// Тест ходит через настоящий HTTP-сервер панели: права проверяются там же, где их
// проверит прод, а не во внутренней функции, которую другой маршрут может обойти.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseEnv } from 'node:util';
import { createServer } from '../src/http/server.ts';
import { findUser, loadConfig, userPaths, type IcarusConfig } from '../src/config.ts';
import { loadRuntimeEnv } from '../src/runtime.ts';
import {
  editEnvText,
  effectiveSecrets,
  envLine,
  readKeysStore,
  syncEnvFile,
  type KeysStore,
} from '../src/keys.ts';
import { PANEL_USER_HEADER } from './fixtures.ts';

const ADMIN = 'trousev';
const USER = 'probe';

function headers(userId?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(userId === undefined ? {} : { [PANEL_USER_HEADER]: userId }) };
}

type Sandbox = {
  config: IcarusConfig;
  envFile: string;
  keysFile: string;
  configFile: string;
  bumps: string[];
  base: string;
  close: () => void;
};

/** Конфиг с админом и обычным человеком, временные .env и keys.json. */
async function withServer(
  run: (box: Sandbox) => Promise<void>,
  options: { envText?: string } = {},
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-keys-'));
  const envFile = path.join(dir, '.env');
  const keysFile = path.join(dir, 'keys.json');
  const configFile = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configFile,
    [
      'apiKey: token',
      `dataDir: ${path.join(dir, 'data')}`,
      'models:',
      '  - provider: deepinfra',
      '    id: deepseek-ai/DeepSeek-V4.1-Flash',
      '    tier: fast',
      'users:',
      '  - id: trousev',
      '    admin: true',
      '  - id: probe',
      '',
    ].join('\n'),
  );
  if (options.envText !== undefined) fs.writeFileSync(envFile, options.envText, { mode: 0o600 });

  const state = loadRuntimeEnv({ envFile, keysFile, base: { ...process.env } });
  const config = loadConfig(configFile, state.env);
  config.envFile = envFile;
  config.keysFile = keysFile;
  config.secretEnv = state.secrets;

  const bumps: string[] = [];
  const registry = {
    bumpResources: (userId: string) => bumps.push(userId),
    list: () => [],
    oneShot: async () => '',
  };
  const server = createServer(config, registry as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ config, envFile, keysFile, configFile, bumps, base, close: () => server.close() });
  } finally {
    server.close();
  }
}

const page = (box: Sandbox, user: string) => fetch(`${box.base}/panel/keys`, { headers: headers(user) });
const api = (box: Sandbox, user: string) => fetch(`${box.base}/panel/keys/api`, { headers: headers(user) });
const save = (box: Sandbox, user: string, body: Record<string, unknown>) =>
  fetch(`${box.base}/panel/keys/api`, {
    method: 'POST',
    headers: headers(user),
    body: JSON.stringify(body),
  });

test('.env правится построчно: комментарии и чужие ключи остаются', () => {
  const text = '# Ключи\nDEEPINFRA_API_KEY=old\n\n# Поиск\nTAVILY_API_KEY=tvly-1\n';
  const updated = editEnvText(text, 'DEEPINFRA_API_KEY', 'new');
  assert.match(updated, /# Ключи/);
  assert.match(updated, /# Поиск/);
  assert.match(updated, /^DEEPINFRA_API_KEY=new$/m);
  assert.match(updated, /^TAVILY_API_KEY=tvly-1$/m);
  assert.equal(parseEnv(updated).DEEPINFRA_API_KEY, 'new');

  // Значение с пробелами, решёткой и обратным слэшем обязано пережить круг через
  // файл: parseEnv не разэкранирует двойные кавычки, поэтому выбираем кавычки по
  // содержимому, а не всегда JSON.
  for (const tricky of ['sk-with space#hash', 'sk\\with\\slash', 'sk"quote', "sk'quote"]) {
    const quoted = editEnvText('', 'OPENAI_API_KEY', tricky);
    assert.equal(parseEnv(quoted).OPENAI_API_KEY, tricky, `значение «${tricky}» пережило .env`);
  }
  assert.equal(envLine('A', 'plain-value_1'), 'A=plain-value_1');

  // Удаление убирает строку и повторы, а не оставляет «пустое значение».
  const removed = editEnvText('A=1\nB=2\nA=3\nC=4\n', 'A', null);
  assert.equal(removed, 'B=2\nC=4\n');
  assert.equal(editEnvText(text, 'NO_SUCH_KEY', null), text);
});

test('настройки панели сильнее .env, а убранный ключ гасится', () => {
  const fileVars = { DEEPINFRA_API_KEY: 'from-env', TAVILY_API_KEY: 'tvly' };
  const store: KeysStore = {
    version: 1,
    values: { DEEPINFRA_API_KEY: 'from-panel' },
    removed: ['TAVILY_API_KEY'],
  };
  assert.deepEqual(effectiveSecrets(fileVars, store), { DEEPINFRA_API_KEY: 'from-panel' });
});

test('перед сборкой стека .env приводится к настройкам панели', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-sync-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# комментарий\nDEEPINFRA_API_KEY=deploy-secret\nTAVILY_API_KEY=tvly\n');

  syncEnvFile(
    {
      version: 1,
      values: { DEEPINFRA_API_KEY: 'panel-secret' },
      removed: ['TAVILY_API_KEY'],
    },
    file,
  );

  const text = fs.readFileSync(file, 'utf8');
  assert.equal(parseEnv(text).DEEPINFRA_API_KEY, 'panel-secret', 'настройка панели победила деплой');
  assert.equal(parseEnv(text).TAVILY_API_KEY, undefined, 'убранный ключ не вернулся из .env');
  assert.match(text, /# комментарий/, 'комментарии не потерялись');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'права на файл с секретами — 600');
});

test('неадмину раздела «Ключи» нет ни страницей, ни API, ни в списке разделов', async () => {
  await withServer(async (box) => {
    const adminPage = await page(box, ADMIN);
    assert.equal(adminPage.status, 200);
    assert.match(await adminPage.text(), /СЕКРЕТЫ ИНСТАЛЯЦИИ/);

    const deniedPage = await page(box, USER);
    assert.equal(deniedPage.status, 403);
    assert.match(await deniedPage.text(), /Ключи правит только админ/);

    const deniedApi = await api(box, USER);
    assert.equal(deniedApi.status, 403);
    assert.match(String(((await deniedApi.json()) as { error?: { message?: string } }).error?.message), /только админ/);

    const probeState = (await (await fetch(`${box.base}/panel/api/state`, { headers: headers(USER) })).json()) as {
      sections: Array<{ id: string }>;
    };
    assert.equal(probeState.sections.some((section) => section.id === 'keys'), false, 'неадмину раздел не обещаем');

    const adminState = (await (await fetch(`${box.base}/panel/api/state`, { headers: headers(ADMIN) })).json()) as {
      sections: Array<{ id: string }>;
    };
    assert.equal(adminState.sections.some((section) => section.id === 'keys'), true, 'админу раздел виден');

    // В чате один вход в настройки: списка разделов там нет ни у админа, ни у остальных.
    const chatAdmin = await (await fetch(`${box.base}/panel/chat`, { headers: headers(ADMIN) })).text();
    assert.match(chatAdmin, /href="\/panel\/memory"[^>]*><span>Настройки<\/span>/);
    assert.doesNotMatch(chatAdmin, /href="\/panel\/keys"/);
    // А в меню настроек «Ключи» видит только админ.
    assert.match(
      await (await fetch(`${box.base}/panel/memory`, { headers: headers(ADMIN) })).text(),
      /href="\/panel\/keys"/,
    );
    assert.doesNotMatch(
      await (await fetch(`${box.base}/panel/memory`, { headers: headers(USER) })).text(),
      /href="\/panel\/keys"/,
    );
  });
});

test('админ задаёт ключ: он уезжает в .env и keys.json, а auth.json людей обновляется', async () => {
  await withServer(
    async (box) => {
      const response = await save(box, ADMIN, { name: 'DEEPINFRA_API_KEY', value: 'sk-new' });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { message: string; keys: Array<{ name: string; present: boolean; hint: string }> };
      assert.match(body.message, /сохранён/);
      assert.equal(body.keys.find((key) => key.name === 'DEEPINFRA_API_KEY')?.present, true);

      // Секрет не вернулся в браузер: только подсказка из хвоста.
      assert.doesNotMatch(JSON.stringify(body), /sk-new/);
      assert.match(JSON.stringify(body), /••••••••/);

      assert.equal(parseEnv(fs.readFileSync(box.envFile, 'utf8')).DEEPINFRA_API_KEY, 'sk-new');
      assert.equal(readKeysStore(box.keysFile).values.DEEPINFRA_API_KEY, 'sk-new');

      // Живой конфиг перечитан: ключ уже в auth, значит следующий ход pi его увидит.
      assert.equal(box.config.auth.deepinfra, 'sk-new');
      assert.equal(box.config.secretEnv?.DEEPINFRA_API_KEY, 'sk-new');

      for (const id of [ADMIN, USER]) {
        const auth = JSON.parse(
          fs.readFileSync(path.join(userPaths(box.config, findUser(box.config, id)!).piAgent, 'auth.json'), 'utf8'),
        ) as Record<string, { key: string }>;
        assert.equal(auth.deepinfra?.key, 'sk-new', `auth.json ${id} обновлён`);
      }
      assert.deepEqual(box.bumps.sort(), [ADMIN, USER].sort(), 'следующая сессия поднимется заново');
    },
    { envText: '# рабочий файл\nDEEPINFRA_API_KEY=sk-old\n' },
  );
});

test('убрать ключ — значит именно убрать: .env не возвращает его, а pi получает пусто', async () => {
  await withServer(
    async (box) => {
      fs.writeFileSync(box.envFile, 'DEEPINFRA_API_KEY=sk-old\nTAVILY_API_KEY=tvly\n');
      const response = await save(box, ADMIN, { name: 'DEEPINFRA_API_KEY', action: 'remove' });
      assert.equal(response.status, 200);

      assert.doesNotMatch(fs.readFileSync(box.envFile, 'utf8'), /DEEPINFRA_API_KEY/);
      const store = readKeysStore(box.keysFile);
      assert.deepEqual(store.removed, ['DEEPINFRA_API_KEY']);
      assert.equal('DEEPINFRA_API_KEY' in box.config.auth, false);
      // Именно пустая строка: иначе процесс pi унаследовал бы старое значение
      // из окружения контейнера, созданного по прежнему .env.
      assert.equal(box.config.secretEnv?.DEEPINFRA_API_KEY, '');
      assert.equal(box.config.secretEnv?.TAVILY_API_KEY, 'tvly', 'остальные ключи не задеты');
    },
    { envText: 'DEEPINFRA_API_KEY=sk-old\n' },
  );
});

test('«Перечитать» подхватывает .env, поправленный руками', async () => {
  await withServer(async (box) => {
    fs.writeFileSync(box.envFile, 'TAVILY_API_KEY=tvly-manual\n');
    const response = await save(box, ADMIN, { action: 'reload' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { message: string; keys: Array<{ name: string; present: boolean }> };
    assert.match(body.message, /перечитаны/);
    assert.equal(body.keys.find((key) => key.name === 'TAVILY_API_KEY')?.present, true);
    assert.equal(box.config.secretEnv?.TAVILY_API_KEY, 'tvly-manual');
    assert.deepEqual(box.bumps.sort(), [ADMIN, USER].sort());
  });
});

test('плохое имя ключа и неподходящее значение — отказ, а не запись', async () => {
  await withServer(async (box) => {
    for (const name of ['deepinfra_api_key', '../.env', 'A-B', '']) {
      const response = await save(box, ADMIN, { name, value: 'x' });
      assert.equal(response.status, 400, `имя «${name}» должно быть отвергнуто`);
    }
    const multiline = await save(box, ADMIN, { name: 'OPENAI_API_KEY', value: 'a\nb' });
    assert.equal(multiline.status, 400);

    assert.equal(fs.existsSync(box.keysFile), false, 'неудачная валидация не создаёт файл настроек');
  });
});

test('страница «Ключи» и её скрипт компилируются', async () => {
  await withServer(async (box) => {
    const html = await (await page(box, ADMIN)).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length >= 2, 'в странице есть конфиг и клиент');
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script), 'скрипт раздела не компилируется');
    }
    assert.match(html, /id="keys-list"/);
    assert.match(html, /id="keys-add-button"/);
  });
});
