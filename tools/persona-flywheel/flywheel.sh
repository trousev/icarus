#!/usr/bin/env bash
# Стенд «прокачка персоны Икара». Все артефакты — внутри tools/persona-flywheel/.
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  step)
    # step <label> <prompt.md> [доп. флаги]
    label="${2:?label}"
    prompt="${3:?prompt.md}"
    shift 3
    exec node step.mjs --label "$label" --in "$prompt" "$@"
    ;;
  compare)
    # compare <label> <prompt.md> [сценарии]
    label="${2:?label}"
    prompt="${3:?prompt.md}"
    scenarios="${4:-banter,real-grief,stress-support,provocation,sad-joke,absurd-request}"
    exec node compare.mjs --label "$label" --in "$prompt" --scenarios "$scenarios"
    ;;
  duel)
    # duel <label> <promptA.md> <promptB.md> [--set core|probe] [--scenarios a,b]
    label="${2:?label}"
    a="${3:?promptA.md}"
    b="${4:?promptB.md}"
    shift 4
    exec node duel.mjs --label "$label" --a "$a" --b "$b" "$@"
    ;;
  table)
    exec node leaderboard.mjs
    ;;
  budget)
    exec ./budget.sh "${2:-../../icarus.md}"
    ;;
  *)
    cat <<'USAGE'
Использование:
  ./flywheel.sh step <label> <prompt.md> [--scenarios a,b] [--set core|probe] [--no-critic] [--concurrency 5]
  ./flywheel.sh duel <label> <promptA.md> <promptB.md> [--set core|probe] [--scenarios a,b]
  ./flywheel.sh compare <label> <prompt.md> [сценарии]
  ./flywheel.sh table
  ./flywheel.sh budget [prompt.md]

Артефакты: logs/<label>/{prompt.md,scores.json,report.md,next-persona.md,critique.json}
USAGE
    ;;
esac
