#!/usr/bin/env python3
"""Грейдер ответов ASyMOB: SymPy + math-verify.

Почему Python, а не наш Node-грейдер: в самой статье ответы проверяются SymPy
(LaTeX разбирается в выражение, затем символьное и численное сравнение с
эталоном). Для контрольного прогона «чистой» модели нужна та же методология —
иначе наши проценты не с чем сравнивать. Maple здесь ни при чём: он инструмент
агента, а не судья бенчмарка.

Эталоны вариантов лежат только в синтаксисе SymPy (`Answer in Sympy`); поле
`Answer in Latex` у возмущённых семейств пустое. Тонкости, которые пришлось
учесть (и которые видно в отчёте отдельными колонками):

1. `e` в ASyMOB — число Эйлера (`e**(4/9)`), в SymPy `e` — свободный символ:
   перед сравнением заменяется на `E`.
2. `y(x)=…`, `f(x)=…` — обёртка, а не часть ответа: снимается.
3. Неопределённые интегралы: модель добавляет `+ C`, в эталоне его нет —
   слагаемое `C` убирается, если `C` вообще не встречается в эталоне.
4. У семейств `Equivalence-*` эталон — ответ сида, то есть с параметрами,
   равными 1 (так устроена генерация ASyMOB: подстановка 1 возвращает исходную
   задачу). Поэтому дополнительно проверяется численная эквивалентность с
   приравниванием «лишних» символов к 1; отключается флагом --no-anchor.

Запуск (нужен math-verify: runtime/math-eval/venv):
    runtime/math-eval/venv/bin/python packages/math-eval/grader/asymob_grade.py \\
        --results runtime/math-eval/runs/smoke40/results.jsonl \\
        --suite   runtime/math-eval/suites/asymob-40.jsonl \\
        --manifest runtime/math-eval/suites/asymob-40.manifest.json \\
        --out     runtime/math-eval/runs/smoke40
"""
from __future__ import annotations

import argparse
import json
import re
import signal
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager
from functools import partial
from pathlib import Path

from math_verify import LatexExtractionConfig, parse
from latex2sympy2_extended.latex2sympy2 import NormalizationConfig
from sympy import E, N, Pow, Rational, Symbol, expand, log, simplify, sympify

SYMPY_REF = re.compile(r"ASyMOB SymPy: (.*)$", re.S)

# `y(x)=…`, `f(x)=…`, `y=…` — обёртка вокруг ответа, а не часть ответа.
RELATION = re.compile(r"^\s*([A-Za-z]\w*)\s*(?:\([^()]{0,20}\))?\s*=\s*(?=\S)(.+)$", re.S)

# Метка финального ответа. Агент пишет прозу до неё («радиус сходимости равен …»),
# и без отсечения математика извлекается из середины фразы.
ANSWER_MARK = re.compile(r"(?:Ответ|Answer|Итог|Итого|Результат|Final answer)\s*[:：]", re.I)

# Одиночный знак равенства: `<=`, `>=`, `!=`, `==`, `:=`, `\le`, `\ge` — не он.
RHS_SPLIT = re.compile(r"(?<![<>=!:\\])=(?!=)")

SPECIAL = ("E", "pi", "I", "oo")

# Сколько секунд даём SymPy на одно сравнение. Ответы бывают в сотни килобайт
# (большие степени, десятки слагаемых), и `equals()` на них уходит в бесконечность.
COMPARISON_SECONDS = 1.5
TASK_SECONDS = 20.0


class ComparisonTimeout(Exception):
    """SymPy не уложился в отведённое время."""


@contextmanager
def time_limit(seconds: float = COMPARISON_SECONDS):
    def handler(_signum, _frame):
        raise ComparisonTimeout()

    previous = signal.signal(signal.SIGALRM, handler)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)

# math-verify берём только за разбор LaTeX: его собственное сравнение не раскрывает
# скобки (`simplify` без `expand`) и объявляет «не сошлось» там, где выражения
# тождественны. Равенство считаем сами, SymPy.
PARSE_CONFIG = [
    LatexExtractionConfig(
        normalization_config=NormalizationConfig(
            basic_latex=True, units=True, malformed_operators=True, nits=True, boxed=True
        )
    )
]


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rows.append(json.loads(line))
    return rows


