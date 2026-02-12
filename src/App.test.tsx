import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { useQueue } from "./hooks/useQueue";

const { invokeMock, listenMock, saveMock, openDialogMock, openPathMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue([]),
  listenMock: vi.fn().mockResolvedValue(vi.fn()),
  saveMock: vi.fn(),
  openDialogMock: vi.fn(),
  openPathMock: vi.fn(),
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
    capabilities: {
      speedEstimate: 2.1,
      wordTimestamps: true,
      speakerDiarization: false,
      languages: ["en", "fr"],
    },
  },
];

function setTauriRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invokeMock.mockClear();
  listenMock.mockClear();
  getCurrentWindowMock.mockClear();
  onDragDropEventMock.mockClear();
  saveMock.mockClear();
  openDialogMock.mockClear();
  openPathMock.mockClear();
  localStorage.clear();
  useQueue.reset();
});

beforeEach(() => {
  localStorage.clear();
  useQueue.reset();
  getCurrentWindowMock.mockReturnValue({
    onDragDropEvent: onDragDropEventMock,
  });
  invokeMock.mockImplementation((command: string) => {
    if (command === "get_providers") {
      return Promise.resolve(PROVIDERS_FIXTURE);
    }

    return Promise.resolve([]);
  });
  saveMock.mockResolvedValue("/exports/transcripts.zip");
  openDialogMock.mockResolvedValue(null);
  openPathMock.mockResolvedValue(undefined);
});

