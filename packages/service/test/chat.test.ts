// Чат панели: реестр разговоров, страницы списка, история и подписи шагов.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths } from '../src/config.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import {
  appendChatSession,
  ensureChat,
  findChatRecord,
  sessionIdsOf,
  setChatArchived,
  setChatTelegram,
} from '../src/sessions/chats.ts';
import {
  chatAttachmentFile,
  chatImageFile,
  createChat,
  finishChat,
  listChatPage,
  parseUploadAttachments,
  readChats,
  readHistory,
  splitPromptAttachments,
  traceDetail,
  traceLabel,
} from '../src/control/chat.ts';
import { watchAll, type BulletinEvent } from '../src/control/chat-live.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  return { config, user };
}

/** Файл сессии pi: `<когда создан>_<id>.jsonl`, как его кладёт pi. */
function putSessionFile(
  config: ReturnType<typeof makeConfig>,
  user: ReturnType<typeof probe>,
  conversationId: string,
  entries: unknown[],
  createdAt = '2026-11-01T10-00-00-000Z',
): { file: string; sessionId: string } {
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = sessionIdFor(user.id, conversationId);
  const file = path.join(dir, `${createdAt}_${sessionId}.jsonl`);
  const header = { type: 'session', timestamp: createdAt.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z') };
  fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n'));
  return { file, sessionId };
}

function dialog(userText: string, assistantText: string, at = '2026-11-01T10:00:01.000Z'): unknown[] {
  return [
    { type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
  ];
}

test('в chats.json только метаданные: id, title, createdAt, channel и conversationId', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));

  assert.deepEqual(readChats(config, user), [
    {
      id: chat.id,
      title: 'Новый чат',
      createdAt: '2026-11-01T10:00:00.000Z',
      channel: 'web',
      workspace: 'talk',
      conversationId: chat.id,
    },
  ]);
  assert.equal('preview' in (readChats(config, user)[0] as object), false);
  assert.equal('updatedAt' in (readChats(config, user)[0] as object), false);

  const page = listChatPage(config, user);
  assert.equal(page.chats[0]?.preview, 'Расскажи, что нужно сделать.');
  assert.equal(page.chats[0]?.updatedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(page.chats[0]?.readOnly, false);
});

test('ход веб-чата: заголовок из первой реплики, превью и время из файла сессии', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, dialog('Собери план на четверг', 'Вот план: встреча в 10:00.'));

  finishChat(config, user, chat.id, 'Собери план на четверг');
  finishChat(config, user, chat.id, 'Покажи кота'); // второй ход заголовок не переписывает

  const [found] = listChatPage(config, user, 'план').chats;
  assert.equal(found?.title, 'Собери план на четверг');
  assert.match(found?.preview ?? '', /10:00/);
  assert.equal(found?.updatedAt, '2026-11-01T10:00:01.000Z');
  assert.equal(listChatPage(config, user, 'нет-такого-слова').chats.length, 0);
});

test('finishChat закрывает ход сводкой: разговор не залипает жёлтым', () => {
  // Ход, дошедший до записи, обязан сказать сводке `idle` — иначе сайдбар
  // считает его идущим вечно. Дело не только в счастливом пути: сюда же
  // приходит и `closed`, и любой ранний выход, который до catch не доходит.
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));

  const слышал: BulletinEvent[] = [];
  const отписка = watchAll((event) => слышал.push(event));
  const record = finishChat(config, user, chat.id, 'Собери план на четверг');
  отписка();

  const последний = слышал.at(-1);
  assert.equal(последний?.type, 'idle', 'ход встал');
  assert.equal(последний?.chatId, chat.id, 'и это тот самый разговор');
  assert.equal(последний?.userId, 'probe', 'событие адресовано владельцу, а не всем подряд');
  assert.equal((последний?.chat as { id?: string })?.id, chat.id, 'в сводке едет запись разговора');
  assert.equal(record?.title, 'Собери план на четверг', 'заголовок по-прежнему берётся из первой реплики');
});

test('ход без записи тоже не оставляет разговор жёлтым', () => {
  // Разговор уже удалён или его файл недоступен: `finishChat` записи не даст,
  // но `idle` из сводки уйти обязан — иначе нечего будет гасить.
  const { config, user } = fixture();
  const слышал: BulletinEvent[] = [];
  const отписка = watchAll((event) => слышал.push(event));
  const record = finishChat(config, user, 'web-нет-такого', 'Что-нибудь');
  отписка();

  assert.equal(record, null, 'записи нет');
  assert.equal(слышал.at(-1)?.type, 'idle', 'а сводка всё равно узнала, что ход встал');
});