def gold_expression(reference: str):
    """SymPy-эталон ASyMOB в выражение; `e` — число Эйлера, а не символ."""
    return sympify(reference).subs(Symbol("e"), E)


def prepared(text: str) -> str:
    r"""Хвост после последней метки ответа, без обёртки `y(x)=` и `\operatorname`."""
    marks = list(ANSWER_MARK.finditer(text))
    tail = text[marks[-1].end():] if marks else text
    # `\operatorname{artanh}` SymPy не знает — снимаем обёртку.
    tail = re.sub(r"\\operatorname\{([A-Za-z]+)\}", r"\1", tail)
    match = RELATION.match(tail.strip())
    return match.group(2).strip() if match else tail.strip()


def textual_rhs(text: str) -> str | None:
    """Правая часть уравнения — откат для случаев, которые не разбираются."""
    parts = [part for part in RHS_SPLIT.split(text) if part.strip()]
    return parts[-1].strip() if len(parts) > 1 else None


def as_expr(candidate):
    """Разобранный кандидат math-verify в выражение SymPy."""
    try:
        return candidate if hasattr(candidate, "free_symbols") else sympify(str(candidate))
    except Exception:  # noqa: BLE001
        return None


# `87789722**(-65316278)` — степень, которую SymPy начнёт считать ещё при
# sympify, до всяких проверок. Поэтому смотрим на текст эталона заранее.
ASTRO = re.compile(r"(\d+)\s*\*\*\s*\(?\s*(-?\d+)\s*\)?")
# Что стоит после `**` (в SymPy) или `^` (в LaTeX): там и прячется смертельный масштаб.
ASTRO_TAIL = re.compile(r"\*\*\s*\(?([^)\n]{0,40})")
LATEX_BIG_EXP = re.compile(r"\^\s*\{?\s*-?\d{6,}")
BIG_INT = re.compile(r"\d{5,}")


def astronomical_text(text: str) -> bool:
    """
    Есть ли в записи степень, которую физически нельзя посчитать.

    Ловим и `87789722**(-65316278)`, и `x**(1 + 65316278)`, и `^{65316278}`:
    показатель в пять и более знаков — это уже заведомо нереально.
    """
    if LATEX_BIG_EXP.search(text):
        return True
    for tail in ASTRO_TAIL.findall(text):
        if BIG_INT.search(tail):
            return True
    for base, exponent in ASTRO.findall(text):
        if len(base) * abs(int(exponent)) * 0.5 > 5000:
            return True
    return False


def astronomical(expr) -> bool:
    """
    Есть ли в выражении степень с астрономическим числом знаков.

    В эталонах ASyMOB встречается, например, `87789722**(-65316278)`: это
    полумиллиард знаков, и попытка посчитать такое число вешает SymPy намертво
    (счёт идёт в C, сигнал его не прерывает). Такие задачи честнее пометить
    «сравнить не удалось», чем повесить грейдер.
    """
    try:
        for power in expr.atoms(Pow):
            base, exponent = power.as_base_exp()
            if not exponent.is_Integer or not base.is_number or base == 0:
                continue
            if abs(float(exponent)) * abs(float(log(abs(base), 10))) > 5000:
                return True
    except Exception:  # noqa: BLE001 — не смогли оценить размер, значит опасная
        return True
    return False


def symbolic_equal(left, right) -> bool:
    """
    Быстрое тождество: раскрыть скобки и упростить.

    `equals()` сюда сознательно не зовём: он умеет подтверждать тождества, до
    которых не дошёл `simplify`, но на ответах в сотни килобайт уходит в
    бесконечность. Такие случаи ловит численная сверка ниже — она дешевле и для
    наших задач не хуже.
    """
    try:
        difference = left - right
        if difference == 0:  # тождественные записи видны сразу и стоят дёшево
            return True
        if astronomical(difference):
            return False
        with time_limit():
            return simplify(expand(difference)) == 0
    except Exception:  # noqa: BLE001 — таймаут и внутренние ошибки SymPy равнозначны
        return False


