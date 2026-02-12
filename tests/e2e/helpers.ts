import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const E2E_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(E2E_ROOT, "fixtures");

export function isTauriE2EEnabled(): boolean {
  return process.env.PLAYWRIGHT_TAURI_E2E === "1";
}

export async function dropAudioFile(page: Page, absolutePath: string): Promise<void> {
  await page.evaluate(({ filePath }) => {
    const dropZone = document.querySelector<HTMLElement>("[data-testid='drop-zone']");
    if (!dropZone) {
      throw new Error("drop-zone not found");
    }

    const fileName = filePath.split(/[\\/]/u).pop() || "audio.wav";
    const file = new File(["fixture"], fileName, { type: "audio/wav" });
    Object.defineProperty(file, "path", {
      value: filePath,
      configurable: true,
    });

    const dataTransfer = {
      types: ["Files"],
      files: [file],
      items: [
        {
          kind: "file",
          getAsFile: () => file,
          webkitGetAsEntry: () => ({
            isDirectory: false,
            fullPath: filePath,
          }),
        },
      ],
    };

    const dropEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
    });

    Object.defineProperty(dropEvent, "dataTransfer", {
      value: dataTransfer,
      configurable: true,
    });

    dropZone.dispatchEvent(dropEvent);
  }, {
    filePath: absolutePath,
  });
}
