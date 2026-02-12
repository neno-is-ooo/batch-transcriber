import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
];

function setTauriRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

function createFileWithPath(path: string): File {
  const file = new File(["audio"], path.split("/").pop() ?? "audio.wav", {
    type: "audio/wav",
  });

  Object.defineProperty(file, "path", {
    value: path,
    configurable: true,
  });

  return file;
}

function createDropEvent(paths: string[]): { dataTransfer: DataTransfer } {
  const files = paths.map(createFileWithPath);
  const items = files.map((file) => ({
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => ({
      isDirectory: false,
      fullPath: "",
    }),
  }));

  return {
    dataTransfer: {
      types: ["Files"],
      items: items as unknown as DataTransferItemList,
      files: files as unknown as FileList,
    } as DataTransfer,
  };
}

describe("Queue workflow integration", () => {
  beforeEach(() => {
    setTauriRuntime();
    localStorage.clear();
    useQueue.reset();
    invokeMock.mockReset();
    listenMock.mockClear();
    saveMock.mockReset();
    openDialogMock.mockReset();
    openPathMock.mockReset();

    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "scan_files") {
        const paths = (args.paths as string[]) ?? [];
        return Promise.resolve(
          paths.map((path) => ({
            id: `scanned-${path}`,
            path,
            name: path.split("/").pop() ?? path,
            size: 1_024,
            status: "idle",
            progress: 0,
          }))
        );
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

  it("adds dropped files and renders queue items", async () => {
    render(<App />);

    const dropZone = await screen.findByTestId("drop-zone");
    fireEvent.drop(
      dropZone,
      createDropEvent(["/audio/integration-a.wav", "/audio/integration-b.mp3"])
    );

    await waitFor(() => {
      expect(screen.getByTestId("queue-list")).toBeInTheDocument();
    });

    const queueList = screen.getByTestId("queue-list");
    expect(within(queueList).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("integration-a.wav")).toBeInTheDocument();
    expect(screen.getByText("integration-b.mp3")).toBeInTheDocument();
  });

  it("updates queue item status when transcription events arrive", async () => {
    render(<App />);

    fireEvent.drop(
      await screen.findByTestId("drop-zone"),
      createDropEvent(["/audio/workflow.wav"])
    );

    await waitFor(() => {
      expect(useQueue.getState().items).toHaveLength(1);
    });

    const [item] = useQueue.getState().items;

    useQueue.getState().handleEvent({
      event: "file_started",
      index: 1,
      total: 1,
      file: item.path,
      relative: "workflow.wav",
    });

    await waitFor(() => {
      const node = screen
        .getByTestId(`queue-item-${item.id}`)
        .querySelector("[data-status='processing']");
      expect(node).not.toBeNull();
    });

    useQueue.getState().handleEvent({
      event: "file_done",
      index: 1,
      file: item.path,
      duration_seconds: 4.2,
      processing_seconds: 1.1,
      rtfx: 3.8,
      confidence: 0.91,
      output: {
        txt: "/tmp/workflow.txt",
      },
    });

    await waitFor(() => {
      const node = screen
        .getByTestId(`queue-item-${item.id}`)
        .querySelector("[data-status='completed']");
      expect(node).not.toBeNull();
    });
  });
});
