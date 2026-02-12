import path from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURES_DIR, dropAudioFile, isTauriE2EEnabled } from "./helpers";

test.describe("Tauri transcription workflow", () => {
  test.skip(
    !isTauriE2EEnabled(),
    "Set PLAYWRIGHT_TAURI_E2E=1 to run full desktop E2E against tauri dev."
  );

  test("runs a single-file transcription workflow", async ({ page }) => {
    const fixtureAudio = path.join(FIXTURES_DIR, "test-audio-short.mp3");

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Batch Transcriber" })).toBeVisible();

    await dropAudioFile(page, fixtureAudio);
    await expect(page.locator("[data-testid^='queue-item-']")).toHaveCount(1);

    await page.getByTestId("start-button").click();
    await expect(page.locator("[data-status='completed']")).toBeVisible({ timeout: 120_000 });
  });
});
