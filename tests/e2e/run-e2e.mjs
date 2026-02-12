import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const enabled = process.env.PLAYWRIGHT_TAURI_E2E === "1";

if (!enabled) {
  process.stdout.write(
    "Skipping E2E: set PLAYWRIGHT_TAURI_E2E=1 to run Playwright desktop tests.\n"
  );
  process.exit(0);
}

let hasPlaywright = true;
try {
  require.resolve("@playwright/test");
} catch {
  hasPlaywright = false;
}

if (!hasPlaywright) {
  process.stdout.write(
    "Skipping E2E: @playwright/test is not installed in this environment.\n"
  );
  process.exit(0);
}

const extraArgs = process.argv.slice(2);
const run = spawnSync("npx", ["playwright", "test", ...extraArgs], {
  stdio: "inherit",
});

if (typeof run.status === "number") {
  process.exit(run.status);
}

process.exit(1);
