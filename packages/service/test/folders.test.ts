// Folders in the left menu: the registry, chat membership and the panel API.
//
// A folder is a shelf for conversations, not a working directory: we check that it
// moves nothing on disk, does not lose chats when deleted, and remembers collapsed state.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import {
  FolderError,
  createFolder,
  deleteFolder,
  readFolders,
  renameFolder,
  setFolderCollapsed,
} from '../src/sessions/folders.ts';
import { createChatRecord, readChats, setChatFolder } from '../src/sessions/chats.ts';
import { listChatPage } from '../src/control/chat.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  return { config, user };
}

test('a folder is created, renamed and remembers collapsed state', () => {
  const { config, user } = fixture();
  const folder = createFolder(config, user, '  Работа   и  деньги ', new Date('2026-11-01T10:00:00.000Z'));

  // Extra spaces are collapsed: otherwise the menu shows two visually identical lines.
  assert.equal(folder.name, 'Работа и деньги');
  assert.equal(folder.collapsed, false);
  assert.deepEqual(readFolders(config, user), [folder]);

  renameFolder(config, user, folder.id, 'Работа');
  setFolderCollapsed(config, user, folder.id, true);
  const [stored] = readFolders(config, user);
  assert.equal(stored?.name, 'Работа');
  assert.equal(stored?.collapsed, true, 'свёрнутость хранится на сервере, а не в браузере');
});

test('duplicate names and an empty folder name are not accepted', () => {
  const { config, user } = fixture();
  createFolder(config, user, 'Работа');

  assert.throws(() => createFolder(config, user, ' работа '), (error: unknown) => {
    assert.ok(error instanceof FolderError);
    assert.equal(error.status, 409);
    return true;
  });
  assert.throws(() => createFolder(config, user, '   '), /название/i);
  assert.throws(() => renameFolder(config, user, 'f-нет', 'Дом'), /не найдена/);
  assert.throws(() => setFolderCollapsed(config, user, 'f-нет', true), /не найдена/);
});

test('a conversation moves into a folder and back without changing workspace', () => {
  const { config, user } = fixture();
  const folder = createFolder(config, user, 'Работа');
  const chat = createChatRecord(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));

  const moved = setChatFolder(config, user, chat.id, folder.id);
  assert.equal(moved?.folder, folder.id);

  const [listed] = listChatPage(config, user).chats;
  assert.equal(listed?.folder, folder.id, 'папка едет в браузер вместе со сводкой');
  assert.equal(listed?.workspace, 'talk', 'рабочая папка от полки не меняется');

  setChatFolder(config, user, chat.id, null);
  assert.equal(readChats(config, user)[0]?.folder, undefined);
  // In "Inbox" the field simply is not there — the client need not distinguish null from an empty string.
  assert.equal('folder' in (readChats(config, user)[0] as object), false);
});

test('deleting a folder does not delete conversations: they return to "Inbox"', () => {
  const { config, user } = fixture();
  const folder = createFolder(config, user, 'Работа');
  const first = createChatRecord(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  const second = createChatRecord(config, user, 'talk', new Date('2026-11-01T11:00:00.000Z'));
  setChatFolder(config, user, second.id, folder.id);

  const deleted = deleteFolder(config, user, folder.id);
  assert.equal(deleted.movedChats, 1);
  assert.deepEqual(readFolders(config, user), []);
  // Both conversations are in place: we deleted the shelf, not the conversations.
  assert.deepEqual(
    readChats(config, user).map((chat) => chat.id),
    [second.id, first.id],
  );
  assert.equal(readChats(config, user).every((chat) => chat.folder === undefined), true);
});

/** We bring up a real panel: this also exercises access via the proxy header. */
async function withServer(
  config: ReturnType<typeof makeConfig>,
  run: (base: string, headers: Record<string, string>) => Promise<void>,
): Promise<void> {
  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' });
  } finally {
    server.close();
  }
}

test('folders API: create, move a chat, collapse, rename and delete', async () => {
  const { config, user } = fixture();
  const first = createChatRecord(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  const second = createChatRecord(config, user, 'talk', new Date('2026-11-01T11:00:00.000Z'));

  await withServer(config, async (base, headers) => {
    const empty = (await (await fetch(`${base}/panel/api/folders`, { headers })).json()) as { folders: unknown[] };
    assert.deepEqual(empty.folders, [], 'папок ещё нет — список пустой, а не ошибка');

    const created = await fetch(`${base}/panel/api/folders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Работа' }),
    });
    assert.equal(created.status, 201);
    const { folder } = (await created.json()) as { folder: { id: string; name: string; collapsed: boolean } };
    assert.equal(folder.name, 'Работа');

    const duplicate = await fetch(`${base}/panel/api/folders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'работа' }),
    });
    assert.equal(duplicate.status, 409, 'имя папки сравниваем без учёта регистра');

    // Moving works without pi too: a folder is menu layout, not an agent action.
    const moved = await fetch(`${base}/panel/api/chat/folder`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: second.id, folder: folder.id }),
    });
    assert.equal(moved.status, 200);
    const listed = (await (await fetch(`${base}/panel/api/chats`, { headers })).json()) as {
      chats: Array<{ id: string; folder?: string }>;
    };
    assert.equal(listed.chats.find((chat) => chat.id === second.id)?.folder, folder.id);
    assert.equal(listed.chats.find((chat) => chat.id === first.id)?.folder, undefined, 'остальные — во «Входящих»');

    const unknown = await fetch(`${base}/panel/api/chat/folder`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: first.id, folder: 'f-нет-такой' }),
    });
    assert.equal(unknown.status, 404, 'в несуществующую папку не переносим');

    const collapsed = await fetch(`${base}/panel/api/folders/${folder.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ collapsed: true }),
    });
    assert.equal(collapsed.status, 200);
    assert.equal(((await collapsed.json()) as { folder: { collapsed: boolean } }).folder.collapsed, true);

    const renamed = await fetch(`${base}/panel/api/folders/${folder.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Работа и деньги' }),
    });
    const renamedFolder = ((await renamed.json()) as { folder: { name: string; collapsed: boolean } }).folder;
    assert.equal(renamedFolder.name, 'Работа и деньги');
    assert.equal(renamedFolder.collapsed, true, 'переименование не сбрасывает свёрнутость');

    const removed = await fetch(`${base}/panel/api/folders/${folder.id}`, { method: 'DELETE', headers });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { movedChats: number }).movedChats, 1);
    const after = (await (await fetch(`${base}/panel/api/chats`, { headers })).json()) as {
      chats: Array<{ id: string; folder?: string }>;
    };
    assert.equal(after.chats.filter((chat) => chat.folder).length, 0, 'чаты вернулись во «Входящие»');
  });
});

test('folders are closed to an alien person and answer with a clear error', async () => {
  const { config } = fixture();
  await withServer(config, async (base, headers) => {
    const anonymous = await fetch(`${base}/panel/api/folders`);
    assert.equal(anonymous.status, 401);

    const empty = await fetch(`${base}/panel/api/folders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(empty.status, 400);

    const noSuch = await fetch(`${base}/panel/api/folders/f-нет`, { method: 'DELETE', headers });
    assert.equal(noSuch.status, 404);
  });
});
