#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DESKTOP_DIR"

# Start dev server in the background
npm run dev -- --host 127.0.0.1 --port 1420 &
DEV_PID=$!

cleanup() {
  echo "smoke-ui: cleaning up..."
  kill "$DEV_PID" 2>/dev/null || true
  # Kill any leftover vite processes on port 1420
  lsof -ti:1420 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  echo "smoke-ui: cleanup done"
}
trap cleanup EXIT

# Poll until dev server is ready (up to 80 attempts, 250ms each = 20s)
echo "smoke-ui: waiting for dev server..."
OK=false
for i in $(seq 1 80); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:1420" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 400 ] 2>/dev/null; then
    OK=true
    echo "smoke-ui: dev server ready (attempt $i)"
    break
  fi
  sleep 0.25
done

if [ "$OK" != "true" ]; then
  echo "smoke-ui: dev server startup timeout" >&2
  exit 1
fi

export SMOKE_UI_URL="http://127.0.0.1:1420"
node scripts/smoke_ui_playwright.mjs
