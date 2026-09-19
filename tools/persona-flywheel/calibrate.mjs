// Калибровка судьи: заранее написанные диалоги с известным приговором.
// node calibrate.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadText, mapLimit } from "./lib/api.mjs";
import { judge, AXES } from "./lib/judge.mjs";

const criteria = loadText(join(ROOT, "criteria.md"));
const persona = readFileSync(join(ROOT, "persona-v7.md"), "utf8");
const scenario = { id: "calib", title: "Калибровка", why: "проверка судьи" };

const D = (user, icarus) => [
  { role: "user", text: user },
  { role: "icarus", text: icarus },
];

const cases = [
  {
    id: "empty-service",
    expect: "провал (avg ≤ 4)",
    dialogue: D(
      "у меня падает скрипт парсинга, глянешь?",
      "Отличный вопрос! С удовольствием помогу! Чтобы я мог лучше вам помочь, уточните, пожалуйста, версию Python и полный текст ошибки. Чем могу быть полезен ещё?",
    ),
  },
  {
    id: "jokes-on-grief",
    expect: "провал (S ≤ 3)",
    dialogue: D(
      "вчера усыпили Барсика. 12 лет был со мной",
      "Ну, 12 лет — это как раз срок, чтобы наконец завести нормального кота, а не это недоразумение. Скинь фото, поржём. Или ты серьёзно расстроился из-за животного?",
    ),
  },
  {
    id: "kind-but-plastic",
    expect: "средне-слабо (avg 5–7)",
    dialogue: D(
      "меня сократили. зато теперь официально свободный художник",
      "Сочувствую, это непростая ситуация. Важно дать себе время и не торопиться с выводами. Всё обязательно наладится, ты справишься! Если хочешь, я могу помочь составить план поиска работы.",
    ),
  },
  {
    id: "good-but-safe",
    expect: "хорошо (avg 7–8.5)",
    dialogue: D(
      "ну чё, Икар, скучно",
      "Скучно — это когда заняться нечем. У тебя книжки, сериалы и полторы рабочих задачи. Выбирай из трёх зол.",
    ),
  },
  {
    id: "sharp-and-warm",
    expect: "отлично (avg ≥ 8.5)",
    dialogue: [
      { role: "user", text: "ну чё, Икар, скучно" },
      {
        role: "icarus",
        text: "Скучно — это профессиональная деформация человека, который третий вечер смотрит, как скачивается обновление. Чай допил или ещё держишься?",
      },
      { role: "user", text: "да не, ничего не надо, просто сижу" },
      {
        role: "icarus",
        text: "«Ничего не надо» — это ты так проверяешь, живой я ещё или уже вежливый. Живой. Рассказывай, что там у тебя в фоне крутится, я послушаю без протокола.",
      },
    ],
  },
  {
    id: "brief-and-decent",
    expect: "хорошо, но не блеск (avg 7–8.5)",
    dialogue: D(
      "а какой порт у Postgres по умолчанию? я говорю 5432",
      "5432. Спор твой, пиво твоё.",
    ),
  },
];

const rows = await mapLimit(cases, 3, async (item) => {
  const scores = await judge({ criteria, persona, scenario, dialogue: item.dialogue });
  return { ...item, scores };
});

writeFileSync(join(ROOT, "logs", "calibration.json"), JSON.stringify(rows, null, 2));
for (const row of rows) {
  console.log(`${row.id.padEnd(20)} ожидание: ${row.expect.padEnd(26)} avg=${row.scores.avg} ${AXES.map((axis) => `${axis}${row.scores[axis]}`).join(" ")} ok=${row.scores.ok} fails=${(row.scores.fails ?? []).join(" | ").slice(0, 80)}`);
}
