// Виртуальное дерево «Задачи» в левом меню.
//
// Чаты, созданные задачей, не показываются в общем списке: они живут в дереве
// «Задача → дата запуска → разговоры». Это вид поверх метки в chats.json, а не
// папка: folders.json не трогается, перетаскивать и удалять ветку нечего.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/http/server.ts';
import { listChatPage, readHistory, taskChatTree } from '../src/control/chat.ts';
import {
  createChatRecord,
  readChats,
  setChatArchived,
  setChatFolder,
  type ChatRecord,
  type ChatTaskMark,
} from '../src/sessions/chats.ts';
import { createFolder, readFolders } from '../src/sessions/folders.ts';
import { createTask, parseTaskInput, readTasks, taskName, writeTasks } from '../src/sessions/scheduled.ts';
import { makeConfig, PANEL_USER_HEADER, probe } from './fixtures.ts';

const PROMPT = 'Собери сводку по проекту X и приложи список рисков, а заодно проверь сроки и зависимости';

function fixture() {
  const config = makeConfig({ users: [probe('probe')], env: { TZ: 'Europe/Moscow' } });
  return { config, user: probe('probe') };
}

/** Чат задачи с явной датой запуска: так проверяются ветки дерева, а не часы. */
function taskChat(
  config: ReturnType<typeof fixture>['config'],
  user: ReturnType<typeof fixture>['user'],
  at: string,
  task: ChatTaskMark = { id: 'task-1', name: 'Сводка по проекту' },
  title = 'Сводка по проекту',
): ChatRecord {
  return createChatRecord(config, user, 'talk', new Date(at), { title, task });
}

test('чат задачи не попадает в обычный список, а собирается в дерево', () => {
  const { config, user } = fixture();
  const regular = createChatRecord(config, user, 'talk', new Date('2026-11-12T09:00:00.000Z'));
  const launched = taskChat(config, user, '2026-11-12T09:05:00.000Z');

  const page = listChatPage(config, user);
  assert.deepEqual(
    page.chats.map((chat) => chat.id),
    [regular.id],
    'в общем списке только обычный разговор',
  );
  assert.equal(page.total, 1);

  const tree = taskChatTree(config, user);
  assert.equal(tree.length, 1);
  assert.deepEqual(
    tree[0].runs.flatMap((run) => run.chats.map((chat) => chat.id)),
    [launched.id],
  );
});

test('чат задачи не показывается ни в папке, ни во «Входящих», даже если у него есть folder', () => {
  const { config, user } = fixture();
  const folder = createFolder(config, user, 'Работа');
  const tagged = taskChat(config, user, '2026-11-12T09:00:00.000Z');
  // Раньше чат могли успеть перетащить в папку: метка задачи всё равно сильнее.
  setChatFolder(config, user, tagged.id, folder.id);

  const page = listChatPage(config, user);
  assert.equal(page.chats.length, 0, 'ни в папке, ни во «Входящих» его нет');
  assert.equal(taskChatTree(config, user)[0].runs[0].chats.length, 1, 'он в дереве, а не потерян');
});

test('дерево: два уровня — задача и дата запуска, свежие сверху', () => {
  const { config, user } = fixture();
  const taskA: ChatTaskMark = { id: 'task-a', name: 'Сводка по проекту' };
  const taskB: ChatTaskMark = { id: 'task-b', name: 'Проверить бэкапы' };
  taskChat(config, user, '2026-11-12T06:00:00.000Z', taskA, 'Сводка за понедельник');
  taskChat(config, user, '2026-11-13T06:00:00.000Z', taskA, 'Сводка за вторник');
  taskChat(config, user, '2026-11-11T06:00:00.000Z', taskB, 'Бэкапы за понедельник');

  const tree = taskChatTree(config, user);
  // Сверху задача с последним запуском: человек ищет глазами свежий результат.
  assert.deepEqual(
    tree.map((group) => group.name),
    ['Сводка по проекту', 'Проверить бэкапы'],
  );
  assert.deepEqual(
    tree[0].runs.map((run) => run.date),
    ['2026-11-13', '2026-11-12'],
    'даты по убыванию',
  );
  // Второй уровень — дата, третий — сами разговоры.
  assert.deepEqual(
    tree[0].runs[1].chats.map((chat) => chat.title),
    ['Сводка за понедельник'],
  );
});

test('дата ветки считается в поясе человека, а не в UTC', () => {
  const { config, user } = fixture();
  // 21:30 UTC 12 ноября — это уже 00:30 13 ноября по Москве.
  taskChat(config, user, '2026-11-12T21:30:00.000Z');

  assert.deepEqual(
    taskChatTree(config, user)[0].runs.map((run) => run.date),
    ['2026-11-13'],
  );
});

test('история чата задачи помнит метку: панель не вернёт его в общий список', () => {
  const { config, user } = fixture();
  const chat = taskChat(config, user, '2026-11-12T09:00:00.000Z');

  // Открытие разговора не должно «терять» метку: иначе он всплыл бы во «Входящих».
  assert.deepEqual(readHistory(config, user, chat.id)?.chat.task, {
    id: 'task-1',
    name: 'Сводка по проекту',
  });
});

