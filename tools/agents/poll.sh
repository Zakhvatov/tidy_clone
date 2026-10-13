#!/usr/bin/env bash
# Статус всех саб-агентов: tools/agents/poll.sh [task-filter]
#
# Состояние определяется двумя признаками:
#   1) живой процесс по pid-файлу  → RUNNING
#   2) маркер отчёта в логе       → DONE(лог), даже если обёртку убили
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
  pidfile="$LOGDIR/$name.pid"
  size=$(wc -c < "$log" 2>/dev/null | tr -d ' ')

  alive=""
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    info=$(ps -o etime=,time= -p "$pid" 2>/dev/null | tr -s ' ' | sed 's/^ //')
    [ -n "$info" ] && alive="RUNNING pid=$pid elapsed/cpu=$info"
  fi

  marker=""
  if grep -qE '## (ОТЧЁТ|РЕВЬЮ|ТЕСТ|АУДИТ)' "$log" 2>/dev/null; then
    marker="DONE(лог: есть отчёт)"
  fi

  if [ -n "$alive" ]; then
    printf '%-34s %-10s bytes=%-8s %s\n' "$name" "$st" "$size" "$alive"
  elif [ -n "$marker" ]; then
    printf '%-34s %-10s bytes=%-8s %s\n' "$name" "$st" "$size" "$marker"
  else
    printf '%-34s %-10s bytes=%-8s НЕ ЗАВЕРШЁН И НЕ ЖИВ — проверить лог\n' "$name" "$st" "$size"
  fi
done
