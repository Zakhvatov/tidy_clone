#!/usr/bin/env bash
# Запуск саб-агента в фоне. Координатор запускает и потом поллит статус.
#
#   tools/agents/run.sh <role> <task-id> <prompt-file> [рабочая-директория]
#
# role: worker | reviewer | tester | auditor
# Пишет:
#   .agents/logs/<role>-<task-id>.log      — полный вывод агента
#   .agents/logs/<role>-<task-id>.status   — running | done:<code> | failed:<code>
set -uo pipefail

ROLE="${1:?role}"
TASK="${2:?task-id}"
PROMPT_FILE="${3:?prompt-file}"
WORKDIR="${4:-$(pwd)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ROLE_FILE="$ROOT/tools/agents/roles/$ROLE.md"
[ -f "$ROLE_FILE" ] || { echo "нет роли: $ROLE_FILE" >&2; exit 2; }
[ -f "$PROMPT_FILE" ] || { echo "нет промпта: $PROMPT_FILE" >&2; exit 2; }

LOGDIR="$ROOT/.agents/logs"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/$ROLE-$TASK.log"
STATUS="$LOGDIR/$ROLE-$TASK.status"
PIDFILE="$LOGDIR/$ROLE-$TASK.pid"

: > "$LOG"
echo "running" > "$STATUS"

(
  cd "$WORKDIR" || exit 3
  pi -p "$(cat "$PROMPT_FILE")" \
     --mode text \
     --no-session \
     --append-system-prompt "$(cat "$ROLE_FILE")"
) >>"$LOG" 2>&1 &
AGENT_PID=$!
echo "$AGENT_PID" > "$PIDFILE"
wait "$AGENT_PID"
CODE=$?
rm -f "$PIDFILE"

if [ "$CODE" -eq 0 ]; then
  echo "done:$CODE" > "$STATUS"
else
  echo "failed:$CODE" > "$STATUS"
fi
exit "$CODE"
