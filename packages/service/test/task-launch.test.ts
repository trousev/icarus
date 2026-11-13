// Task launch: a new conversation and a prompt into it.
//
// There's no Docker or model here: the registry is a stub, and the conversation registry is real. We check
// the main promise of a task — on schedule, an ORDINARY chat appears with the person's prompt,
// not a message into someone else's conversation.
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

test('launch starts a new conversation: title from the prompt, prompt goes to the agent', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, sent, acquired } = makeRegistry();

  const outcome = await taskLauncher(config, registry).launch(user, task());

  assert.equal(outcome.error, undefined);
  // The conversation appeared in the chat registry — the panel will show it in the list.
  const chats = readChats(config, user);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, outcome.chatId);
  assert.equal(chats[0].channel, 'web');
  assert.equal(chats[0].workspace, 'talk');
  // The title is the prompt, not "New chat": the list shows what was launched.
  assert.equal(chats[0].title, PROMPT);
  // Task label: the panel uses it to move the conversation from the common list into the
  // "Tasks → task name → run date" tree.
  assert.deepEqual(chats[0].task, { id: 'task-1', name: PROMPT });
  assert.ok(chats[0].runAt, 'дата запуска сохранена для ветки дерева');
  assert.equal(chats[0].folder, undefined, 'задача не превращается в папку меню');
  // The prompt went in full, not as a title.
  assert.deepEqual(sent, [PROMPT]);
  assert.deepEqual(acquired, [{ conversationId: outcome.chatId, workspace: 'talk' }]);
  // The turn channel is recorded: the panel labels the reply as a web chat.
  assert.equal(findChatRecord(config, user, outcome.chatId ?? '')?.lastTurn?.channel, 'web');
});

test('a task has a name: the title and the tree branch are labeled with it, not the prompt', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, sent } = makeRegistry();

  const outcome = await taskLauncher(config, registry).launch(user, task({ name: 'Сводка по проекту' }));

  const chat = readChats(config, user).find((item) => item.id === outcome.chatId);
  assert.equal(chat?.title, 'Сводка по проекту', 'в открытом чате видно, что это за прогон');
  assert.deepEqual(chat?.task, { id: 'task-1', name: 'Сводка по проекту' });
  assert.deepEqual(sent, [PROMPT], 'агенту всё равно уходит полный промпт');
});

test('a long prompt in the title is cut at the first line', async () => {
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

test('a task runs in its own workspace', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, acquired } = makeRegistry();

  const outcome = await taskLauncher(config, registry).launch(user, task({ workspace: 'work' }));

  assert.equal(acquired[0]?.workspace, 'work');
  assert.equal(readChats(config, user)[0].workspace, 'work');
  assert.ok(outcome.chatId);
});

test('the agent did not come up: the conversation remains, and the error is returned to the task', async () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  const { registry, sent } = makeRegistry({ fail: 'контейнер icarus-user-probe не найден — подними стек' });

  const outcome = await taskLauncher(config, registry).launch(user, task());

  assert.match(outcome.error ?? '', /контейнер/);
  assert.ok(outcome.chatId, 'разговор попытки всё равно назван');
  assert.equal(readChats(config, user).length, 1, 'чат с промптом в заголовке не выбрасываем');
  assert.deepEqual(sent, [], 'промпт никуда не уехал');
});

test('a person\'s busyness is the busy sessions of their conversations', () => {
  const config = makeConfig({ users: [probe('probe')] });
  const user = probe('probe');
  assert.equal(taskLauncher(config, makeRegistry().registry).busy(user), false);
  assert.equal(taskLauncher(config, makeRegistry({ busy: true }).registry).busy(user), true);
});

test('a task created through the store is launched with its own prompt', async () => {
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
  // Conversations live in the person's dataDir: the session file will appear alongside.
  assert.ok(userPaths(config, user).sessions.includes('probe'));
});
