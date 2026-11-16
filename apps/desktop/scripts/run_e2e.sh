#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEBUG_PORT="${1:-9248}"
STARTUP_TIMEOUT="${2:-120}"

cd "$DESKTOP_DIR"

# WebKitGTK remote debugging (Linux equivalent of WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)
export WEBKIT_INSPECTOR_SERVER="127.0.0.1:$DEBUG_PORT"

# Refuse to run when something already answers on the debug port (the tests would attach to that app)
if curl -s --max-time 2 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
  echo "e2e: port $DEBUG_PORT is already answering. Close that app or pass another port. Nothing was started." >&2
  exit 1
fi

# Data folder: always a fresh, empty folder made for this run (never the everyday / development data).
# A marker is planted in it; e2e_playwright.mjs checks the marker before its first write.
DATA_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)/target/e2e-data"
mkdir -p "$DATA_ROOT"
DATA_DIR="$(mktemp -d "$DATA_ROOT/run-XXXXXXXX")"
E2E_DATA_MARKER="e2e-marker-$(date +%s)-$$-$RANDOM"
printf '{"boards":[{"boardName":"%s","url":"https://e2e-marker.invalid/"}],"threads":[]}' "$E2E_DATA_MARKER" > "$DATA_DIR/favorites.json"
export EMBER_DATA_DIR="$DATA_DIR"
export E2E_DATA_MARKER
echo "e2e: data folder for this run: $DATA_DIR"

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

# Remove the data folder of this run only when the tests passed (keep it for inspection otherwise)
if [ "$E2E_EXIT" = "0" ]; then
  cleanup
  trap - EXIT
  case "$DATA_DIR" in
    "$DATA_ROOT"/run-*) rm -rf -- "${DATA_DIR:?}" ;;
  esac
else
  echo "e2e: data folder kept: $DATA_DIR"
fi

echo "e2e: test exit code=$E2E_EXIT"
exit "$E2E_EXIT"
