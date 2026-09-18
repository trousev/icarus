// Эскалация моделей: правило выбора уровня и разбор конфигурации уровней.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTier, parseTierSpec, LONG_PROMPT } from '../../extensions/escalation.ts';

test('спецификация уровня разбирается из строки окружения', () => {
  assert.deepEqual(parseTierSpec('deepseek/deepseek-v4-pro:medium', { provider: 'x', id: 'y', thinking: 'off' }), {
    provider: 'deepseek',
    id: 'deepseek-v4-pro',
    thinking: 'medium',
  });
  assert.deepEqual(parseTierSpec('deepseek/deepseek-v4-flash', { provider: 'x', id: 'y', thinking: 'off' }), {
    provider: 'deepseek',
    id: 'deepseek-v4-flash',
    thinking: 'off',
  });
  assert.deepEqual(parseTierSpec('мусор', { provider: 'deepseek', id: 'fallback', thinking: 'off' }), {
    provider: 'deepseek',
    id: 'fallback',
    thinking: 'off',
  });
  assert.equal(parseTierSpec(undefined, { provider: 'd', id: 'f', thinking: 'off' }).id, 'f');
});

test('болтовня остаётся на быстрой модели', () => {
  assert.equal(chooseTier({ hasImages: false, prompt: 'привет, как дела?', toolsUsed: false }), 'fast');
  assert.equal(chooseTier({ hasImages: false, prompt: 'расскажи анекдот', toolsUsed: false }), 'fast');
});

test('картинка уводит на модель со зрением', () => {
  assert.equal(chooseTier({ hasImages: true, prompt: 'что тут?', toolsUsed: false }), 'vision');
  assert.equal(chooseTier({ hasImages: true, prompt: 'привет', toolsUsed: true }), 'vision', 'картинка важнее тулов');
});

test('работа уводит на сильную модель', () => {
  assert.equal(chooseTier({ hasImages: false, prompt: 'напиши код парсера', toolsUsed: false }), 'strong');
  assert.equal(chooseTier({ hasImages: false, prompt: 'исправь тесты', toolsUsed: false }), 'strong');
  assert.equal(chooseTier({ hasImages: false, prompt: 'коротко', toolsUsed: true }), 'strong', 'тул уже полез в дело');
});

test('длинная реплика считается сложной', () => {
  const long = 'а'.repeat(LONG_PROMPT + 1);
  assert.equal(chooseTier({ hasImages: false, prompt: long, toolsUsed: false }), 'strong');
  assert.equal(chooseTier({ hasImages: false, prompt: 'а'.repeat(50), toolsUsed: false }), 'fast');
});
