// Icarus tool get_control_panel_link: the control panel address, and the login into it
// is the human's regular login through the SSO proxy. No passes or expirations remain here.
import test from 'node:test';
import assert from 'node:assert/strict';
import registerControlPanel, { controlPanelLink } from '../../extensions/control-panel.ts';

/** The link or a throw: in the tests we care about exactly what went out to the human. */
function urlOf(input: string): string {
  const result = controlPanelLink({ url: input });
  if (!('url' in result)) throw new Error(result.error);
  return result.url;
}

test('the tool returns the panel address as is', () => {
  assert.equal(urlOf('https://chat.trousev.pro/'), 'https://chat.trousev.pro/');

  // We do not double trailing slashes: the address comes both with and without them.
  assert.equal(urlOf('https://chat.trousev.pro'), 'https://chat.trousev.pro/');
  assert.equal(urlOf(' http://localhost:8081// '), 'http://localhost:8081/');
});

test('the address has no key or pass — the proxy will let people in', () => {
  const url = new URL(urlOf('https://chat.trousev.pro/'));
  assert.deepEqual([...url.searchParams.keys()], [], 'параметров доступа в ссылке быть не должно');
  assert.equal(url.pathname, '/', 'корень домена — это и есть панель');
});

test('without an address the tool honestly refuses', () => {
  for (const env of [{}, { url: '   ' }]) {
    const result = controlPanelLink(env);
    if (!('error' in result)) throw new Error(`ожидал отказ для ${JSON.stringify(env)}`);
    assert.match(result.error, /ICARUS_URL/);
  }
});

test('the extension registers the tool and in Icarus\'s hands returns the panel address', async () => {
  const tools: any[] = [];
  registerControlPanel({ registerTool: (tool: unknown) => tools.push(tool) } as never);
  assert.deepEqual(tools.map((tool) => tool.name), ['get_control_panel_link']);

  const saved = process.env.ICARUS_URL;
  process.env.ICARUS_URL = 'https://chat.trousev.pro/';
  try {
    const result = await tools[0].execute();
    assert.match(result.content[0].text, /https:\/\/chat\.trousev\.pro\//);
    assert.match(result.content[0].text, /только твою память/);
    assert.doesNotMatch(result.content[0].text, /\?t=/, 'пропусков в ссылке больше нет');
  } finally {
    if (saved === undefined) delete process.env.ICARUS_URL;
    else process.env.ICARUS_URL = saved;
  }
});
