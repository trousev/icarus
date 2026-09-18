// Сверка истории: якорь — реплики пользователя, дробление ответа ассистента не считается расхождением.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHistory, normalizeContent, toTurns } from '../src/sessions/divergence.ts';

test('новая сессия не считается расхождением', () => {
  const result = compareHistory([{ role: 'user', content: 'привет' }], []);
  assert.equal(result.diverged, false);
  assert.equal(result.newUserText, 'привет');
});

test('продолжение разговора совпадает', () => {
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

test('дробление ответа ассистента тулами — не расхождение', () => {
  // pi: текст, потом тулы, потом ещё текст — три отдельных сообщения ассистента
  const session = [
    { role: 'user', content: 'что я люблю пить?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Сейчас посмотрю.' }] },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Кофе без сахара.' }] },
  ];
  // LibreChat склеил всё в одно сообщение
  const incoming = [
    { role: 'user', content: 'что я люблю пить?' },
    { role: 'assistant', content: 'Сейчас посмотрю.Кофе без сахара.' },
    { role: 'user', content: 'а ещё?' },
  ];
  const result = compareHistory(incoming, session);
  assert.equal(result.diverged, false, 'не должно быть ложного расхождения');
});

test('правка реплики пользователя ловится', () => {
  const session = [{ role: 'user', content: 'привет' }];
  const incoming = [{ role: 'user', content: 'привет, совсем другой текст' }];
  const result = compareHistory(incoming, session);
  assert.equal(result.diverged, true);
  assert.match(result.reason, /расхождение/);
  assert.match(result.diff, /в сессии/);
});

test('регенерация ответа не ломает согласованность', () => {
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

test('нормализация контента понимает строки, блоки OpenAI и блоки pi', () => {
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

test('служебные роли не попадают в реплики', () => {
  const turns = toTurns([
    { role: 'system', content: 'ты ассистент' },
    { role: 'user', content: 'привет' },
    { role: 'tool', content: 'результат' },
  ]);
  assert.deepEqual(turns, [{ role: 'user', text: 'привет' }]);
});
