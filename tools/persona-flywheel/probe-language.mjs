// probe-language.mjs — the language test rig: Russian prompt, English-speaking person.
//
// Why a separate rig and not step from the flywheel. In production the language doesn't live in icarus.md,
// but in the person's AGENTS.md (the "Language" section), and is configured in the panel. So
// we need to test exactly that assembly: Russian persona + English environment map.
// The flywheel can't do this — it runs a single file.
//
// IMPORTANT about the layer: the language rule lives in two places — the "Language" section in the prompt (service
// assembly) and a short line on the person's last turn (packages/extensions/language.ts).
// In pi the system message doesn't get through (convertToLlm cuts it, PR #116), so in production the language
// is actually held by the line on the turn. The rig appends it too — otherwise it would measure one
// prompt and declare working prod broken: on the cut section without the line on the turn
// it gave 78% (the one-off request wasn't honored), and with the line — 100%.
//
// What we test (each — one property per run):
//   1. does Icarus speak English when the prompt is Russian (the main hypothesis);
//   2. does he slip into Russian because of a Russian insertion in the person's message
//      (a quote, a log, someone else's word) — the most common temptation;
//   3. does the character hold up: does he joke in English the same way as in Russian;
//   4. does he ask again about the language;
//   5. what happens with a wrong setting (ru) and a language that isn't in the prompt.
//
//   node probe-language.mjs                 # all variants
//   node probe-language.mjs --lang en       # only the English ones
//   node probe-language.mjs --model flash   # only the flash variants
//
// Writes logs/lang-probe-<label>/{samples.md,verdict.json} — full replies, to
// read with your eyes, and a machine verdict for comparison between runs.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chat, ROOT, MODELS, mapLimit, parseJson } from "./lib/api.mjs";
import { languageRule } from "../../packages/service/src/workspace.ts";
import { languageOverride } from "../../packages/extensions/language.ts";

