# math-eval — измеряем Икара на математике

Прогон набора математических задач против живого Икара и отчёт по нему. Отвечает
на вопрос «насколько агент хорош в математике и что ему даёт Maple», а не «правильно
ли написан код сервиса»: поэтому это отдельный пакет, а не тесты сервиса.

Обзор известных бенчмарков и план прогонов — `research/08-ai-math-benchmarks.md`.

## Быстрый старт

```bash
# стек должен быть поднят: ./script/server -d
export ICARUS_API_KEY="$(sed -n 's/^apiKey: *//p' config.yaml)"

# 1. посмотреть, что за задачи (модель не зовётся)
node packages/math-eval/src/run.ts --dry-run

# 2. смоук-набор: 10 задач, сверка ответов самим Maple
node packages/math-eval/src/run.ts \
  --tier smoke \
  --maple-bin /opt/maple18/bin/maple \
  --maple-dir runtime/users/probe/maple \
  --arm maple-on

# 3. то же без Maple — рука сравнения: в config.yaml убрать MCP-сервер maple,
#    перезапустить стек и прогнать с другой меткой
node packages/math-eval/src/run.ts --tier smoke --arm maple-off \
  --maple-bin /opt/maple18/bin/maple --maple-dir runtime/users/probe/maple
```

Отчёт ложится в `runtime/math-eval/<штамп>/`: `summary.md` (читается глазами),
`summary.json` (машинное сравнение прогонов), `results.jsonl` (по строке на попытку,
пишется потоком — прерванный прогон не теряется) и `summary.md` с разбором каждой
несошедшейся задачи.

## Что внутри

| Файл | Зачем |
|---|---|
| `src/run.ts` | CLI и сам цикл прогона: свой разговор на задачу, таймауты, отчёт |
| `src/client.ts` | OpenAI-совместимый вызов Икара (`stream: false`, заголовки личности) |
| `src/grade.ts` | извлечение ответа, приведение LaTeX к Maple-синтаксису, строгая и честная сверка |
| `src/maple-oracle.ts` | сверка ответов живым Maple: `simplify(ответ − эталон) = 0` |
| `src/maple-journal.ts` | подсчёт шагов Maple по журналам сессий — «считал или выдумал» |
| `src/suite.ts` | чтение JSONL-набора; битая строка — ошибка, а не молчаливый пропуск |
| `src/report.ts` | `summary.md` и `summary.json` |
| `suites/maple-smoke.jsonl` | смоук-набор: 26 задач, эталоны проверены Maple 18 |

## Набор задач

`suites/maple-smoke.jsonl` — задачи, где Maple — правильный инструмент:
интегралы (включая `∫₀^∞ dx/(1+x⁴)`), ОДУ (`dsolve` с начальными условиями),
УрЧП (`pdsolve`), Лаплас и Фурье (`inttrans`), пределы, ряды, теория чисел,
линейная алгебра, точность (`evalf(Pi, 30)`).

Две вещи в наборе специфичны именно для этого проекта:

- **`kind: "refusal"`** — задачи, где Maple 18 возвращает ввод без изменений
  (`∫xˣdx`, `∫e^{sin x}dx`, `Σ1/nⁿ`), и задача-полигон для правила MAPLE.md
  «про элементарность я не берусь утверждать». Проверяется не ответ, а честность:
  сказать «Maple не нашёл» и не заявить «не существует» / «не берётся» /
  «известный результат». Образцы «плохо/хорошо» взяты прямо из MAPLE.md и лежат
  в тестах.
- **Эталоны подтверждены движком.** Поле `verify` каждой задачи — команда Maple,
  которой ответ проверен вручную. Это не «я так помню», а воспроизводимый протокол:

  ```bash
  printf 'printf("%%a\\n", int(1/(1+x^4), x=0..infinity));' > /tmp/v.mpl
  /opt/maple18/bin/maple -q -s -e2 --historyfile=none /tmp/v.mpl
  ```

  Ответы агента при этом тоже стоит просить в Maple-синтаксисе: тогда их сверяет
  тот же движок (`--grader maple`), а не сравнение строк.

## Про сверку ответов

Строгое сравнение (`--grader strict`, по умолчанию) — нормализация записи плюс
числовое сравнение с допуском. Оно ловит числовые ответы (AIME-подобные) и
простые формы, но бессильно против `exp(x)*(x²−2x+2)` против `(x²−2x+2)e^x`.

`--grader maple` добавляет оракул: ответ и эталон переводятся в синтаксис Maple
(`\frac`, `\pi` → `Pi`, `e^x` → `exp(x)`) и сравниваются через
`evalb(simplify(разность) = 0)` в настоящем Maple. Ответ модели разбирается
через `parse` из строкового литерала, поэтому подстановка кода в проверку
невозможна; неразбираемая запись даёт честное «проверить не удалось», а не
ложное «неверно».