def fold_case(expr):
    """`A` и `a` после разбора LaTeX расходятся регистром — сравниваем без него."""
    expr = sympify(expr)  # xreplace умеет вернуть питоновский int — это ломает сравнение
    return expr.xreplace({s: Symbol(str(s).lower()) for s in expr.free_symbols})


def numeric_equal(gold, pred, anchor: bool, trials: int = 2):
    """
    Численная эквивалентность на случайных рациональных точках.

    `anchor` включает правило самой ASyMOB: параметры возмущения устроены так, что
    подстановка 1 возвращает исходную задачу, поэтому символы, которых нет в
    эталоне, приравниваются к 1.
    """
    gold = fold_case(gold)
    pred = fold_case(pred)
    if astronomical(gold) or astronomical(pred):
        return None
    gold_symbols = {s for s in gold.free_symbols if str(s) not in SPECIAL}
    extra = {s for s in pred.free_symbols if str(s) not in SPECIAL} - gold_symbols
    if extra and not anchor:
        return False
    agreed = 0
    for trial in range(trials):
        subs = {s: Rational(2 + trial, 1 + (trial % 3)) for s in gold_symbols}
        if anchor:
            subs.update({s: Rational(1) for s in extra})
        try:
            with time_limit(1.0):
                left = complex(N(gold.subs(subs), 30))
                right = complex(N(pred.subs(subs), 30))
        except Exception:  # noqa: BLE001 — особая точка или не успели
            continue
        if abs(left - right) > 1e-9 * max(1.0, abs(left)):
            return False
        agreed += 1
    return agreed > 0 if agreed else None


def candidates_from(text: str) -> list:
    """
    Разобрать ответ модели в выражения SymPy.

    math-verify извлекает формулы только из математического окружения, поэтому
    голый LaTeX оборачиваем в `$…$`; если не вышло — пробуем текст как есть
    (в нём уже есть `\\[…\\]`).
    """
    plain = prepared(text)
    # Если ответ записан уравнением, годится и целое уравнение, и его стороны:
    # `\int f dx = F + C` и `R = e^2/4` — это ответы, а не условия.
    # Цепочка равенств — это тоже ответ, но её части могут быть разными: берём
    # все части по верхнеуровневым `=`, а не только последнюю (агент иногда
    # последним шагом сам себе противоречит, а верная форма стоит раньше).
    attempts = [plain]
    parts = [part.strip() for part in RHS_SPLIT.split(plain) if part.strip()]
    if len(parts) > 1:
        attempts.extend(reversed(parts))
    rhs = textual_rhs(plain)
    if rhs and rhs not in attempts:
        attempts.append(rhs)
    for attempt in attempts:
        if not attempt.strip():
            continue
        for variant in (f"${attempt}$", attempt):
            try:
                parsed = parse(variant, extraction_config=PARSE_CONFIG)
            except Exception:  # noqa: BLE001 — битый LaTeX это не падение грейдера
                parsed = []
            found = [item for item in (as_expr(candidate) for candidate in parsed) if item is not None]
            if found:
                sides = []
                for item in found:
                    for side in (getattr(item, "rhs", None), getattr(item, "lhs", None)):
                        if side is not None:
                            sides.append(side)
                return found + sides
    return []


def grade(gold, candidates: list, anchor: bool) -> tuple[bool, bool, str]:
    """
    Вердикт: (зачтено с нормализацией, зачтено строго, каким правилом).

    Строгий вердикт — только символьное тождество: снятая обёртка `y(x)=` это
    часть разбора, а не поблажка. `+C` и правило параметров=1 смягчают вердикт
    и видны в отчёте отдельной колонкой.
    """
    if not candidates:
        return False, False, "ответ не разобран"

    try:
        with time_limit(TASK_SECONDS):
            return grade_within(gold, candidates, anchor)
    except ComparisonTimeout:
        return False, False, "не удалось сравнить"


