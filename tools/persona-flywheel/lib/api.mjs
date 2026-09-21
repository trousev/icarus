// Общие утилиты стенда: вызовы модели, терпимый JSON, средние.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export const API_URL = "https://api.deepinfra.com/v1/openai/chat/completions";

export const MODELS = {
  // на ком гоняем реплики Икара
  icarus: process.env.FW_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash",
  user: "deepseek-ai/DeepSeek-V4.1-Flash",
  judge: "deepseek-ai/DeepSeek-V4-Pro-0813",
  critic: "deepseek-ai/DeepSeek-V4-Pro-0813",
};

let cachedKey = process.env.DEEPINFRA_API_KEY ?? "";
export function apiKey() {
  if (cachedKey) return cachedKey;
  const envFile = process.env.FW_ENV_FILE ?? "/home/trousev/src/icarus/.env";
  const text = readFileSync(envFile, "utf8");
  const match = text.match(/^\s*DEEPINFRA_API_KEY\s*=\s*(\S+)\s*$/m);
  if (!match) throw new Error("DEEPINFRA_API_KEY не найден");
  cachedKey = match[1];
  return cachedKey;
}

export async function chat({ model, system, messages, maxTokens = 500, temperature = 1, retries = 3, responseFormat, extra }) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    // на повторах даём модели больше места: пустой ответ обычно значит,
    // что весь бюджет ушёл в размышления и на текст ничего не осталось
    const budget = maxTokens * (attempt >= 2 ? 4 : 1);
    const body = {
      model,
      messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
      max_tokens: budget,
      temperature,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(extra ?? {}),
    };
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = await response.json();
      const message = data.choices?.[0]?.message ?? {};
      const finish = data.choices?.[0]?.finish_reason ?? "?";
      const content = (message.content ?? "").trim();
      if (!content) throw new Error(`пустой ответ (finish=${finish}, reasoning=${(message.reasoning_content ?? "").length})`);
      return { content, reasoning: message.reasoning_content ?? "", finish, usage: data.usage };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
    }
  }
  throw lastError;
}

// Модель иногда тратит весь бюджет на скрытые размышления и оставляет текст пустым.
// Второй заход без размышлений: просим выдать только финальную реплику.
export async function chatFinal({ model, system, messages, maxTokens = 300, temperature = 1 }) {
  return chat({
    model,
    system,
    messages: [
      ...messages,
      { role: "user", content: "Стоп размышления. Выдай только финальный текст ответа, одной репликой, без пояснений." },
    ],
    maxTokens,
    temperature,
    retries: 3,
  });
}

export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) return null;
  for (let end = raw.length; end > start; end--) {
    const slice = raw.slice(start, end).trim();
    if (!/[\]}]$/.test(slice)) continue;
    try {
      return JSON.parse(slice.replace(/,\s*([\]}])/g, "$1"));
    } catch {
      /* пробуем короче */
    }
  }
  return null;
}

export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
export const round2 = (value) => Math.round(value * 100) / 100;

export function loadScenarios(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "scenarios.json"), "utf8")).scenarios;
}

export function loadText(path, fallback = "") {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

// параллельный map с ограничением одновременности
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
