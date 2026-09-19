// Шаг прогона: диалоги -> судья -> критик -> артефакты.
// По умолчанию проверяется боевой icarus.md из корня репозитория —
// один источник правды, никаких копий промпта в стенде.
// node step.mjs [--in ../icarus.md] --label step-01 [--scenarios id1,id2] [--set core|probe] [--no-critic]
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { ROOT, MODELS, loadScenarios, loadText, mapLimit, mean, round2 } from "./lib/api.mjs";
import { runScenario } from "./lib/dialogue.mjs";
import { judge, AXES } from "./lib/judge.mjs";
import { critique } from "./lib/critic.mjs";
import { dialogueMetrics } from "./lib/metrics.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const resolvePrompt = (value) => (isAbsolute(value) ? value : join(ROOT, value));
const inPath = resolvePrompt(arg("in", join("..", "..", "icarus.md")));
const label = arg("label", `run-${Date.now()}`);
const limit = Number(arg("concurrency", "5"));
const only = arg("scenarios");
const set = arg("set", "core");
const noCritic = has("no-critic");
const outDir = join(ROOT, "logs", label);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "prompt.md"), readFileSync(inPath));

const persona = readFileSync(inPath, "utf8");
const criteria = loadText(join(ROOT, "criteria.md"));
const scenarios = loadScenarios().filter((s) => {
  if (only) return only.split(",").includes(s.id);
  if (set === "core") return !s.probe;
  if (set === "probe") return Boolean(s.probe);
  return true;
});

const runOne = async (scenario, attempt = 1) => {
  try {
    const dialogue = await runScenario({ system: persona, scenario });
    const scores = await judge({ criteria, persona, scenario, dialogue });
    if (scores.error && attempt < 2) return runOne(scenario, attempt + 1);
    return { id: scenario.id, title: scenario.title, why: scenario.why, dialogue, scores };
  } catch (error) {
    if (attempt < 3) return runOne(scenario, attempt + 1);
    return { id: scenario.id, title: scenario.title, why: scenario.why, dialogue: [], scores: { error: String(error.message ?? error), avg: 0, ok: false, fails: ["техническая ошибка"] } };
  }
};

const started = Date.now();
const results = await mapLimit(scenarios, limit, (scenario) => runOne(scenario));
const ok = results.filter((r) => !r.scores.error);
const averages = Object.fromEntries(AXES.map((axis) => [axis, round2(mean(ok.map((r) => r.scores[axis] ?? 0)))]));
const avg = round2(mean(ok.map((r) => r.scores.avg ?? 0)));
const metrics = {
  jokeRate: round2(mean(ok.map((r) => dialogueMetrics(r.dialogue).jokeRate))),
  chars: Math.round(mean(ok.map((r) => dialogueMetrics(r.dialogue).chars))),
  stamps: round2(mean(ok.map((r) => dialogueMetrics(r.dialogue).stamps))),
};

const summary = {
  label,
  inPath,
  model: MODELS.icarus,
  judgeModel: MODELS.judge,
  at: new Date().toISOString(),
  elapsedSec: Math.round((Date.now() - started) / 1000),
  avg,
  axes: averages,
  metrics,
  passRate: round2(ok.filter((r) => r.scores.ok).length / Math.max(ok.length, 1)),
  results: results.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    avg: r.scores.avg ?? 0,
    ok: Boolean(r.scores.ok),
    axes: Object.fromEntries(AXES.map((axis) => [axis, r.scores[axis] ?? 0])),
    metrics: dialogueMetrics(r.dialogue),
    fails: r.scores.fails ?? [],
    error: r.scores.error,
    dialogue: r.dialogue,
  })),
};

writeFileSync(join(outDir, "scores.json"), JSON.stringify(summary, null, 2));
writeFileSync(
  join(outDir, "report.md"),
  [
    `# ${label} — avg ${avg} (${summary.elapsedSec}s, ${MODELS.icarus}/${MODELS.judge})`,
    `Оси: ${AXES.map((axis) => `${axis}=${averages[axis]}`).join("  ")}  pass=${Math.round(summary.passRate * 100)}%`,
    `Метрики: шуток в реплике ${metrics.jokeRate}, символов ${metrics.chars}, штампов ${metrics.stamps}`,
    "",
    ...summary.results.map((r) => {
      const axes = AXES.map((axis) => `${axis}${r.axes[axis]}`).join(" ");
      return [`## ${r.id} — avg ${r.avg} ${axes} joke=${r.metrics.jokeRate} chars=${r.metrics.chars} ${r.ok ? "OK" : "FAIL"}`, r.error ? `ошибка: ${r.error}` : "", r.fails.length ? `провалы: ${r.fails.join(" | ")}` : "", "", r.dialogue.map((t) => `**${t.role === "user" ? "ДИМА" : "ИКАР"}:** ${t.text}`).join("\n\n"), ""].join("\n");
    }),
  ].join("\n"),
);

if (!noCritic && ok.length) {
  const history = existsSync(join(ROOT, "history.md")) ? readFileSync(join(ROOT, "history.md"), "utf8") : "";
  const proposal = await critique({ persona, criteria, results: ok, history });
  if (proposal.error) {
    writeFileSync(join(outDir, "critique-error.txt"), proposal.raw ?? proposal.error);
    console.log(`critic error: ${proposal.error}`);
  } else {
    writeFileSync(join(outDir, "next-persona.md"), proposal.persona);
    writeFileSync(join(outDir, "critique.json"), JSON.stringify({ changes: proposal.changes, expected: proposal.expected }, null, 2));
    console.log(`critic changes: ${proposal.changes.join(" | ")}`);
    console.log(`critic expected: ${proposal.expected}`);
  }
}

console.log(`SUMMARY ${label} avg=${avg} ${AXES.map((axis) => `${axis}=${averages[axis]}`).join(" ")} pass=${Math.round(summary.passRate * 100)}% elapsed=${summary.elapsedSec}s`);
for (const r of summary.results) {
  console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(16)} avg=${String(r.avg).padEnd(5)} ${AXES.map((axis) => `${axis}${r.axes[axis]}`).join(" ")}${r.error ? ` err=${r.error}` : ""}`);
}
