// Критик: смотрит на слабые диалоги и предлагает следующую версию промпта.
import { chat, parseJson, MODELS } from "./api.mjs";
import { AXES } from "./judge.mjs";
import { transcript } from "./dialogue.mjs";

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
