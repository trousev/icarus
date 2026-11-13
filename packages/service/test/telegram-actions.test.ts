// Действие Telegram вместо словесного статуса: чем бот показывает, что он занят,
// как часто повторяет это и когда честно замолкает.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TelegramApi } from '../src/telegram/api.ts';
import { TelegramReply } from '../src/telegram/reply.ts';
import { ACTION_GAP_MS, STICKER_LIE_MS, THINKING_ACTION, actionForTool } from '../src/telegram/chat-action.ts';

function fakeApi() {
  const actions: string[] = [];
  const api = {
    async sendMessage() {
      return { message_id: 1 };
    },
    async editMessageText() {},
    async sendChatAction(_chatId: number, action = 'typing') {
      actions.push(action);
    },
  };
  return { api: api as unknown as TelegramApi, actions };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('каждая фаза хода переводится в действие из списка Telegram', () => {
  assert.equal(actionForTool('read'), 'upload_document');
  assert.equal(actionForTool('write'), 'upload_document');
  assert.equal(actionForTool('edit'), 'upload_document');
  assert.equal(actionForTool('subagent'), 'find_location');
  assert.equal(actionForTool('bash'), 'typing');
  assert.equal(actionForTool('grep'), 'typing');
  assert.equal(actionForTool('невиданный-тул'), 'typing');
});

test('смена фазы видна сразу, а не на следующем тике', () => {
  const { api, actions } = fakeApi();
  const reply = new TelegramReply(api, 42, { actionGapMs: 0, actionIntervalMs: 3_600_000 });

  reply.setAction('upload_document');

  assert.deepEqual(actions, ['upload_document']);
});

test('действие повторяется, пока ход идёт: Telegram забывает его за пять секунд', async () => {
  const { api, actions } = fakeApi();
  const reply = new TelegramReply(api, 42, { actionGapMs: 0, actionIntervalMs: 5 });

  reply.setAction('typing');
  await sleep(40);

  assert.ok(actions.length >= 3, 'индикатор держится сам, без новых событий хода');
  assert.ok(
    actions.every((action) => action === 'typing'),
    'повторяем то же действие, а не первое попавшееся',
  );
});

test('null выключает индикатор: ход ждёт человека и ничего не делает', async () => {
  const { api, actions } = fakeApi();
  const reply = new TelegramReply(api, 42, { actionGapMs: 0, actionIntervalMs: 5 });

  reply.setAction('typing');
  await sleep(20);
  reply.setAction(null);
  const sent = actions.length;
  await sleep(20);

  assert.equal(actions.length, sent, 'после выключения ничего не уезжает');
});

test('затянувшийся стикер становится честным «печатает»', async () => {
  const { api, actions } = fakeApi();
  let clock = 0;
  const reply = new TelegramReply(api, 42, {
    actionGapMs: 0,
    actionIntervalMs: 5,
    now: () => clock,
  });

  reply.setAction(THINKING_ACTION);
  assert.equal(actions.at(-1), THINKING_ACTION, 'сначала шутка');
  await sleep(20);
  clock = STICKER_LIE_MS + 1;
  await sleep(20);

  assert.equal(actions.at(-1), 'typing', 'шутка не должна залипать на весь ход');
});

test('частая смена фаз не превращается в частокол запросов', () => {
  const { api, actions } = fakeApi();
  const reply = new TelegramReply(api, 42, { actionIntervalMs: 3_600_000 });

  reply.setAction('typing');
  reply.setAction('find_location');
  reply.setAction('upload_document');

  assert.deepEqual(actions, ['typing'], `следующее действие — не раньше чем через ${ACTION_GAP_MS} мс`);
});
