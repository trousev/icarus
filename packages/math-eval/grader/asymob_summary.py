#!/usr/bin/env python3
"""Сводка по размеченному прогону ASyMOB: доли семейств и сравнение с публикацией.

Зачем пересчёт: наш сэмпл сбалансирован по семействам, а полный набор ASyMOB —
нет (Equivalence — 55%, Numeric — 41%, Symbolic — всего 4%). Поэтому «сырая»
точность сэмпла и «Total» из статьи — разные величины, и сравнивать надо
пересчитанную: Σ (доля семейства в полном наборе × точность на семействе).

    runtime/math-eval/venv/bin/python packages/math-eval/grader/asymob_summary.py \\
        --graded runtime/math-eval/runs/smoke40/graded.jsonl \\
        --out    runtime/math-eval/runs/smoke40
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Размеры семейств в полном наборе ASyMOB (arXiv 2505.23851v3, таблица 1).
GROUP_SIZES = {
    "symbolic": 1348,
    "numeric-all": 1100,
    "numeric-one": 3490,
    "numeric-random": 10000,
    "equivalence-one-easy": 1745,
    "equivalence-one-hard": 1745,
    "equivalence-all-easy": 7920,
    "equivalence-all-hard": 7920,
}

# Опубликованные числа (таблица 2 и 6 в статье): колонка Total и по категориям.
PUBLISHED = {
    "DeepSeek-V3": {"total": 45.4, "Integrals": 39.6, "Differential Equations": 42.5, "Series": 45.1, "Limits": 65.9, "Hypergeometrics": 46.1},
    "DeepSeek-R1": {"total": 78.3, "Integrals": 72.3, "Differential Equations": 73.7, "Series": 85.0, "Limits": 91.5, "Hypergeometrics": 79.5},
    "Gemini-2.5-Flash (no code)": {"total": 78.5, "Integrals": 69.8, "Differential Equations": 79.9, "Series": 79.4, "Limits": 92.2, "Hypergeometrics": 81.8},
    "GPT-4.1 (no code)": {"total": 48.9, "Integrals": 43.0, "Differential Equations": 47.8, "Series": 47.5, "Limits": 66.4, "Hypergeometrics": 50.7},
}
PUBLISHED_AVERAGE = 46.8


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graded", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", default="DeepSeek Flash")
    args = parser.parse_args()

    rows = read_jsonl(Path(args.graded))
    total = len(rows)
    solved = sum(1 for row in rows if row["ok"])
    strict = sum(1 for row in rows if row["strict"])
    undecided = sum(1 for row in rows if row["method"] == "не удалось сравнить")
    unparsed = sum(1 for row in rows if row["method"] == "ответ не разобран")

    def by(key: str) -> dict[str, tuple[int, int]]:
        buckets: dict[str, list[dict]] = {}
        for row in rows:
            buckets.setdefault(str(row.get(key) or "—"), []).append(row)
        return {name: (len(bucket), sum(1 for r in bucket if r["ok"])) for name, bucket in buckets.items()}

    groups = by("group")
    variations = by("variation")
    topics = by("topic")

    weight_total = sum(GROUP_SIZES.get(name, 0) for name in groups)
    reweighted = (
        sum(GROUP_SIZES.get(name, 0) * good / count for name, (count, good) in groups.items()) / weight_total
        if weight_total
        else 0.0
    )

    share = lambda good: 100 * good / total if total else 0.0  # noqa: E731
    lines = [f"# Сводка ASyMOB: {args.label}", ""]
    lines += [
        f"- задач: {total}; **зачтено {solved} ({share(solved):.1f}%)**, строго символьным сравнением {strict} ({share(strict):.1f}%)",
        f"- не разобрано: ответ {unparsed}, сравнить не удалось {undecided}",
        f"- **пересчёт на доли полного набора: {100 * reweighted:.1f}%** "
        f"(веса: {', '.join(f'{k} {v}' for k, v in sorted(GROUP_SIZES.items()))})",
        "",
        "Публикация (arXiv 2505.23851v3): средняя по конфигурациям 46.8%; "
        f"DeepSeek-V3 45.4%, DeepSeek-R1 78.3%, Gemini-2.5-Flash без кода 78.5%.",
        "Строгое сравнение с ними некорректно: наш грейдер собран заново (SymPy + math-verify) "
        "и сэмпл другой, поэтому совпадение проверяем по порядку величины.",
        "",
        "## По группам (и вклад в пересчёт)",
        "",
        "| группа | задач | верно | точность | доля набора | вклад, п.п. |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for name in sorted(groups, key=lambda key: -GROUP_SIZES.get(key, 0)):
        count, good = groups[name]
        size = GROUP_SIZES.get(name, 0)
        lines.append(
            f"| {name} | {count} | {good} | {100 * good / count:.1f}% | {100 * size / weight_total:.1f}% "
            f"| {100 * size * good / count / weight_total:.2f} |"
        )
    lines += ["", "## По семействам", "", "| семейство | задач | верно | точность |", "| --- | --- | --- | --- |"]
    for name in sorted(variations):
        count, good = variations[name]
        lines.append(f"| {name} | {count} | {good} | {100 * good / count:.1f}% |")

    lines += ["", "## По темам, рядом с публикацией", ""]
    header = "| тема | задач | " + args.label + " | " + " | ".join(PUBLISHED) + " |"
    lines += [header, "| --- | --- | " + " | ".join("---" for _ in range(len(PUBLISHED) + 1)) + " |"]
    for name in sorted(topics):
        count, good = topics[name]
        cells = [f"{PUBLISHED[model].get(name, float('nan')):.1f}%" for model in PUBLISHED]
        lines.append(f"| {name} | {count} | **{100 * good / count:.1f}%** | " + " | ".join(cells) + " |")
    lines.append(
        "| всего | " + str(total) + f" | **{share(solved):.1f}%** | "
        + " | ".join(f"{PUBLISHED[model]['total']:.1f}%" for model in PUBLISHED)
        + " |"
    )
    lines += ["", f"Средняя по конфигурациям в публикации: {PUBLISHED_AVERAGE}%.", ""]

    out = Path(args.out)
    (out / "summary-benchmark.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(f"сырая точность: {solved}/{total} ({share(solved):.1f}%)")
    print(f"строго символьным сравнением: {strict} ({share(strict):.1f}%)")
    print(f"пересчёт на доли полного набора: {100 * reweighted:.1f}%")
    print(f"отчёт: {out / 'summary-benchmark.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
