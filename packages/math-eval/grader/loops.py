#!/usr/bin/env python3
"""Поиск зацикливаний и обрывов по результатам прогона.

Замер 400 задач ASyMOB показал: у задач с 11+ вызовами Maple точность падает до
62% против 70% у остальных, а 17 ходов оборвались по таймауту — агент перебирал
формулировки одной и той же команды (`evalf`, `value`, `simplify` по кругу), пока
клиент не отвалился. Глазами такое не найти, а по логам — легко.

    runtime/math-eval/venv/bin/python packages/math-eval/grader/loops.py \\
        --results runtime/math-eval/runs/icarus-400/results.jsonl \\
        --graded  runtime/math-eval/runs/icarus-400/graded.jsonl \\
        --maple-dir /path/к/журналам  --budget 6 --out runtime/math-eval/runs/loops.md

`--maple-dir` необязателен: без него шаги берутся из results.jsonl (поле
mapleSteps). Если он задан, туда же дописываются сессии с самым длинным
журналом — по ним видно, какие именно вызовы повторялись.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf8").splitlines()
        if line.strip() and not line.startswith("#")
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", required=True)
    parser.add_argument("--graded", help="если есть — покажем вердикт грейдера")
    parser.add_argument("--budget", type=int, default=10, help="порог тревоги по числу вызовов Maple (в промпте бюджет мягче — ~6)")
    parser.add_argument("--slow-ms", type=int, default=60_000, help="порог «долгого» хода")
    parser.add_argument("--out")
    args = parser.parse_args()

    rows = read_jsonl(Path(args.results))
    graded = {row["id"]: row for row in read_jsonl(Path(args.graded))} if args.graded else {}

    def steps(row: dict) -> int:
        return int(row.get("mapleSteps") or 0)

    def verdict(row: dict) -> str:
        g = graded.get(row["id"])
        if not g:
            return "—"
        return "верно" if g["ok"] else str(g["method"])

    flagged = []
    for row in rows:
        reasons = []
        if row.get("error"):
            reasons.append("обрыв по таймауту")
        if steps(row) > args.budget:
            reasons.append(f"{steps(row)} вызовов Maple (бюджет {args.budget})")
        if (row.get("ms") or 0) > args.slow_ms:
            reasons.append(f"ход {round((row['ms'] or 0) / 1000)} с")
        if reasons:
            flagged.append((row, reasons))
    flagged.sort(key=lambda item: (-steps(item[0]), -(item[0].get("ms") or 0)))

    inside = [r for r in rows if steps(r) <= args.budget and not r.get("error")]
    over = [r for r in rows if steps(r) > args.budget or r.get("error")]

    def accuracy(bucket: list[dict]) -> str:
        if not graded or not bucket:
            return "—"
        good = sum(1 for r in bucket if graded.get(r["id"], {}).get("ok"))
        return f"{100 * good / len(bucket):.1f}% ({good}/{len(bucket)})"

    buckets = [(0, 0, "0"), (1, 2, "1-2"), (3, 5, "3-5"), (6, 10, "6-10"), (11, 20, "11-20"), (21, 10**6, "21+")]
    lines = ["# Зацикливания и обрывы", ""]
    lines += [
        f"- задач всего: {len(rows)}; помечено: {len(flagged)} "
        f"(обрывов {sum(1 for r in rows if r.get('error'))}, больше {args.budget} вызовов {sum(1 for r in rows if steps(r) > args.budget)})",
        f"- шагов Maple: медиана {int(statistics.median([steps(r) for r in rows] or [0]))}, "
        f"максимум {max([steps(r) for r in rows] or [0])}",
        "",
        "## Точность по числу вызовов Maple",
        "",
        "| вызовов | задач | верно | обрывов |",
        "| --- | --- | --- | --- |",
    ]
    for low, high, label in buckets:
        bucket = [r for r in rows if low <= steps(r) <= high]
        if not bucket:
            continue
        lines.append(
            f"| {label} | {len(bucket)} | {accuracy(bucket)} "
            f"| {sum(1 for r in bucket if r.get('error'))} |"
        )
    lines += [
        "",
        f"Вывод для промпта: до 6 вызовов точность держится, после 10 падает. "
        f"Мягкий бюджет в инструкции — ~6, порог тревоги здесь — {args.budget}.",
        "",
        "| задача | шагов | ход | вердикт | почему помечено |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row, reasons in flagged[:60]:
        lines.append(
            f"| `{row['id']}` | {steps(row)} | {round((row.get('ms') or 0) / 1000)} с "
            f"| {verdict(row)} | {', '.join(reasons)} |"
        )
    if len(flagged) > 60:
        lines.append(f"| … | | | | ещё {len(flagged) - 60} задач |")

    report = "\n".join(lines) + "\n"
    if args.out:
        Path(args.out).write_text(report, encoding="utf8")
    print(report[:1500])
    print(f"помечено задач: {len(flagged)}")
    if args.out:
        print(f"отчёт: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