test('история берётся из файла сессии: текст и трассировка, без сырых результатов', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, [
    { type: 'message', timestamp: '2026-11-01T10:00:01.000Z', message: { role: 'user', content: 'Построй план' } },
    {
      type: 'message',
      timestamp: '2026-11-01T10:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Сначала посмотрю память.' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'memory/identity.md' } },
        ],
      },
    },
    {
      type: 'message',
      timestamp: '2026-11-01T10:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: '# Кто\n- Живёт в Москве' }],
      },
    },
    {
      type: 'message',
      timestamp: '2026-11-01T10:00:04.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Готово.' }] },
    },
  ]);

  const history = readHistory(config, user, chat.id);
  assert.equal(history?.messages.length, 2);
  assert.equal(history?.messages[0].role, 'user');
  assert.equal(history?.messages[1].role, 'assistant');
  assert.match(history?.messages[1].text ?? '', /Сначала посмотрю память[\s\S]*Готово/);
  const [step] = history?.messages[1].trace ?? [];
  assert.equal(step.label, 'ПАМЯТЬ');
  assert.equal(step.status, 'ok');
  assert.match(step.result ?? '', /Москве/);
  assert.equal(history?.chat.title, 'Построй план', 'заголовок в реестре обновился из файла');
});

test('неизвестный разговор не выдумывает историю', () => {
  const { config, user } = fixture();
  assert.equal(readHistory(config, user, 'web-нет'), null);
  assert.equal(readHistory(config, user, 'session:нет-такой'), null);
});

test('Telegram-разговор в реестре и в списке: его можно продолжить из панели', () => {
  const { config, user } = fixture();
  const conversationId = 'telegram-4242';
  const { sessionId } = putSessionFile(
    config,
    user,
    conversationId,
    dialog('Собери отчёт для мамы', 'Готово: отчёт лежит в incoming/otchet.md'),
  );
  ensureChat(config, user, conversationId, 'telegram');

  const [chat] = listChatPage(config, user).chats;
  assert.equal(chat?.id, conversationId);
  assert.equal(chat?.channel, 'telegram');
  // Транспорт — труба, разговор общий: панель продолжает Telegram, а не смотрит.
  assert.equal(chat?.readOnly, false);
  assert.match(chat?.title ?? '', /отчёт/);
  assert.match(chat?.preview ?? '', /Готово/);
  assert.equal(readChats(config, user)[0]?.title, chat?.title, 'заголовок сохранился в реестре');

  const history = readHistory(config, user, chat?.id ?? '');
  assert.equal(history?.chat.readOnly, false);
  assert.equal(history?.chat.channel, 'telegram');
  assert.equal(history?.messages.length, 2);
  assert.equal(history?.messages[0]?.text, 'Собери отчёт для мамы');

  // Старая ссылка `session:<id>` ведёт к той же записи.
  const legacy = readHistory(config, user, `session:${sessionId}`);
  assert.equal(legacy?.chat.id, conversationId);
});

test('список сортируется по createdAt, а не по времени файла сессии', () => {
  const { config, user } = fixture();
  const older = createChat(config, user, 'talk', new Date('2026-01-01T10:00:00.000Z'));
  const newer = createChat(config, user, 'talk', new Date('2026-02-01T10:00:00.000Z'));
  const { file: olderFile } = putSessionFile(
    config,
    user,
    older.id,
    dialog('Старый разговор', 'Старый ответ'),
    '2026-01-01T10-00-00-000Z',
  );
  putSessionFile(config, user, newer.id, dialog('Новый разговор', 'Новый ответ'), '2026-02-01T10-00-00-000Z');

  // Файл старого чата трогали позже — на порядок это влиять не должно.
  fs.utimesSync(olderFile, new Date('2026-03-01T10:00:00.000Z'), new Date('2026-03-01T10:00:00.000Z'));

  assert.deepEqual(
    listChatPage(config, user).chats.map((chat) => chat.id),
    [newer.id, older.id],
  );
});

