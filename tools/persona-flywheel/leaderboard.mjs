// Таблица лидеров: собирает все logs/*/scores.json в одну сводку.
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/api.mjs";

const logsDir = join(ROOT, "logs");
const rows = [];
for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(logsDir, entry.name, "scores.json");
  if (!existsSync(file)) continue;
  const data = JSON.parse(readFileSync(file, "utf8"));
  const scenarios = new Set(data.results.map((r) => r.id));
  rows.push({
    label: data.label,
    avg: data.avg,
    axes: data.axes,
    metrics: data.metrics ?? {},
    pass: Math.round(data.passRate * 100),
    set: scenarios.has("banter") ? (scenarios.size > 10 ? "core+probe" : "core") : "probe",
    n: data.results.length,
    at: data.at,
  });
}
rows.sort((a, b) => a.at.localeCompare(b.at));

const header = "| прогон | набор | avg | W | H | L | S | N | C | шуток | символов | штампов | pass |";
const separator = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
const body = rows.map((row) =>
  `| ${row.label} | ${row.set} (${row.n}) | ${row.avg} | ${["W", "H", "L", "S", "N", "C"].map((axis) => row.axes[axis]).join(" | ")} | ${row.metrics.jokeRate ?? "—"} | ${row.metrics.chars ?? "—"} | ${row.metrics.stamps ?? "—"} | ${row.pass}% |`,
);
const table = ["# Таблица лидеров", "", header, separator, ...body, ""].join("\n");
writeFileSync(join(ROOT, "leaderboard.md"), table);
console.log(table);