describe("App", () => {
  it("does not render custom titlebar in web mode", () => {
    render(<App />);

    expect(screen.queryByTestId("titlebar")).not.toBeInTheDocument();
    expect(screen.getByText("Desktop runtime not detected.")).toBeInTheDocument();
  });

  it("renders and validates Tauri bridge when available", async () => {
    setTauriRuntime();

    render(<App />);

    expect(
      screen.getByRole("heading", {
        name: "Batch Transcriber",
      })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("titlebar")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_model_catalog");
    });
    expect(listenMock).toHaveBeenCalledWith("transcription-event", expect.any(Function));

    expect(screen.getByText("Ready to transcribe.")).toBeInTheDocument();
  });

  it("starts and stops transcription through tauri commands", async () => {
    setTauriRuntime();

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "start_transcription") {
        return Promise.resolve("session-abc");
      }

      if (command === "stop_transcription") {
        return Promise.resolve(undefined);
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    useQueue.getState().addItems([
      {
        id: "seed-audio",
        path: "/audio/input.wav",
        name: "input.wav",
        size: 2_048,
        status: "idle",
        progress: 0,
      },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Ready to transcribe.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /transcribe 1 item/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "start_transcription",
        expect.objectContaining({
          provider: "parakeet-coreml",
          model: "v3",
          outputDir: "/tmp/parakeet-transcripts",
          settings: expect.objectContaining({
            outputFormat: "both",
            notificationsEnabled: true,
            notifyOnComplete: true,
            notifyOnError: true,
          }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("stop-button")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("stop-button"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /stop now/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("stop_transcription", {
        sessionId: "session-abc",
      });
    });
  });

  it("syncs native menu state with queue status", async () => {
    setTauriRuntime();

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "start_transcription") {
        return Promise.resolve("session-menu");
      }

      if (command === "stop_transcription") {
        return Promise.resolve(undefined);
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    useQueue.getState().addItems([
      {
        id: "menu-state-audio",
        path: "/audio/menu-state.wav",
        name: "menu-state.wav",
        size: 1_024,
        status: "idle",
        progress: 0,
      },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("update_menu_state", {
        hasItems: true,
        isProcessing: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /transcribe 1 item/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("update_menu_state", {
        hasItems: true,
        isProcessing: true,
      });
    });
  });

  it("handles files-selected menu event and scans dropped paths", async () => {
    setTauriRuntime();

    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, handler);
      return Promise.resolve(vi.fn());
    });

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

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    render(<App />);

    await waitFor(() => {
      expect(listeners.has("files-selected")).toBe(true);
    });

    const handler = listeners.get("files-selected");
    if (!handler) {
      throw new Error("Expected files-selected handler to be registered");
    }

    handler({
      payload: ["/audio/from-menu.wav"],
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("scan_files", {
        paths: ["/audio/from-menu.wav"],
      });
    });

    expect(screen.getByText("from-menu.wav")).toBeInTheDocument();
  });

  it("handles native drag-drop events for files and folders", async () => {
    setTauriRuntime();

    let dragDropHandler:
      | ((event: { payload: { type: string; paths?: string[] } }) => void)
      | undefined;
    onDragDropEventMock.mockImplementation(
      (handler: (event: { payload: { type: string; paths?: string[] } }) => void) => {
        dragDropHandler = handler;
        return Promise.resolve(vi.fn());
      }
    );

    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "register_file_open_listener") {
        return Promise.resolve([]);
      }

      if (command === "scan_files") {
        const paths = (args.paths as string[]) ?? [];
        const [path] = paths;

        if (path === "/audio/folder-drop") {
          return Promise.reject(new Error("Path is not a file"));
        }

        return Promise.resolve([
          {
            id: `file-${path}`,
            path,
            name: path.split("/").pop() ?? path,
            size: 1_024,
            status: "idle",
            progress: 0,
          },
        ]);
      }

      if (command === "scan_directory") {
        const path = args.path as string;
        return Promise.resolve([
          {
            id: `dir-${path}`,
            path: `${path}/inside.wav`,
            name: "inside.wav",
            size: 2_048,
            status: "idle",
            progress: 0,
          },
        ]);
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    render(<App />);

    await waitFor(() => {
      expect(onDragDropEventMock).toHaveBeenCalledTimes(1);
    });

    if (!dragDropHandler) {
      throw new Error("Expected drag-drop handler to be registered");
    }

    dragDropHandler({
      payload: {
        type: "drop",
        paths: ["/audio/native-drop.wav", "/audio/folder-drop"],
      },
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("scan_files", {
        paths: ["/audio/native-drop.wav"],
      });
      expect(invokeMock).toHaveBeenCalledWith("scan_files", {
        paths: ["/audio/folder-drop"],
      });
      expect(invokeMock).toHaveBeenCalledWith("scan_directory", {
        path: "/audio/folder-drop",
        recursive: true,
      });
    });

    expect(screen.getByText("native-drop.wav")).toBeInTheDocument();
    expect(screen.getByText("inside.wav")).toBeInTheDocument();
  });

  it("hydrates pending files-opened paths on cold start and shows ready toast", async () => {
    setTauriRuntime();

    listenMock.mockImplementation(() => Promise.resolve(vi.fn()));

    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "register_file_open_listener") {
        return Promise.resolve(["/audio/cold-open.wav"]);
      }

      if (command === "scan_files") {
        const paths = (args.paths as string[]) ?? [];
        return Promise.resolve(
          paths.map((path) => ({
            id: `cold-${path}`,
            path,
            name: path.split("/").pop() ?? path,
            size: 512,
            status: "idle",
            progress: 0,
          }))
        );
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("register_file_open_listener");
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("scan_files", {
        paths: ["/audio/cold-open.wav"],
      });
    });

    expect(screen.getByText("cold-open.wav")).toBeInTheDocument();
    expect(
      screen.getByText("Ready to transcribe. Added 1 file(s) to queue.")
    ).toBeInTheDocument();
  });

  it("shows queued warning toast when files-opened arrives during processing", async () => {
    setTauriRuntime();

    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, handler);
      return Promise.resolve(vi.fn());
    });

    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "register_file_open_listener") {
        return Promise.resolve([]);
      }

      if (command === "scan_files") {
        const paths = (args.paths as string[]) ?? [];
        return Promise.resolve(
          paths.map((path) => ({
            id: `live-${path}`,
            path,
            name: path.split("/").pop() ?? path,
            size: 256,
            status: "idle",
            progress: 0,
          }))
        );
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    useQueue.getState().setProcessing("session-live");

    render(<App />);

    await waitFor(() => {
      expect(listeners.has("files-opened")).toBe(true);
    });

    const handler = listeners.get("files-opened");
    if (!handler) {
      throw new Error("Expected files-opened handler to be registered");
    }

    handler({
      payload: ["/audio/live-open.wav"],
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("scan_files", {
        paths: ["/audio/live-open.wav"],
      });
    });

    await waitFor(() => {
      expect(
        screen.getByText("Files queued - will process after current batch")
      ).toBeInTheDocument();
    });
  });

  it("starts transcription from menu-start-transcription event", async () => {
    setTauriRuntime();

    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, handler);
      return Promise.resolve(vi.fn());
    });

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "start_transcription") {
        return Promise.resolve("session-from-menu");
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    useQueue.getState().addItems([
      {
        id: "start-from-menu-item",
        path: "/audio/start-from-menu.wav",
        name: "start-from-menu.wav",
        size: 2_048,
        status: "idle",
        progress: 0,
      },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(listeners.has("menu-start-transcription")).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /transcribe 1 item/i })).toBeInTheDocument();
    });

    const handler = listeners.get("menu-start-transcription");
    if (!handler) {
      throw new Error("Expected menu-start-transcription handler to be registered");
    }

    handler({ payload: null });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "start_transcription",
        expect.objectContaining({
          provider: "parakeet-coreml",
          model: "v3",
          outputDir: "/tmp/parakeet-transcripts",
        })
      );
    });
  });

  it("toggles in-app quick look via space shortcut for selected queue item", async () => {
    setTauriRuntime();

    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "read_transcript") {
        const path = (args?.path as string | undefined) ?? "";
        return Promise.resolve(path.includes("preview") ? "Preview transcript" : "");
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    useQueue.getState().addItems([
      {
        id: "quick-look-item",
        path: "/audio/preview.wav",
        name: "preview.wav",
        size: 1_024,
        transcriptPath: "/output/preview.txt",
        status: "idle",
        progress: 0,
      },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("preview.wav")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("preview.wav"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-look-overlay")).toHaveClass("quick-look-overlay--open");
      expect(screen.getByText("Preview transcript")).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: " " });

    await waitFor(() => {
      expect(screen.getByTestId("quick-look-overlay")).not.toHaveClass("quick-look-overlay--open");
    });

    fireEvent.keyDown(window, { key: " " });

    await waitFor(() => {
      expect(screen.getByTestId("quick-look-overlay")).toHaveClass("quick-look-overlay--open");
    });
  });

  it("navigates quick look items with arrow keys and closes on escape", async () => {
    setTauriRuntime();

    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }

      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }

      if (command === "read_transcript") {
        const path = (args?.path as string | undefined) ?? "";
        if (path.endsWith("first.txt")) {
          return Promise.resolve("First transcript");
        }
        if (path.endsWith("second.txt")) {
          return Promise.resolve("Second transcript");
        }
        return Promise.resolve("");
      }

      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    useQueue.getState().addItems([
      {
        id: "quick-look-item-1",
        path: "/audio/first.wav",
        name: "first.wav",
        size: 1_024,
        transcriptPath: "/output/first.txt",
        status: "idle",
        progress: 0,
      },
      {
        id: "quick-look-item-2",
        path: "/audio/second.wav",
        name: "second.wav",
        size: 1_024,
        transcriptPath: "/output/second.txt",
        status: "idle",
        progress: 0,
      },
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("first.wav")).toBeInTheDocument();
      expect(screen.getByText("second.wav")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("first.wav"));

    await waitFor(() => {
      expect(screen.getByText("First transcript")).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: "ArrowRight" });

    await waitFor(() => {
      expect(screen.getByText("Second transcript")).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByTestId("quick-look-overlay")).not.toHaveClass("quick-look-overlay--open");
    });
  });

  it("exports completed transcripts through the export dialog", async () => {
    setTauriRuntime();

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }
      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }
      if (command === "get_session_history") {
        return Promise.resolve([]);
      }
      if (command === "export_transcripts") {
        return Promise.resolve("/exports/transcripts.zip");
      }
      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    useQueue.getState().addItems([
      {
        id: "export-item",
        path: "/audio/export.wav",
        name: "export.wav",
        size: 2_048,
        status: "idle",
        progress: 0,
      },
    ]);
    const [item] = useQueue.getState().items;
    useQueue.getState().updateItem(item.id, {
      status: "completed",
      progress: 100,
      transcriptPath: "/tmp/parakeet-transcripts/export.txt",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Export ZIP" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Export ZIP" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith(
        "export_transcripts",
        expect.objectContaining({
          destination: "/exports/transcripts.zip",
          options: expect.objectContaining({
            format: "zip",
            naming: "preserve",
          }),
        })
      );
    });
  });

  it("loads history and reopens a selected session into the queue", async () => {
    setTauriRuntime();

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_model_catalog") {
        return Promise.resolve([]);
      }
      if (command === "get_providers") {
        return Promise.resolve(PROVIDERS_FIXTURE);
      }
      if (command === "get_session_history") {
        return Promise.resolve([
          {
            id: "session-h1",
            createdAt: 1_707_696_000,
            provider: "parakeet-coreml",
            model: "v3",
            outputDir: "/tmp/out",
            manifestPath: "/tmp/sessions/session-h1.json",
            total: 1,
            processed: 1,
            skipped: 0,
            failed: 0,
            durationSeconds: 6.2,
            exitCode: 0,
            status: "completed",
            files: [
              {
                id: "file-h1",
                path: "/audio/history.wav",
                name: "history.wav",
                status: "success",
                transcriptPath: "/tmp/out/history.txt",
              },
            ],
          },
        ]);
      }
      if (command === "update_menu_state") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve([]);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("session-h1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reopen Session" }));

    await waitFor(() => {
      expect(within(screen.getByTestId("queue-list")).getByText("history.wav")).toBeInTheDocument();
    });
  });
});
