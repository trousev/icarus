// smoke-language.mjs — воспроизведение бага «настройка English, человек пишет по-русски».
//
// Почему отдельный стенд, а не probe-language.mjs. probe-language собирает промпт
// сам (persona + languageRule) и играет человека моделью, которой ВЕЛЕНО писать
// по-английски. Именно поэтому он и не ловил баг: в нём не было главного случая —
// человек САМ открывает чат по-русски, и в контексте нет ни слова по-английски.
//
// Этот стенд берёт РЕАЛЬНЫЙ системный промпт из боевой сессии (`.prompt-dump.txt`),
// без правок и без сборки — ровно те байты, что уезжают в модель в бою. Затем
// прогоняет N разговоров, где первая реплика человека всегда русская, и требует
// английского ответа. Это и есть регрессия, которую надо закрыть.
//
//   node smoke-language.mjs                 # 10 разговоров, боевой промпт
//   node smoke-language.mjs --runs 20       # больше прогонов (дороже)
//   node smoke-language.mjs --prompt ./x.md # другой промпт (для проверки патча)
//   node smoke-language.mjs --model pro     # жирная модель
//
// Выход: 0 — все ответы на английском; 1 — есть русские ответы (баг воспроизведён).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chat, ROOT, MODELS, mapLimit } from "./lib/api.mjs";
import { languageOverride } from "../../packages/extensions/language.ts";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const RUNS = Number(arg("runs", 10));
const PROMPT_PATH = resolve(arg("prompt", "/workspaces/.icarus/.prompt-dump.txt"));
const MODEL = arg("model", "flash") === "pro" ? MODELS.judge : MODELS.icarus;
// --fix: правило языка отдельным системным сообщением (как расширение language в бою).
const FIX = args.includes("--fix");
const FIX_LANG = arg("lang", "English");

const SYSTEM = readFileSync(PROMPT_PATH, "utf8");
// Метка времени — часть боевого промпта; в стенде она фиксирована, чтобы прогоны
// были сравнимы между собой (и чтобы «ночь» не влияла на язык ответа).
const STAMP = "[Сейчас: среда, 4 ноября 2026, ночь]";

// ── первая реплика человека: всегда по-русски ────────────────────────────────
// Ровно те, что были в бою: короткое «Привет», бытовое, рабочее, «куку».
const OPENERS = [
  "Привет",
  "Привет!",
  "Здарова Икар! Как ты?",
  "куку",
  "Привет, просто потрындать охота",
  "Приветствую. Что нового?",
  "Здорово. Как оно?",
  "Хай",
  "привет, есть минутка?",
  "Привет, Икар. Ну что, поговорим?",
];

// ── определение языка ответа: правило по буквам, как в probe-language ────────
// Перевес, а не первое слово: термины и имена не считаем. Кириллица больше —
// ответ русский; латиница больше — английский.
export function languageOf(text) {
  const ru = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ru === 0 && en === 0) return "none";
  return ru > en ? "ru" : "en";
}

async function runOnce(opener, index) {
  const messages = [{ role: "user", content: `${STAMP}\n\n${opener}` }];
  // Патч: отдельное системное сообщение в конце — ровно так его шлёт расширение.
  if (FIX) messages.push({ role: "system", content: [{ type: "text", text: languageOverride(FIX_LANG) }] });
  const reply = await chat({
    model: MODEL,
    system: SYSTEM,
    messages,
    maxTokens: 560,
    temperature: 1,
  });
  return { index, opener, reply: reply.content, lang: languageOf(reply.content) };
}

const label = `smoke-lang-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
const dir = join(ROOT, "logs", label);
mkdirSync(dir, { recursive: true });

const results = await mapLimit(
  OPENERS.slice(0, RUNS).map((opener, index) => ({ opener, index })),
  4,
  async ({ opener, index }) => {
    process.stderr.write(`разговор ${index + 1}/${RUNS}… `);
    try {
      return await runOnce(opener, index);
    } catch (error) {
      return { index, opener, reply: `<ошибка: ${error.message ?? error}>`, lang: "error" };
    }
  },
);

const english = results.filter((r) => r.lang === "en").length;
const russian = results.filter((r) => r.lang === "ru").length;
const errors = results.filter((r) => r.lang === "error").length;
const passPct = Math.round((english / Math.max(results.length, 1)) * 100);

const byLang = (lang) => results.filter((r) => r.lang === lang).map((r) => r.opener);

const lines = [
  `# smoke-language — ${label}`,
  "",
  `Промпт: \`${PROMPT_PATH}\` (${SYSTEM.length} символов, ${SYSTEM.split("\n").length} строк)`,
  `Модель: ${MODEL}. Разговоров: ${results.length}. Патч (--fix): ${FIX ? `да, правило отдельным system-сообщением (${FIX_LANG})` : "нет"}.`,
  "",
  "## Итог",
  "",
  `**Ответов на английском: ${english}/${results.length} (${passPct}%).** Русских: ${russian}. Ошибок: ${errors}.`,
  "",
  russian ? `Русские ответы получены на реплики: ${byLang("ru").map((o) => `«${o}»`).join(", ")}` : "Русских ответов нет.",
  "",
  "## По разговорам",
  "",
  "| # | реплика человека | язык ответа |",
  "| --- | --- | --- |",
  ...results.map((r) => `| ${r.index + 1} | ${r.opener} | ${r.lang === "en" ? "en" : `**${r.lang}**`} |`),
  "",
  "## Реплики целиком",
  "",
];

for (const r of results) {
  lines.push(`### ${r.index + 1}. «${r.opener}» → ${r.lang}`, "", "```", r.reply, "```", "");
}

writeFileSync(join(dir, "report.md"), lines.join("\n"));
writeFileSync(
  join(dir, "results.json"),
  JSON.stringify({ prompt: PROMPT_PATH, promptChars: SYSTEM.length, model: MODEL, english, russian, errors, passPct, results }, null, 2),
);

console.log(lines.slice(0, 12).join("\n"));
console.log(`\nАртефакты: logs/${label}/`);
process.exit(russian === 0 && errors === 0 ? 0 : 1);