test('архивный чат задачи уходит в «Архив», а после возврата — обратно в дерево', () => {
  const { config, user } = fixture();
  const chat = taskChat(config, user, '2026-11-12T09:00:00.000Z');

  setChatArchived(config, user, chat.id, true);
  assert.equal(taskChatTree(config, user).length, 0, 'в дереве архива нет');
  assert.deepEqual(
    listChatPage(config, user, '', 30, null, null, true).chats.map((item) => item.id),
    [chat.id],
    'архив показывает его как обычный разговор',
  );

  setChatArchived(config, user, chat.id, false);
  assert.equal(taskChatTree(config, user)[0].runs[0].chats[0].id, chat.id);
  assert.equal(listChatPage(config, user).chats.length, 0, 'и снова не в общем списке');
});

test('«Задачи» — не папка: в folders.json от дерева ничего не появляется', () => {
  const { config, user } = fixture();
  taskChat(config, user, '2026-11-12T09:00:00.000Z');

  taskChatTree(config, user);
  assert.deepEqual(readFolders(config, user), [], 'в реестре папок пусто');
  // Настоящая папка с чатом задачи никак не связана: её создание и удаление
  // дерево не трогает, а чат остаётся помеченным задачей.
  const folder = createFolder(config, user, 'Работа');
  assert.deepEqual(
    readFolders(config, user).map((item) => item.name),
    [folder.name],
  );
  assert.equal(readChats(config, user)[0].task?.id, 'task-1');
});

test('API списка отдаёт дерево вместе с первой страницей и с фильтром поиска', async () => {
  const { config, user } = fixture();
  const regular = createChatRecord(config, user, 'talk', new Date('2026-11-12T09:00:00.000Z'), {
    title: 'Обычный разговор',
  });
  taskChat(config, user, '2026-11-12T10:00:00.000Z', { id: 'task-a', name: 'Сводка по проекту' }, 'Сводка');
  taskChat(config, user, '2026-11-12T11:00:00.000Z', { id: 'task-b', name: 'Проверить бэкапы' }, 'Бэкапы');

  const server = createServer(config, {} as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const headers = { [PANEL_USER_HEADER]: 'probe', 'content-type': 'application/json' };
  try {
    const base = `http://127.0.0.1:${port}`;
    const plain = (await (await fetch(`${base}/panel/api/chats`, { headers })).json()) as {
      chats: Array<{ id: string }>;
      tasks: Array<{ name: string }>;
    };
    assert.deepEqual(
      plain.chats.map((chat) => chat.id),
      [regular.id],
      'чаты задач в общем списке не отдаются',
    );
    assert.deepEqual(
      plain.tasks.map((group) => group.name),
      ['Проверить бэкапы', 'Сводка по проекту'],
    );

    const found = (await (await fetch(`${base}/panel/api/chats?q=сводка`, { headers })).json()) as {
      chats: Array<{ id: string }>;
      tasks: Array<{ name: string }>;
    };
    assert.deepEqual(found.chats, [], 'поиск по общему списку задачу не находит');
    assert.deepEqual(
      found.tasks.map((group) => group.name),
      ['Сводка по проекту'],
      'но в дереве поиск её видит',
    );
  } finally {
    server.close();
  }
});

test('ветка называется именем задачи, а переименование меняет подпись', () => {
  const { config, user } = fixture();
  const now = new Date('2026-11-12T09:00:00.000Z');
  const created = createTask(
    config,
    user,
    parseTaskInput(
      { name: 'Сводка по проекту', prompt: PROMPT, repeat: { kind: 'daily', time: '08:00' } },
      'Europe/Moscow',
      now,
    ),
    now,
  );
  // Метка чата хранит имя на момент запуска — например, старое.
  taskChat(config, user, '2026-11-12T09:05:00.000Z', { id: created.id, name: 'Старое имя' }, 'Старое имя');

  assert.equal(taskChatTree(config, user)[0].name, 'Сводка по проекту', 'в дереве имя задачи, а не метки');

  const renamed = readTasks(config, user).map((task) => ({ ...task, name: 'Сводка за неделю' }));
  writeTasks(config, user, renamed);
  assert.equal(taskChatTree(config, user)[0].name, 'Сводка за неделю', 'переименовал задачу — сменилась ветка');
});

test('старая задача без имени не падает: ветка выводится из первой строки промпта', () => {
  const { config, user } = fixture();
  // Запись из файла, который завели до появления имени: поля name просто нет.
  const old = {
    id: 'task-old',
    prompt: `${PROMPT}\nвторая строка промпта`,
    repeat: { kind: 'daily', time: '08:00' },
    enabled: true,
    createdAt: '2026-11-01T09:00:00.000Z',
    nextRunAt: '2026-11-13T08:00:00.000Z',
  };
  writeTasks(config, user, [old as never]);
  taskChat(config, user, '2026-11-12T09:00:00.000Z', { id: old.id, name: 'старая метка' }, 'старая метка');

  assert.equal(taskName(readTasks(config, user)[0]), PROMPT.slice(0, 59) + '…', 'длинная строка аккуратно обрезана');
  assert.equal(taskChatTree(config, user)[0].name, PROMPT.slice(0, 59) + '…');
});
