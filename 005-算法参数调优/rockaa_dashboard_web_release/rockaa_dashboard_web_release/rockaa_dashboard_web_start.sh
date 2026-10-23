#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export ROCKAA_PLATFORMS="${ROCKAA_PLATFORMS:-$(pwd)/platforms}"
LOG_FILE="rockaa_dashboard.log"
PID_FILE="rockaa_dashboard.pid"

bridge_port_from_log() {
  grep -m1 "Serving dashboard:" "$LOG_FILE" 2>/dev/null \
    | grep -oE ":[0-9]+/" | tr -d ":/" || true
}

# Foreground mode keeps the classic behaviour (Ctrl+C to stop).
if [ "${1:-}" = "--foreground" ]; then
  shift
  exec node bridge/adb-bridge.js --open "$@"
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PORT="$(bridge_port_from_log)"
  echo "RockAA Dashboard is already running (PID $(cat "$PID_FILE"))."
  [ -n "$PORT" ] && echo "URL: http://127.0.0.1:${PORT}/"
  echo "Stop it with: kill \$(cat $PID_FILE)${PORT:+  (or ROCKAA_BRIDGE_PORT=$PORT node bridge/adb-bridge.js --stop)}"
  exit 0
fi

nohup node bridge/adb-bridge.js --open "$@" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

URL=""
for _ in $(seq 1 24); do
  URL="$(grep -m1 "Serving dashboard:" "$LOG_FILE" 2>/dev/null || true)"
  [ -n "$URL" ] && break
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Bridge exited during startup; last log lines:"
    tail -5 "$LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.25
done

PORT="$(bridge_port_from_log)"
echo "RockAA Dashboard started in background (PID $(cat "$PID_FILE"))."
[ -n "$URL" ] && echo "$URL"
echo "Logs:   $LOG_FILE"
echo "Stop:   kill \$(cat $PID_FILE)${PORT:+  (or ROCKAA_BRIDGE_PORT=$PORT node bridge/adb-bridge.js --stop)}"
