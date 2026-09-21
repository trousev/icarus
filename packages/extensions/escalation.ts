// Эскалация моделей: болтовня идёт на быстрой модели, работа — на сильной,
// картинки — на модели со зрением. Уровни приходят из окружения контейнера,
// которое сервис собирает из конфига человека.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Tier = "fast" | "strong" | "vision";
export type TierSpec = { provider: string; id: string; thinking: string };

/** Разбирает «provider/model:thinking» в описание модели. */
export function parseTierSpec(value: string | undefined, fallback: TierSpec): TierSpec {
  if (!value) return fallback;
  const [path, thinking] = value.split(":");
  const [provider, ...rest] = (path ?? "").split("/");
  const id = rest.join("/");
  if (!provider || !id) return fallback;
  return { provider, id, thinking: thinking ?? "off" };
}

export const TIERS: Record<Tier, TierSpec> = {
  fast: parseTierSpec(process.env.ICARUS_MODEL_FAST, {
    provider: "deepinfra",
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    thinking: "off",
  }),
  strong: parseTierSpec(process.env.ICARUS_MODEL_STRONG, {
    provider: "deepinfra",
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    thinking: "medium",
  }),
  vision: parseTierSpec(process.env.ICARUS_MODEL_VISION, {
    provider: "deepinfra",
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    thinking: "off",
  }),
};

/** Признаки того, что человек просит работу, а не болтовню. */
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
 * Инструменты-разведка: поиск и чтение. Сами по себе они не повод звать сильную
 * модель — быстрая справится без размышлений, и человек не будет ждать. Всё
 * остальное (bash, правки файлов, MCP, незнакомые тулы) — уже руки, там сильная.
 */
export const SEARCH_TOOLS = new Set(["web_search", "web_fetch", "read", "grep", "find", "ls"]);

/** Сколько поисков подряд терпим на быстрой модели, прежде чем считать это работой. */
export const SEARCH_BUDGET = 3;

export function isSearchTool(name: string): boolean {
  return SEARCH_TOOLS.has(name);
}

export type TierInput = {
  hasImages: boolean;
  prompt: string;
  /** сколько инструментов-разведки уже отработало в этом ходу */
  searches?: number;
  /** попадался ли инструмент, который что-то меняет: bash, write, edit, MCP */
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
 * Разрешает ровно тот уровень размышлений, который выбрал конфиг.
 *
 * pi поднимает неподдерживаемый уровень до ближайшего доступного: если в каталоге
 * модели у `medium` стоит null, `thinking: medium` из конфига молча превратился бы в
 * `high`. Мы отдаём модели ровно тот уровень, который выбрал человек, вместо того
 * чтобы гадать по каталогу. `off` не трогаем: там pi выключает размышления отдельной
 * веткой, и подменять его нечем.
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

  // Как только агенту понадобились руки — дальше ведём сильной моделью. Но поиск
  // и чтение руками не считаются: пока их немного, быстрая модель справляется сама.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (turnTier === "vision") return; // картинку уже отдали зрячей модели
    if (isSearchTool(event.toolName)) searches += 1;
    else heavyTool = true;
    const tier = chooseTier({ hasImages: false, prompt: "", searches, heavyTool });
    await apply(tier === "strong" ? "strong" : turnTier, ctx);
  });
}
