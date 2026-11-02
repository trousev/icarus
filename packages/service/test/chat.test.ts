// Чат панели: список диалогов, история из сессии pi и подписи шагов трассировки.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { userPaths } from '../src/config.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import { rememberTelegramSession } from '../src/sessions/catalog.ts';
import {
  chatImageFile,
  createChat,
  isExternalChatId,
  parseUploadAttachments,
  splitPromptAttachments,
  finishChat,
  listChats,
  readChats,
  readHistory,
  traceDetail,
  traceLabel,
} from '../src/control/chat.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

function fixture() {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  return { config, user };
}

test('новый чат попадает в список и ищется по заголовку и превью', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, new Date('2026-11-01T10:00:00.000Z'));

  assert.equal(chat.title, 'Новый чат');
  assert.equal(readChats(config, user).length, 1);
  assert.deepEqual(listChats(config, user).map((item) => item.id), [chat.id]);

  finishChat(config, user, chat.id, 'Собери план на четверг', 'Вот план: встреча в 10:00.');
  const [found] = listChats(config, user, 'план');
  assert.equal(found?.title, 'Собери план на четверг');
  assert.match(found?.preview ?? '', /10:00/);

  finishChat(
    config,
    user,
    chat.id,
    'Покажи кота',
    'Держи кота. ![котик](/workspace/incoming/kotic.jpg) Рыжий.',
  );
  const withImage = listChats(config, user, 'кота')[0];
  assert.doesNotMatch(withImage?.preview ?? '', /!\[|\/workspace\//, 'в превью нет markdown и путей');
  assert.equal(listChats(config, user, 'нет-такого-слова').length, 0);
});

test('история берётся из файла сессии: текст и трассировка, без сырых результатов', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, new Date('2026-11-01T10:00:00.000Z'));
  const sessionId = sessionIdFor(user.id, chat.id);
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', timestamp: '2026-11-01T10:00:00.000Z' }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:01.000Z',
        message: { role: 'user', content: 'Построй план' },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Сначала посмотрю память.' },
            { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'memory/identity.md' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: '# Кто\n- Живёт в Москве' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-01T10:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Готово.' }] },
      }),
    ].join('\n'),
  );

  const history = readHistory(config, user, chat.id);
  assert.equal(history?.messages.length, 2);
  assert.equal(history?.messages[0].role, 'user');
  assert.equal(history?.messages[1].role, 'assistant');
  assert.match(history?.messages[1].text ?? '', /Сначала посмотрю память[\s\S]*Готово/);
  const [step] = history?.messages[1].trace ?? [];
  assert.equal(step.label, 'ПАМЯТЬ');
  assert.equal(step.status, 'ok');
  assert.match(step.result ?? '', /Москве/);
});

test('неизвестный разговор не выдумывает историю', () => {
  const { config, user } = fixture();
  assert.equal(readHistory(config, user, 'web-нет'), null);
  assert.equal(readHistory(config, user, 'session:нет-такой'), null);
});

/** Файл сессии pi: `<когда создан>_<id>.jsonl`, как его кладёт pi. */
function putSessionFile(
  config: ReturnType<typeof makeConfig>,
  user: ReturnType<typeof probe>,
  conversationId: string,
  entries: unknown[],
): { file: string; sessionId: string } {
  const dir = userPaths(config, user).sessions;
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = sessionIdFor(user.id, conversationId);
  const file = path.join(dir, `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`);
  fs.writeFileSync(file, [JSON.stringify({ type: 'session', timestamp: '2026-11-01T10:00:00.000Z' }), ...entries.map((entry) => JSON.stringify(entry))].join('\n'));
  return { file, sessionId };
}

