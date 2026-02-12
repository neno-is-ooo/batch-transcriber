#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/macos"
APP_NAME="${APP_NAME:-Batch Transcriber.app}"
APP_PATH="$BUNDLE_DIR/$APP_NAME"

cd "$ROOT_DIR"

npm run tauri build -- --bundles app

if [[ ! -d "$APP_PATH" ]]; then
  echo "[package] App bundle not found: $APP_PATH" >&2
  exit 1
fi

ARCH="$(uname -m)"
STAMP="$(date +%Y%m%d-%H%M%S)"
ZIP_PATH="$BUNDLE_DIR/Batch-Transcriber_${ARCH}_${STAMP}.zip"

ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"

echo "[package] Shareable zip created: $ZIP_PATH"
