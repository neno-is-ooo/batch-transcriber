#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/swift-worker"
WORKER_BIN="$WORKER_DIR/.build/release/coreml-batch"

if [[ ! -x "$WORKER_BIN" ]]; then
  echo "[coreml-batch] building worker..." >&2
  (
    cd "$WORKER_DIR"
    swift build -c release
  )
fi

exec "$WORKER_BIN" "$@"
