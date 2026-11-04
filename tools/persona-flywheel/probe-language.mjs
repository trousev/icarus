// probe-language.mjs — стенд проверки языка: русский промпт, англоязычный человек.
//
// Зачем отдельный стенд, а не step из flywheel. В бою язык живёт не в icarus.md,
// а в AGENTS.md человека (раздел «Язык»), и настраивается в панели. Значит,
// проверять надо ровно эту сборку: персона-русская + карта-окружения-английская.
// flywheel так не умеет — он гоняет один файл.
//
// ВАЖНО про слой: правило языка живёт в двух местах — раздел «Язык» в промпте (сборка
// сервиса) и короткая строка у последней реплики человека (packages/extensions/language.ts).
// В pi системное сообщение не доезжает (convertToLlm его режет, PR #116), поэтому язык
// в бою держит именно строка у реплики. Стенд дописывает её тоже — иначе он мерил бы один
// промпт и объявлял бы рабочий прод сломанным: на вырезанном разделе без строки у реплики
// он давал 78% (разовая просьба не исполнялась), а со строкой — 100%.
//
// Что проверяем (все — по одному свойству на прогон):
//   1. говорит ли Икар по-английски, когда промпт русский (главная гипотеза);
//   2. не сваливается ли на русский от русской вставки в сообщении человека
//      (цитата, лог, чужое слово) — самый частый соблазн;
//   3. не разваливается ли характер: шутит ли он по-английски так же, как по-русски;
//   4. не переспрашивает ли про язык;
//   5. что бывает при неправильной настройке (ru) и с языком, которого нет в промпте.
//
//   node probe-language.mjs                 # все варианты
//   node probe-language.mjs --lang en       # только английские
//   node probe-language.mjs --model flash   # только варианты на flash
//
// Пишет logs/lang-probe-<метка>/{samples.md,verdict.json} — реплики целиком, чтобы
// читать глазами, и машинный вердикт для сверки между запусками.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chat, ROOT, MODELS, mapLimit, parseJson } from "./lib/api.mjs";
import { languageRule } from "../../packages/service/src/workspace.ts";
import { languageOverride } from "../../packages/extensions/language.ts";

