#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
release-macos.sh

Builds, signs, notarizes, staples, and zips a macOS app bundle.

Required env vars:
  APPLE_SIGN_IDENTITY   Developer ID Application certificate name
  APPLE_NOTARY_PROFILE  notarytool keychain profile name

Optional env vars:
  BUNDLES               Tauri bundle targets (default: app)

Flags:
  --skip-notary         Skip notarization/stapling (still signs)
  --help                Show this message

Example:
  APPLE_SIGN_IDENTITY="Developer ID Application: Example, Inc. (TEAMID)" \
  APPLE_NOTARY_PROFILE="AC_NOTARY" \
  ./scripts/release-macos.sh
EOF
}

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/macos"
APP_NAME="${APP_NAME:-Batch Transcriber.app}"
APP_PATH="$BUNDLE_DIR/$APP_NAME"
ENTITLEMENTS_PATH="$ROOT_DIR/src-tauri/Parakeet_Batch_Transcriber.entitlements"
BUNDLES="${BUNDLES:-app}"
CODESIGN_BIN="${CODESIGN_BIN:-/usr/bin/codesign}"
SKIP_NOTARY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-notary)
      SKIP_NOTARY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[release] Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

SIGN_IDENTITY="${APPLE_SIGN_IDENTITY:-}"
NOTARY_PROFILE="${APPLE_NOTARY_PROFILE:-}"

if [[ -z "$SIGN_IDENTITY" ]]; then
  echo "[release] APPLE_SIGN_IDENTITY is required." >&2
  exit 1
fi

if [[ "$SKIP_NOTARY" -ne 1 && -z "$NOTARY_PROFILE" ]]; then
  echo "[release] APPLE_NOTARY_PROFILE is required unless --skip-notary is used." >&2
  exit 1
fi

if [[ ! -f "$ENTITLEMENTS_PATH" ]]; then
  echo "[release] Entitlements file not found: $ENTITLEMENTS_PATH" >&2
  exit 1
fi

sign_binary() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    return 0
  fi

  "$CODESIGN_BIN" \
    --force \
    --timestamp \
    --options runtime \
    --entitlements "$ENTITLEMENTS_PATH" \
    --sign "$SIGN_IDENTITY" \
    "$target"
}

find_resource_path() {
  local relative="$1"
  local direct="$APP_PATH/Contents/Resources/$relative"
  local nested="$APP_PATH/Contents/Resources/resources/$relative"

  if [[ -e "$direct" ]]; then
    echo "$direct"
    return 0
  fi

  if [[ -e "$nested" ]]; then
    echo "$nested"
    return 0
  fi

  return 1
}

sign_python_venv() {
  local venv_root="$1"

  if [[ ! -d "$venv_root" ]]; then
    return 0
  fi

  while IFS= read -r -d '' library; do
    sign_binary "$library"
  done < <(find "$venv_root" -type f \( -name "*.dylib" -o -name "*.so" \) -print0 | sort -z)

  if [[ -d "$venv_root/bin" ]]; then
    while IFS= read -r -d '' executable; do
      sign_binary "$executable"
    done < <(find "$venv_root/bin" -type f -perm -111 -print0 | sort -z)
  fi
}

cd "$ROOT_DIR"

echo "[release] Building frontend..."
npm run build

echo "[release] Building worker artifacts..."
"$ROOT_DIR/scripts/build-workers.sh"

echo "[release] Bundling worker artifacts into src-tauri/resources..."
"$ROOT_DIR/scripts/bundle-app.sh"

echo "[release] Building app bundle (bundles=$BUNDLES)..."
npm run tauri build -- --bundles "$BUNDLES"

if [[ ! -d "$APP_PATH" ]]; then
  echo "[release] App bundle not found: $APP_PATH" >&2
  exit 1
fi

echo "[release] Signing Python venv payloads (if bundled)..."
if whisper_venv="$(find_resource_path "whisper-venv")"; then
  sign_python_venv "$whisper_venv"
fi
if faster_whisper_venv="$(find_resource_path "faster-whisper-venv")"; then
  sign_python_venv "$faster_whisper_venv"
fi

echo "[release] Signing nested app binaries..."
if swift_worker="$(find_resource_path "parakeet-batch")"; then
  sign_binary "$swift_worker"
fi
if swift_modelctl="$(find_resource_path "parakeet-modelctl")"; then
  sign_binary "$swift_modelctl"
fi

if [[ -f "$APP_PATH/Contents/MacOS/tauri-app" ]]; then
  sign_binary "$APP_PATH/Contents/MacOS/tauri-app"
fi

if [[ -d "$APP_PATH/Contents/Frameworks" ]]; then
  while IFS= read -r framework_bin; do
    sign_binary "$framework_bin"
  done < <(find "$APP_PATH/Contents/Frameworks" -type f \( -perm -111 -o -name "*.dylib" \))
fi

echo "[release] Signing app bundle..."
sign_binary "$APP_PATH"
"$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$APP_PATH"

ARCH="$(uname -m)"
STAMP="$(date +%Y%m%d-%H%M%S)"
NOTARY_ZIP="$BUNDLE_DIR/Batch-Transcriber_notary_${ARCH}_${STAMP}.zip"
FINAL_ZIP="$BUNDLE_DIR/Batch-Transcriber_signed_${ARCH}_${STAMP}.zip"

echo "[release] Creating notarization zip..."
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARY_ZIP"

if [[ "$SKIP_NOTARY" -eq 1 ]]; then
  echo "[release] Skipping notarization and stapling."
else
  echo "[release] Submitting notarization request..."
  xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait

  echo "[release] Stapling notarization ticket..."
  xcrun stapler staple "$APP_PATH"
  xcrun stapler validate "$APP_PATH"

  echo "[release] Gatekeeper assessment..."
  spctl --assess --type execute --verbose=4 "$APP_PATH"
fi

echo "[release] Creating shareable release zip..."
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$FINAL_ZIP"

echo "[release] Done."
echo "[release] App: $APP_PATH"
echo "[release] Zip: $FINAL_ZIP"
