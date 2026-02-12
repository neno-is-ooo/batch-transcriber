# Batch Transcriber on macOS (Unsigned Build)

This build may be blocked by Gatekeeper on first launch because it is unsigned or not notarized.

Use these steps to run it safely without disabling macOS security globally.

## 1) Verify checksum first

Ask me for the expected SHA-256 for the exact file I sent you, then verify it:

```bash
shasum -a 256 "/path/to/Batch-Transcriber_<arch>_<timestamp>.zip"
# or
shasum -a 256 "/path/to/Batch Transcriber_<version>_<arch>.dmg"
```

If the hash does not match, do not open the file.

## 2) Preferred first launch

1. Move `Batch Transcriber.app` to `/Applications`.
2. In Finder, right-click the app and choose `Open`.
3. Click `Open` again in the warning dialog.

## 3) If still blocked

1. Try to open once so macOS records the block.
2. Open `System Settings` -> `Privacy & Security`.
3. Click `Open Anyway` for Batch Transcriber.
4. Confirm `Open`.

## 4) Terminal fallback (app-only)

If Finder methods fail:

```bash
xattr -dr com.apple.quarantine "/Applications/Batch Transcriber.app"
open "/Applications/Batch Transcriber.app"
```

## 5) Important

Do **not** disable Gatekeeper system-wide.
Allow only this app after checksum verification.

## Compatibility

Use the build matching your Mac architecture:

- Apple Silicon: `arm64`
- Intel: `x64`