function dialog(userText: string, assistantText: string, at = '2026-11-01T10:00:01.000Z'): unknown[] {
  return [
    { type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
  ];
}

test('в списке диалогов видны Telegram-разговоры, и они только для чтения', () => {
  const { config, user } = fixture();
  const conversationId = 'telegram-4242';
  const { sessionId } = putSessionFile(
    config,
    user,
    conversationId,
    dialog('Собери отчёт для мамы', 'Готово: отчёт лежит в incoming/otchet.md'),
  );
  rememberTelegramSession(config, user, conversationId, sessionId);

  const chat = listChats(config, user).find((item) => item.id === `session:${sessionId}`);
  assert.ok(chat, 'файл сессии Telegram попал в список');
  assert.equal(chat.channel, 'telegram');
  assert.equal(chat.readOnly, true);
  assert.match(chat.title, /отчёт/);
  assert.match(chat.preview, /Готово/);

  const history = readHistory(config, user, chat.id);
  assert.equal(history?.chat.readOnly, true);
  assert.equal(history?.chat.channel, 'telegram');
  assert.equal(history?.messages.length, 2);
  assert.equal(history?.messages[0]?.text, 'Собери отчёт для мамы');
  assert.equal(isExternalChatId(chat.id), true);
  assert.equal(isExternalChatId('web-1'), false);
});

test('веб-разговор не дублируется в списке как внешняя сессия', () => {
  const { config, user } = fixture();
  const chat = createChat(config, user, new Date('2026-11-01T10:00:00.000Z'));
  putSessionFile(config, user, chat.id, dialog('Построй план', 'Вот план'));

  assert.deepEqual(
    listChats(config, user).map((item) => item.id),
    [chat.id],
    'у веб-чата один и тот же файл сессии, и второй записи быть не должно',
  );
});

test('старый файл без каталога всё равно виден, но без канала', () => {
  const { config, user } = fixture();
  const { sessionId } = putSessionFile(config, user, 'telegram-777', dialog('Старый разговор', 'Старый ответ'));

  const [chat] = listChats(config, user);
  assert.equal(chat?.id, `session:${sessionId}`);
  assert.equal(chat?.channel, 'external');
  assert.equal(chat?.readOnly, true, 'без каталога канал неизвестен — писать всё равно нельзя');
  assert.match(chat?.title ?? '', /Старый разговор/);
  assert.equal(readHistory(config, user, chat?.id ?? '')?.messages.length, 2);
});

test('пустой файл сессии не выдаётся за разговор', () => {
  const { config, user } = fixture();
  putSessionFile(config, user, 'telegram-99', []);
  assert.equal(listChats(config, user).length, 0);
});

test('через API внешний разговор читается, но не пишется', async () => {
  const { config, user } = fixture();
  const conversationId = 'telegram-4242';
  const { sessionId } = putSessionFile(config, user, conversationId, dialog('Покажи погоду', 'Солнечно'));
  rememberTelegramSession(config, user, conversationId, sessionId);

  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };
  const externalId = `session:${sessionId}`;

  try {
    const base = `http://127.0.0.1:${port}`;
    const listed = (await (await fetch(`${base}/panel/api/chats`, { headers })).json()) as {
      chats: Array<{ id: string; readOnly?: boolean }>;
    };
    assert.equal(listed.chats.find((chat) => chat.id === externalId)?.readOnly, true);

    const history = await fetch(`${base}/panel/api/chat/history?id=${encodeURIComponent(externalId)}`, { headers });
    assert.equal(history.status, 200);

    const send = await fetch(`${base}/panel/api/chat/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: externalId, text: 'продолжи' }),
    });
    assert.equal(send.status, 403, 'в Telegram-разговор из панели не записать');
    const abort = await fetch(`${base}/panel/api/chat/abort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: externalId }),
    });
    assert.equal(abort.status, 403);
  } finally {
    server.close();
  }
});

test('шаги называют то, чем Икар занимался, а не сырое имя тула', () => {
  assert.equal(traceLabel('bash', { command: 'cat /workspace/memory/identity.md' }), 'ПАМЯТЬ');
  assert.equal(traceLabel('bash', { command: 'ls /workspace' }), 'ТЕРМИНАЛ');
  assert.equal(traceLabel('mcp_connect', { name: 'homeassistant' }), 'MCP');
  assert.equal(traceLabel('mcp_homeassistant_llm__GetDateTime'), 'ДОМ');
  assert.equal(traceDetail('mcp_connect', { name: 'homeassistant' }), 'homeassistant');
  assert.equal(traceDetail('read', { path: 'memory/preferences.md' }), 'memory/preferences.md');
});

test('картинка из workspace отдаётся только из incoming и maple', () => {
  const { config, user } = fixture();
  const paths = userPaths(config, user);
  fs.mkdirSync(paths.incoming, { recursive: true });
  fs.mkdirSync(paths.maple, { recursive: true });
  fs.writeFileSync(path.join(paths.incoming, 'kotic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(paths.maple, 'plot.gif'), Buffer.from('GIF89a'));

  const incoming = chatImageFile(config, user, '/workspace/incoming/kotic.png');
  assert.equal(incoming?.type, 'image/png');
  assert.match(incoming?.file ?? '', /kotic\.png$/);

  const maple = chatImageFile(config, user, '/workspace/maple/plot.gif');
  assert.equal(maple?.type, 'image/gif');

  assert.equal(chatImageFile(config, user, '/workspace/incoming/../../etc/passwd.png'), null);
  assert.equal(chatImageFile(config, user, '/workspace/icarus.md'), null);
  assert.equal(chatImageFile(config, user, '/workspace/incoming/нет-такой.png'), null);
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
  assert.ok(uploaded.files[0]?.startsWith('/workspace/incoming/'));
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
    'Смотри\n\n[Пользователь приложил файлы, они уже лежат на диске:\n- /workspace/incoming/a.png\n- /workspace/incoming/b.pdf]',
  );
  assert.equal(parsed.text, 'Смотри');
  assert.deepEqual(parsed.attachments, [
    { path: '/workspace/incoming/a.png', image: true },
    { path: '/workspace/incoming/b.pdf', image: false },
  ]);
});