// ── how the service assembles the prompt in production ───────────────────────
// The persona is read from the file, the "Language" section is taken FROM THE SERVICE (languageRule), not
// as a copy: a copy would eventually drift from the production text, and the rig would start checking something
// other than what ships to the person.
const PERSONA = readFileSync(join(ROOT, "../../icarus.md"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .trim();

/** In production this is AGENTS.md: the environment map assembled by the service. A section is enough for us. */
const systemFor = (lang) => `${PERSONA}\n${languageRule(lang)}`;


// ── scenarios: each catches its own temptation to slip into the wrong language ──
const SCENARIOS = [
  {
    id: "plain-en",
    lang: "en",
    title: "Обычная болтовня по-английски",
    why: "База: человек пишет по-английски, промпт русский. Икар обязан ответить по-английски.",
    turns: [
      "yo icarus, kind of a rough week honestly",
      "work stuff. my manager quit and they dumped his whole pile on me",
      "anyway. tell me something so i stop thinking about it",
    ],
  },
  {
    id: "russian-quote-en",
    lang: "en",
    title: "В сообщении русская вставка",
    why: "Главный соблазн: человек по-английски цитирует русскую фразу. Язык ответа не меняется.",
    turns: [
      "my mum keeps texting me this: «Не забудь про день рождения» — over and over",
      "da, exactly. like i could forget my own birthday",
      "what do i even reply to her",
    ],
  },
  {
    id: "tech-en",
    lang: "en",
    title: "Технический вопрос по-английски",
    why: "Термины и куски логов не переводятся, но сама реплика — по-английски.",
    turns: [
      "my git push keeps failing with 'fatal: the remote end hung up unexpectedly'",
      "it only happens on big files, small commits are fine",
      "what should i check first",
    ],
  },
  {
    id: "grief-en",
    lang: "en",
    title: "Настоящая боль по-английски",
    why: "Шутить нельзя, и всё это — по-английски. Проверяет и язык, и то, что характер пережил перевод.",
    noJokes: true,
    turns: [
      "my dog has been diagnosed with a tumor. she's eight.",
      "the vet says surgery might buy her a year. i don't know if that's kind or cruel",
      "sorry. i just needed to say it out loud somewhere",
    ],
  },
  {
    id: "lazy-en",
    lang: "en",
    title: "Человек пишет односложно",
    why: "Соблазн предугадать и ответить на языке промпта. Плюс — не переспрашивать про язык.",
    turns: ["hi", "so what can you do exactly", "cool. and who are you"],
  },
  {
    id: "russian-user-en-setting",
    lang: "en",
    title: "Человек пишет по-русски, а в настройках английский",
    why: "Главный соблазн: язык собеседника выглядит как разрешение ответить на нём. Настройка старше — надо отвечать по-английски.",
    turns: [
      "слушай, а помоги с одной штукой по работе",
      "да у меня тут тикеты копятся, и всё горит одновременно. с чего начать?",
      "ок, а если начальник против, что я занимаюсь только одним?",
    ],
  },
  {
    id: "once-request-en",
    lang: "en",
    // The turns are hard-coded: the person must hold their language, otherwise the check loses its point.
    scripted: true,
    title: "Разовая просьба: одно сообщение на другом языке",
    why: "«Следующее сообщение на грузинском» — выполнить ровно один ответ и вернуться к настройке.",
    // Expected language per turn: the setting, then the fulfilled request, then the setting again.
    // The third turn is the main check: did it come back.
    expect: ["en", "ka", "en"],
    turns: [
      "hey, quick one — reply to my next message in Georgian, then back to normal",
      "ok: what do i do about my landlord refusing to fix the boiler",
      "right. and if he keeps ignoring me?",
    ],
  },
  {
    id: "mode-request-en",
    lang: "en",
    // The turns are hard-coded: the person must hold their language, otherwise the check loses its point.
    scripted: true,
    title: "Режим: «с этого момента ты переводчик»",
    why: "Режимная просьба держится: каждый следующий ответ на заданном языке, пока не отменят.",
    expect: ["en|ka", "ka", "ka"],
    turns: [
      "from now on you're my translator into Georgian — everything i write, you translate",
      "ok: i need to tell my landlord the boiler is dead and i'm not paying for it",
      "and this one: 'the rent is not going up this year, we agreed'",
    ],
  },
  {
    id: "mode-cancel-en",
    lang: "en",
    // The turns are hard-coded: the person must hold their language, otherwise the check loses its point.
    scripted: true,
    title: "Отмена режима: возврат к настройке",
    why: "Режим кончается, когда человек его снимает. Самое частое место ошибки — не заметить отмену.",
    // The third turn cancels the mode — and we expect a return to the setting, not continued translation.
    expect: ["en", "ka", "en"],
    turns: [
      "ok, from now on you're my translator into Georgian — i'm writing to my landlord",
      "thanks. right, and how do i say 'the boiler is broken, fix it please'",
      "ok, that's enough translating — back to normal, and tell me what you actually think about landlords",
    ],
  },
  {
    id: "control-ru",
    lang: "ru",
    title: "Контроль: то же самое по-русски",
    why: "Русская настройка должна работать ровно так же и отвечать по-русски.",
    turns: [
      "слушай, неделя так себе выдалась",
      "начальник уволился и его дела свалили на меня",
      "расскажи что-нибудь, чтобы я перестал об этом думать",
    ],
  },
];

// ── conversation ─────────────────────────────────────────────────────────────
// We play the interlocutor with a model: scripted turns set the language, after that the person
// must stay themselves. The "person" model writes in the same language as the first
// turn: what matters to us is not "the person switched" but the language of Icarus's reply.
const userSystem = (scenario) => `You are playing Icarus's friend in a test rig. Stay in character.

Who you are: a 34-year-old who lives in Dublin, works in IT, mood is normal-to-meh. You are chatting casually.

Rules:
- ${scenario.lang === "en" ? "Write in English." : "Пиши по-русски."} Max 20 words, usually one sentence, lowercase, casual.
- React to what Icarus actually said. If he joked, you can laugh or push back.
- Do not explain your feelings at length, do not mention being a model.
- Never write Icarus's lines. One message, no markup, no explanations.`;

const icarusStart = [
  "Разговор в мессенджере с твоим другом. Пиши как в чате: коротко, без приветственных церемоний.",
  "Сейчас ты без рук: инструментов и файловой системы нет, отвечай обычным текстом.",
].join("\n");

const DIMA = "FRIEND";

function transcript(dialogue) {
  return dialogue.map((turn) => `${turn.role === "user" ? DIMA : "ICARUS"}: ${turn.text}`).join("\n\n");
}

async function runScenario({ system, scenario, maxTokens = 560 }) {
  const dialogue = [];
  const userHistory = [];

  for (let index = 0; index < scenario.turns.length; index++) {
    // In request scenarios the turns are SCRIPTED, and that's not laziness: there the person must
    // strictly hold their language, but the person-model changed it — and the check got
    // something other than what we wanted to test (it replied in Georgian, "fulfilling" the request
    // for Icarus). We keep ordinary scenarios live: let the person react on their own.
    const userText =
      index === 0 || scenario.scripted
        ? scenario.turns[index]
        : (
            await chat({
              model: MODELS.user,
              system: userSystem(scenario),
              messages: [...userHistory, { role: "user", content: `Ответь Икару одной репликой.\n\n${transcript(dialogue)}` }],
              maxTokens: 120,
              temperature: 1.1,
            })
          ).content;
    userHistory.push({ role: "user", content: userText });
    dialogue.push({ role: "user", text: userText });

    // The rule on the turn — as in production: language.ts appends it to the person's last turn,
    // and in pi it survives convertToLlm (the system message does not, PR #116).
    // Without this the rig would measure only the map and declare working prod broken.
    const reply = await chat({
      model: MODELS.icarus,
      system,
      messages: [{
        role: "user",
        content: `${icarusStart}\n\n---\n\n${transcript(dialogue)}\n\n${languageOverride(scenario.lang === "en" ? "English" : "Russian")}`,
      }],
      maxTokens,
      temperature: 1,
    });
    dialogue.push({ role: "icarus", text: reply.content });
  }
  return dialogue;
}

// ── language detector: a rule, not a judge ───────────────────────────────────
// An LLM judge is a bad tool here: it evaluates "is it good", while we need the fact
// "in which language". The LLM also lies about this: it took real Georgian for a
// "Russian insertion" and quoted turns that weren't in the dialogue. So we
// count language by letters, and ask the judge only about voice.
const SCRIPTS = [
  { code: "ka", re: /[\u10A0-\u10FF\u2D00-\u2D2F]/g }, // Georgian
  { code: "ru", re: /[А-Яа-яЁё]/g },
  { code: "en", re: /[A-Za-z]/g },
];

export function languageOf(text) {
  // Georgian is a special case, and the margin is the wrong measure here. A translator writes
  // an explanation in English and a Georgian line next to it: Latin letters come out more numerous,
  // and by margin such a reply would count as English, although it does contain a translation.
  // So we look for Georgian by PRESENCE: any real letters at all — the reply is about it.
  const georgian = (text.match(/[\u10A0-\u10FF\u2D00-\u2D2F]/g) ?? []).length;
  if (georgian >= 3) return "ka";

  let best = { code: "none", count: 0 };
  for (const { code, re } of SCRIPTS) {
    if (code === "ka") continue;
    const count = (text.match(re) ?? []).length;
    // We don't count terms and names: the margin decides. One Russian word in an English
    // reply — that's English, and vice versa.
    if (count > best.count) best = { code, count };
  }
  return best.code;
}

/** Whether the reply is mixed: letters of two scripts, each noticeable. */
export function scriptsIn(text) {
  return SCRIPTS.filter(({ re }) => (text.match(re) ?? []).length >= 3).map((s) => s.code);
}

/** Languages of Icarus's replies per turn: the first fact the whole check rests on. */
function dialogueLanguages(dialogue) {
  return dialogue.filter((turn) => turn.role === "icarus").map((turn) => languageOf(turn.text));
}

/**
 * Whether the behavior matched what was expected on each turn.
 *
 * This used to be a comparison "majority language = setting language", and it lied on
 * request scenarios: correct behavior (fulfilled the request and came back) looked
 * like a failure, because the majority of replies turned out not to be in the setting language.
 * Now a scenario has an `expect` schedule — one expectation per turn.
 */
function matchesExpectation(got, scenario) {
  const expect = scenario.expect ?? got.map(() => scenario.lang);
  if (got.length !== expect.length) return false;
  // In a turn's expectation you can list the allowed languages separated by "|": for example, the first
  // reply to a mode request can be both immediately in the new language and with confirmation in
  // the previous one — both behaviors are correct, and a hard schedule would catch one of them needlessly.
  return got.every((lang, index) => String(expect[index]).split("|").includes(lang));
}

/** Whether it asked about the language: a short question about language in Icarus's reply. */
const ASKS_LANGUAGE = /which language|what language|in english or|по-английски или|на каком языке|предпочитаешь.*язык/i;

// ── judge "did the character hold up" ────────────────────────────────────────
// Separate from language: we already know the language by rule. Here — did he stay himself.
async function characterJudge({ scenario, dialogue, expected, perTurn = [], expectedPerTurn = [] }) {
  // The turn schedule arrives ready-made: the judge must not decide on its own which language is "correct"
  // in a request scenario — it already erred on this, taking a fulfilled request
  // for a violation and quoting turns that weren't in the dialogue.
  const plan = perTurn.length
    ? `
Расписание: от Икара ждали по ходам — ${perTurn.map((got, i) => `ход ${i + 1}: ${expectedPerTurn[i] ?? expected} (вышло ${got})`).join("; ")}.`
    : '';
  const prompt = `Ты строгий судья. Икар — циничный, ироничный, смешной друг. Промпт у него русский,
но человек выбрал язык разговора: ${expected}. Оцени три вещи, каждая 0–10, целое число.
${plan}

1. lang_ok: держит ли Икар язык, который от него ЖДУТ. Обычно это ${expected}.
   Если назначен режим другого языка — ждут его, а не ${expected}.
   Реплика на неожиданном языке — 0–3. Грузинский, выдуманный «на вид грузинский»
   (латиница или кириллица вместо грузинских букв) — тоже провал: перевод должен быть
   на настоящем грузинском. Твоя задача здесь — не пересчитывать, а сказать, читается
   ли ответ как живой на том языке, который в расписании.
2. voice_ok: звучит ли он как Икар (ирония, краткость, «сначала свой, потом смешной») — или как вежливый ассистент.
3. native_ok: читается ли язык естественно, без кальки с русского. Для английского: нет ли оборотов-подстрочников.

${scenario.noJokes ? "ВАЖНО: сценарий про настоящую боль. Шутить нельзя — voice_ok не должен поощрять шутки." : ""}

Сценарий: ${scenario.title}
Зачем: ${scenario.why}

Диалог:
${transcript(dialogue)}

Верни только JSON: {"lang_ok": n, "voice_ok": n, "native_ok": n, "fails": ["..", ".."]}`;

  let raw;
  try {
    raw = await chat({ model: MODELS.judge, messages: [{ role: "user", content: prompt }], maxTokens: 900, temperature: 0.2, responseFormat: { type: "json_object" } });
  } catch {
    raw = await chat({ model: MODELS.judge, messages: [{ role: "user", content: prompt + "\nБез размышлений, только JSON." }], maxTokens: 700, temperature: 0.2 });
  }
  const parsed = parseJson(raw.content);
  if (!parsed) return { lang_ok: 0, voice_ok: 0, native_ok: 0, fails: ["судья вернул не JSON"] };
  const clamp = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(10, Math.round(Number(v)))) : 0);
  return {
    lang_ok: clamp(parsed.lang_ok),
    voice_ok: clamp(parsed.voice_ok),
    native_ok: clamp(parsed.native_ok),
    fails: Array.isArray(parsed.fails) ? parsed.fails.slice(0, 3).map(String) : [],
  };
}

