#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCHEMA="$ROOT_DIR/tests/workers/protocol-schema.json"
VALIDATOR="$ROOT_DIR/tests/workers/validate-stream.mjs"
MANIFEST="$ROOT_DIR/tests/e2e/fixtures/test-manifest.json"
WORKER_PROJECT="$ROOT_DIR/workers/whisper-batch"
OUTPUT_DIR="${TMPDIR:-/tmp}/whisper-worker-live-$(date +%s)"

if [[ "${WHISPER_WORKER_LIVE:-0}" != "1" ]]; then
  echo "Skipping live whisper worker validation. Set WHISPER_WORKER_LIVE=1 to enable."
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required for live whisper worker validation."
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

uv run --project "$WORKER_PROJECT" whisper-batch \
  --manifest "$MANIFEST" \
  --output-dir "$OUTPUT_DIR" \
  --model "${WHISPER_MODEL:-base}" \
  | node "$VALIDATOR" "$SCHEMA"
