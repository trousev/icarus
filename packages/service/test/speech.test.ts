// Распознавание речи: что уходит провайдеру и что мы делаем с его ответом.
// Сети тут нет: fetch — заглушка, ключ — выдуманный.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audioName, speechTranscriber, transcribe, transcriptFrom } from '../src/speech.ts';
import type { SpeechConfig } from '../src/config.ts';
import { makeConfig } from './fixtures.ts';

const SPEECH: SpeechConfig = {
  provider: 'deepinfra',
  model: 'openai/whisper-large-v3',
  language: 'ru',
  baseUrl: 'https://api.deepinfra.com/v1/openai',
  apiKey: 'secret-key',
};

/** Провайдер глазами клиента: один ответ на один запрос. */
function fakeFetch(response: { body?: string; status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(response.body ?? JSON.stringify({ text: 'привет' }), { status: response.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

test('голосовое уходит провайдеру как multipart с моделью и языком', async () => {
  const { calls, fetch } = fakeFetch();

  const text = await transcribe(SPEECH, Buffer.from('ogg-байты'), 'audio/ogg', { fetch });

  assert.equal(text, 'привет');
  assert.equal(calls[0]?.url, 'https://api.deepinfra.com/v1/openai/audio/transcriptions');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.deepEqual(calls[0]?.init.headers, { authorization: 'Bearer secret-key' });

  const form = calls[0]?.init.body as FormData;
  assert.ok(form instanceof FormData, 'тело — форма, а не JSON: провайдер ждёт файл');
  assert.equal(form.get('model'), 'openai/whisper-large-v3');
  assert.equal(form.get('language'), 'ru');
  assert.equal(form.get('response_format'), 'json');

  const file = form.get('file') as File;
  assert.equal(file.name, 'voice.ogg', 'по расширению провайдер понимает формат');
  assert.equal(file.type, 'audio/ogg');
  assert.equal(await file.text(), 'ogg-байты');
});

test('язык не задан — не подсказываем: пусть распознаватель решит сам', async () => {
  const { calls, fetch } = fakeFetch();
  const { language: _language, ...withoutLanguage } = SPEECH;

  await transcribe(withoutLanguage, Buffer.from('ogg'), 'audio/ogg', { fetch });

  assert.equal((calls[0]?.init.body as FormData).get('language'), null);
});

test('ошибка провайдера приезжает кодом и телом', async () => {
  const { fetch } = fakeFetch({ status: 401, body: '{"error":"Invalid API key"}' });

  await assert.rejects(
    () => transcribe(SPEECH, Buffer.from('ogg'), 'audio/ogg', { fetch }),
    /код 401.*Invalid API key/,
  );
});

test('таймаут и обрыв сети объясняются человеку по-русски', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const slow = (async () => {
    throw timeout;
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => transcribe(SPEECH, Buffer.from('ogg'), 'audio/ogg', { fetch: slow, timeoutMs: 5000 }),
    /провайдер не ответил за 5 с/,
  );

  const offline = (async () => {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.deepinfra.com') });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => transcribe(SPEECH, Buffer.from('ogg'), 'audio/ogg', { fetch: offline }),
    /до провайдера не дошло: getaddrinfo ENOTFOUND/,
  );
});

test('ответ строкой — тоже расшифровка: провайдер ответил текстом', async () => {
  const { fetch } = fakeFetch({ body: '  просто текст  ' });

  assert.equal(await transcribe(SPEECH, Buffer.from('ogg'), 'audio/ogg', { fetch }), 'просто текст');
});

test('разбор ответа: { text }, строка и пустота', () => {
  assert.equal(transcriptFrom({ text: ' раз ' }), 'раз');
  assert.equal(transcriptFrom(' два '), 'два');
  assert.equal(transcriptFrom({}), '');
  assert.equal(transcriptFrom(null), '');
});

test('распознавание не настроено — расшифровщика нет', () => {
  assert.equal(speechTranscriber(makeConfig()), null, 'нет speech — нечем расшифровывать');
  assert.equal(typeof speechTranscriber(makeConfig({ speech: SPEECH })), 'function');
});

test('имя файла подсказывает формат, а незнакомый mime — OGG', () => {
  assert.equal(audioName('audio/ogg'), 'voice.ogg');
  assert.equal(audioName('audio/OGG'), 'voice.ogg');
  assert.equal(audioName('audio/mpeg'), 'voice.mp3');
  assert.equal(audioName('application/octet-stream'), 'voice.ogg');
});