def grade_within(gold, candidates: list, anchor: bool) -> tuple[bool, bool, str]:
    """Тело сверки; вынесено, чтобы накрыть задачу общим лимитом времени."""
    undecided = False
    for item in candidates:
        verdict = symbolic_equal(gold, item)
        if verdict is True:
            return True, True, "символьно"
        undecided = undecided or verdict is None

    for item in candidates:
        # Дальше сравниваем без регистра: latex2sympy приводит `A` к `a`, `C` к `c`.
        gold_folded = fold_case(gold)
        gold_names = {str(s) for s in gold_folded.free_symbols}
        folded = fold_case(item)
        constants = {s for s in folded.free_symbols if str(s) == "c" and "c" not in gold_names}
        clean = sympify(folded.xreplace({s: 0 for s in constants})) if constants else folded
        if constants:
            verdict = symbolic_equal(gold_folded, clean)
            if verdict is True:
                return True, False, "символьно, без +C"
            undecided = undecided or verdict is None
        for use_anchor in ((True, False) if anchor else (False,)):
            verdict = numeric_equal(gold_folded, clean, anchor=use_anchor)
            if verdict is True:
                return True, False, "численно, параметры=1" if use_anchor else "численно"
            undecided = undecided or verdict is None
    return False, False, "не удалось сравнить" if undecided else "не сошлось"


