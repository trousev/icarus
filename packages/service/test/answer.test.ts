// Буфер видимого ответа: незаконченный хвост держим, продолжение склеиваем.
// Проверяем чисто, без HTTP — механику стыков, из-за которых LibreChat рвал
// ответ посреди слова.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerBuffer, HOLD_LIMIT, joinChunks, safeCut } from '../src/http/answer.ts';

/** Собирает буфер с накопителем кусков, которые он отдал. */
function makeBuffer(limit?: number) {
  const out: string[] = [];
  const buffer = new AnswerBuffer((text) => out.push(text), limit);
  return { buffer, out, text: () => out.join('') };
}

test('незаконченный хвост не отдаём, законченный — отдаём сразу', () => {
  const { buffer, out, text } = makeBuffer();
  buffer.push('Сейчас гляну');
  assert.deepEqual(out, [], 'хвост без конца фразы должен ждать');

  buffer.push('. Пойду');
  assert.deepEqual(out, ['Сейчас гляну. '], 'законченная фраза уходит, незаконченная остаётся');
  assert.equal(text() + buffer.held, 'Сейчас гляну. Пойду');
});

test('точка в «12.10» и «т.е.» не считается концом фразы', () => {
  assert.equal(safeCut('Приду 12.10'), 0);
  assert.equal(safeCut('Приду 12 октября. '), 'Приду 12 октября. '.length);
});

test('оборванное посреди слова продолжение приклеивается вплотную', () => {
  const { buffer, out, text } = makeBuffer();
  buffer.push('Сайт рендерится д');
  // Мысль модели и активность тула разрезали ход — хвост остаётся в буфере.
  buffer.breakText();
  buffer.startBlock();
  buffer.push('жаваскриптом, текстом не отдаёт. ');

  assert.equal(text(), 'Сайт рендерится джаваскриптом, текстом не отдаёт. ', 'слово разорвано');
  assert.deepEqual(out, ['Сайт рендерится джаваскриптом, текстом не отдаёт. ']);
});

test('законченная фраза перед новым сообщением отделяется пустой строкой', () => {
  assert.equal(joinChunks('Теперь журнал.', '**Шаг 2 — журнал.**'), '\n\n');
  assert.equal(joinChunks('Пробую их API.', 'The API works.'), '\n\n');
});

test('продолжение той же фразы отделяется пробелом, а не пустой строкой', () => {
  assert.equal(joinChunks('Сейчас посмотрю,', 'что там внутри'), ' ');
  assert.equal(joinChunks('уже с пробелом ', 'и текст'), '');
  assert.equal(joinChunks('', 'первый кусок'), '');
});

test('куски одного сообщения склеиваются без разделителя', () => {
  const { buffer, text } = makeBuffer();
  buffer.startBlock();
  buffer.push('Привет');
  buffer.push(', Саня');
  buffer.flush();
  assert.equal(text(), 'Привет, Саня');
});

test('длинный абзац не держим дольше предохранителя', () => {
  const { buffer, out } = makeBuffer(40);
  const answer = `${'слово '.repeat(20)}конец`;
  buffer.push(answer);
  assert.ok(out.length > 0, 'хвост длиннее предохранителя обязан уходить частями');
  assert.ok(out.join('').length + buffer.held.length === answer.length, 'текст потерялся');
  assert.equal(out.join('') + buffer.held, answer);
});

test('предохранитель режет по пробелу, а не по букве', () => {
  const { buffer, out } = makeBuffer(HOLD_LIMIT);
  buffer.push(`${'а'.repeat(HOLD_LIMIT)} ${'б'.repeat(10)}`);
  assert.match(out.join(''), / $/, 'кусок должен кончиться пробелом, а не серединой слова');
  assert.equal(buffer.held, 'б'.repeat(10));
});

test('flush отдаёт всё, что придержали', () => {
  const { buffer, out } = makeBuffer();
  buffer.push('Хвост без точки');
  assert.deepEqual(out, []);
  buffer.flush();
  assert.deepEqual(out, ['Хвост без точки']);
  assert.equal(buffer.held, '');
});
