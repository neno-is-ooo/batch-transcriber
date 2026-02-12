#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SWIFT_WORKER_DIR="$ROOT_DIR/swift-worker/.build/release"
RESOURCES_DIR="$ROOT_DIR/src-tauri/resources"

log() {
  echo "[bundle-app] $1"
}

warn() {
  echo "[bundle-app] $1" >&2
}

copy_binary() {
  local source_path="$1"
  local target_path="$2"

  if [[ ! -f "$source_path" ]]; then
    warn "Missing required binary: ${source_path}"
    exit 1
  fi

  cp "$source_path" "$target_path"
  chmod +x "$target_path"
}

copy_venv() {
  local source_dir="$1"
  local target_dir="$2"
  local display_name="$3"

  if [[ ! -d "$source_dir" ]]; then
    warn "Skipping ${display_name}: ${source_dir} was not found"
    return 0
  fi

  mkdir -p "$target_dir"
  cp -R "$source_dir"/. "$target_dir"/
  log "Bundled ${display_name} into ${target_dir}"
}

mkdir -p "$RESOURCES_DIR"

copy_binary "$SWIFT_WORKER_DIR/parakeet-batch" "$RESOURCES_DIR/parakeet-batch"
copy_binary "$SWIFT_WORKER_DIR/parakeet-modelctl" "$RESOURCES_DIR/parakeet-modelctl"

copy_venv "$ROOT_DIR/workers/whisper-batch/.venv" "$RESOURCES_DIR/whisper-venv" "whisper venv"
copy_venv "$ROOT_DIR/workers/faster-whisper-batch/.venv" "$RESOURCES_DIR/faster-whisper-venv" "faster-whisper venv"

log "Workers bundled into ${RESOURCES_DIR}"
