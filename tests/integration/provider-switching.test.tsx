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
];

function setTauriRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

describe("Provider switching integration", () => {
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
        id: "seed-provider-integration",
        path: "/audio/provider-switch.wav",
        name: "provider-switch.wav",
        size: 2_048,
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

  it("updates model options when provider changes and keeps queue state", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("provider-select")).toHaveValue("parakeet-coreml");
      expect(screen.getByTestId("model-select")).toHaveValue("v3");
      expect(screen.getByText("provider-switch.wav")).toBeInTheDocument();
    });

    expect(screen.getByRole("option", { name: /v3 \(Multilingual\)/i })).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("provider-select"), {
      target: { value: "whisper-openai" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("provider-select")).toHaveValue("whisper-openai");
      expect(screen.getByTestId("model-select")).toHaveValue("large-v3");
    });

    expect(screen.getByRole("option", { name: /Large v3 - Best quality/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /v2 \(English\)/i })).not.toBeInTheDocument();
    expect(screen.getByText("provider-switch.wav")).toBeInTheDocument();
    expect(useQueue.getState().items).toHaveLength(1);
  });
});
