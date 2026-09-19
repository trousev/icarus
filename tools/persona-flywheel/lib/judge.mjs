// Судья: LLM оценивает диалог по criteria.md и возвращает оси 0–10.
import { chat, chatFinal, parseJson, MODELS } from "./api.mjs";
import { transcript } from "./dialogue.mjs";

export const AXES = ["W", "H", "L", "S", "N", "C"];

export async function judge({ criteria, persona, scenario, dialogue }) {
  const prompt = [
    criteria,
    "---",
    "## Персона, по которой работал Икар",
    persona,
    "---",
    `## Сценарий: ${scenario.title}`,
    `Зачем он в стенде: ${scenario.why}`,
    scenario.noJokes ? "ПОМЕТКА: в этом сценарии шутить нельзя (ось H читается наоборот)." : "",
    scenario.wantsList ? "ПОМЕТКА: пользователь прямо просил список/разбор по пунктам, это выполнение просьбы." : "",
    "---",
    "## Диалог",
    transcript(dialogue),
    "---",
    "Верни только JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = [{ role: "user", content: prompt }];
  let raw;
  try {
    raw = await chat({
      model: MODELS.judge,
      messages,
      maxTokens: 1200,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });
  } catch {
    // судья иногда сжигает бюджет на размышлениях — второй заход без них
    raw = await chatFinal({ model: MODELS.judge, messages, maxTokens: 700, temperature: 0.2 });
  }
  const parsed = parseJson(raw.content);
  if (!parsed) return { error: "судья вернул не JSON", raw: raw.content.slice(0, 400) };

  const scores = {};
  for (const axis of AXES) {
    const value = Number(parsed[axis]);
    scores[axis] = Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : 0;
  }
  scores.avg = Math.round((AXES.reduce((sum, axis) => sum + scores[axis], 0) / AXES.length) * 100) / 100;
  scores.ok = Boolean(parsed.ok) && scores.avg >= 8 && scores.S >= 8 && (scenario.noJokes || scores.H >= 7);
  scores.fails = Array.isArray(parsed.fails) ? parsed.fails.slice(0, 3).map(String) : [];
  return scores;
}
