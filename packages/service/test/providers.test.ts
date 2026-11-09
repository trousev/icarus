// models.json: провайдера DeepInfra pi сам не знает, и без этого файла модель из
// config.yaml в контейнере просто не найдётся. Проверяем и сам блок провайдера,
// и то, что чужие провайдеры мы не переписываем.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';
import { renderModelsJson } from '../src/providers.ts';
import type { ModelConfig } from '../src/config.ts';
import { MODEL_ID, PROVIDER } from './fixtures.ts';

type ProviderBlock = {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: string;
  };
  models?: Array<{
    id: string;
    input?: string[];
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
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
    { provider: PROVIDER, id: MODEL_ID, thinking: 'low', tier: 'fast' },
    { provider: PROVIDER, id: MODEL_ID, thinking: 'medium', tier: 'strong' },
  ]);

  const deepinfra = providers[PROVIDER];
  assert.equal(deepinfra.baseUrl, 'https://api.deepinfra.com/v1/openai');
  assert.equal(deepinfra.api, 'openai-completions');
  assert.equal(deepinfra.apiKey, '$DEEPINFRA_API_KEY', 'ключ берётся из окружения контейнера');
  assert.equal(
    deepinfra.compat?.thinkingFormat,
    'openai',
    'DeepInfra знает reasoning_effort, а thinking:{type} молча игнорирует',
  );
  assert.equal(deepinfra.compat?.supportsReasoningEffort, true, 'уровни шлём как reasoning_effort');
  assert.equal(deepinfra.compat?.supportsDeveloperRole, false, 'роль developer DeepSeek не принимает');
});

test('уровни thinking размечены под значения reasoning_effort DeepInfra', () => {
  const { providers } = parse([{ provider: PROVIDER, id: MODEL_ID, thinking: 'low', tier: 'fast' }]);
  const model = providers[PROVIDER].models?.[0];

  assert.deepEqual(model?.thinkingLevelMap, {
    off: 'none',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  });
});

test('одна и та же модель на трёх уровнях описывается один раз', () => {
  const { providers } = parse([
    { provider: PROVIDER, id: MODEL_ID, thinking: 'low', tier: 'fast' },
    { provider: PROVIDER, id: MODEL_ID, thinking: 'medium', tier: 'strong' },
    { provider: PROVIDER, id: MODEL_ID, thinking: 'low', tier: 'vision' },
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
  assert.equal(model?.thinkingLevelMap, undefined, 'чужим моделям уровни не приписываем');
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

test('pi шлёт DeepInfra reasoning_effort, а не thinking:{type}', async () => {
  // Страховка от возврата «deepseek»-формата: он посылает thinking:{type}, которого
  // у DeepInfra нет. Запрос перехватываем на onPayload — до сети он не доходит.
  const { providers } = parse([{ provider: PROVIDER, id: MODEL_ID, thinking: 'low', tier: 'fast' }]);
  const model = {
    ...providers[PROVIDER].models?.[0],
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl: 'https://api.deepinfra.com/v1/openai',
  } as unknown as Model<'openai-completions'>;

  const sent: Array<Record<string, unknown>> = [];
  for (const reasoning of ['off', 'low', 'medium'] as const) {
    const stream = streamSimple(
      model,
      { messages: [{ role: 'user', content: 'привет', timestamp: Date.now() }] },
      {
        apiKey: 'test',
        // pi превращает off в отсутствие уровня: проверяем именно этот путь.
        reasoning: reasoning === 'off' ? undefined : reasoning,
        onPayload: (payload) => {
          sent.push(payload as Record<string, unknown>);
          throw new Error('payload intercepted');
        },
      },
    );
    try {
      for await (const event of stream) assert.ok(event, 'до перехвата событий быть не должно');
    } catch {
      // onPayload обрывает запрос до сети — это и нужно.
    }
  }

  assert.equal(sent.length, 3);
  for (const payload of sent) {
    assert.equal('thinking' in payload, false, 'DeepInfra не знает поля thinking:{type}');
  }
  assert.deepEqual(
    sent.map((payload) => payload.reasoning_effort),
    ['none', 'low', 'medium'],
    'off/low/medium уезжают значениями reasoning_effort',
  );
});
