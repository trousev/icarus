#!/usr/bin/env python3
"""Сравнение рук на одном наборе задач: Икар с Maple против чистой модели.

Каждая рука задаётся тройкой «подпись:graded.jsonl:results.jsonl»: первый файл
даёт вердикты, второй — шаги Maple, токены и время. Отчёт отвечает на три
вопроса: кто точнее, где именно они расходятся и что даёт Maple внутри руки.

    runtime/math-eval/venv/bin/python packages/math-eval/grader/compare_arms.py \\
        --arm "Икар+Maple:runtime/math-eval/runs/icarus-400/graded.jsonl:runtime/math-eval/runs/icarus-400/results.jsonl" \\
        --arm "чистая модель:runtime/math-eval/runs/full400/graded.jsonl:runtime/math-eval/runs/full400/results.jsonl" \\
        --out runtime/math-eval/runs/compare.md
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from asymob_summary import GROUP_SIZES  # noqa: E402


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line.strip()]


def reweighted(rows: list[dict]) -> float:
    """Точность, пересчитанная на доли полного набора ASyMOB."""
    buckets: dict[str, list[dict]] = {}
    for row in rows:
        buckets.setdefault(str(row.get("group") or "—"), []).append(row)
    total = sum(GROUP_SIZES.get(name, 0) for name in buckets)
    if total == 0:
        return 0.0
    return 100 * sum(
        GROUP_SIZES.get(name, 0) * sum(1 for r in bucket if r["ok"]) / len(bucket)
        for name, bucket in buckets.items()
    ) / total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", action="append", required=True, help="подпись:graded.jsonl:results.jsonl")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    arms = []
    for spec in args.arm:
        parts = spec.split(":")
        if len(parts) != 3:
            raise SystemExit(f"ожидаю «подпись:graded:results», а не «{spec}»")
        label, graded_path, results_path = parts
        graded = read_jsonl(Path(graded_path))
        results = {row["id"]: row for row in read_jsonl(Path(results_path))}
        arms.append({"label": label, "graded": graded, "results": results})

    total = len(arms[0]["graded"])

    def share(rows: list[dict]) -> float:
        return 100 * sum(1 for row in rows if row["ok"]) / len(rows) if rows else 0.0

    lines = ["# Сравнение рук на одном наборе ASyMOB", ""]
    lines.append(f"Задач в наборе: {total}. Пересчёт — на доли полного набора ASyMOB.")
    lines += ["", "## Итоги", "", "| рука | зачтено | строго | пересчёт | трогали Maple | медиана | токенов |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for arm in arms:
        rows = arm["graded"]
        solved = sum(1 for row in rows if row["ok"])
        strict = sum(1 for row in rows if row["strict"])
        with_maple = sum(1 for row in rows if (arm["results"].get(row["id"], {}).get("mapleSteps") or 0) > 0)
        latencies = [arm["results"].get(row["id"], {}).get("ms") for row in rows]
        latencies = [value for value in latencies if value]
        tokens = sum((arm["results"].get(row["id"], {}).get("usage") or {}).get("total_tokens", 0) for row in rows)
        lines.append(
            f"| {arm['label']} | {solved}/{len(rows)} ({share(rows):.1f}%) | "
            f"{100 * strict / len(rows):.1f}% | {reweighted(rows):.1f}% | "
            f"{with_maple} ({100 * with_maple / len(rows):.0f}%) | "
            f"{int(statistics.median(latencies)) if latencies else 0} мс | {tokens} |"
        )

    lines += ["", "## По темам", "", "| тема | задач | " + " | ".join(arm["label"] for arm in arms) + " |",
              "| --- | --- | " + " | ".join("---" for _ in arms) + " |"]
    topics: dict[str, list[str]] = {}
    for arm in arms:
        for row in arm["graded"]:
            topics.setdefault(str(row.get("topic") or "—"), []).append(row["id"])
    for topic in sorted(topics):
        ids = set(topics[topic])
        cells = []
        for arm in arms:
            rows = [row for row in arm["graded"] if row["id"] in ids]
            cells.append(f"{share(rows):.1f}%")
        lines.append(f"| {topic} | {len(ids)} | " + " | ".join(cells) + " |")

    if len(arms) > 1:
        lines += ["", "## Где руки разошлись", ""]
        by_arm = [{row["id"]: row for row in arm["graded"]} for arm in arms]
        ids = sorted({row["id"] for row in arms[0]["graded"]})
        for task_id in ids:
            verdicts = [mapping.get(task_id, {}).get("ok", False) for mapping in by_arm]
            if len(set(verdicts)) == 1:
                continue
            marks = " ".join(
                f"{arm['label']}: {'ок' if verdict else '--'}" for arm, verdict in zip(arms, verdicts)
            )
            lines.append(f"- `{task_id}` — {marks}")

    lines += ["", "## Что даёт Maple внутри руки", ""]
    for arm in arms:
        with_maple = [row for row in arm["graded"] if (arm["results"].get(row["id"], {}).get("mapleSteps") or 0) > 0]
        without = [row for row in arm["graded"] if not (arm["results"].get(row["id"], {}).get("mapleSteps") or 0)]
        if not with_maple:
            lines.append(f"- {arm['label']}: Maple не звали ни разу.")
            continue
        steps = [arm["results"][row["id"]]["mapleSteps"] for row in with_maple]
        lines.append(
            f"- {arm['label']}: Maple звали в {len(with_maple)} задачах — верно {share(with_maple):.1f}% "
            f"(в среднем {statistics.mean(steps):.1f} шагов); без Maple — {len(without)} задач, верно {share(without):.1f}%."
        )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf8")
    print("\n".join(lines[:14]))
    print(f"\nотчёт: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
