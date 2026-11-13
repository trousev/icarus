// Model escalation: chit-chat runs on the fast model, work on the strong one,
// images on the vision model. The tiers come from the container environment,
// which the service assembles from the person's config.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Tier = "fast" | "strong" | "vision";
export type TierSpec = { provider: string; id: string; thinking: string };

/** Parses "provider/model:thinking" into a model spec. */
export function parseTierSpec(value: string | undefined, fallback: TierSpec): TierSpec {
  if (!value) return fallback;
  const [path, thinking] = value.split(":");
  const [provider, ...rest] = (path ?? "").split("/");
  const id = rest.join("/");
  if (!provider || !id) return fallback;
  // Without an explicit level we don't turn off reasoning: on off the model loses the reasoning
  // channel and writes tool calls as markup in the visible answer.
  return { provider, id, thinking: thinking ?? "low" };
}

export const TIERS: Record<Tier, TierSpec> = {
  fast: parseTierSpec(process.env.ICARUS_MODEL_FAST, {
    provider: "deepinfra",
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    thinking: "low",
  }),
  strong: parseTierSpec(process.env.ICARUS_MODEL_STRONG, {
    provider: "deepinfra",
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    thinking: "medium",
  }),
  vision: parseTierSpec(process.env.ICARUS_MODEL_VISION, {
    provider: "deepinfra",
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    thinking: "low",
  }),
};

/** Signs that the person is asking for work, not chit-chat. */
const HEAVY_PATTERNS = [
  /напиши\s+(код|скрипт|функцию|программу)/i,
  /отрефактор/i,
  /проанализируй/i,
  /разберись/i,
  /исправь/i,
  /почини/i,
  /сравни/i,
  /составь\s+(план|список|таблицу)/i,
  /почему\s+не/i,
  /\bdebug\b/i,
  /\bрефактор/i,
  /посчитай/i,
  /переведи\s+текст/i,
];

export const LONG_PROMPT = 400;

/**
 * Reconnaissance tools: search and reading. By themselves they're no reason to call the
 * strong model — the fast one will manage without reasoning, and the person won't wait.
 * Everything else (bash, file edits, MCP, unfamiliar tools) is already hands, that's strong.
 */
export const SEARCH_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "read",
  "grep",
  "find",
  "ls",
  // "what time is it" is a glance, not work: no point running the strong model on it
  "now",
]);

/** How many searches in a row we tolerate on the fast model before counting it as work. */
export const SEARCH_BUDGET = 3;

export function isSearchTool(name: string): boolean {
  return SEARCH_TOOLS.has(name);
}

export type TierInput = {
  hasImages: boolean;
  prompt: string;
  /** how many reconnaissance tools have already run in this turn */
  searches?: number;
  /** whether a tool that changes something came up: bash, write, edit, MCP */
  heavyTool?: boolean;
};

export function chooseTier(input: TierInput): Tier {
  if (input.hasImages) return "vision";
  if (input.heavyTool) return "strong";
  if ((input.searches ?? 0) > SEARCH_BUDGET) return "strong";
  if (input.prompt.length > LONG_PROMPT) return "strong";
  if (HEAVY_PATTERNS.some((pattern) => pattern.test(input.prompt))) return "strong";
  return "fast";
}

/**
 * Allows exactly the thinking level the config chose.
 *
 * pi raises an unsupported level to the nearest available one: if the model catalog
 * has null for `medium`, `thinking: medium` from the config would silently turn into
 * `high`. We give the model exactly the level the person chose instead of guessing
 * from the catalog. We don't touch `off`: that's an explicit disabling of reasoning,
 * and it must not be replaced with a level.
 */
export function unblockThinking<T extends object>(model: T, level: string): T {
  const map = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
  if (level === "off" || !map || map[level] !== null) return model;
  return { ...model, thinkingLevelMap: { ...map, [level]: level } };
}

function log(message: string): void {
  process.stderr.write(`[escalation] ${message}\n`);
}

export default function (pi: ExtensionAPI) {
  let current: Tier | null = null;
  let turnTier: Tier = "fast";
  let searches = 0;
  let heavyTool = false;

  const apply = async (tier: Tier, ctx: ExtensionContext): Promise<void> => {
    if (current === tier) return;
    const spec = TIERS[tier];
    const model = ctx.modelRegistry?.find(spec.provider, spec.id);
    if (!model) {
      log(`модель ${spec.provider}/${spec.id} не найдена — остаюсь как есть`);
      return;
    }
    const patched = unblockThinking(model, spec.thinking);
    if (patched !== model) {
      log(`pi не пропускает thinking=${spec.thinking} для ${spec.provider}/${spec.id} — включаю принудительно`);
    }
    await pi.setModel(patched);
    pi.setThinkingLevel(spec.thinking as never);
    current = tier;
    log(`уровень ${tier}: ${spec.provider}/${spec.id}:${spec.thinking}`);
  };

  pi.on("before_agent_start", async (event, ctx) => {
    searches = 0;
    heavyTool = false;
    const hasImages = (event.images?.length ?? 0) > 0;
    turnTier = chooseTier({ hasImages, prompt: String(event.prompt ?? "") });
    await apply(turnTier, ctx);
  });

  // Once the agent needs hands, we run it on the strong model from there. But search
  // and reading don't count as hands: while there are few of them, the fast model manages on its own.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (turnTier === "vision") return; // the image was already given to the sighted model
    if (isSearchTool(event.toolName)) searches += 1;
    else heavyTool = true;
    const tier = chooseTier({ hasImages: false, prompt: "", searches, heavyTool });
    await apply(tier === "strong" ? "strong" : turnTier, ctx);
  });
}
