#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SWIFT_WORKER_DIR="$ROOT_DIR/swift-worker"
SWIFT_BATCH_BIN="$SWIFT_WORKER_DIR/.build/release/parakeet-batch"
SWIFT_MODELCTL_BIN="$SWIFT_WORKER_DIR/.build/release/parakeet-modelctl"
WHISPER_WORKER_DIR="$ROOT_DIR/workers/whisper-batch"
FASTER_WHISPER_WORKER_DIR="$ROOT_DIR/workers/faster-whisper-batch"

log() {
  echo "[build-workers] $1"
}

warn() {
  echo "[build-workers] $1" >&2
}

prepare_python_worker() {
  local worker_dir="$1"
  local worker_name="$2"

  if [[ ! -d "$worker_dir" ]]; then
    warn "Skipping ${worker_name}: missing directory (${worker_dir})"
    return 0
  fi

  if ! command -v uv >/dev/null 2>&1; then
    warn "Skipping ${worker_name}: 'uv' command not found"
    return 0
  fi

  log "Preparing ${worker_name} Python environment..."
  (
    cd "$worker_dir"
    uv venv --relocatable --clear .venv
    uv pip install --python .venv/bin/python .
  )
}

if [[ ! -d "$SWIFT_WORKER_DIR" ]]; then
  warn "Swift worker directory is missing: ${SWIFT_WORKER_DIR}"
  exit 1
fi

log "Building Swift workers..."
(
  cd "$SWIFT_WORKER_DIR"
  swift build -c release
)

if [[ ! -x "$SWIFT_BATCH_BIN" ]]; then
  warn "Missing Swift worker binary: ${SWIFT_BATCH_BIN}"
  exit 1
fi

if [[ ! -x "$SWIFT_MODELCTL_BIN" ]]; then
  warn "Missing Swift model manager binary: ${SWIFT_MODELCTL_BIN}"
  exit 1
fi

prepare_python_worker "$WHISPER_WORKER_DIR" "whisper-batch"
prepare_python_worker "$FASTER_WHISPER_WORKER_DIR" "faster-whisper-batch"

log "Done."
