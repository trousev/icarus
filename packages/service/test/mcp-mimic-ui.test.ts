// The MCP panel client runs for real: the mimicry dialog is markup
// drawn by JS, and a human walks through it by hand. The test checks exactly the path
// "clicked Connect → read three steps → pasted the address → login completed", not the
// presence of strings in HTML: a typo in a selector breaks the dialog silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mcpPage } from '../src/control/mcp-ui.ts';
import type { PanelSession } from '../src/control/ui.ts';

const SESSION: PanelSession = {
  user: 'probe',
  sections: [
    { id: 'memory', label: 'Память' },
    { id: 'skills', label: 'Скиллы' },
    { id: 'mcp', label: 'MCP' },
    { id: 'profile', label: 'Пользователь' },
  ],
  scopes: { personal: 'memory', shared: 'memory' },
  scopeLabels: { personal: 'Личная', shared: 'Семейная' },
  model: 'deepseek-v4-flash',
  storage: 'git · local',
  language: 'ru',
};

const MIMIC = 'http://localhost:47821/callback';

const serverView = {
  id: 'anydo',
  name: 'Any.do MCP',
  description: 'Списки задач',
  transport: 'streamable-http',
  target: 'https://mcp.any.do/mcp',
  auth: 'oauth',
  global: false,
  owner: 'probe',
  ownerIsMe: true,
  shared: false,
  enabled: true,
  ready: false,
  authState: 'needed',
  mimic: true,
  canEdit: true,
  canShare: true,
  canDelete: true,
};

type Route = (path: string, init?: RequestInit) => { status?: number; body: unknown };

