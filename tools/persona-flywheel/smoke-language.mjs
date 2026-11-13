// smoke-language.mjs — reproduces the bug "setting English, person writes Russian".
//
// Why a separate rig and not probe-language.mjs. probe-language assembles the prompt
// itself (persona + languageRule) and plays the person with a model that is ORDERED
// to write in English. That is exactly why it didn't catch the bug: it lacked the main case —
// the person OPENS the chat in Russian themselves, and there isn't a word of English in the context.
//
// This rig takes the REAL system prompt from a production session (`.prompt-dump.txt`),
// without edits and without assembly — exactly the bytes that ship to the model in production. Then
// it runs N conversations where the person's first turn is always Russian, and demands
// an English reply. This is the regression that needs to be closed.
//
//   node smoke-language.mjs                 # 10 conversations, production prompt
//   node smoke-language.mjs --runs 20       # more runs (more expensive)
//   node smoke-language.mjs --prompt ./x.md # a different prompt (to test a patch)
//   node smoke-language.mjs --model pro     # the fat model
//
// Exit: 0 — all replies in English; 1 — there are Russian replies (bug reproduced).

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
// --fix: the language rule as a separate system message (like the language extension in production).
const FIX = args.includes("--fix");
const FIX_LANG = arg("lang", "English");

const SYSTEM = readFileSync(PROMPT_PATH, "utf8");
// The timestamp is part of the production prompt; in the rig it's fixed so that runs
// are comparable to each other (and so that "night" doesn't affect the reply language).
const STAMP = "[Сейчас: среда, 4 ноября 2026, ночь]";

// ── the person's first turn: always in Russian ──────────────────────────────
// Exactly the ones seen in production: a short "Привет", domestic, work, "куку".
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

// ── detecting the reply language: a letter-based rule, as in probe-language ──
// The margin, not the first word: we don't count terms and names. More Cyrillic —
// the reply is Russian; more Latin — English.
export function languageOf(text) {
  const ru = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ru === 0 && en === 0) return "none";
  return ru > en ? "ru" : "en";
}

async function runOnce(opener, index) {
  // Patch: the rule is appended to the person's turn — exactly how the extension sends it
  // (packages/extensions/language.ts), and exactly how convertToLlm in pi survives it.
  const content = FIX ? `${STAMP}\n\n${opener}\n\n${languageOverride(FIX_LANG)}` : `${STAMP}\n\n${opener}`;
  const messages = [{ role: "user", content }];
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
  `Модель: ${MODEL}. Разговоров: ${results.length}. Патч (--fix): ${FIX ? `да, правило дописано к реплике (${FIX_LANG})` : "нет"}.`,
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
