// Инструмент Икара get_memory_management_link: ссылка личная, со сроком и проверяемая.
import test from 'node:test';
import assert from 'node:assert/strict';
import registerMemoryPanel, { memoryManagementLink } from '../../extensions/memory-panel.ts';
import { derivePanelKey, verifyPanelCredential } from '../../extensions/lib/panel-link.ts';

const SECRET = 'секрет-сервиса';
const KEY = derivePanelKey(SECRET, 'probe');
const NOW = Date.parse('2026-09-19T12:00:00Z');

test('инструмент собирает ссылку на память текущего человека', () => {
  const result = memoryManagementLink(
    { userId: 'probe', panelKey: KEY, url: 'http://icarus.example:8081/' },
    NOW,
  );
  if (!('url' in result)) throw new Error(result.error);

  const url = new URL(result.url);
  assert.equal(url.origin, 'http://icarus.example:8081');
  assert.equal(url.pathname, '/panel');

  const credentials = url.searchParams.get('t') ?? '';
  const checked = verifyPanelCredential(SECRET, credentials, NOW);
  assert.equal(checked.ok, true);
  assert.equal(checked.ok && checked.userId, 'probe');
  assert.equal(checked.ok && checked.expiresAt, NOW + 24 * 60 * 60 * 1000, 'по умолчанию сутки');
});

test('срок годности берётся из окружения', () => {
  const result = memoryManagementLink(
    { userId: 'probe', panelKey: KEY, url: 'http://icarus.example:8081', ttlMinutes: '60' },
    NOW,
  );
  if (!('url' in result)) throw new Error(result.error);

  const checked = verifyPanelCredential(SECRET, new URL(result.url).searchParams.get('t') ?? '', NOW);
  assert.equal(checked.ok && checked.expiresAt, NOW + 60 * 60 * 1000);
});

test('без личного ключа и адреса инструмент честно отказывает', () => {
  const incomplete = [
    {},
    { userId: 'probe' },
    { userId: 'probe', panelKey: KEY },
    { panelKey: KEY, url: 'http://icarus.example:8081' },
    { userId: '  ', panelKey: KEY, url: 'http://icarus.example:8081' },
  ];
  for (const env of incomplete) {
    const result = memoryManagementLink(env, NOW);
    assert.ok('error' in result, `ожидал отказ для ${JSON.stringify(env)}`);
  }
});

test('расширение регистрирует инструмент и в руках Икара отдаёт ссылку', async () => {
  const tools: any[] = [];
  registerMemoryPanel({ registerTool: (tool: unknown) => tools.push(tool) } as never);
  assert.deepEqual(tools.map((tool) => tool.name), ['get_memory_management_link']);

  const saved = {
    id: process.env.ICARUS_USER_ID,
    key: process.env.ICARUS_PANEL_KEY,
    url: process.env.ICARUS_URL,
  };
  process.env.ICARUS_USER_ID = 'probe';
  process.env.ICARUS_PANEL_KEY = KEY;
  process.env.ICARUS_URL = 'http://icarus.example:8081';
  try {
    const result = await tools[0].execute();
    assert.match(result.content[0].text, /твоей памятью/);
    assert.match(result.content[0].text, /http:\/\/icarus\.example:8081\/panel\?t=/);
  } finally {
    for (const [name, value] of [
      ['ICARUS_USER_ID', saved.id],
      ['ICARUS_PANEL_KEY', saved.key],
      ['ICARUS_URL', saved.url],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

