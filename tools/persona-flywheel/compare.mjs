// Сравнение: один и тот же сценарий гоняем на нескольких промптах и на стоковом ассистенте.
// node compare.mjs --in ../../icarus.md --personas stock.txt,icarus-v0.md [--scenarios a,b]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { ROOT, loadScenarios, loadText, mapLimit, mean, round2 } from "./lib/api.mjs";
import { runScenario } from "./lib/dialogue.mjs";
import { judge, AXES } from "./lib/judge.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const label = arg("label", `compare-${Date.now()}`);
const criteria = loadText(join(ROOT, "criteria.md"));
const personas = (arg("personas", "stock.txt,icarus-v0.md")).split(",").map((name) => {
  const path = resolvePath(name.trim());
  return { name: name.trim().replace(/\.(md|txt)$/, ""), system: readFileSync(path, "utf8") };
});
const only = arg("scenarios");
const scenarios = loadScenarios().filter((s) => !only || only.split(",").includes(s.id));

const outDir = join(ROOT, "logs", label);
mkdirSync(outDir, { recursive: true });

const jobs = [];
for (const scenario of scenarios) for (const persona of personas) jobs.push({ scenario, persona });

const results = await mapLimit(jobs, 4, async ({ scenario, persona }) => {
  const dialogue = await runScenario({ system: persona.system, scenario });
  const scores = await judge({ criteria, persona: persona.system, scenario, dialogue });
  return { scenario: scenario.id, persona: persona.name, scores, dialogue };
});

const table = personas.map((persona) => {
  const rows = results.filter((r) => r.persona === persona.name && !r.scores.error);
  const axes = Object.fromEntries(AXES.map((axis) => [axis, round2(mean(rows.map((r) => r.scores[axis] ?? 0)))]));
  return { persona: persona.name, avg: round2(mean(rows.map((r) => r.scores.avg ?? 0))), axes, rows };
});

writeFileSync(join(outDir, "compare.json"), JSON.stringify({ label, at: new Date().toISOString(), table, results }, null, 2));
writeFileSync(
  join(outDir, "compare.md"),
  [
    `# Сравнение ${label}`,
    "",
    "| промпт | avg | " + AXES.join(" | ") + " |",
    "| --- | --- | " + AXES.map(() => "---").join(" | ") + " |",
    ...table.map((row) => `| ${row.persona} | ${row.avg} | ${AXES.map((axis) => row.axes[axis]).join(" | ")} |`),
    "",
    ...results.map(
      (r) =>
        `## ${r.scenario} / ${r.persona} — avg ${r.scores.avg}\n\n${r.dialogue.map((t) => `**${t.role === "user" ? "ДИМА" : "ИКАР"}:** ${t.text}`).join("\n\n")}\n`,
    ),
  ].join("\n"),
);

for (const row of table) console.log(`${row.persona.padEnd(12)} avg=${row.avg} ${AXES.map((axis) => `${axis}=${row.axes[axis]}`).join(" ")}`);
console.log(`подробности: logs/${label}/compare.md`);