def grade_outcome(outcome: dict, suite: dict, manifest: dict, anchor: bool) -> dict:
    """Разметить одну задачу. Функция модульного уровня — её гоняет пул процессов."""
    task = suite.get(outcome["id"], {})
    match = SYMPY_REF.match(task.get("verify", ""))
    where = manifest.get(outcome["id"], {})
    record = {
        "id": outcome["id"],
        "ok": False,
        "strict": False,
        "method": "",
        "gold": match.group(1) if match else None,
        "pred": None,
        "ms": outcome.get("ms"),
        "usage": outcome.get("usage"),
        "group": where.get("group"),
        "variation": where.get("variation"),
        "topic": where.get("topic", outcome.get("category")),
    }
    if outcome.get("error"):
        record["method"] = "ошибка вызова"
        return record
    if not match:
        record["method"] = "нет SymPy-эталона"
        return record
    if astronomical_text(match.group(1)):
        record["method"] = "эталон астрономический: сравнить нельзя"
        return record
    try:
        gold = gold_expression(match.group(1))
    except Exception as exc:  # noqa: BLE001 — эталон бывает и непарсимым
        record["method"] = f"эталон не разобран: {exc}"
        return record

    prediction_text = f"{outcome.get('extracted') or ''} {outcome.get('content', '')}"
    if astronomical_text(prediction_text):
        record["method"] = "ответ астрономический: сравнить нельзя"
        return record

    candidates = candidates_from(outcome.get("extracted") or "")
    if not candidates:
        candidates = candidates_from(outcome.get("content", ""))
    if not candidates:
        record["method"] = "ответ не разобран"
        return record

    record["pred"] = str(candidates[0])[:300]
    ok, strict, method = grade(gold, candidates, anchor)
    record.update(ok=ok, strict=strict, method=method)
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=int, default=1, help="сколько процессов на разметку")
    parser.add_argument("--results", required=True)
    parser.add_argument("--suite", required=True, help="JSONL набора: оттуда берём SymPy-эталон")
    parser.add_argument("--manifest", required=False, help="карта id → семейство/тема")
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", default="", help="подпись прогона в отчёте")
    parser.add_argument("--no-anchor", action="store_true", help="не приравнивать лишние параметры к 1")
    args = parser.parse_args()
    anchor = not args.no_anchor

    results = read_jsonl(Path(args.results))
    suite = {row["id"]: row for row in read_jsonl(Path(args.suite))}
    manifest = {}
    if args.manifest and Path(args.manifest).exists():
        manifest = {entry["id"]: entry for entry in json.loads(Path(args.manifest).read_text())["entries"]}

    if args.jobs > 1:
        worker = partial(grade_outcome, suite=suite, manifest=manifest, anchor=anchor)
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            graded = list(pool.map(worker, results))
    else:
        graded = [grade_outcome(outcome, suite, manifest, anchor) for outcome in results]

    bad_gold = sum(1 for row in graded if row["method"].startswith("эталон") or row["method"] == "нет SymPy-эталона")
    unparsed = sum(1 for row in graded if row["method"] == "ответ не разобран")
    errors = sum(1 for row in graded if row["method"] == "ошибка вызова")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "graded.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in graded) + "\n", encoding="utf8"
    )

    total = len(graded)
    solved = sum(1 for row in graded if row["ok"])
    strict = sum(1 for row in graded if row["strict"])
    methods: dict[str, int] = {}
    for row in graded:
        if row["ok"]:
            methods[row["method"]] = methods.get(row["method"], 0) + 1
    latencies = [row["ms"] for row in graded if row["ms"]]
    tokens = sum((row["usage"] or {}).get("total_tokens", 0) for row in graded)

    def table(rows: list[dict], key: str) -> list[str]:
        groups: dict[str, list[dict]] = {}
        for row in rows:
            groups.setdefault(str(row.get(key) or "—"), []).append(row)
        lines = [f"| {key} | задач | верно | точность |", "| --- | --- | --- | --- |"]
        for name in sorted(groups):
            bucket = groups[name]
            good = sum(1 for row in bucket if row["ok"])
            lines.append(f"| {name} | {len(bucket)} | {good} | {100 * good / len(bucket):.1f}% |")
        return lines

    share = lambda good: f"{100 * good / total:.1f}%" if total else "—"  # noqa: E731
    lines = [f"# ASyMOB: контрольный прогон {args.label}".rstrip(), ""]
    lines += [
        f"- всего задач: {total}; ошибок вызова: {errors}",
        f"- **зачтено: {solved} ({share(solved)})**; из них строгим символьным сравнением: {strict} ({share(strict)})",
        f"- ответ не разобран: {unparsed}; эталон не разобран: {bad_gold}",
        f"- чем зачтено: "
        + (", ".join(f"{name} — {count}" for name, count in sorted(methods.items())) or "—"),
        f"- токенов: {tokens}; медиана ответа: {int(statistics.median(latencies)) if latencies else 0} мс",
        "",
        "Правила сверки: символьное равенство math-verify; снятие обёртки `y(x)=`;",
        "слагаемое `+C` убирается, если `C` нет в эталоне;",
        ("численная эквивалентность с приравниванием лишних параметров к 1 (правило ASyMOB:"
         if anchor
         else "численная эквивалентность без поблажек (--no-anchor):"),
        "подстановка 1 возвращает исходную задачу). Строгая доля — только символьное равенство.",
        "",
        "Ориентиры из статьи ASyMOB (arXiv 2505.23851v3): средняя точность моделей 74.6% на",
        "сид-наборе и 46.8% на полном наборе; топ-системы теряют ~21 п.п. от своего сид-уровня.",
        "Наш сэмпл — только возмущённые семейства, сиды исключены.",
        "",
        "## По семействам",
        "",
    ]
    lines += table(graded, "variation")
    lines += ["", "## По темам", ""]
    lines += table(graded, "topic")
    lines += ["", "## Не сошлось", ""]
    for row in graded:
        if row["ok"]:
            continue
        lines.append(f"- `{row['id']}` — {row['method']}")
        if row["gold"]:
            lines.append(f"  - эталон: `{row['gold'][:200]}`")
        if row["pred"]:
            lines.append(f"  - модель: `{row['pred'][:200]}`")
    (out_dir / "graded.md").write_text("\n".join(lines) + "\n", encoding="utf8")

    print(f"зачтено {solved}/{total} ({share(solved)}), строго {strict} ({share(strict)})")
    print(f"не разобрано ответов: {unparsed}, эталонов: {bad_gold}, ошибок: {errors}")
    print("правила: " + (", ".join(f"{name} — {count}" for name, count in sorted(methods.items())) or "—"))
    print(f"отчёт: {out_dir / 'graded.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
