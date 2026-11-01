// Чат панели: список диалогов, история из сессии pi и подписи шагов трассировки.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '../src/config.ts';
import { sessionIdFor } from '../src/sessions/pi-session.ts';
import {
  chatImageFile,
  createChat,
  finishChat,
  listChats,
  readChats,
  readHistory,
  traceDetail,
  traceLabel,
} from '../src/control/chat.ts';
import { makeConfig, probe } from './fixtures.ts';

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
