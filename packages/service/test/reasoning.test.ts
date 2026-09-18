// Активность тулов превращается в человеческие фразы для reasoning_content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { phraseForToolEnd, phraseForToolStart } from '../src/reasoning.ts';

test('чтение файла', () => {
  assert.equal(phraseForToolStart('read', { path: '/workspace/memory/identity.md' }), 'читаю memory/identity.md');
});

test('правка файла', () => {
  assert.equal(phraseForToolStart('edit', { path: '/workspace/memory/preferences.md' }), 'правлю memory/preferences.md');
});

test('команда обрезается', () => {
  const phrase = phraseForToolStart('bash', { command: 'x'.repeat(200) });
  assert.ok(phrase && phrase.length < 90, 'фраза должна быть короткой');
  assert.match(phrase, /^выполняю: /);
});

test('неизвестный тул не молчит', () => {
  assert.match(String(phraseForToolStart('mystery', {})), /mystery/);
});

test('итог различает успех и ошибку', () => {
  assert.equal(phraseForToolEnd('write', false), 'записал');
  assert.match(phraseForToolEnd('write', true), /не получилось/);
});