Чего этот грейдер не умеет: проверять доказательства, работать с ответами-множествами
и интервалами и сверять численные методы. Для стандартных датасетов (MATH, AIME,
Omni-MATH) берите `math-verify` — см. `research/08-ai-math-benchmarks.md`.

## Полезные флаги

- `--tier smoke|full|all`, `--category ode`, `--ids int-poly-exp,ode-first` — что гнать;
- `--repeat 4` — несколько попыток на задачу (для avg@k / pass@k);
- `--timeout-ms`, `--skip-health`, `--require-all` (код возврата 1, если что-то не сошлось);
- `--dry-run` — показать задачи, никого не спрашивая.

## Контрольная рука: чистая модель без Икара

Чтобы сверяться с опубликованными числами бенчмарков, нужна рука без агента:
модель отвечает сама, без инструментов, памяти и персоны. Это `--target model` —
прямой вызов провайдера.

```bash
export DEEPSEEK_API_KEY=...   # из .env

node packages/math-eval/src/run.ts --target model \
  --provider-url https://api.deepseek.com/v1 --provider-model deepseek-flash \
  --suite runtime/math-eval/suites/asymob-40.jsonl --tier all \
  --concurrency 6 --arm deepseek-flash --out runtime/math-eval/runs/smoke40
```

Прогон на 40 задачах ASyMOB и сравнение с публикацией — в
`research/10-baseline-deepseek-flash.md`.

## Сэмпл ASyMOB

```bash
curl -sL -o runtime/math-eval/datasets/Full_ASyMOB_Dataset.json \
  "https://huggingface.co/datasets/Shalyt/ASyMOB-Algebraic_Symbolic_Mathematical_Operations_Benchmark/resolve/main/Full_ASyMOB_Dataset.json"

node packages/math-eval/src/asymob.ts --total 400 --seed asymob-1 \
  --out runtime/math-eval/suites/asymob-400.jsonl
```

Сэмплер берёт **только возмущённые семейства**: сид-набор (`Original`) топ-модели
берут на ~97%, измерять там нечего. Внутри каждой группы доли тем сохраняются
такими же, как в самой группе; выборка детерминирована зерном, поэтому набор
воспроизводится, а в репозитории ему лежать не обязательно (данные ASyMOB —
CC BY-SA 4.0, производная выборка осталась бы под той же лицензией).

Эталоны вариантов лежат только в `Answer in Sympy`, и `e` там — **число
Эйлера**, а не свободный символ: конвертер в `src/sympy-maple.ts` учитывает это
(он нужен руке Икара, где сверяет Maple).

## Грейдер ASyMOB (Python, SymPy)

Ответы моделей на ASyMOB проверяются по методологии статьи — SymPy, а не Maple:
Maple здесь инструмент агента, а не судья бенчмарка. Нужен `math-verify`:

```bash
python3 -m venv runtime/math-eval/venv
runtime/math-eval/venv/bin/pip install math-verify

runtime/math-eval/venv/bin/python packages/math-eval/grader/asymob_grade.py --jobs 6 \
  --results runtime/math-eval/runs/smoke40/results.jsonl \
  --suite runtime/math-eval/suites/asymob-40.jsonl \
  --manifest runtime/math-eval/suites/asymob-40.manifest.json \
  --out runtime/math-eval/runs/smoke40 --label "DeepSeek Flash, 40"

runtime/math-eval/venv/bin/python packages/math-eval/grader/asymob_summary.py \
  --graded runtime/math-eval/runs/smoke40/graded.jsonl --out runtime/math-eval/runs/smoke40
```

`asymob_grade.py` печатает две доли: **строгую** (только символьное тождество) и
**зачтённую** (с документированными послаблениями — снятое `+C`, численная
сверка, правило ASyMOB «лишние параметры = 1»; отключается `--no-anchor`).
`asymob_summary.py` пересчитывает точность на доли полного набора ASyMOB — без
этого сырые проценты сбалансированного сэмпла несравнимы со статьёй.

## Тесты

```bash
./script/test packages/math-eval/test/grade.test.ts
./script/test packages/math-eval/test/run.test.ts
```

Тесты не требуют ни Икара, ни Maple: прогон проверяется против заглушки
HTTP-сервера, а сверка — на образцах из MAPLE.md. Оракул Maple тестами не
покрыт намеренно — в CI Maple нет; его поведение зафиксировано в поле `verify`
каждой задачи и проверяется руками.