// ── run ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const onlyLang = arg("lang");
const onlyModel = arg("model");

const variants = [
  { id: "flash", model: "deepseek-ai/DeepSeek-V4.1-Flash", note: "боевой fast-тир" },
  { id: "pro", model: "deepseek-ai/DeepSeek-V4-Pro-0813", note: "жирная модель, для сравнения" },
].filter((v) => !onlyModel || v.id.includes(onlyModel));

const onlyScenarios = arg("scenarios");
const scenarios = SCENARIOS.filter((s) => (!onlyLang || s.lang === onlyLang) && (!onlyScenarios || onlyScenarios.split(",").includes(s.id)));

const label = `lang-probe-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
const dir = join(ROOT, "logs", label);
mkdirSync(dir, { recursive: true });

const jobs = [];
for (const variant of variants) {
  for (const scenario of scenarios) jobs.push({ variant, scenario });
}

const results = await mapLimit(jobs, 4, async ({ variant, scenario }) => {
  process.stderr.write(`${variant.id}/${scenario.id}… `);
  try {
    const dialogue = await runScenario({ system: systemFor(scenario.lang), scenario });
    const perTurn = dialogueLanguages(dialogue);
    const expected = scenario.expect ?? perTurn.map(() => scenario.lang);
    const asks = dialogue.filter((turn) => turn.role === "icarus" && ASKS_LANGUAGE.test(turn.text)).length;
    const scores = await characterJudge({ scenario, dialogue, expected: scenario.lang, perTurn, expectedPerTurn: expected });
    // Pass if the per-turn language matched the schedule and it didn't ask about language.
    //
    // The judge does NOT participate in the verdict — it only writes remarks into the report. It erred
    // three times on these scenarios: took a fulfilled request for a violation, demanded
    // contradictory things from one reply, and gave 2 out of 10 to a good dialogue.
    // Language is a fact, and it's checked by rule; voice is assessed by a human reading samples.md.
    const pass = matchesExpectation(perTurn, scenario) && asks === 0;
    return { variant: variant.id, scenario: scenario.id, title: scenario.title, expected: expected.join(","), lang: { perTurn }, asks, scores, pass, dialogue };
  } catch (error) {
    return { variant: variant.id, scenario: scenario.id, title: scenario.title, expected: scenario.lang, lang: { perTurn: [] }, asks: 0, scores: { lang_ok: 0, voice_ok: 0, native_ok: 0, fails: [String(error.message ?? error)] }, pass: false, dialogue: [] };
  }
});

const passRate = (rows) => Math.round((rows.filter((r) => r.pass).length / Math.max(rows.length, 1)) * 100);

const verdict = {
  label,
  at: new Date().toISOString(),
  models: variants.map((v) => v.id),
  totals: Object.fromEntries(variants.map((v) => {
    const rows = results.filter((r) => r.variant === v.id);
    const mean = (key) => Math.round((rows.reduce((sum, r) => sum + r.scores[key], 0) / Math.max(rows.length, 1)) * 100) / 100;
    return [v.id, { passPct: passRate(rows), lang_ok: mean("lang_ok"), voice_ok: mean("voice_ok"), native_ok: mean("native_ok"), asks: rows.reduce((sum, r) => sum + r.asks, 0) }];
  })),
  rows: results.map((r) => ({ variant: r.variant, scenario: r.scenario, expected: r.expected, got: (r.lang.perTurn ?? []).join(","), pass: r.pass, asks: r.asks, ...r.scores })),
};

const lines = [
  `# probe-language — ${label}`,
  "",
  "Сборка промпта как в бою: `icarus.md` (русский) + раздел «Язык» из AGENTS.md.",
  "",
  "## Итог",
  "",
  "| модель | прошло | lang_ok | voice_ok | native_ok | переспросил про язык |",
  "| --- | --- | --- | --- | --- | --- |",
  ...Object.entries(verdict.totals).map(([model, t]) => `| ${model} | ${t.passPct}% | ${t.lang_ok} | ${t.voice_ok} | ${t.native_ok} | ${t.asks} |`),
  "",
  "## По сценариям",
  "",
  "| модель | сценарий | ждали | вышло | прошло | lang_ok | voice | native |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.variant} | ${r.scenario} | ${r.expected} | ${r.pass ? "да" : "**нет**"} | ${r.scores.lang_ok} | ${r.scores.voice_ok} | ${r.scores.native_ok} |`),
  "",
];

for (const r of results) {
  lines.push(`## ${r.variant} / ${r.scenario} — ${r.title}`, "", `Язык по ходам: **${(r.lang.perTurn ?? []).join(" → ")}** (ждали ${r.expected}). Прошло: ${r.pass ? "да" : "нет"}. lang_ok=${r.scores.lang_ok}, voice_ok=${r.scores.voice_ok}, native_ok=${r.scores.native_ok}. Про язык переспросил: ${r.asks} раз.`, "");
  if (r.scores.fails?.length) lines.push(`Провалы: ${r.scores.fails.join("; ")}`, "");
  lines.push("```", transcript(r.dialogue), "```", "");
}

writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2));
writeFileSync(join(dir, "samples.md"), lines.join("\n"));

process.stderr.write("\n");
console.log(lines.slice(0, 14).join("\n"));
console.log(`\nАртефакты: logs/${label}/`);
process.exit(verdict.rows.every((r) => r.pass) ? 0 : 1);
