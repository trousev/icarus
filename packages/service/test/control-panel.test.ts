// Инструмент Икара get_control_panel_link: адрес панели управления, а вход в неё —
// обычный вход человека через SSO-прокси. Никаких пропусков и сроков тут не осталось.
import test from 'node:test';
import assert from 'node:assert/strict';
import registerControlPanel, { controlPanelLink } from '../../extensions/control-panel.ts';

/** Ссылка или падение: в тестах нас интересует, что именно уехало человеку. */
function urlOf(input: string): string {
  const result = controlPanelLink({ url: input });
  if (!('url' in result)) throw new Error(result.error);
  return result.url;
}

test('инструмент отдаёт адрес панели как есть', () => {
  assert.equal(urlOf('https://memory.trousev.pro/'), 'https://memory.trousev.pro/');

  // Хвостовые слэши не удваиваем: адрес приходит и с ними, и без.
  assert.equal(urlOf('https://memory.trousev.pro'), 'https://memory.trousev.pro/');
  assert.equal(urlOf(' http://localhost:8081// '), 'http://localhost:8081/');
});

test('в адресе нет ни ключа, ни пропуска — пускать будет прокси', () => {
  const url = new URL(urlOf('https://memory.trousev.pro/'));
  assert.deepEqual([...url.searchParams.keys()], [], 'параметров доступа в ссылке быть не должно');
  assert.equal(url.pathname, '/', 'корень домена — это и есть панель');
});

test('без адреса инструмент честно отказывает', () => {
  for (const env of [{}, { url: '   ' }]) {
    const result = controlPanelLink(env);
    if (!('error' in result)) throw new Error(`ожидал отказ для ${JSON.stringify(env)}`);
    assert.match(result.error, /ICARUS_URL/);
  }
});

test('расширение регистрирует инструмент и в руках Икара отдаёт адрес панели', async () => {
  const tools: any[] = [];
  registerControlPanel({ registerTool: (tool: unknown) => tools.push(tool) } as never);
  assert.deepEqual(tools.map((tool) => tool.name), ['get_control_panel_link']);

  const saved = process.env.ICARUS_URL;
  process.env.ICARUS_URL = 'https://memory.trousev.pro/';
  try {
    const result = await tools[0].execute();
    assert.match(result.content[0].text, /https:\/\/memory\.trousev\.pro\//);
    assert.match(result.content[0].text, /только твою память/);
    assert.doesNotMatch(result.content[0].text, /\?t=/, 'пропусков в ссылке больше нет');
  } finally {
    if (saved === undefined) delete process.env.ICARUS_URL;
    else process.env.ICARUS_URL = saved;
  }
});
