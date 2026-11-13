#!/usr/bin/env bash
# Prompt size reference. There is no hard limit anymore: during bootstrapping it kept
# the prompt in check; now it's a guideline (1–2 A4 pages ≈ 90 non-empty lines).
set -euo pipefail
cd "$(dirname "$0")"
file="${1:-persona.md}"
lines=$(grep -c '[^[:space:]]' "$file" || true)
chars=$(wc -m < "$file")
echo "$file: непустых строк $lines, символов $chars"
if [ "$lines" -gt 90 ]; then
  echo "ориентир 90 строк превышен — не ошибка, но проверь, что каждая новая строка работает"
fi
