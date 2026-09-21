// Кастомные провайдеры pi: то, чего нет во встроенном каталоге pi.
//
// pi знает только свой каталог моделей. DeepInfra в него не входит — это обычный
// OpenAI-совместимый хост, поэтому провайдер описывается явно в ~/.pi/agent/models.json.
// Файл собирается из config.yaml при подготовке человека (см. workspace.ts).
//
// Почему описание живёт здесь, а не в config.yaml: config.yaml человек правит руками,
// и в нём лежит только выбор — провайдер, id модели, уровень размышлений, tier.
// Базовый адрес, протокол, способ подписи и метаданные модели — свойство провайдера,
// а не выбора, и его место рядом с остальными знаниями о провайдерах (PROVIDER_ENV
// в config.ts). Иначе каждый человек в своей копии конфига держал бы ещё и адрес API.
import type { ModelConfig } from './config.ts';

/** Что pi должен знать о модели, чего нет в config.yaml. */
type ModelMeta = {
  /** Человеческое имя для списка моделей; пусто — подставится id. */
  name: string;
  /**
   * Картинки, которые модель принимает. По этому полю pi решает, можно ли отдать
   * ей изображение, — от него зависит уровень vision в эскалации.
   */
  input: Array<'text' | 'image'>;
  /** Умеет ли модель размышления: без этого thinking из config.yaml ни на что не влияет. */
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Цены за миллион токенов — только для показа расходов в pi, на запросы не влияют. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/**
 * Модели DeepInfra, которые мы выбираем в config.yaml. Значения — с их страниц моделей
 * (context_length и pricing из /v1/openai/models?filter=with_meta). Список не обязан
 * быть полным каталогом: незнакомая модель получит осторожные умолчания ниже.
 */
const DEEPINFRA_CATALOG: Record<string, Partial<ModelMeta>> = {
  'deepseek-ai/DeepSeek-V4.1-Flash': {
    name: 'DeepSeek V4.1 Flash',
    input: ['text', 'image'],
    reasoning: true,
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.2, output: 0.6, cacheRead: 0.006, cacheWrite: 0.2 },
  },
  'deepseek-ai/DeepSeek-V4-Flash-0731': {
    name: 'DeepSeek V4 Flash 0731',
    reasoning: true,
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.09, output: 0.18, cacheRead: 0.018, cacheWrite: 0.09 },
  },
  'deepseek-ai/DeepSeek-V4-Pro-0813': {
    name: 'DeepSeek V4 Pro 0813',
    reasoning: true,
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 1.3, output: 2.6, cacheRead: 0.1, cacheWrite: 1.3 },
  },
  'zai-org/GLM-5.2': {
    name: 'GLM-5.2',
    reasoning: true,
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.75, output: 2.4, cacheRead: 0.14, cacheWrite: 0.75 },
  },
};

/**
 * Умолчания для модели, которой нет в каталоге выше: тексты, без размышлений.
 * Осторожность важнее полноты — лишние параметры размышлений чужой модели ни к чему.
 */
const DEEPINFRA_DEFAULTS: ModelMeta = {
  name: '',
  input: ['text'],
  reasoning: false,
  contextWindow: 131072,
  maxTokens: 16384,
};

/** Описание одной модели DeepInfra в формате models.json. */
function deepInfraModel(id: string): Record<string, unknown> {
  const meta: ModelMeta = { ...DEEPINFRA_DEFAULTS, ...(DEEPINFRA_CATALOG[id] ?? {}) };
  return {
    id,
    name: meta.name === '' ? id : meta.name,
    reasoning: meta.reasoning,
    input: meta.input,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    ...(meta.cost ? { cost: meta.cost } : {}),
  };
}

/**
 * Провайдеры, которых pi не знает сам. Ключ — имя провайдера в config.yaml,
 * значение — сборка блока `providers.<имя>` для models.json.
 */
const CUSTOM_PROVIDERS: Record<string, (models: ModelConfig[]) => Record<string, unknown>> = {
  deepinfra: (models) => ({
    name: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    api: 'openai-completions',
    // Ключ подставляется из окружения контейнера: .env уезжает туда целиком (env_file).
    apiKey: '$DEEPINFRA_API_KEY',
    compat: {
      // DeepSeek на DeepInfra не принимает роль developer — системный промпт идёт как system.
      supportsDeveloperRole: false,
      // Размышления приезжают в reasoning_content, а запрос несёт thinking/reasoning_effort.
      thinkingFormat: 'deepseek',
    },
    models: [...new Set(models.map((model) => model.id))].map((id) => deepInfraModel(id)),
  }),
};

/**
 * Собирает models.json для pi. В файл попадают только кастомные провайдеры из
 * config.yaml: встроенные (anthropic, google, ...) pi знает по своему каталогу,
 * и переописывать их здесь значило бы чинить то, что не сломано.
 *
 * @param models - модели из config.yaml.
 * @returns содержимое ~/.pi/agent/models.json.
 */
export function renderModelsJson(models: ModelConfig[]): string {
  const providers: Record<string, unknown> = {};
  for (const provider of new Set(models.map((model) => model.provider))) {
    const build = CUSTOM_PROVIDERS[provider];
    if (!build) continue;
    providers[provider] = build(models.filter((model) => model.provider === provider));
  }
  return JSON.stringify({ providers }, null, 2) + '\n';
}
