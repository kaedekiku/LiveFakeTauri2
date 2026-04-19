#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# LiveFake release script
# Usage: scripts/release.sh <version> <release-notes>
# Example:
#   scripts/release.sh 0.0.50 "- サムネサイズ設定を追加
#   - ホバープレビュー遅延設定を追加"
# ============================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
TAURI_DIR="$DESKTOP_DIR/src-tauri"
OUT_DIR="$ROOT_DIR/out"
LANDING_DIR="$ROOT_DIR/apps/landing"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <version> <release-notes>"
  echo "Example: $0 0.0.50 '- feature A\n- feature B'"
  exit 1
fi

VERSION="$1"
RELEASE_NOTES="$2"
TAG="v${VERSION}"

echo "============================================"
echo " LiveFake Release ${TAG}"
echo "============================================"
echo ""
echo "Release notes:"
echo "$RELEASE_NOTES"
echo ""

# --------------------------------------------------
# 1. Version bump (3 files)
# --------------------------------------------------
echo "[1/9] Version bump -> ${VERSION}"

# package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$DESKTOP_DIR/package.json"

# tauri.conf.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$TAURI_DIR/tauri.conf.json"

# Cargo.toml (only the first version line in [package])
sed -i "0,/^version = \"[^\"]*\"/s//version = \"${VERSION}\"/" "$TAURI_DIR/Cargo.toml"

echo "  package.json:    $(grep '"version"' "$DESKTOP_DIR/package.json" | head -1 | xargs)"
echo "  tauri.conf.json: $(grep '"version"' "$TAURI_DIR/tauri.conf.json" | head -1 | xargs)"
echo "  Cargo.toml:      $(grep '^version' "$TAURI_DIR/Cargo.toml" | head -1 | xargs)"

# --------------------------------------------------
# 2. Validate (cargo check + frontend build + smoke test)
# --------------------------------------------------
echo ""
echo "[2/9] Validating..."

echo "  cargo check..."
cargo check --workspace 2>&1 | tail -1

echo "  npm build..."
(cd "$DESKTOP_DIR" && npm run build 2>&1 | tail -1)

echo "  smoke test..."
(cd "$DESKTOP_DIR" && npm run test:smoke-ui 2>&1 | tail -1)

# --------------------------------------------------
# 3. Commit & push
# --------------------------------------------------
echo ""
echo "[3/9] Commit & push"

cd "$ROOT_DIR"
git add \
  "$DESKTOP_DIR/package.json" \
  "$TAURI_DIR/tauri.conf.json" \
  "$TAURI_DIR/Cargo.toml" \
  Cargo.lock \
  "$DESKTOP_DIR/src/App.tsx" \
  "$DESKTOP_DIR/src/styles.css"

# Only add files that have changes staged
git diff --cached --quiet && { echo "No changes to commit"; exit 1; }

git commit -m "${TAG}: $(echo "$RELEASE_NOTES" | head -1)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

git push

# --------------------------------------------------
# 4. Windows build
# --------------------------------------------------
echo ""
echo "[4/9] Windows build (npx tauri build)"

(cd "$DESKTOP_DIR" && npx tauri build 2>&1 | tail -3)

# --------------------------------------------------
# 5. Create Windows ZIP & copy to out/
# --------------------------------------------------
echo ""
echo "[5/9] Create Windows ZIP"

mkdir -p "$OUT_DIR"
(cd "$ROOT_DIR/target/release" && powershell -Command "Compress-Archive -Path LiveFake.exe -DestinationPath livefake-win-x64.zip -Force")
cp "$ROOT_DIR/target/release/livefake-win-x64.zip" "$OUT_DIR/livefake-win-x64.zip"

WIN_SHA256=$(sha256sum "$OUT_DIR/livefake-win-x64.zip" | awk '{print $1}')
WIN_SIZE=$(wc -c < "$OUT_DIR/livefake-win-x64.zip" | tr -d ' ')
echo "  SHA256: ${WIN_SHA256}"
echo "  Size:   ${WIN_SIZE}"

# --------------------------------------------------
# 6. Wait for Mac build
# --------------------------------------------------
echo ""
echo "============================================"
echo " Mac版を out/ に配置してください"
echo " (Macで pull → scripts/build_mac_release.sh)"
echo "============================================"
echo ""
read -r -p "配置したらEnterを押してください..."

# Verify Mac ZIP exists
MAC_ZIP="$OUT_DIR/livefake-mac-arm64.zip"
if [[ ! -f "$MAC_ZIP" ]]; then
  echo "ERROR: $MAC_ZIP not found" >&2
  exit 1
fi

MAC_SHA256=$(sha256sum "$MAC_ZIP" | awk '{print $1}')
MAC_SIZE=$(wc -c < "$MAC_ZIP" | tr -d ' ')
echo "  Mac SHA256: ${MAC_SHA256}"
echo "  Mac Size:   ${MAC_SIZE}"

# --------------------------------------------------
# 7. Generate latest.json
# --------------------------------------------------
echo ""
echo "[7/9] Generate latest.json"

RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%S+09:00)"
DOWNLOAD_URL="https://github.com/kiyohken2000/5ch-browser-template/releases/tag/${TAG}"

python "$ROOT_DIR/scripts/prepare_release_metadata.py" \
  --version "$VERSION" \
  --released-at "$RELEASED_AT" \
  --download-page-url "$DOWNLOAD_URL" \
  --windows-zip "$OUT_DIR/livefake-win-x64.zip" \
  --mac-zip "$MAC_ZIP"

git add "$LANDING_DIR/public/latest.json"
git commit -m "release: update latest.json for ${TAG}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push

# --------------------------------------------------
# 8. GitHub Release
# --------------------------------------------------
echo ""
echo "[8/9] GitHub Release"

gh release create "$TAG" \
  "$OUT_DIR/livefake-win-x64.zip" \
  "$OUT_DIR/livefake-mac-arm64.zip" \
  --title "$TAG" \
  --notes "## Changes
${RELEASE_NOTES}"

echo "  https://github.com/kiyohken2000/5ch-browser-template/releases/tag/${TAG}"

# --------------------------------------------------
# 9. Cloudflare Pages deploy
# --------------------------------------------------
echo ""
echo "[9/9] Cloudflare Pages deploy"

(cd "$LANDING_DIR" && npx wrangler pages deploy public --project-name=livefake 2>&1 | tail -2)

echo ""
echo "============================================"
echo " Release ${TAG} complete!"
echo "============================================"
