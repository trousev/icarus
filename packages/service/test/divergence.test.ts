// History comparison: the anchor is user messages; splitting of the assistant's answer is not considered a divergence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHistory, normalizeContent, toTurns } from '../src/sessions/divergence.ts';

test('a new session is not considered a divergence', () => {
  const result = compareHistory([{ role: 'user', content: 'привет' }], []);
  assert.equal(result.diverged, false);
  assert.equal(result.newUserText, 'привет');
});

test('a continuation of the conversation matches', () => {
  const incoming = [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'здорово' },
    { role: 'user', content: 'как дела' },
  ];
  const session = [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'здорово' },
  ];
  const result = compareHistory(incoming, session);
  assert.equal(result.diverged, false);
  assert.equal(result.newUserText, 'как дела');
});

test('splitting the assistant answer by tools is not a divergence', () => {
  // pi: text, then tools, then more text — three separate assistant messages
  const session = [
    { role: 'user', content: 'что я люблю пить?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Сейчас посмотрю.' }] },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Кофе без сахара.' }] },
  ];
  // The client merged everything into one message
  const incoming = [
    { role: 'user', content: 'что я люблю пить?' },
    { role: 'assistant', content: 'Сейчас посмотрю.Кофе без сахара.' },
    { role: 'user', content: 'а ещё?' },
  ];
  const result = compareHistory(incoming, session);
  assert.equal(result.diverged, false, 'не должно быть ложного расхождения');
});

test('an edit of a user message is caught', () => {
  const session = [{ role: 'user', content: 'привет' }];
  const incoming = [{ role: 'user', content: 'привет, совсем другой текст' }];
  const result = compareHistory(incoming, session);
  assert.equal(result.diverged, true);
  assert.match(result.reason, /расхождение/);
  assert.match(result.diff, /в сессии/);
});

test('regeneration of the answer does not break consistency', () => {
  const session = [
    { role: 'user', content: 'вопрос' },
    { role: 'assistant', content: 'первый вариант' },
  ];
  const incoming = [
    { role: 'user', content: 'вопрос' },
    { role: 'assistant', content: 'второй вариант после регенерации' },
    { role: 'user', content: 'продолжай' },
  ];
  assert.equal(compareHistory(incoming, session).diverged, false);
});

test('content normalization understands strings, OpenAI blocks and pi blocks', () => {
  assert.equal(normalizeContent('просто строка'), 'просто строка');
  assert.equal(
    normalizeContent([
      { type: 'text', text: 'раз' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: 'два' },
    ]),
    'раз\nдва',
  );
  assert.equal(normalizeContent([{ type: 'thinking', thinking: 'мысли' }]), '');
});

test('service roles do not get into messages', () => {
  const turns = toTurns([
    { role: 'system', content: 'ты ассистент' },
    { role: 'user', content: 'привет' },
    { role: 'tool', content: 'результат' },
  ]);
  assert.deepEqual(turns, [{ role: 'user', text: 'привет' }]);
});
