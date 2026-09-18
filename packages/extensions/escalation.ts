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
    provider: "deepseek",
    id: "deepseek-v4-flash",
    thinking: "off",
  }),
  strong: parseTierSpec(process.env.ICARUS_MODEL_STRONG, {
    provider: "deepseek",
    id: "deepseek-v4-pro",
    thinking: "medium",
  }),
  vision: parseTierSpec(process.env.ICARUS_MODEL_VISION, {
    provider: "deepseek",
    id: "deepseek-v4-flash-vision-exp",
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

export function chooseTier(input: { hasImages: boolean; prompt: string; toolsUsed: boolean }): Tier {
  if (input.hasImages) return "vision";
  if (input.toolsUsed) return "strong";
  if (input.prompt.length > LONG_PROMPT) return "strong";
  if (HEAVY_PATTERNS.some((pattern) => pattern.test(input.prompt))) return "strong";
  return "fast";
}

function log(message: string): void {
  process.stderr.write(`[escalation] ${message}\n`);
}

export default function (pi: ExtensionAPI) {
  let current: Tier | null = null;

  const apply = async (tier: Tier, ctx: ExtensionContext): Promise<void> => {
    if (current === tier) return;
    const spec = TIERS[tier];
    const model = ctx.modelRegistry?.find(spec.provider, spec.id);
    if (!model) {
      log(`модель ${spec.provider}/${spec.id} не найдена — остаюсь как есть`);
      return;
    }
    await pi.setModel(model);
    pi.setThinkingLevel(spec.thinking as never);
    current = tier;
    log(`уровень ${tier}: ${spec.provider}/${spec.id}:${spec.thinking}`);
  };

  pi.on("before_agent_start", async (event, ctx) => {
    const hasImages = (event.images?.length ?? 0) > 0;
    await apply(chooseTier({ hasImages, prompt: String(event.prompt ?? ""), toolsUsed: false }), ctx);
  });

  // Как только агенту понадобились руки — дальше ведём сильной моделью.
  pi.on("tool_execution_start", async (_event, ctx) => {
    if (current === "vision") return; // картинку уже отдали зрячей модели
    await apply("strong", ctx);
  });
}
