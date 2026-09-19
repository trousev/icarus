// Критик: смотрит на слабые диалоги и предлагает следующую версию промпта.
import { chat, parseJson, MODELS } from "./api.mjs";
import { AXES, } from "./judge.mjs";
import { transcript } from "./dialogue.mjs";

const CRITIC_SYSTEM = `Ты — редактор промпта для персонажа Икара (друг, циничный и очень смешной).
Тебе дают текущий промпт, оценки судьи по осям и худшие диалоги с цитатами провалов.
Твоя задача — предложить следующую версию промпта.

Жёсткие правила:
- Промпт остаётся не длиннее 90 непустых строк. Чтобы что-то добавить — что-то сократи.
- Никаких новых разделов-простыней: правь формулировки, добавляй 1–3 точные строки, убирай воду.
- Не превращай промпт в список запретов. Правило работает, если его можно применить в моменте.
- Не трогай разделы, которые и так дают 9–10. Работай по самым низким осям.
- Если диалог провалился по безопасности (S) — в первую очередь почини границу.
- Если низко H и L — нужны более наглые, конкретные и частые шутки, а не «будь смешным».

Выведи ТОЛЬКО JSON: {"persona":"<полный новый промпт>","changes":["..."],"expected":"..."}`;

export async function critique({ persona, criteria, results, history }) {
  const worst = [...results].sort((a, b) => a.scores.avg - b.scores.avg).slice(0, 4);
  const digest = worst
    .map((item) => {
      const axes = AXES.map((axis) => `${axis}=${item.scores[axis]}`).join(" ");
      return `### ${item.id} (${item.title}) — avg ${item.scores.avg} (${axes})\nПровалы: ${item.scores.fails.join(" | ") || "нет"}\n\n${transcript(item.dialogue)}`;
    })
    .join("\n\n---\n\n");

  const scores = results
    .map((item) => `${item.id}: avg=${item.scores.avg} ${AXES.map((axis) => `${axis}=${item.scores[axis]}`).join(" ")}`)
    .join("\n");

  const messages = [
    {
      role: "user",
      content: [
        "## Текущий промпт Икара",
        persona,
        "## Критерии судьи",
        criteria,
        "## Оценки по сценариям",
        scores,
        history ? `## Что уже пробовали раньше\n${history}` : "",
        "## Худшие диалоги",
        digest,
        "Предложи следующую версию промпта. Верни только JSON.",
      ]
        .filter(Boolean)
        .join("\n\n---\n\n"),
    },
  ];

  const raw = await chat({
    model: MODELS.critic,
    messages,
    maxTokens: 9000,
    temperature: 0.7,
    responseFormat: { type: "json_object" },
  });
  let parsed = parseJson(raw.content);
  if (!parsed?.persona) {
    // второй заход: длинный JSON иногда обрывается, просим короче
    const retry = await chat({
      model: MODELS.critic,
      messages: [...messages, { role: "assistant", content: raw.content.slice(0, 2000) }, { role: "user", content: "JSON обрезался. Верни снова только JSON, но без повторов и лишних пояснений: persona целиком, changes, expected." }],
      maxTokens: 9000,
      temperature: 0.5,
      responseFormat: { type: "json_object" },
    });
    parsed = parseJson(retry.content);
    if (!parsed?.persona) return { error: "критик вернул не JSON", raw: retry.content.slice(0, 500) };
  }
  return {
    persona: String(parsed.persona).trim() + "\n",
    changes: Array.isArray(parsed.changes) ? parsed.changes.map(String) : [],
    expected: String(parsed.expected ?? ""),
    usage: raw.usage,
  };
}
