// Visible-answer buffer: hold the unfinished tail, glue the continuation.
// Tested cleanly, without HTTP — the seam mechanics that made the client tear
// the answer mid-word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerBuffer, HOLD_LIMIT, joinChunks, safeCut } from '../src/http/answer.ts';

/** Builds a buffer with an accumulator of the chunks it has emitted. */
function makeBuffer(limit?: number) {
  const out: string[] = [];
  const buffer = new AnswerBuffer((text) => out.push(text), limit);
  return { buffer, out, text: () => out.join('') };
}

test('unfinished tail is not emitted, finished one is emitted at once', () => {
  const { buffer, out, text } = makeBuffer();
  buffer.push('Сейчас гляну');
  assert.deepEqual(out, [], 'хвост без конца фразы должен ждать');

  buffer.push('. Пойду');
  assert.deepEqual(out, ['Сейчас гляну. '], 'законченная фраза уходит, незаконченная остаётся');
  assert.equal(text() + buffer.held, 'Сейчас гляну. Пойду');
});

test('dot in «12.10» and «т.е.» does not count as end of sentence', () => {
  assert.equal(safeCut('Приду 12.10'), 0);
  assert.equal(safeCut('Приду 12 октября. '), 'Приду 12 октября. '.length);
});

test('continuation cut mid-word is glued tight', () => {
  const { buffer, out, text } = makeBuffer();
  buffer.push('Сайт рендерится д');
  // The model's thought and tool activity split the turn — the tail stays in the buffer.
  buffer.breakText();
  buffer.startBlock();
  buffer.push('жаваскриптом, текстом не отдаёт. ');

  assert.equal(text(), 'Сайт рендерится джаваскриптом, текстом не отдаёт. ', 'слово разорвано');
  assert.deepEqual(out, ['Сайт рендерится джаваскриптом, текстом не отдаёт. ']);
});

test('finished sentence before a new message is separated by a blank line', () => {
  assert.equal(joinChunks('Теперь журнал.', '**Шаг 2 — журнал.**'), '\n\n');
  assert.equal(joinChunks('Пробую их API.', 'The API works.'), '\n\n');
});

test('continuation of the same sentence is separated by a space, not a blank line', () => {
  assert.equal(joinChunks('Сейчас посмотрю,', 'что там внутри'), ' ');
  assert.equal(joinChunks('уже с пробелом ', 'и текст'), '');
  assert.equal(joinChunks('', 'первый кусок'), '');
});

test('chunks of one message are glued without a separator', () => {
  const { buffer, text } = makeBuffer();
  buffer.startBlock();
  buffer.push('Привет');
  buffer.push(', Саня');
  buffer.flush();
  assert.equal(text(), 'Привет, Саня');
});

test('a long paragraph is not held longer than the fuse', () => {
  const { buffer, out } = makeBuffer(40);
  const answer = `${'слово '.repeat(20)}конец`;
  buffer.push(answer);
  assert.ok(out.length > 0, 'хвост длиннее предохранителя обязан уходить частями');
  assert.ok(out.join('').length + buffer.held.length === answer.length, 'текст потерялся');
  assert.equal(out.join('') + buffer.held, answer);
});

test('the fuse cuts at a space, not mid-letter', () => {
  const { buffer, out } = makeBuffer(HOLD_LIMIT);
  buffer.push(`${'а'.repeat(HOLD_LIMIT)} ${'б'.repeat(10)}`);
  assert.match(out.join(''), / $/, 'кусок должен кончиться пробелом, а не серединой слова');
  assert.equal(buffer.held, 'б'.repeat(10));
});

test('flush emits everything that was held', () => {
  const { buffer, out } = makeBuffer();
  buffer.push('Хвост без точки');
  assert.deepEqual(out, []);
  buffer.flush();
  assert.deepEqual(out, ['Хвост без точки']);
  assert.equal(buffer.held, '');
});
