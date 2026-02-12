#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCHEMA="$ROOT_DIR/tests/workers/protocol-schema.json"
VALIDATOR="$ROOT_DIR/tests/workers/validate-stream.mjs"
MANIFEST="$ROOT_DIR/tests/e2e/fixtures/test-manifest.json"
WORKER="$ROOT_DIR/swift-worker/.build/release/coreml-batch"
MODEL_DIR="${COREML_MODEL_DIR:-}"
OUTPUT_DIR="${TMPDIR:-/tmp}/coreml-worker-live-$(date +%s)"

if [[ "${COREML_WORKER_LIVE:-0}" != "1" ]]; then
  echo "Skipping live CoreML worker validation. Set COREML_WORKER_LIVE=1 to enable."
  exit 0
fi

if [[ ! -x "$WORKER" ]]; then
  echo "Missing coreml worker binary at $WORKER"
  exit 1
fi

if [[ -z "$MODEL_DIR" || ! -d "$MODEL_DIR" ]]; then
  echo "Set COREML_MODEL_DIR to a valid model directory before running live validation."
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

"$WORKER" \
  --manifest "$MANIFEST" \
  --output-dir "$OUTPUT_DIR" \
  --model-dir "$MODEL_DIR" \
  --model-version "${COREML_MODEL_VERSION:-v3}" \
  --dry-run \
  | node "$VALIDATOR" "$SCHEMA"