test('список листается страницами, следующая догружается по курсору', () => {
  const { config, user } = fixture();
  const created = [];
  for (let index = 1; index <= 5; index += 1) {
    const day = String(index).padStart(2, '0');
    const chat = createChat(config, user, 'talk', new Date(`2026-11-${day}T10:00:00.000Z`));
    const { file } = putSessionFile(
      config,
      user,
      chat.id,
      dialog(`Тема ${index}`, `Ответ ${index}`),
      `2026-11-${day}T10-00-00-000Z`,
    );
    fs.utimesSync(file, new Date(`2026-11-${day}T10:00:00.000Z`), new Date(`2026-11-${day}T10:00:00.000Z`));
    finishChat(config, user, chat.id, `Тема ${index}`);
    created.push(chat);
  }

  const first = listChatPage(config, user, '', 2);
  assert.equal(first.chats.length, 2);
  assert.equal(first.total, 5);
  assert.equal(first.nextCursor, '2');
  assert.deepEqual(first.chats.map((chat) => chat.title), ['Тема 5', 'Тема 4']);

  const second = listChatPage(config, user, '', 2, first.nextCursor);
  assert.deepEqual(second.chats.map((chat) => chat.title), ['Тема 3', 'Тема 2']);
  assert.equal(second.nextCursor, '4');

  const third = listChatPage(config, user, '', 2, second.nextCursor);
  assert.deepEqual(third.chats.map((chat) => chat.title), ['Тема 1']);
  assert.equal(third.nextCursor, null);

  const search = listChatPage(config, user, 'Тема 3', 2);
  assert.equal(search.total, 1);
  assert.deepEqual(search.chats.map((chat) => chat.id), [created[2]?.id]);
});

test('разговор через API читается, но из панели не пишется', async () => {
  const { config, user } = fixture();
  // API-клиент владеет историей сам: его разговор панель только смотрит.
  const conversationId = 'api-4242';
  const { sessionId } = putSessionFile(config, user, conversationId, dialog('Покажи погоду', 'Солнечно'));
  ensureChat(config, user, conversationId, 'api');

  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };

  try {
    const base = `http://127.0.0.1:${port}`;
    const listed = (await (await fetch(`${base}/panel/api/chats`, { headers })).json()) as {
      chats: Array<{ id: string; readOnly?: boolean }>;
      nextCursor: string | null;
      total: number;
    };
    assert.equal(listed.chats.find((chat) => chat.id === conversationId)?.readOnly, true);
    assert.equal(listed.nextCursor, null);
    assert.equal(listed.total, 1);

    const history = await fetch(`${base}/panel/api/chat/history?id=${encodeURIComponent(conversationId)}`, { headers });
    assert.equal(history.status, 200);

    const send = await fetch(`${base}/panel/api/chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: conversationId, text: 'продолжи' }),
    });
    assert.equal(send.status, 403, 'в API-разговор из панели не записать');
    const abort = await fetch(`${base}/panel/api/chat/abort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: conversationId }),
    });
    assert.equal(abort.status, 403);

    const legacy = await fetch(`${base}/panel/api/chat/history?id=${encodeURIComponent(`session:${sessionId}`)}`, { headers });
    assert.equal(legacy.status, 200, 'старая ссылка на файл сессии продолжает открываться');
  } finally {
    server.close();
  }
});

test('архивный разговор уходит из общего списка в свою страницу', () => {
  const { config, user } = fixture();
  const stay = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  const hidden = createChat(config, user, 'talk', new Date('2026-11-02T10:00:00.000Z'));
  setChatArchived(config, user, hidden.id, true, new Date('2026-11-03T10:00:00.000Z'));

  const everyday = listChatPage(config, user);
  assert.deepEqual(everyday.chats.map((chat) => chat.id), [stay.id], 'архивный в ежедневном списке не виден');
  assert.equal(everyday.chats[0]?.archived, false);
  assert.equal(everyday.total, 1);

  const archive = listChatPage(config, user, '', 30, null, null, true);
  assert.deepEqual(archive.chats.map((chat) => chat.id), [hidden.id], 'и живёт только в архиве');
  assert.equal(archive.chats[0]?.archived, true);
  assert.equal(archive.total, 1);

  // История архивного разговора открывается по прямой ссылке: архив — не удаление.
  assert.equal(readHistory(config, user, hidden.id)?.chat.archived, true);
});

