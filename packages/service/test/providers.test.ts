// models.json: провайдера DeepInfra pi сам не знает, и без этого файла модель из
// config.yaml в контейнере просто не найдётся. Проверяем и сам блок провайдера,
// и то, что чужие провайдеры мы не переписываем.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModelsJson } from '../src/providers.ts';
import type { ModelConfig } from '../src/config.ts';
import { MODEL_ID, PROVIDER } from './fixtures.ts';

type ProviderBlock = {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  compat?: { supportsDeveloperRole?: boolean; thinkingFormat?: string };
  models?: Array<{
    id: string;
    input?: string[];
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
};

function parse(models: ModelConfig[]): { providers: Record<string, ProviderBlock> } {
  return JSON.parse(renderModelsJson(models));
}

test('DeepInfra уезжает в models.json целиком: адрес, протокол, ключ и модели', () => {
  const { providers } = parse([
    { provider: PROVIDER, id: MODEL_ID, thinking: 'off', tier: 'fast' },
    { provider: PROVIDER, id: MODEL_ID, thinking: 'medium', tier: 'strong' },
  ]);

  const deepinfra = providers[PROVIDER];
  assert.equal(deepinfra.baseUrl, 'https://api.deepinfra.com/v1/openai');
  assert.equal(deepinfra.api, 'openai-completions');
  assert.equal(deepinfra.apiKey, '$DEEPINFRA_API_KEY', 'ключ берётся из окружения контейнера');
  assert.equal(deepinfra.compat?.thinkingFormat, 'deepseek', 'мысли приезжают в reasoning_content');
  assert.equal(deepinfra.compat?.supportsDeveloperRole, false, 'роль developer DeepSeek не принимает');
});

test('одна и та же модель на трёх уровнях описывается один раз', () => {
  const { providers } = parse([
    { provider: PROVIDER, id: MODEL_ID, thinking: 'off', tier: 'fast' },
    { provider: PROVIDER, id: MODEL_ID, thinking: 'medium', tier: 'strong' },
    { provider: PROVIDER, id: MODEL_ID, thinking: 'off', tier: 'vision' },
  ]);

  assert.deepEqual(
    providers[PROVIDER].models?.map((model) => model.id),
    [MODEL_ID],
  );
});

test('V4.1-Flash объявлена зрячей и думающей: иначе vision и thinking не заработают', () => {
  const { providers } = parse([{ provider: PROVIDER, id: MODEL_ID, thinking: 'medium', tier: 'strong' }]);
  const model = providers[PROVIDER].models?.[0];

  assert.deepEqual(model?.input, ['text', 'image']);
  assert.equal(model?.reasoning, true);
  assert.ok((model?.contextWindow ?? 0) >= 100_000);
});

test('незнакомая модель DeepInfra получает осторожные умолчания, а не выдуманные цены', () => {
  const { providers } = parse([{ provider: PROVIDER, id: 'кто-то/Чужак-7B', tier: 'fast' }]);
  const model = providers[PROVIDER].models?.[0];

  assert.deepEqual(model?.input, ['text'], 'картинки обещаем только там, где их проверили');
  assert.equal(model?.reasoning, false);
  assert.equal(model?.cost, undefined);
});

test('встроенные провайдеры pi не переописываем', () => {
  const { providers } = parse([
    { provider: 'google', id: 'gemini-flash', tier: 'fast' },
    { provider: PROVIDER, id: MODEL_ID, tier: 'fast' },
  ]);

  assert.deepEqual(Object.keys(providers), [PROVIDER], 'google pi знает сам');
});

test('без кастомных провайдеров файл остаётся валидным и пустым', () => {
  assert.deepEqual(parse([{ provider: 'google', id: 'gemini-flash' }]), { providers: {} });
});
