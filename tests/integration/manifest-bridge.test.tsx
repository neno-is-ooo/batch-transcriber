import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { useQueue } from "../../src/hooks/useQueue";

const { invokeMock, listenMock, saveMock, openDialogMock, openPathMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn().mockResolvedValue(vi.fn()),
  saveMock: vi.fn(),
  openDialogMock: vi.fn(),
  openPathMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: saveMock,
  open: openDialogMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: openPathMock,
}));

const PROVIDERS_FIXTURE = [
  {
    id: "coreml-local",
    name: "CoreML Local",
    available: true,
    runtime: {
      type: "SwiftNative",
      binaryPath: "/tmp/coreml-batch",
      modelDir: "/tmp/models",
    },
  },
];

function setTauriRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

describe("Manifest bridge integration", () => {
  beforeEach(() => {
    setTauriRuntime();
    localStorage.clear();
    useQueue.reset();
    invokeMock.mockReset();
    listenMock.mockClear();
    saveMock.mockReset();
    openDialogMock.mockReset();
    openPathMock.mockReset();

    useQueue.getState().addItems([
      {
        id: "seed-manifest-bridge",
        path: "/audio/inputs/bridge.wav",
        relativePath: "inputs/bridge.wav",
        name: "bridge.wav",
        size: 4_096,
        status: "idle",
        progress: 0,
      },
    ]);

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "start_transcription") {
        return Promise.resolve("session-manifest-bridge");
      }

      if (command === "register_file_open_listener") {
        return Promise.resolve([]);
      }

      if (command === "get_session_history") {
        return Promise.resolve([]);
      }

      if (command === "check_notification_permission") {
        return Promise.resolve(true);
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    localStorage.clear();
    useQueue.reset();
  });

  it("passes queue items and settings to start_transcription", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("start-button")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("start-button"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "start_transcription",
        expect.objectContaining({
          provider: "coreml-local",
          model: "v3",
          outputDir: "/tmp/batch-transcripts",
          items: [
            expect.objectContaining({
              path: "/audio/inputs/bridge.wav",
              relativePath: "inputs/bridge.wav",
            }),
          ],
          settings: expect.objectContaining({
            outputFormat: "both",
            notificationsEnabled: true,
            notifyOnComplete: true,
            notifyOnError: true,
          }),
        })
      );
    });
  });
});
