import { defineConfig } from "@playwright/test";
import process from "node:process";

const runTauriE2E = process.env.PLAYWRIGHT_TAURI_E2E === "1";
const tauriBaseUrl = process.env.PLAYWRIGHT_TAURI_BASE_URL ?? "http://127.0.0.1:1420";
const tauriDevCommand = process.env.PLAYWRIGHT_TAURI_COMMAND ?? "npm run tauri dev";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
  ],
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: tauriBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  ...(runTauriE2E
    ? {
        webServer: {
          command: tauriDevCommand,
          url: tauriBaseUrl,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
        },
      }
    : {}),
});
