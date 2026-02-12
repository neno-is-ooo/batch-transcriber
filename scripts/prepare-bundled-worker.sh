#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/build-workers.sh"
"$ROOT_DIR/scripts/bundle-app.sh"

echo "[prepare-worker] Worker artifacts are ready."
