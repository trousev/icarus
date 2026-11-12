// Запуск задачи: новый разговор и промпт в него.
//
// Докера и модели тут нет: реестр — заглушка, а реестр разговоров настоящий. Проверяем
// главное обещание задачи — по времени появляется ОБЫЧНЫЙ чат с промптом человека,
// а не сообщение в чужой разговор.
import test from 'node:test';
import assert from 'node:assert/strict';
import { userPaths } from '../src/config.ts';
import { readChats, findChatRecord } from '../src/sessions/chats.ts';
import type { SessionRegistry } from '../src/sessions/registry.ts';
import { taskLauncher } from '../src/sessions/task-launch.ts';
import { createTask, parseTaskInput, type ScheduledTask } from '../src/sessions/scheduled.ts';
import { makeConfig, probe } from './fixtures.ts';

const PROMPT = 'Собери сводку по проекту X и приложи список рисков';

function makeRegistry(options: { busy?: boolean; fail?: string } = {}) {
  const sent: string[] = [];
  const acquired: Array<{ conversationId: string; workspace?: string }> = [];
  const registry = {
    busyConversations: () => (options.busy ? ['web-other'] : []),
    acquire: async (_user: unknown, conversationId: string, workspace?: string) => {
      acquired.push({ conversationId, workspace });
      if (options.fail) throw new Error(options.fail);
      return {
        prompt: async (text: string) => {
          sent.push(text);
        },
      };
    },
  };
  return { registry: registry as unknown as SessionRegistry, sent, acquired };
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    prompt: PROMPT,
    repeat: { kind: 'daily', time: '08:00' },
    enabled: true,
    createdAt: '2026-11-08T07:00:00.000Z',
    nextRunAt: '2026-11-08T08:00:00.000Z',
    ...overrides,
  };
}

test('запуск заводит новый разговор: заголовок из промпта, промпт уходит агенту', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, sent, acquired } = makeRegistry();

  const outcome = await taskLauncher(config, registry).launch(user, task());

  assert.equal(outcome.error, undefined);
  // Разговор появился в реестре чатов — панель покажет его в списке.
  const chats = readChats(config, user);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, outcome.chatId);
  assert.equal(chats[0].channel, 'web');
  assert.equal(chats[0].workspace, 'talk');
  // Заголовок — промпт, а не «Новый чат»: в списке видно, что запустилось.
  assert.equal(chats[0].title, PROMPT);
  // Метка задачи: по ней панель убирает разговор из общего списка в дерево
  // «Задачи → имя задачи → дата запуска».
  assert.deepEqual(chats[0].task, { id: 'task-1', name: PROMPT });
  assert.ok(chats[0].runAt, 'дата запуска сохранена для ветки дерева');
  assert.equal(chats[0].folder, undefined, 'задача не превращается в папку меню');
  // Промпт уехал целиком, а не заголовком.
  assert.deepEqual(sent, [PROMPT]);
  assert.deepEqual(acquired, [{ conversationId: outcome.chatId, workspace: 'talk' }]);
  // Канал хода записан: панель подписывает реплику как веб-чат.
  assert.equal(findChatRecord(config, user, outcome.chatId ?? '')?.lastTurn?.channel, 'web');
});

test('длинный промпт в заголовке режется по первой строке', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry } = makeRegistry();
  const long = `Собери сводку по проекту X и приложи список рисков, а заодно проверь сроки и зависимости\nвторая строка промпта`;

  const outcome = await taskLauncher(config, registry).launch(user, task({ prompt: long }));

  const title = readChats(config, user).find((chat) => chat.id === outcome.chatId)?.title ?? '';
  assert.ok(title.length <= 60, 'заголовок влезает в строку списка');
  assert.match(title, /^Собери сводку по проекту X/);
  assert.equal(title.includes('вторая строка'), false, 'в заголовок идёт только первая строка');
});

test('задача работает в своём workspace', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, acquired } = makeRegistry();

  const outcome = await taskLauncher(config, registry).launch(user, task({ workspace: 'work' }));

  assert.equal(acquired[0]?.workspace, 'work');
  assert.equal(readChats(config, user)[0].workspace, 'work');
  assert.ok(outcome.chatId);
});

test('агент не поднялся: разговор остаётся, а ошибка возвращается задаче', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, sent } = makeRegistry({ fail: 'контейнер icarus-user-probe не найден — подними стек' });

  const outcome = await taskLauncher(config, registry).launch(user, task());

  assert.match(outcome.error ?? '', /контейнер/);
  assert.ok(outcome.chatId, 'разговор попытки всё равно назван');
  assert.equal(readChats(config, user).length, 1, 'чат с промптом в заголовке не выбрасываем');
  assert.deepEqual(sent, [], 'промпт никуда не уехал');
});

test('занятость человека — это занятые сессии его разговоров', () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  assert.equal(taskLauncher(config, makeRegistry().registry).busy(user), false);
  assert.equal(taskLauncher(config, makeRegistry({ busy: true }).registry).busy(user), true);
});

test('задача, созданная через хранилище, запускается своим промптом', async () => {
  const config = makeConfig({ users: [probe('probe')], env: { TZ: 'Europe/Dublin' } });
  const user = probe('probe');
  const { registry, sent } = makeRegistry();
  const now = new Date('2026-11-08T07:00:00Z');
  const created = createTask(
    config,
    user,
    parseTaskInput({ prompt: PROMPT, repeat: { kind: 'daily', time: '08:00' } }, 'Europe/Dublin', now),
    now,
  );

  const outcome = await taskLauncher(config, registry).launch(user, created);

  assert.deepEqual(sent, [PROMPT]);
  assert.equal(readChats(config, user)[0].id, outcome.chatId);
  // Разговоры лежат в dataDir человека: файл сессии появится рядом.
  assert.ok(userPaths(config, user).sessions.includes('probe'));
});
