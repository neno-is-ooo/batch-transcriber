import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const BUILD_WORKERS_SCRIPT = join(REPO_ROOT, "scripts", "build-workers.sh");
const BUNDLE_APP_SCRIPT = join(REPO_ROOT, "scripts", "bundle-app.sh");
const RELEASE_MACOS_SCRIPT = join(REPO_ROOT, "scripts", "release-macos.sh");

function makeExecutable(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function makeTempRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `tm17-${name}-`));
}

describe("build-workers.sh", () => {
  it("builds swift workers and prepares both python worker envs", () => {
    const root = makeTempRoot("build-workers-all");
    const binDir = join(root, "bin");
    const callLog = join(root, "calls.log");

    mkdirSync(join(root, "swift-worker"), { recursive: true });
    mkdirSync(join(root, "workers", "whisper-batch"), { recursive: true });
    mkdirSync(join(root, "workers", "faster-whisper-batch"), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    makeExecutable(
      join(binDir, "swift"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "swift:$PWD:$*" >> "$CALL_LOG"
mkdir -p ".build/release"
printf '#!/usr/bin/env bash\nexit 0\n' > ".build/release/parakeet-batch"
printf '#!/usr/bin/env bash\nexit 0\n' > ".build/release/parakeet-modelctl"
chmod +x ".build/release/parakeet-batch" ".build/release/parakeet-modelctl"
`
    );

    makeExecutable(
      join(binDir, "uv"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "uv:$PWD:$*" >> "$CALL_LOG"
if [[ "$1" == "venv" ]]; then
  mkdir -p ".venv/bin"
  touch ".venv/bin/python"
fi
`
    );

    const result = spawnSync("bash", [BUILD_WORKERS_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        ROOT_DIR: root,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CALL_LOG: callLog,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(root, "swift-worker", ".build", "release", "parakeet-batch"))).toBe(true);
    expect(existsSync(join(root, "swift-worker", ".build", "release", "parakeet-modelctl"))).toBe(true);
    expect(existsSync(join(root, "workers", "whisper-batch", ".venv", "bin", "python"))).toBe(true);
    expect(existsSync(join(root, "workers", "faster-whisper-batch", ".venv", "bin", "python"))).toBe(true);

    const calls = readFileSync(callLog, "utf8");
    expect(calls).toContain("swift:");
    expect(calls).toContain("uv:");
    expect(calls).toContain("whisper-batch:venv --relocatable --clear .venv");
    expect(calls).toContain("whisper-batch:pip install --python .venv/bin/python .");
    expect(calls).toContain("faster-whisper-batch:venv --relocatable --clear .venv");
    expect(calls).toContain("faster-whisper-batch:pip install --python .venv/bin/python .");
  });

  it("skips missing python worker directories with a warning", () => {
    const root = makeTempRoot("build-workers-missing");
    const binDir = join(root, "bin");

    mkdirSync(join(root, "swift-worker"), { recursive: true });
    mkdirSync(join(root, "workers", "whisper-batch"), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    makeExecutable(
      join(binDir, "swift"),
      `#!/usr/bin/env bash
set -euo pipefail
mkdir -p ".build/release"
printf '#!/usr/bin/env bash\nexit 0\n' > ".build/release/parakeet-batch"
printf '#!/usr/bin/env bash\nexit 0\n' > ".build/release/parakeet-modelctl"
chmod +x ".build/release/parakeet-batch" ".build/release/parakeet-modelctl"
`
    );

    makeExecutable(
      join(binDir, "uv"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "venv" ]]; then
  mkdir -p ".venv/bin"
  touch ".venv/bin/python"
fi
`
    );

    const result = spawnSync("bash", [BUILD_WORKERS_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        ROOT_DIR: root,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Skipping faster-whisper-batch");
  });
});

describe("bundle-app.sh", () => {
  it("copies swift binaries and python venvs into src-tauri/resources", () => {
    const root = makeTempRoot("bundle-app");

    makeExecutable(
      join(root, "swift-worker", ".build", "release", "parakeet-batch"),
      "#!/usr/bin/env bash\nexit 0\n"
    );
    makeExecutable(
      join(root, "swift-worker", ".build", "release", "parakeet-modelctl"),
      "#!/usr/bin/env bash\nexit 0\n"
    );

    mkdirSync(join(root, "workers", "whisper-batch", ".venv", "bin"), { recursive: true });
    writeFileSync(join(root, "workers", "whisper-batch", ".venv", "bin", "python"), "");
    mkdirSync(join(root, "workers", "faster-whisper-batch", ".venv", "bin"), { recursive: true });
    writeFileSync(join(root, "workers", "faster-whisper-batch", ".venv", "bin", "python"), "");

    const result = spawnSync("bash", [BUNDLE_APP_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        ROOT_DIR: root,
      },
    });

    expect(result.status).toBe(0);
    const bundledBatch = join(root, "src-tauri", "resources", "parakeet-batch");
    const bundledModelctl = join(root, "src-tauri", "resources", "parakeet-modelctl");
    const bundledWhisperPy = join(root, "src-tauri", "resources", "whisper-venv", "bin", "python");

    expect(existsSync(bundledBatch)).toBe(true);
    expect(existsSync(bundledModelctl)).toBe(true);
    expect(existsSync(bundledWhisperPy)).toBe(true);
    expect((statSync(bundledBatch).mode & 0o111) !== 0).toBe(true);
    expect((statSync(bundledModelctl).mode & 0o111) !== 0).toBe(true);
  });
});

describe("release-macos.sh", () => {
  it("signs nested python payloads and app bundle with entitlements", () => {
    const root = makeTempRoot("release-macos");
    const binDir = join(root, "bin");
    const codesignLog = join(root, "codesign.log");
    const npmLog = join(root, "npm.log");
    const releaseStepLog = join(root, "release-step.log");
    const entitlementsPath = join(root, "src-tauri", "Batch_Transcriber.entitlements");

    mkdirSync(binDir, { recursive: true });
    mkdirSync(dirname(entitlementsPath), { recursive: true });
    writeFileSync(
      entitlementsPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict></dict></plist>
`
    );

    makeExecutable(
      join(root, "scripts", "build-workers.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "build-workers" >> "$RELEASE_STEP_LOG"
`
    );
    makeExecutable(
      join(root, "scripts", "bundle-app.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "bundle-app" >> "$RELEASE_STEP_LOG"
`
    );

    makeExecutable(
      join(binDir, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$NPM_LOG"
if [[ "$1" == "run" && "$2" == "tauri" && "$3" == "build" ]]; then
  app="$ROOT_DIR/src-tauri/target/release/bundle/macos/Batch Transcriber.app"
  mkdir -p "$app/Contents/MacOS"
  mkdir -p "$app/Contents/Frameworks"
  mkdir -p "$app/Contents/Resources/resources/whisper-venv/bin"
  mkdir -p "$app/Contents/Resources/resources/whisper-venv/lib"
  mkdir -p "$app/Contents/Resources/resources/faster-whisper-venv/bin"
  mkdir -p "$app/Contents/Resources/resources/faster-whisper-venv/lib"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$app/Contents/MacOS/tauri-app"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$app/Contents/Resources/resources/parakeet-batch"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$app/Contents/Resources/resources/parakeet-modelctl"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$app/Contents/Resources/resources/whisper-venv/bin/python"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$app/Contents/Resources/resources/faster-whisper-venv/bin/python3"
  touch "$app/Contents/Resources/resources/whisper-venv/lib/libwhisper.so"
  touch "$app/Contents/Resources/resources/faster-whisper-venv/lib/libfaster.dylib"
  chmod +x "$app/Contents/MacOS/tauri-app"
  chmod +x "$app/Contents/Resources/resources/parakeet-batch"
  chmod +x "$app/Contents/Resources/resources/parakeet-modelctl"
  chmod +x "$app/Contents/Resources/resources/whisper-venv/bin/python"
  chmod +x "$app/Contents/Resources/resources/faster-whisper-venv/bin/python3"
fi
`
    );

    makeExecutable(
      join(binDir, "codesign"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$CODESIGN_LOG"
`
    );
    makeExecutable(
      join(binDir, "ditto"),
      `#!/usr/bin/env bash
set -euo pipefail
output="\${@: -1}"
mkdir -p "$(dirname "$output")"
touch "$output"
`
    );
    makeExecutable(join(binDir, "xcrun"), "#!/usr/bin/env bash\nset -euo pipefail\n");
    makeExecutable(join(binDir, "spctl"), "#!/usr/bin/env bash\nset -euo pipefail\n");

    const result = spawnSync("bash", [RELEASE_MACOS_SCRIPT, "--skip-notary"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ROOT_DIR: root,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CODESIGN_BIN: "codesign",
        APPLE_SIGN_IDENTITY: "Developer ID Application: Test (TEAMID)",
        CODESIGN_LOG: codesignLog,
        NPM_LOG: npmLog,
        RELEASE_STEP_LOG: releaseStepLog,
      },
    });

    expect(result.status).toBe(0);

    const stepLog = readFileSync(releaseStepLog, "utf8");
    expect(stepLog).toContain("build-workers");
    expect(stepLog).toContain("bundle-app");

    const codesignCalls = readFileSync(codesignLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(codesignCalls.length).toBeGreaterThan(0);
    const signingCalls = codesignCalls.filter((call) => call.includes("--sign"));
    expect(signingCalls.length).toBeGreaterThan(0);
    signingCalls.forEach((call) => {
      expect(call).toContain("--entitlements");
      expect(call).toContain(entitlementsPath);
    });

    const libIndex = signingCalls.findIndex((call) => call.includes("libwhisper.so"));
    const dylibIndex = signingCalls.findIndex((call) => call.includes("libfaster.dylib"));
    const venvBinIndex = signingCalls.findIndex((call) => call.includes("whisper-venv/bin/python"));
    const swiftBinIndex = signingCalls.findIndex((call) => call.includes("resources/parakeet-batch"));
    const appIndex = signingCalls.findIndex((call) => call.endsWith("Batch Transcriber.app"));

    expect(libIndex).toBeGreaterThanOrEqual(0);
    expect(dylibIndex).toBeGreaterThanOrEqual(0);
    expect(venvBinIndex).toBeGreaterThanOrEqual(0);
    expect(swiftBinIndex).toBeGreaterThanOrEqual(0);
    expect(appIndex).toBeGreaterThanOrEqual(0);
    expect(libIndex).toBeLessThan(appIndex);
    expect(venvBinIndex).toBeLessThan(appIndex);
    expect(swiftBinIndex).toBeLessThan(appIndex);

    const bundleDir = join(root, "src-tauri", "target", "release", "bundle", "macos");
    const zipOutputs = readdirSync(bundleDir).filter((name) => name.endsWith(".zip"));
    expect(zipOutputs.length).toBeGreaterThan(0);
  });
});
