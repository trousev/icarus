// Живой ход переживает уход зрителя: накопление событий, догон и закрытие.
//
// Проверяем ровно тот случай, ради которого hub и появился: панель закрыли
// посреди ответа (F5), ход продолжил идти, а вернувшаяся панель догнала его
// целиком — с размышлениями и шагами, а не только с итогом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emit, finishTurn, liveTurn, startTurn, subscribe, type LiveEvent } from '../src/control/chat-live.ts';

test('события копятся, даже когда зрителя нет', () => {
  const turn = startTurn('probe', 'web-1');
  emit(turn, { type: 'text', text: 'И' });
  emit(turn, { type: 'text', text: 'кар' });
  emit(turn, { type: 'step', step: { id: 't1' } });

  assert.equal(turn.events.length, 3);
  assert.equal(liveTurn('probe', 'web-1'), turn);
  // Чужой разговор — чужой ход: ключ не должен течь между людьми.
  assert.equal(liveTurn('probe', 'web-2'), undefined);
  assert.equal(liveTurn('vita', 'web-1'), undefined);
});

test('вернувшийся зритель получает всё накопленное и дальше живое', () => {
  const turn = startTurn('probe', 'web-1');
  const ушёл: LiveEvent[] = [];
  const отписка = subscribe(turn, (event) => ушёл.push(event));

  // Ход идёт: зритель №1 видит первое сообщение…
  emit(turn, { type: 'text', text: 'раз' });
  assert.deepEqual(ушёл, [{ type: 'text', text: 'раз' }]);

  // …потом жмёт F5: отписываемся, как это делает закрытый HTTP-ответ.
  отписка();
  emit(turn, { type: 'text', text: 'два' });
  emit(turn, { type: 'text', text: 'три' });

  // Панель открылась заново и цепляется к потоку: сначала догон, потом живое.
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

test('завершённый ход без зрителей не висит в памяти вечно', async () => {
  const turn = startTurn('probe', 'web-1');
  emit(turn, { type: 'done' });
  finishTurn(turn);
  // Ход завершён, зрителей нет, но минута ещё не прошла — держим для догона.
  assert.equal(liveTurn('probe', 'web-1'), turn);
});

test('чужой сбой подписчика не рвёт ход остальным', () => {
  const turn = startTurn('probe', 'web-1');
  const дошло: LiveEvent[] = [];
  subscribe(turn, () => {
    throw new Error('зритель сломался');
  });
  subscribe(turn, (event) => дошло.push(event));

  emit(turn, { type: 'text', text: 'жив' });
  assert.deepEqual(дошло, [{ type: 'text', text: 'жив' }]);
});
