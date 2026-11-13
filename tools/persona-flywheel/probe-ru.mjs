// probe-ru.mjs — a pointed check of Russian: one scenario, different models and prompt tweaks.
// Lives next to the rig, but isn't part of the flywheel: run it by hand when there's a complaint about "machine" Russian.
//
//   node probe-ru.mjs            # all variants
//   node probe-ru.mjs flash      # only the flash variants
//
// Writes logs/ru-probe-<label>/samples.md — full replies, to read with your eyes.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chat, ROOT } from "./lib/api.mjs";

const PERSONA = readFileSync(join(ROOT, "../../icarus.md"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .trim();

// Hypothesis patch: the persona lacks a direct requirement about Russian.
const RU_CLAUSE = `
# Русский
- Думаешь по-русски, а не переводишь с английского. Оборот, который звучит как подстрочник, — брак: переписываешь.
- Идиоматику берёшь только ту, в которой уверен. Сомневаешься в слове или обороте — берёшь простое и точное.
- Перед отправкой проверяешь падежи, вид глагола и согласование. Грамматическая ошибка хуже пресной реплики.
`;

const QUESTION = `Слушай, иду в консульство голосовать. Могут на входе досмотреть сумку и попросить
показать телефон, пролистать телегу? Как себя вести?`;

const VARIANTS = [
  // production mode: Icarus's fast tier — V4.1-Flash with thinking disabled
  { id: "flash-off-base", model: "deepseek-ai/DeepSeek-V4.1-Flash", temperature: 1, thinking: "disabled", persona: PERSONA },
  { id: "flash-off-t13", model: "deepseek-ai/DeepSeek-V4.1-Flash", temperature: 1.3, thinking: "disabled", persona: PERSONA },
  { id: "flash-off-ru", model: "deepseek-ai/DeepSeek-V4.1-Flash", temperature: 1, thinking: "disabled", persona: PERSONA + RU_CLAUSE },
  { id: "pro-off-base", model: "deepseek-ai/DeepSeek-V4-Pro-0813", temperature: 1, thinking: "disabled", persona: PERSONA },
  { id: "pro-off-ru", model: "deepseek-ai/DeepSeek-V4-Pro-0813", temperature: 1, thinking: "disabled", persona: PERSONA + RU_CLAUSE },
];

const only = process.argv[2];
const chosen = only
  ? VARIANTS.filter((v) => v.model.toLowerCase().includes(only.toLowerCase()) || v.id.includes(only))
  : VARIANTS;

const label = `ru-probe-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
const dir = join(ROOT, "logs", label);
mkdirSync(dir, { recursive: true });

const out = [`# probe-ru — ${new Date().toISOString()}`, "", `Вопрос: ${QUESTION}`, ""];

for (const variant of chosen) {
  process.stderr.write(`${variant.id}… `);
  try {
    const reply = await chat({
      model: variant.model,
      system: variant.persona,
      messages: [{ role: "user", content: QUESTION }],
      maxTokens: 700,
      temperature: variant.temperature,
      extra: variant.thinking ? { thinking: { type: variant.thinking } } : undefined,
    });
    process.stderr.write("ок\n");
    out.push(
      `## ${variant.id} (${variant.model}, t=${variant.temperature}, thinking=${variant.thinking ?? "по умолчанию"})`,
      "",
      reply.content,
      "",
      `<!-- usage: ${JSON.stringify(reply.usage)} reasoning: ${reply.reasoning.length} симв. -->`,
      "",
    );
  } catch (error) {
    process.stderr.write(`провал: ${error.message}\n`);
    out.push(`## ${variant.id} — ПРОВАЛ`, "", String(error.message), "");
  }
}

writeFileSync(join(dir, "samples.md"), out.join("\n"));
console.log(`\n${join(dir, "samples.md")}`);
