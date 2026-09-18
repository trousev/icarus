// Контракт формы ответа OpenAI: то, на что рассчитывает LibreChat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, completion, completionId, DONE, errorBody, usageChunk } from '../src/http/sse.ts';

function parse(sse: string) {
  return JSON.parse(sse.replace(/^data: /, '').trim());
}

test('идентификатор похож на OpenAI', () => {
  assert.match(completionId(), /^chatcmpl-[a-z0-9]+$/);
});

test('чанк контента имеет форму chat.completion.chunk', () => {
  const parsed = parse(chunk('chatcmpl-1', 'icarus', { content: 'привет' }));
  assert.equal(parsed.object, 'chat.completion.chunk');
  assert.equal(parsed.model, 'icarus');
  assert.equal(parsed.choices[0].index, 0);
  assert.equal(parsed.choices[0].delta.content, 'привет');
  assert.equal(parsed.choices[0].finish_reason, null);
});

test('чанк размышлений уходит в reasoning_content', () => {
  const parsed = parse(chunk('chatcmpl-1', 'icarus', { reasoning_content: 'читаю memory/identity.md\n' }));
  assert.equal(parsed.choices[0].delta.reasoning_content, 'читаю memory/identity.md\n');
});

test('финальный чанк несёт finish_reason', () => {
  const parsed = parse(chunk('chatcmpl-1', 'icarus', {}, 'stop'));
  assert.equal(parsed.choices[0].finish_reason, 'stop');
});

test('чанк с usage не содержит choices (как у OpenAI при include_usage)', () => {
  const parsed = parse(usageChunk('chatcmpl-1', 'icarus', { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }));
  assert.deepEqual(parsed.choices, []);
  assert.equal(parsed.usage.total_tokens, 12);
});

test('поток заканчивается маркером [DONE]', () => {
  assert.equal(DONE, 'data: [DONE]\n\n');
});

test('обычный ответ имеет форму chat.completion', () => {
  const parsed = completion('chatcmpl-1', 'icarus', 'ответ', {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  }) as Record<string, any>;
  assert.equal(parsed.object, 'chat.completion');
  assert.equal(parsed.choices[0].message.role, 'assistant');
  assert.equal(parsed.choices[0].message.content, 'ответ');
  assert.equal(parsed.choices[0].finish_reason, 'stop');
});

test('ошибка отдаётся в форме OpenAI', () => {
  const parsed = errorBody('нет токена', 'authentication_error') as Record<string, any>;
  assert.equal(parsed.error.type, 'authentication_error');
  assert.equal(parsed.error.message, 'нет токена');
});