test('архив через API: разговор уезжает из списка, возвращается и переживает реестр', async () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  // Разговор живёт в Telegram: без места панель не знает, какой топик удалять.
  setChatTelegram(config, user, chat.id, 42, 17);
  // Архив Telegram-разговора — одно действие с ботом: панель зовёт бота вынести
  // топик, а возврат из архива Telegram не трогает (восстанавливать нечего).
  const removed: string[] = [];
  const server = createServer(config, {} as never, {
    archiveTelegram: async (_person, record) => void removed.push(record.id),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };

  try {
    const base = `http://127.0.0.1:${port}`;
    const archive = await fetch(`${base}/panel/api/chat/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: chat.id }),
    });
    assert.equal(archive.status, 200);
    assert.deepEqual(await archive.json(), { chat: { id: chat.id, archived: true } });

    const everyday = (await (await fetch(`${base}/panel/api/chats`, { headers })).json()) as {
      chats: Array<{ id: string }>;
      total: number;
    };
    assert.equal(everyday.total, 0, 'в обычном списке разговора больше нет');

    const arhiveList = (await (await fetch(`${base}/panel/api/chats?archived=1`, { headers })).json()) as {
      chats: Array<{ id: string; archived: boolean }>;
      total: number;
    };
    assert.deepEqual(arhiveList.chats.map((item) => item.id), [chat.id]);
    assert.equal(arhiveList.chats[0]?.archived, true);
    assert.equal(readChats(config, user)[0]?.archivedAt !== undefined, true, 'отметка лежит в chats.json');

    const restore = await fetch(`${base}/panel/api/chat/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: chat.id, archived: false }),
    });
    assert.deepEqual(await restore.json(), { chat: { id: chat.id, archived: false } });
    const back = (await (await fetch(`${base}/panel/api/chats`, { headers })).json()) as {
      chats: Array<{ id: string }>;
      total: number;
    };
    assert.equal(back.total, 1, 'вернулся в общий список');
    assert.deepEqual(removed, [chat.id], 'топик выносится ботом только при архивации, а не при возврате');

    const missing = await fetch(`${base}/panel/api/chat/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: 'web-нет-такого' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('шаги называют то, чем Икар занимался, а не сырое имя тула', () => {
  assert.equal(traceLabel('bash', { command: 'cat /workspaces/.icarus/memory/identity.md' }), 'ПАМЯТЬ');
  assert.equal(traceLabel('bash', { command: 'ls /workspaces' }), 'ТЕРМИНАЛ');
  assert.equal(traceLabel('mcp_connect', { name: 'homeassistant' }), 'MCP');
  assert.equal(traceLabel('mcp_homeassistant_llm__GetDateTime'), 'ДОМ');
  // Поиск и открытие страницы — разные занятия, и подписи у них разные.
  assert.equal(traceLabel('web_search', { query: 'ёжик' }), 'ПОИСК');
  assert.equal(traceLabel('web_fetch', { url: 'https://anekdotbar.ru/pro-ezhika/' }), 'СТРАНИЦА');
  assert.equal(traceDetail('mcp_connect', { name: 'homeassistant' }), 'homeassistant');
  assert.equal(traceDetail('read', { path: 'memory/preferences.md' }), 'memory/preferences.md');
});

test('картинка отдаётся из вложений и рабочих папок, и только картинка', () => {
  const { config, user } = fixture();
  const paths = userPaths(config, user);
  const plots = path.join(paths.workspaces, 'talk', '.maple', 'plots');
  fs.mkdirSync(paths.incoming, { recursive: true });
  fs.mkdirSync(plots, { recursive: true });
  fs.writeFileSync(path.join(paths.incoming, 'kotic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(plots, 'plot.gif'), Buffer.from('GIF89a'));
  fs.writeFileSync(path.join(plots, 'plot 2.gif'), Buffer.from('GIF89a'));

  const incoming = chatImageFile(config, user, '/workspaces/.icarus/incoming/kotic.png');
  assert.equal(incoming?.type, 'image/png');
  assert.match(incoming?.file ?? '', /kotic\.png$/);

  // График из workspace: MCP кладёт файл рядом с работой человека, а путь отдаёт
  // в markdown. Абсолютный контейнерный путь и закодированные пробелы — оба.
  const plot = chatImageFile(config, user, '/workspaces/talk/.maple/plots/plot.gif');
  assert.equal(plot?.type, 'image/gif');
  const spaced = chatImageFile(config, user, '/workspaces/talk/.maple/plots/plot%202.gif');
  assert.equal(spaced?.type, 'image/gif');

  assert.equal(chatImageFile(config, user, '/workspaces/.icarus/incoming/../../etc/passwd.png'), null);
  assert.equal(chatImageFile(config, user, '/workspaces/.icarus/icarus.md'), null);
  assert.equal(chatImageFile(config, user, '/workspaces/talk/.maple/plots/plot.mw'), null, 'не картинка — не отдаём');
  assert.equal(chatImageFile(config, user, '/workspaces/.icarus/incoming/нет-такой.png'), null);
});

test('файл из ответа агента скачивается ссылкой, а не ищется статикой', async () => {
  const { config, user } = fixture();
  const plots = path.join(userPaths(config, user).workspaces, 'talk', '.maple', 'plots');
  fs.mkdirSync(plots, { recursive: true });
  fs.writeFileSync(path.join(plots, 'смета.pdf'), Buffer.from('%PDF-1.4'));

  // Прямая проверка разбора: тот же путь, что и у картинки, но файл любой.
  const found = chatAttachmentFile(config, user, '/workspaces/talk/.maple/plots/смета.pdf');
  assert.equal(found?.type, 'application/pdf');
  assert.equal(chatAttachmentFile(config, user, '/etc/passwd'), null);

  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe' };
  try {
    const base = `http://127.0.0.1:${port}`;
    const url = `/panel/api/chat/file?path=${encodeURIComponent('/workspaces/talk/.maple/plots/смета.pdf')}`;
    const file = await fetch(`${base}${url}`, { headers });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition') ?? '', /attachment;/);
    assert.equal(await file.text(), '%PDF-1.4');

    const outside = await fetch(`${base}/panel/api/chat/file?path=%2Fetc%2Fpasswd`, { headers });
    assert.equal(outside.status, 404, 'за пределы рабочей папки не пускаем');
  } finally {
    server.close();
  }
});

