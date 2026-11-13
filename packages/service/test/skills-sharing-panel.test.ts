// Skill sharing through the panel: the owner shares, the recipient sees it disabled,
// enables it for themselves and cannot edit someone else's.
//
// This is an HTTP test, not a storage test: we check permissions on the routes — that's
// where it is decided whether a foreign skill reaches the editor or deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import type { IcarusConfig } from '../src/config.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function asUser(userId: string): Record<string, string> {
  return { [PANEL_USER_HEADER]: userId };
}

async function withServer(handler: (base: string, config: IcarusConfig) => Promise<void>): Promise<void> {
  const config = makeConfig({ users: [probe('anna'), probe('boris')] });
  // The panel only needs bump: "write for me" doesn't take part in this test.
  const registry = { bumpResources: () => 0 };
  const server = createServer(config, registry as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await handler(`http://127.0.0.1:${port}`, config);
  } finally {
    server.close();
  }
}

function call(base: string, route: string, userId: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/panel/skills/${route}`, {
    ...init,
    headers: { ...asUser(userId), 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function post(base: string, route: string, userId: string, body: unknown): Promise<Response> {
  return call(base, route, userId, { method: 'POST', body: JSON.stringify(body) });
}

type Skill = {
  id: string;
  name: string;
  owner: string;
  ownerIsMe: boolean;
  shared: boolean;
  enabled: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
};

const DRAFT = { name: 'pirate-mode', description: 'говорить как пират', body: '# Йо-хо-хо' };

test('the owner shares, the recipient sees the skill disabled and enables it for themselves', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, 'save', 'anna', DRAFT)).status, 200);

    const shared = await post(base, 'share', 'anna', { id: 'pirate-mode/SKILL.md', shared: true });
    assert.equal(shared.status, 200);

    const annaList = (await (await call(base, 'files', 'anna')).json()) as { skills: Skill[] };
    assert.equal(annaList.skills.length, 1);
    assert.equal(annaList.skills[0].ownerIsMe, true);
    assert.equal(annaList.skills[0].shared, true, 'в панели видно, что скилл расшарен');

    const borisList = (await (await call(base, 'files', 'boris')).json()) as { skills: Skill[] };
    assert.equal(borisList.skills.length, 1);
    assert.equal(borisList.skills[0].owner, 'anna');
    assert.equal(borisList.skills[0].enabled, false, 'у получателя по умолчанию выключен');
    assert.equal(borisList.skills[0].canEdit, false);

    const toggled = await post(base, 'toggle', 'boris', {
      id: 'pirate-mode/SKILL.md',
      owner: 'anna',
      enabled: true,
    });
    assert.equal(toggled.status, 200);

    const after = (await (await call(base, 'files', 'boris')).json()) as { skills: Skill[] };
    assert.equal(after.skills[0].enabled, true);

    // The author's edit reaches the snapshot with the same save: the recipient reads the
    // new body already, without waiting for their environment to be rebuilt.
    const updated = await post(base, 'save', 'anna', { ...DRAFT, id: 'pirate-mode/SKILL.md', body: '# Новое тело' });
    assert.equal(updated.status, 200);

    const detail = await call(base, 'skill?id=' + encodeURIComponent('pirate-mode/SKILL.md') + '&owner=anna', 'boris');
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as { body: string; canEdit: boolean };
    assert.match(body.body, /Новое тело/);
    assert.equal(body.canEdit, false);

    // The page has both a status toggle and a sharing checkbox: it's not only the
    // API, the person must see access in the section itself.
    const page = await (await fetch(base + '/panel/skills', { headers: asUser('anna') })).text();
    assert.match(page, /id="skill-share"/);
    assert.match(page, /data-toggle/);
  });
});

test('a foreign skill can neither be saved nor deleted', async () => {
  await withServer(async (base) => {
    await post(base, 'save', 'anna', DRAFT);
    await post(base, 'share', 'anna', { id: 'pirate-mode/SKILL.md', shared: true });

    const save = await post(base, 'save', 'boris', { ...DRAFT, owner: 'anna' });
    assert.equal(save.status, 403);

    const remove = await post(base, 'delete', 'boris', { id: 'pirate-mode/SKILL.md', owner: 'anna' });
    assert.equal(remove.status, 403);

    const mine = (await (await call(base, 'files', 'anna')).json()) as { skills: Skill[] };
    assert.equal(mine.skills[0].shared, true, 'после отказов скилл у владельца цел');
  });
});

test('your own skill is disabled through the panel and remains open', async () => {
  await withServer(async (base) => {
    await post(base, 'save', 'anna', DRAFT);

    const off = await post(base, 'toggle', 'anna', { id: 'pirate-mode/SKILL.md', enabled: false });
    assert.equal(off.status, 200);

    const list = (await (await call(base, 'files', 'anna')).json()) as { skills: Skill[] };
    assert.equal(list.skills[0].enabled, false);

    const detail = await call(base, 'skill?id=' + encodeURIComponent('pirate-mode/SKILL.md'), 'anna');
    assert.equal(detail.status, 200, 'выключенный скилл всё равно читается панелью');
    const body = (await detail.json()) as { enabled: boolean; body: string };
    assert.equal(body.enabled, false);
    assert.match(body.body, /Йо-хо-хо/);
  });
});
