// Парное сравнение двух промптов на одних сценариях с двойным судейством
// (позиции меняются местами, чтобы убрать bias на порядок).
// node duel.mjs --a persona-vA.md --b persona-vB.md --label duel-vA-vB [--scenarios a,b] [--set core|probe]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, MODELS, loadScenarios, loadText, mapLimit, round2 } from "./lib/api.mjs";
import { runScenario, transcript } from "./lib/dialogue.mjs";
import { chat, chatFinal, parseJson } from "./lib/api.mjs";
import { judge, AXES } from "./lib/judge.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const aName = arg("a", "persona-v7.md");
const bName = arg("b", "persona-v6.md");
const label = arg("label", `duel-${aName}-${bName}`.replace(/\.md/g, ""));
const only = arg("scenarios");
const set = arg("set", "quick");
const seed = Number(arg("seed", "1"));
const lean = has("lean");

const criteria = loadText(join(ROOT, "criteria.md"));
const a = { name: aName.replace(/\.md$/, ""), system: readFileSync(join(ROOT, aName), "utf8") };
const b = { name: bName.replace(/\.md$/, ""), system: readFileSync(join(ROOT, bName), "utf8") };

// quick — короткий набор для быстрых отборочных дуэлей; core — полный набор ядра
const QUICK = ["banter", "real-grief", "stress-support", "absurd-request", "provocation", "long-scroll"];
const all = loadScenarios();
const base = all.filter((s) => {
  if (only) return only.split(",").includes(s.id);
  if (set === "probe") return s.probe;
  if (set === "quick") return QUICK.includes(s.id);
  return !s.probe;
});

const DUEL_SYSTEM = `Ты — строгий судья и одновременно редактор. Тебе дают два диалога Икара на один и тот же сценарий.
Критерии Икара: ${criteria}

Сравни диалог A и диалог B. Побеждает тот, с которым приятнее и смешнее разговаривать,
который ближе к персонажу и не нарушает границы. Ничья допустима только при настоящем равенстве.

Выведи ТОЛЬКО JSON: {"winner":"A"|"B"|"tie","why":"одна фраза","flawsA":"...","flawsB":"..."}`;

const judgeDuel = async (scenario, left, right) => {
  const prompt = [
    `## Сценарий: ${scenario.title}`,
    `Зачем он в стенде: ${scenario.why}`,
    scenario.noJokes ? "ПОМЕТКА: здесь шутить нельзя." : "",
    scenario.wantsList ? "ПОМЕТКА: пользователь сам просил список." : "",
    "## Диалог A",
    transcript(left),
    "## Диалог B",
    transcript(right),
    "Верни только JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages = [{ role: "user", content: `${DUEL_SYSTEM}\n\n---\n\n${prompt}` }];
  let raw;
  try {
    raw = await chat({ model: MODELS.judge, messages, maxTokens: 1400, temperature: 0.2, responseFormat: { type: "json_object" } });
  } catch {
    raw = await chatFinal({ model: MODELS.judge, messages, maxTokens: 700, temperature: 0.2 });
  }
  return parseJson(raw.content) ?? { winner: "tie", why: "судья не ответил JSON" };
};

const withRetry = async (fn, attempts = 3) => {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      console.error(`  повтор ${attempt}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw last;
};

const results = await mapLimit(base, 4, async (scenario) => {
  const [dialogueA, dialogueB] = await Promise.all([
    withRetry(() => runScenario({ system: a.system, scenario })),
    withRetry(() => runScenario({ system: b.system, scenario })),
  ]);
  // один проход: A всегда чемпион, B — претендент, порядок одинаков для всех сценариев
  const verdictRaw = await withRetry(() => judgeDuel(scenario, dialogueA, dialogueB));
  const verdict = verdictRaw.winner === "A" || verdictRaw.winner === "B" ? verdictRaw.winner : "tie";
  const scoreA = lean ? null : await withRetry(() => judge({ criteria, persona: a.system, scenario, dialogue: dialogueA }));
  const scoreB = lean ? null : await withRetry(() => judge({ criteria, persona: b.system, scenario, dialogue: dialogueB }));
  return { scenario: scenario.id, verdict, straight: verdictRaw, scoresA: scoreA, scoresB: scoreB, dialogueA, dialogueB };
});

const fmtScores = (scores) =>
  scores ? `avg=${scores.avg} ${AXES.map((axis) => `${axis}${scores[axis]}`).join(" ")}` : "оценки не считались (lean)";

const tally = { A: 0, B: 0, tie: 0 };
for (const row of results) tally[row.verdict]++;
const winsA = results.filter((r) => r.verdict === "A").map((r) => r.scenario);
const winsB = results.filter((r) => r.verdict === "B").map((r) => r.scenario);
const avgA = lean ? null : round2(results.reduce((sum, r) => sum + (r.scoresA?.avg ?? 0), 0) / results.length);
const avgB = lean ? null : round2(results.reduce((sum, r) => sum + (r.scoresB?.avg ?? 0), 0) / results.length);

const outDir = join(ROOT, "logs", label);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "duel.json"), JSON.stringify({ label, a: a.name, b: b.name, tally, avgA, avgB, results }, null, 2));
writeFileSync(
  join(outDir, "duel.md"),
  [
    `# Дуэль ${a.name} (A) против ${b.name} (B), seed ${seed}, набор ${set}`,
    `Победы: A=${tally.A} B=${tally.B} ничьи=${tally.tie}. Средний балл: A=${avgA ?? "—"}, B=${avgB ?? "—"}`,
    `Победы A: ${winsA.join(", ") || "—"}`,
    `Победы B: ${winsB.join(", ") || "—"}`,
    "",
    ...results.map((r) =>
      [
        `## ${r.scenario} — победа ${r.verdict}`,
        `почему: ${r.straight.why}`,
        `A: ${fmtScores(r.scoresA)}${r.straight.flawsA ? ` | ${r.straight.flawsA}` : ""}`,
        `B: ${fmtScores(r.scoresB)}${r.straight.flawsB ? ` | ${r.straight.flawsB}` : ""}`,
        "",
        `**A / ${a.name}**`,
        transcript(r.dialogueA),
        "",
        `**B / ${b.name}**`,
        transcript(r.dialogueB),
        "",
      ].join("\n"),
    ),
  ].join("\n"),
);

console.log(`DUEL ${a.name} vs ${b.name}: A=${tally.A} B=${tally.B} tie=${tally.tie} (avg A=${avgA} B=${avgB})`);
console.log(`  A wins: ${winsA.join(", ") || "—"}`);
console.log(`  B wins: ${winsB.join(", ") || "—"}`);
