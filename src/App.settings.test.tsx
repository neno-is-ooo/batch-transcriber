import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { useQueue } from "./hooks/useQueue";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn().mockResolvedValue(vi.fn()),
}));

const { getCurrentWindowMock, onDragDropEventMock } = vi.hoisted(() => ({
  getCurrentWindowMock: vi.fn(),
  onDragDropEventMock: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

function setTauriRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

describe("App settings panel", () => {
  beforeEach(() => {
    localStorage.clear();
    useQueue.reset();
    invokeMock.mockReset();
    listenMock.mockClear();
    getCurrentWindowMock.mockClear();
    onDragDropEventMock.mockClear();
    getCurrentWindowMock.mockReturnValue({
      onDragDropEvent: onDragDropEventMock,
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    useQueue.reset();
  });

  it("persists provider, model, output format, and notifications preferences", async () => {
    setTauriRuntime();

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve([
          {
            id: "parakeet-coreml",
            name: "Parakeet CoreML",
            available: true,
            runtime: {
              type: "SwiftNative",
              binaryPath: "/tmp/parakeet-batch",
              modelDir: "/tmp/models",
            },
          },
          {
            id: "whisper-openai",
            name: "Whisper (OpenAI)",
            available: true,
            runtime: {
              type: "PythonUv",
              package: "whisper-batch",
              entryPoint: "whisper_batch",
            },
          },
        ]);
      }

      return Promise.resolve([]);
    });

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("provider-select")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("provider-select"), {
      target: { value: "whisper-openai" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("model-select")).toHaveValue("large-v3");
    });

    fireEvent.change(screen.getByTestId("model-select"), {
      target: { value: "medium" },
    });

    fireEvent.change(screen.getByTestId("output-format-select"), {
      target: { value: "json" },
    });

    const notificationsToggle = screen.getByTestId("notifications-toggle") as HTMLInputElement;
    const notifyOnCompleteToggle = screen.getByTestId(
      "notify-on-complete-toggle"
    ) as HTMLInputElement;
    const notifyOnErrorToggle = screen.getByTestId("notify-on-error-toggle") as HTMLInputElement;

    expect(notificationsToggle.checked).toBe(true);
    expect(notifyOnCompleteToggle.checked).toBe(true);
    expect(notifyOnErrorToggle.checked).toBe(true);

    fireEvent.click(notifyOnCompleteToggle);
    expect(notifyOnCompleteToggle.checked).toBe(false);

    fireEvent.click(notifyOnErrorToggle);
    expect(notifyOnErrorToggle.checked).toBe(false);

    fireEvent.click(notificationsToggle);
    expect(notificationsToggle.checked).toBe(false);
    expect(notifyOnCompleteToggle.disabled).toBe(true);
    expect(notifyOnErrorToggle.disabled).toBe(true);

    unmount();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("provider-select")).toHaveValue("whisper-openai");
    });

    expect(screen.getByTestId("model-select")).toHaveValue("medium");
    expect(screen.getByTestId("output-format-select")).toHaveValue("json");
    expect((screen.getByTestId("notifications-toggle") as HTMLInputElement).checked).toBe(false);
    expect(
      (screen.getByTestId("notify-on-complete-toggle") as HTMLInputElement).checked
    ).toBe(false);
    expect(
      (screen.getByTestId("notify-on-error-toggle") as HTMLInputElement).checked
    ).toBe(false);
  });

  it("updates provider availability when provider probe is refreshed", async () => {
    setTauriRuntime();

    const unavailableProviders = [
      {
        id: "faster-whisper",
        name: "Faster Whisper",
        available: false,
        runtime: {
          type: "PythonUv",
          package: "faster-whisper-batch",
          entryPoint: "faster_whisper_batch",
        },
        installInstructions:
          "Install or fix the `faster-whisper-batch` runtime so `uv run --package faster-whisper-batch -- --version` succeeds.",
      },
    ];

    const availableProviders = [
      {
        id: "faster-whisper",
        name: "Faster Whisper",
        available: true,
        runtime: {
          type: "PythonUv",
          package: "faster-whisper-batch",
          entryPoint: "faster_whisper_batch",
        },
        capabilities: {
          speedEstimate: 4.2,
          wordTimestamps: true,
          speakerDiarization: true,
          languages: ["en", "es"],
        },
      },
    ];

    let providersCallCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        providersCallCount += 1;
        return Promise.resolve(
          providersCallCount === 1 ? unavailableProviders : availableProviders
        );
      }

      return Promise.resolve([]);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Not Installed")).toBeInTheDocument();
    });

    expect(screen.getByTestId("install-instructions")).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByTestId("provider-selector")).getByRole("button", { name: "Refresh" })
    );

    await waitFor(() => {
      expect(screen.getByText("Ready")).toBeInTheDocument();
    });

    expect(screen.getByTestId("capabilities-grid")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("get_providers");
  });
});