/** Runs the MCP section script in the DOM with a network stub and returns everything for checks. */
async function openPanel(routes: Record<string, Route>, view: Record<string, unknown> = serverView) {
  const html = mcpPage(SESSION);
  const configMatch = html.match(/window\.__MCP_CFG__ = (\{.*?\});/s);
  assert.ok(configMatch, 'страница отдаёт конфиг клиенту');
  const { document, window } = parseHTML(html);
  const scripts = [...document.querySelectorAll('script')]
    .map((node) => node.textContent ?? '')
    .filter(Boolean);
  const calls: Array<{ path: string; body: string }> = [];
  const fallback: Route = (path) => {
    if (path.includes('/panel/mcp/servers')) {
      return { body: { servers: [view], enabled: 1, ready: 0 } };
    }
    if (path.includes('/panel/api/state')) return { body: { counts: {} } };
    return { body: {} };
  };
  window.fetch = async (url: string, init: RequestInit = {}) => {
    const path = String(url);
    calls.push({ path, body: String(init.body ?? '') });
    const route = Object.entries(routes).find(([key]) => path.includes(key))?.[1] ?? fallback;
    const { status = 200, body } = route(path, init);
    return {
      ok: status < 400,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
    };
  };
  const location = { href: 'http://panel/panel/mcp', pathname: '/panel/mcp', search: '' };
  Object.defineProperty(window, 'location', { value: location, configurable: true });
  window.__MCP_CFG__ = JSON.parse(configMatch[1] ?? '{}') as Record<string, unknown>;
  const run = new Function('window', 'document', 'fetch', 'URL', 'location', 'history', scripts.at(-1) ?? '');
  run(window, document, window.fetch, window.URL, location, { replaceState() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { document, window, calls, location };
}

const click = (node: any): void => {
  assert.ok(node, 'элемент есть');
  node.dispatchEvent(new (node.ownerDocument.defaultView as any).Event('click'));
};

test('mimicry: the dialog explains the steps, opens the login and waits for the pasted address', async () => {
  const started = {
    url: 'https://mcp.any.do/authorize?client_id=client-1&state=st',
    state: 'st',
    mimic: true,
    redirectUri: MIMIC,
    expiresIn: 600,
  };
  const opened = await openPanel({
    'oauth/start': () => ({ body: started }),
    'oauth/complete': () => ({ body: { server: { ...serverView, ready: true, authState: 'ready' } } }),
  });
  const { document, calls } = opened;

  const connect = [...document.querySelectorAll('.mcp-actions button')].find(
    (button) => button.textContent === 'Подключить',
  );
  click(connect ?? null);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // We do not navigate the panel tab away: otherwise the person could not paste the address.
  assert.equal(opened.location.href, 'http://panel/panel/mcp');

  const steps = [...document.querySelectorAll('.mcp-steps li')];
  assert.equal(steps.length, 3, 'инструкция из трёх шагов');
  const text = steps.map((step) => step.textContent ?? '').join(' ');
  assert.match(text, /Открыть страницу входа/);
  assert.match(text, /ошибку/, 'человек предупреждён про ошибку браузера');
  assert.match(text, /скопируй .*весь адрес/i);

  const link = document.getElementById('m-open') as any;
  assert.equal(link?.getAttribute('href'), started.url);
  assert.equal(link?.getAttribute('target'), '_blank');
  assert.match(document.querySelector('.mcp-dialog')?.textContent ?? '', /localhost:47821\/callback/);
  assert.match(document.querySelector('.mcp-dialog')?.textContent ?? '', /10 мин/);

  const paste = document.getElementById('m-paste') as any;
  assert.ok(paste, 'поле для вставки');
  paste.value = `${MIMIC}?code=code-1&state=st`;
  click(document.getElementById('m-done'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const complete = calls.find((call) => call.path.includes('oauth/complete'));
  assert.ok(complete, 'адрес уехал на сервер');
  assert.deepEqual(JSON.parse(complete.body), { id: 'anydo', url: `${MIMIC}?code=code-1&state=st` });
  assert.equal(document.getElementById('m-paste'), null, 'диалог закрылся после успеха');
  assert.match(document.getElementById('mcp-notice')?.textContent ?? '', /Доступ к «Any\.do MCP» получен/);
});

test('a redirect_uri error suggests the checkbox, but with the checkbox on — it no longer does', async () => {
  const failed = {
    status: 400,
    body: { error: { message: "динамическая регистрация клиента не удалась: Redirect URI 'x' is not allowed." } },
  };
  const plain = await openPanel({ 'oauth/start': () => failed }, { ...serverView, mimic: false });
  const connect = [...plain.document.querySelectorAll('.mcp-actions button')].find(
    (button) => button.textContent === 'Подключить',
  );
  click(connect ?? null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(plain.document.getElementById('mcp-notice')?.textContent ?? '', /Мимикрировать под Claude/);

  // With the checkbox on, the person has already done what they could: there is no point repeating the advice.
  const mimicRoutes = {
    'oauth/start': (): { status: number; body: unknown } => failed,
  };
  const withMimic = await openPanel(mimicRoutes);
  // The card comes with mimic: true — the server is already mimicking.
  const mirror = [...withMimic.document.querySelectorAll('.mcp-actions button')].find(
    (button) => button.textContent === 'Подключить',
  );
  click(mirror ?? null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const notice = withMimic.document.getElementById('mcp-notice')?.textContent ?? '';
  assert.match(notice, /не удалась/);
  assert.doesNotMatch(notice, /Мимикрировать под Claude/);
});

test('the form shows the mimicry checkbox only for OAuth and sends it to the server', async () => {
  const opened = await openPanel({
    add: () => ({ body: { server: serverView } }),
  });
  const { document, calls } = opened;
  click(document.getElementById('mcp-add'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const row = document.getElementById('f-mimic-row');
  assert.ok(row, 'строка галочки есть в форме');
  assert.equal((row as any).hidden, true, 'по умолчанию авторизация «без», галочки не видно');

  // linkedom exposes select.value as read-only: we provide a regular setter, as in a browser.
  const auth = document.getElementById('f-auth') as any;
  Object.defineProperty(auth, 'value', {
    configurable: true,
    get: () => 'oauth',
    set: () => undefined,
  });
  auth.value = 'oauth';
  auth.dispatchEvent(new (opened.window.Event)('change'));
  assert.equal((row as any).hidden, false, 'у OAuth галочка видна');

  const mimic = document.getElementById('f-mimic') as any;
  mimic.checked = true;
  (document.getElementById('f-name') as any).value = 'Any.do';
  (document.getElementById('f-url') as any).value = 'https://mcp.any.do/mcp';

  click(document.getElementById('f-save'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const added = calls.find((call) => call.path.includes('/panel/mcp/add'));
  assert.ok(added, 'форма отправила сервер');
  assert.equal(JSON.parse(added.body).mimic, true);
  assert.match(document.body.textContent ?? '', new RegExp(MIMIC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
