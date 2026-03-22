#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEBUG_PORT="${1:-9248}"
STARTUP_TIMEOUT="${2:-120}"

cd "$DESKTOP_DIR"

# WebKitGTK remote debugging (Linux equivalent of WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)
export WEBKIT_INSPECTOR_SERVER="127.0.0.1:$DEBUG_PORT"

echo "e2e: starting npx tauri dev (debug port=$DEBUG_PORT)..."
npx tauri dev 2>&1 &
TAURI_PID=$!

cleanup() {
  echo "e2e: cleaning up..."
  kill "$TAURI_PID" 2>/dev/null || true
  # Kill the entire process group
  kill -- -"$TAURI_PID" 2>/dev/null || true
  echo "e2e: cleanup done"
}
trap cleanup EXIT

# Wait for CDP endpoint
echo "e2e: waiting for CDP endpoint..."
MAX_ATTEMPTS=$((STARTUP_TIMEOUT * 4))
OK=false
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  RESPONSE=$(curl -s "http://127.0.0.1:$DEBUG_PORT/json/version" 2>/dev/null || echo "")
  if echo "$RESPONSE" | grep -qiE "WebKit|Chrome|WebView"; then
    OK=true
    echo "e2e: CDP endpoint ready (attempt $i)"
    break
  fi
  sleep 0.25
done

if [ "$OK" != "true" ]; then
  echo "e2e: CDP endpoint startup timeout after ${STARTUP_TIMEOUT}s" >&2
  exit 1
fi

# Small extra wait for Tauri IPC to initialize
sleep 2

export E2E_CDP_URL="http://127.0.0.1:$DEBUG_PORT"
echo "e2e: running playwright tests..."
E2E_EXIT=0
node "$SCRIPT_DIR/e2e_playwright.mjs" || E2E_EXIT=$?

echo "e2e: test exit code=$E2E_EXIT"
exit "$E2E_EXIT"
