# Batch Transcriber

Desktop batch transcription for macOS with multiple local engines:

- CoreML Local (Swift worker)
- OpenAI Whisper (Python worker)
- Faster-Whisper (Python worker)

The app is built with Tauri + React and uses a shared NDJSON event protocol across providers.

## Features

- Drag/drop files and folders
- Queue with progress, retries, and per-file status
- Provider/model selection in-app
- Session history and transcript preview
- Output as `.txt`, `.json`, or both
- Buildable macOS distributables (`.app`, `.dmg`)

## Requirements

- macOS
- Node.js 18+
- Rust toolchain (`cargo`)
- Xcode Command Line Tools (`swift`)
- `uv` (for Python worker environments)

## Development

```bash
npm install
npm run tauri dev
```

## Build and Test

```bash
npm run lint
npm run test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Package For Other Macs

Build unsigned local distributables:

```bash
npm run package:mac      # creates .app + shareable zip
npm run package:mac:dmg  # creates .dmg
```

Artifacts are written under:

- `src-tauri/target/release/bundle/macos/`
- `src-tauri/target/release/bundle/dmg/`

For signed/notarized releases:

```bash
APPLE_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_NOTARY_PROFILE="YOUR_NOTARY_PROFILE" \
npm run release:mac
```

## Provider Notes

- CoreML model bundles are expected under:
  - `~/Library/Application Support/FluidAudio/Models/`
- Whisper/Faster-Whisper Python environments are prepared via `scripts/build-workers.sh`.
- Bundling scripts copy worker binaries/venvs into `src-tauri/resources` for distributable builds.

## Optional CLI Worker Run

For direct worker execution (CoreML worker path):

```bash
./scripts/bulk-transcribe.sh \
  --input-dir "/path/to/audio" \
  --output-dir "/path/to/transcripts" \
  --model-version v3 \
  --output-format both
```

## Security Bypass Guide For Friends

If you share an unsigned build and macOS blocks first launch, use:

- `README-FRIEND-MACOS.md`
