// Custom pi providers: the ones not in pi's built-in catalog.
//
// pi only knows its own model catalog. DeepInfra isn't in it — it's a regular
// OpenAI-compatible host, so the provider is described explicitly in ~/.pi/agent/models.json.
// The file is assembled from config.yaml during workspace setup (see workspace.ts).
//
// Why the description lives here and not in config.yaml: the human edits config.yaml by hand,
// and it holds only the choice — provider, model id, reasoning level, tier.
// The base URL, protocol, signing method and model metadata are a property of the provider,
// not of the choice, and their place is next to the other provider knowledge (PROVIDER_ENV
// in config.ts). Otherwise every human in their own copy of the config would also keep the API address.
import { DEEPINFRA_BASE_URL, type ModelConfig } from './config.ts';

/** What pi needs to know about the model that isn't in config.yaml. */
type ModelMeta = {
  /** Human-readable name for the model list; empty means the id is used instead. */
  name: string;
  /**
   * Images the model accepts. pi uses this field to decide whether an image can be
   * given to it — the vision level in escalation depends on it.
   */
  input: Array<'text' | 'image'>;
  /** Whether the model supports reasoning: without this, thinking from config.yaml does nothing. */
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Prices per million tokens — only for showing costs in pi, they don't affect requests. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/**
 * DeepInfra models that we choose in config.yaml. The values come from their model pages
 * (context_length and pricing from /v1/openai/models?filter=with_meta). The list doesn't have to
 * be a complete catalog: an unfamiliar model gets the cautious defaults below.
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
 * Defaults for a model not in the catalog above: text, without reasoning.
 * Caution matters more than completeness — extra reasoning parameters for someone else's model are uncalled for.
 */
const DEEPINFRA_DEFAULTS: ModelMeta = {
  name: '',
  input: ['text'],
  reasoning: false,
  contextWindow: 131072,
  maxTokens: 16384,
};

/**
 * pi levels → DeepInfra reasoning_effort values. pi has its own set of levels, the host
 * has its own; `off` is not the absence of the field, but an explicit "none": otherwise
 * DeepInfra would apply the model default and reasoning could stay enabled.
 */
const DEEPINFRA_THINKING_LEVELS = {
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const;

/** Description of a single DeepInfra model in models.json format. */
function deepInfraModel(id: string): Record<string, unknown> {
  const meta: ModelMeta = { ...DEEPINFRA_DEFAULTS, ...(DEEPINFRA_CATALOG[id] ?? {}) };
  return {
    id,
    name: meta.name === '' ? id : meta.name,
    reasoning: meta.reasoning,
    input: meta.input,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    ...(meta.reasoning ? { thinkingLevelMap: DEEPINFRA_THINKING_LEVELS } : {}),
    ...(meta.cost ? { cost: meta.cost } : {}),
  };
}

/**
 * Providers that pi doesn't know by itself. The key is the provider name in config.yaml,
 * the value assembles the `providers.<name>` block for models.json.
 */
const CUSTOM_PROVIDERS: Record<string, (models: ModelConfig[]) => Record<string, unknown>> = {
  deepinfra: (models) => ({
    name: 'DeepInfra',
    baseUrl: DEEPINFRA_BASE_URL,
    api: 'openai-completions',
    // The key is substituted from the container environment: .env is shipped there whole (env_file).
    apiKey: '$DEEPINFRA_API_KEY',
    compat: {
      // DeepSeek on DeepInfra doesn't accept the developer role — the system prompt goes as system.
      supportsDeveloperRole: false,
      // DeepInfra knows reasoning_effort, but not the thinking:{type} field from the DeepSeek API:
      // the latter is silently ignored. The openai format sends exactly reasoning_effort —
      // including reasoning_effort: "none" when reasoning is disabled.
      thinkingFormat: 'openai',
      supportsReasoningEffort: true,
    },
    models: [...new Set(models.map((model) => model.id))].map((id) => deepInfraModel(id)),
  }),
};

/**
 * Assembles models.json for pi. Only custom providers from config.yaml make it into the file:
 * pi knows the built-in ones (anthropic, google, ...) from its own catalog,
 * and re-describing them here would mean fixing what isn't broken.
 *
 * @param models - models from config.yaml.
 * @returns contents of ~/.pi/agent/models.json.
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
