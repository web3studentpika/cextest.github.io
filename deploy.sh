#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8080}"
KEEPER_HTTP_TIMEOUT="${KEEPER_HTTP_TIMEOUT:-12}"
LOG_FILE="/tmp/axon-otc-${PORT}.log"

cd "$ROOT_DIR"

echo "[1/5] Installing dependencies..."
npm install

echo "[2/5] Stopping old process on port ${PORT} (if any)..."
if command -v lsof >/dev/null 2>&1; then
  OLD_PIDS="$(lsof -ti tcp:${PORT} || true)"
  if [ -n "$OLD_PIDS" ]; then
    echo "$OLD_PIDS" | xargs kill -9 || true
  fi
else
  echo "lsof not found, skip killing old process automatically."
fi

echo "[3/5] Starting server..."
nohup env PORT="$PORT" KEEPER_HTTP_TIMEOUT="$KEEPER_HTTP_TIMEOUT" node server.js > "$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "[4/5] Waiting for service to boot..."
sleep 2

echo "[5/5] Checking port status..."
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep ":${PORT}" || true
fi

echo
echo "Deploy finished."
echo "PID: $NEW_PID"
echo "URL: http://127.0.0.1:${PORT}"
echo "LOG: $LOG_FILE"