test('вложения из браузера ложатся в incoming, картинки уходят и в files, и в images', () => {
  const { config, user } = fixture();
  const incoming = userPaths(config, user).incoming;
  const uploaded = parseUploadAttachments(
    [
      { name: 'котик.png', type: 'image/png', data: Buffer.from('PNG').toString('base64') },
      { name: 'план.txt', type: 'text/plain', data: Buffer.from('план').toString('base64') },
    ],
    incoming,
  );

  assert.equal(uploaded.files.length, 2);
  assert.equal(uploaded.images.length, 1);
  assert.equal(uploaded.images[0]?.mimeType, 'image/png');
  assert.deepEqual(uploaded.names, ['котик.png', 'план.txt']);
  assert.ok(uploaded.files[0]?.startsWith('/workspaces/.icarus/incoming/'));
  for (const file of uploaded.files) {
    assert.ok(fs.existsSync(path.join(incoming, path.basename(file))));
  }
  assert.deepEqual(
    uploaded.paths.map((item) => item.image),
    [true, false],
  );
  assert.throws(() => parseUploadAttachments([{ name: 'x', data: '' }], incoming), /пустое/);
});

test('след вложений в реплике разбирается обратно в плашки', () => {
  const parsed = splitPromptAttachments(
    'Смотри\n\n[Пользователь приложил файлы, они уже лежат на диске:\n- /workspaces/.icarus/incoming/a.png\n- /workspaces/.icarus/incoming/b.pdf]',
  );
  assert.equal(parsed.text, 'Смотри');
  assert.deepEqual(parsed.attachments, [
    { path: '/workspaces/.icarus/incoming/a.png', image: true },
    { path: '/workspaces/.icarus/incoming/b.pdf', image: false },
  ]);
});


test('после /clear история склеивается с разделителем, а не обнуляется', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, 'talk', new Date('2026-11-01T10:00:00.000Z'));
  const firstId = sessionIdFor(user.id, chat.id);
  putSessionFile(config, user, chat.id, dialog('старый вопрос', 'старый ответ'));

  const secondId = '8d2c4a10-1111-4bbb-8ccc-1234567890ab';
  appendChatSession(config, user, chat.id, secondId, '2026-11-02T09:00:00.000Z');
  const dir = userPaths(config, user).sessions;
  const second = path.join(dir, `2026-11-02T09-00-00-000Z_${secondId}.jsonl`);
  fs.writeFileSync(
    second,
    [
      { type: 'session', timestamp: '2026-11-02T09:00:00.000Z' },
      ...dialog('новый вопрос', 'новый ответ', '2026-11-02T09:00:01.000Z'),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );

  const record = findChatRecord(config, user, chat.id);
  assert.ok(record);
  assert.deepEqual(sessionIdsOf(record, user), [firstId, secondId], 'цепочка сессий на месте');

  const history = readHistory(config, user, chat.id);
  assert.ok(history);
  assert.deepEqual(
    history.messages.map((message) => message.divider ?? message.text),
    ['старый вопрос', 'старый ответ', 'clear', 'новый вопрос', 'новый ответ'],
    'старые сообщения остались до разделителя',
  );
  assert.equal(history.messages[2]?.timestamp, '2026-11-02T09:00:00.000Z', 'у границы есть время');

  const page = listChatPage(config, user);
  assert.match(page.chats[0]?.preview ?? '', /новый ответ/, 'в списке — свежая сессия');
});
