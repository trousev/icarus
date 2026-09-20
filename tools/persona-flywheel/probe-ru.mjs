// probe-ru.mjs — точечная проверка русского: один сценарий, разные модели и правки промпта.
// Живёт рядом со стендом, но не часть flywheel: гонять руками, когда жалоба на «машинный» русский.
//
//   node probe-ru.mjs            # все варианты
//   node probe-ru.mjs flash      # только варианты на flash
//
// Пишет logs/ru-probe-<метка>/samples.md — реплики целиком, чтобы читать глазами.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chat, ROOT } from "./lib/api.mjs";

const PERSONA = readFileSync(join(ROOT, "../../icarus.md"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .trim();

// Правка-гипотеза: персоне не хватает прямого требования к русскому.
const RU_CLAUSE = `
# Русский
- Думаешь по-русски, а не переводишь с английского. Оборот, который звучит как подстрочник, — брак: переписываешь.
- Идиоматику берёшь только ту, в которой уверен. Сомневаешься в слове или обороте — берёшь простое и точное.
- Перед отправкой проверяешь падежи, вид глагола и согласование. Грамматическая ошибка хуже пресной реплики.
`;

const QUESTION = `Слушай, иду в консульство голосовать. Могут на входе досмотреть сумку и попросить
показать телефон, пролистать телегу? Как себя вести?`;

const VARIANTS = [
  // боевой режим: fast-тир Икара — flash с выключенным мышлением
  { id: "flash-off-base", model: "deepseek-v4-flash", temperature: 1, thinking: "disabled", persona: PERSONA },
  { id: "flash-off-t13", model: "deepseek-v4-flash", temperature: 1.3, thinking: "disabled", persona: PERSONA },
  { id: "flash-off-ru", model: "deepseek-v4-flash", temperature: 1, thinking: "disabled", persona: PERSONA + RU_CLAUSE },
  { id: "pro-off-base", model: "deepseek-v4-pro", temperature: 1, thinking: "disabled", persona: PERSONA },
  { id: "pro-off-ru", model: "deepseek-v4-pro", temperature: 1, thinking: "disabled", persona: PERSONA + RU_CLAUSE },
];

const only = process.argv[2];
const chosen = only ? VARIANTS.filter((v) => v.model.includes(only) || v.id.includes(only)) : VARIANTS;

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
