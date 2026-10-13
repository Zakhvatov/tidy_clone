#!/usr/bin/env bash
# Статус всех саб-агентов: tools/agents/poll.sh [task-filter]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGDIR="$ROOT/.agents/logs"
FILTER="${1:-}"
[ -d "$LOGDIR" ] || { echo "нет запусков"; exit 0; }
for f in "$LOGDIR"/*.status; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .status)"
  case "$name" in *"$FILTER"*) ;; *) continue ;; esac
  st="$(cat "$f")"
  log="$LOGDIR/$name.log"
  size=$(wc -c < "$log" 2>/dev/null | tr -d ' ')
  age=$(( $(date +%s) - $(stat -f %m "$log" 2>/dev/null || echo 0) ))
  printf '%-34s %-10s bytes=%-8s idle=%ss\n' "$name" "$st" "$size" "$age"
done
