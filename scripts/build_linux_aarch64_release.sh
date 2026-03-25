#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
OUT_DIR="$ROOT_DIR/out"
ZIP_PATH="$OUT_DIR/ember-linux-aarch64.zip"
BUILD_INFO_PATH="$OUT_DIR/build-info.txt"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script is for Linux only." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
  echo "This script must be run on an AArch64 (ARM64) system. Detected: $ARCH" >&2
  exit 1
fi

echo "[1/6] Update main"
git -C "$ROOT_DIR" pull --ff-only

echo "[2/6] npm install"
pushd "$DESKTOP_DIR" > /dev/null
npm install
if git -C "$ROOT_DIR" ls-files --error-unmatch "apps/desktop/package-lock.json" > /dev/null 2>&1; then
  if ! git -C "$ROOT_DIR" diff --quiet -- "apps/desktop/package-lock.json"; then
    git -C "$ROOT_DIR" restore "apps/desktop/package-lock.json"
  fi
else
  rm -f "$DESKTOP_DIR/package-lock.json"
fi

echo "[3/6] tauri build (linux aarch64 override config)"
TMP_CONFIG="$(mktemp /tmp/tauri-linux-aarch64-build-override.XXXXXX.json)"
trap 'rm -f "$TMP_CONFIG"' EXIT
cat > "$TMP_CONFIG" <<'JSON'
{
  "bundle": {
    "icon": [
      "icons/icon.png"
    ],
    "targets": [
      "appimage",
      "deb",
      "rpm"
    ]
  }
}
JSON
npm run tauri:build -- --config "$TMP_CONFIG"
popd > /dev/null

APPIMAGE_PATH="$(ls -t "$ROOT_DIR"/target/release/bundle/appimage/*.AppImage 2>/dev/null | head -n 1 || true)"
DEB_PATH="$(ls -t "$ROOT_DIR"/target/release/bundle/deb/*.deb 2>/dev/null | head -n 1 || true)"
RPM_PATH="$(ls -t "$ROOT_DIR"/target/release/bundle/rpm/*.rpm 2>/dev/null | head -n 1 || true)"

if [[ -z "$APPIMAGE_PATH" || ! -f "$APPIMAGE_PATH" ]]; then
  echo "AppImage not found under target/release/bundle/appimage" >&2
  exit 1
fi

echo "[4/6] Create ZIP"
mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"
zip -j "$ZIP_PATH" "$APPIMAGE_PATH" > /dev/null

# Copy .deb and .rpm alongside if available
if [[ -n "$DEB_PATH" && -f "$DEB_PATH" ]]; then
  cp "$DEB_PATH" "$OUT_DIR/"
fi
if [[ -n "$RPM_PATH" && -f "$RPM_PATH" ]]; then
  cp "$RPM_PATH" "$OUT_DIR/"
fi

echo "[5/6] Write build metadata"
ZIP_SIZE="$(stat -c%s "$ZIP_PATH")"
ZIP_SHA256="$(sha256sum "$ZIP_PATH" | awk '{print $1}')"
APPIMAGE_NAME="$(basename "$APPIMAGE_PATH")"

cat > "$BUILD_INFO_PATH" <<EOF
zip path: $ZIP_PATH
zip size(bytes): $ZIP_SIZE
zip sha256: $ZIP_SHA256
appimage filename: $APPIMAGE_NAME
EOF

if [[ -n "$DEB_PATH" && -f "$DEB_PATH" ]]; then
  DEB_OUT="$OUT_DIR/$(basename "$DEB_PATH")"
  echo "deb path: $DEB_OUT" >> "$BUILD_INFO_PATH"
  echo "deb sha256: $(sha256sum "$DEB_OUT" | awk '{print $1}')" >> "$BUILD_INFO_PATH"
fi
if [[ -n "$RPM_PATH" && -f "$RPM_PATH" ]]; then
  RPM_OUT="$OUT_DIR/$(basename "$RPM_PATH")"
  echo "rpm path: $RPM_OUT" >> "$BUILD_INFO_PATH"
  echo "rpm sha256: $(sha256sum "$RPM_OUT" | awk '{print $1}')" >> "$BUILD_INFO_PATH"
fi

echo "[6/6] Done"
echo "ZIP:  $ZIP_PATH"
echo "INFO: $BUILD_INFO_PATH"
[[ -n "$DEB_PATH" && -f "$DEB_PATH" ]] && echo "DEB:  $OUT_DIR/$(basename "$DEB_PATH")"
[[ -n "$RPM_PATH" && -f "$RPM_PATH" ]] && echo "RPM:  $OUT_DIR/$(basename "$RPM_PATH")"