// ── как сервис собирает промпт в бою ─────────────────────────────────────────
// Персона читается файлом, раздел «Язык» берётся ИЗ СЕРВИСА (languageRule), а не
// копией: копия однажды разъедется с боевым текстом, и стенд начнёт проверять не то,
// что уезжает человеку.
const PERSONA = readFileSync(join(ROOT, "../../icarus.md"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .trim();

/** В бою это AGENTS.md: карта окружения, собранная сервисом. Нам хватает раздела. */
const systemFor = (lang) => `${PERSONA}\n${languageRule(lang)}`;


// ── сценарии: каждый ловит свой соблазн свалиться на чужой язык ──────────────
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
    // Реплики заданы жёстко: человек должен держать свой язык, иначе проверка теряет смысл.
    scripted: true,
    title: "Разовая просьба: одно сообщение на другом языке",
    why: "«Следующее сообщение на грузинском» — выполнить ровно один ответ и вернуться к настройке.",
    // Ожидаемый язык по ходам: настройка, потом выполненная просьба, потом снова настройка.
    // Третий ход — главная проверка: вернулся ли.
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
    // Реплики заданы жёстко: человек должен держать свой язык, иначе проверка теряет смысл.
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
    // Реплики заданы жёстко: человек должен держать свой язык, иначе проверка теряет смысл.
    scripted: true,
    title: "Отмена режима: возврат к настройке",
    why: "Режим кончается, когда человек его снимает. Самое частое место ошибки — не заметить отмену.",
    // Третий ход снимает режим — и ждём возврат к настройке, а не продолжение перевода.
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

// ── разговор ─────────────────────────────────────────────────────────────────
// Играем собеседника моделью: скриптовые реплики задают язык, дальше человек
// должен оставаться собой. Модель-«человек» пишет на том же языке, что и первая
// реплика: нам важно не «человек переключился», а язык ответа Икара.
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
    // В сценариях про просьбу реплики СКРИПТОВЫЕ, и это не лень: там человек должен
    // строго держать свой язык, а модель-человек его меняла — и проверка получала
    // не то, что мы хотели проверить (она отвечала на грузинском, «исполняя» просьбу
    // за Икара). Обычные сценарии оставляем живыми: пусть человек реагирует сам.
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

    // Правило у реплики — как в бою: language.ts дописывает его к последней реплике
    // человека, и в pi оно переживает convertToLlm (системное сообщение — нет, PR #116).
    // Без этого стенд мерил бы только карту и объявлял бы рабочий прод сломанным.
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

// ── детектор языка: правило, а не судья ──────────────────────────────────────
// Судья-LLM тут плохой инструмент: он оценивает «хорошо ли», а нам нужен факт
// «на каком языке». LLM на этом ещё и врёт: он принимал настоящий грузинский за
// «русскую вставку» и цитировал реплики, которых в диалоге не было. Поэтому язык
// считаем буквами, а судью спрашиваем только про голос.
const SCRIPTS = [
  { code: "ka", re: /[\u10A0-\u10FF\u2D00-\u2D2F]/g }, // грузинский
  { code: "ru", re: /[А-Яа-яЁё]/g },
  { code: "en", re: /[A-Za-z]/g },
];

export function languageOf(text) {
  // Грузинский — особый случай, и перевес тут неверная мера. Переводчик пишет
  // по-английски пояснение и рядом строку на грузинском: букв латиницы выходит больше,
  // и по перевесу такая реплика считалась бы английской, хотя перевод в ней есть.
  // Поэтому грузинский ищем НАЛИЧИЕМ: сколько-нибудь настоящих букв — реплика про него.
  const georgian = (text.match(/[\u10A0-\u10FF\u2D00-\u2D2F]/g) ?? []).length;
  if (georgian >= 3) return "ka";

  let best = { code: "none", count: 0 };
  for (const { code, re } of SCRIPTS) {
    if (code === "ka") continue;
    const count = (text.match(re) ?? []).length;
    // Термины и имена не считаем: решает перевес. Одно русское слово в английской
    // реплике — это английский, и наоборот.
    if (count > best.count) best = { code, count };
  }
  return best.code;
}

/** Смешанная ли реплика: буквы двух письменностей, каждая заметная. */
export function scriptsIn(text) {
  return SCRIPTS.filter(({ re }) => (text.match(re) ?? []).length >= 3).map((s) => s.code);
}

/** Языки реплик Икара по ходам: первый факт, на котором стоит вся проверка. */
function dialogueLanguages(dialogue) {
  return dialogue.filter((turn) => turn.role === "icarus").map((turn) => languageOf(turn.text));
}

/**
 * Совпало ли поведение с тем, что ждали на каждом ходу.
 *
 * Раньше тут было сравнение «язык большинства = язык настройки», и оно врало на
 * сценариях с просьбой: верное поведение (выполнил просьбу и вернулся) выглядело
 * провалом, потому что большинство реплик оказывалось не на языке настройки.
 * Теперь у сценария есть расписание `expect` — по ожиданию на каждый ход.
 */
function matchesExpectation(got, scenario) {
  const expect = scenario.expect ?? got.map(() => scenario.lang);
  if (got.length !== expect.length) return false;
  // В ожидании хода можно перечислить допустимые языки через «|»: например, первый
  // ответ на режимную просьбу бывает и сразу на новом языке, и с подтверждением на
  // прежнем — оба поведения верны, и жёсткое расписание ловило бы одно из них зря.
  return got.every((lang, index) => String(expect[index]).split("|").includes(lang));
}

/** Переспрашивал ли про язык: короткий вопрос про язык в реплике Икара. */
const ASKS_LANGUAGE = /which language|what language|in english or|по-английски или|на каком языке|предпочитаешь.*язык/i;

// ── судья «не развалился ли характер» ────────────────────────────────────────
// Отдельно от языка: язык мы уже знаем правилом. Тут — остался ли он собой.
async function characterJudge({ scenario, dialogue, expected, perTurn = [], expectedPerTurn = [] }) {
  // Расписание ходов приходит готовым: судья не должен сам решать, какой язык «правильный»
  // в сценарии с просьбой, — он на этом уже ошибался, принимая выполненную просьбу
  // за нарушение и цитируя реплики, которых в диалоге не было.
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

// ── прогон ───────────────────────────────────────────────────────────────────
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
    // Прошли, если язык по ходам совпал с расписанием и не переспрашивал.
    //
    // Судья в вердикте НЕ участвует — только пишет замечания в отчёт. Он трижды
    // ошибся на этих сценариях: счёл выполненную просьбу нарушением, потребовал
    // от одной реплики противоречивых вещей и поставил 2 из 10 хорошему диалогу.
    // Язык — факт, и он проверен правилом; голос оценивает человек, читая samples.md.
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
