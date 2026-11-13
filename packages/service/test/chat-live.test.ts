// A live turn survives the viewer leaving: event accumulation, catch-up and close.
//
// We check exactly the case the hub was created for: the panel was closed
// in the middle of an answer (F5), the turn kept going, and the returned panel
// caught up with it entirely — with reasoning and steps, not just the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  broadcast,
  emit,
  finishTurn,
  liveTurn,
  startTurn,
  subscribe,
  watchAll,
  type BulletinEvent,
  type LiveEvent,
} from '../src/control/chat-live.ts';

test('events accumulate even when there is no viewer', () => {
  const turn = startTurn('probe', 'web-1');
  emit(turn, { type: 'text', text: 'И' });
  emit(turn, { type: 'text', text: 'кар' });
  emit(turn, { type: 'step', step: { id: 't1' } });

  assert.equal(turn.events.length, 3);
  assert.equal(liveTurn('probe', 'web-1'), turn);
  // Someone else's conversation is someone else's turn: the key must not leak between people.
  assert.equal(liveTurn('probe', 'web-2'), undefined);
  assert.equal(liveTurn('vita', 'web-1'), undefined);
});

test('a returning viewer gets everything accumulated and then the live stream', () => {
  const turn = startTurn('probe', 'web-1');
  const ушёл: LiveEvent[] = [];
  const отписка = subscribe(turn, (event) => ушёл.push(event));

  // The turn is in progress: viewer #1 sees the first message…
  emit(turn, { type: 'text', text: 'раз' });
  assert.deepEqual(ушёл, [{ type: 'text', text: 'раз' }]);

  // …then presses F5: we unsubscribe, as a closed HTTP response does.
  отписка();
  emit(turn, { type: 'text', text: 'два' });
  emit(turn, { type: 'text', text: 'три' });

  // The panel reopened and attaches to the stream: first catch-up, then live.
  const догнал: LiveEvent[] = [];
  const отписка2 = subscribe(turn, (event) => догнал.push(event));

  assert.deepEqual(
    догнал,
    [
      { type: 'text', text: 'раз' },
      { type: 'text', text: 'два' },
      { type: 'text', text: 'три' },
    ],
    'догон отдаёт весь ход с начала, а не только хвост',
  );

  emit(turn, { type: 'text', text: 'четыре' });
  assert.equal(догнал.length, 4, 'после догона поток продолжает идти');

  finishTurn(turn);
  assert.equal(turn.done, true);
  отписка2();
});

test('a finished turn without viewers does not hang in memory forever', async () => {
  const turn = startTurn('probe', 'web-1');
  emit(turn, { type: 'done' });
  finishTurn(turn);
  // The turn is finished, there are no viewers, but a minute has not passed yet — we keep it for catch-up.
  assert.equal(liveTurn('probe', 'web-1'), turn);
});

test('someone else\'s subscriber failure does not break the turn for the others', () => {
  const turn = startTurn('probe', 'web-1');
  const дошло: LiveEvent[] = [];
  subscribe(turn, () => {
    throw new Error('зритель сломался');
  });
  subscribe(turn, (event) => дошло.push(event));

  emit(turn, { type: 'text', text: 'жив' });
  assert.deepEqual(дошло, [{ type: 'text', text: 'жив' }]);
});

test('the bulletin reports turns across all conversations at once', () => {
  const слышал: BulletinEvent[] = [];
  const отписка = watchAll((event) => слышал.push(event));

  // Two conversations in progress at the same time — this is what the bulletin was made for.
  broadcast({ userId: 'probe', chatId: 'web-1', type: 'busy' });
  broadcast({ userId: 'probe', chatId: 'web-2', type: 'busy' });
  broadcast({ userId: 'probe', chatId: 'web-1', type: 'idle', chat: { id: 'web-1' } });

  assert.deepEqual(
    слышал,
    [
      { userId: 'probe', chatId: 'web-1', type: 'busy' },
      { userId: 'probe', chatId: 'web-2', type: 'busy' },
      { userId: 'probe', chatId: 'web-1', type: 'idle', chat: { id: 'web-1' } },
    ],
    'сводка идёт по всем разговорам, старт и финал — вперемешку',
  );

  отписка();
  broadcast({ userId: 'probe', chatId: 'web-3', type: 'busy' });
  assert.equal(слышал.length, 3, 'отписанный больше ничего не слышит');
});

test('a failed bulletin listener does not silence the others', () => {
  const дошло: BulletinEvent[] = [];
  const убрать = watchAll(() => {
    throw new Error('слушатель сломался');
  });
  const отписка = watchAll((event) => дошло.push(event));

  broadcast({ userId: 'probe', chatId: 'web-1', type: 'busy' });
  assert.equal(дошло.length, 1, 'живой слушатель получил событие');
  убрать();
  отписка();
});
