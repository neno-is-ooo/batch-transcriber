import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanProgress } from "./tauri-commands";
import {
  checkNotificationPermission,
  deleteSession,
  exportTranscripts,
  exportTranscript,
  getProviders,
  getSessionHistory,
  healthCheck,
  onScanProgress,
  readTranscript,
  registerFileOpenListener,
  requestNotificationPermission,
  resolveProviderRuntime,
  scanDirectory,
  scanFiles,
  startTranscription,
  stopTranscription,
  updateMenuState,
} from "./tauri-commands";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

describe("tauri-commands", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("invokes scan_files with paths", async () => {
    const expected = [{ path: "/audio/a.mp3" }];
    invokeMock.mockResolvedValueOnce(expected);

    await expect(scanFiles(["/audio/a.mp3"]))
      .resolves
      .toEqual(expected);

    expect(invokeMock).toHaveBeenCalledWith("scan_files", {
      paths: ["/audio/a.mp3"],
    });
  });

  it("invokes scan_directory with args", async () => {
    const expected = [{ path: "/audio/folder/a.wav" }];
    invokeMock.mockResolvedValueOnce(expected);

    await expect(scanDirectory("/audio/folder", true))
      .resolves
      .toEqual(expected);

    expect(invokeMock).toHaveBeenCalledWith("scan_directory", {
      path: "/audio/folder",
      recursive: true,
    });
  });

  it("wraps invoke errors with command context", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));

    await expect(scanFiles(["/audio/a.mp3"]))
      .rejects
      .toThrow("scan_files failed: boom");
  });

  it("invokes get_providers without args", async () => {
    const expected = [{ id: "parakeet-coreml", available: true }];
    invokeMock.mockResolvedValueOnce(expected);

    await expect(getProviders()).resolves.toEqual(expected);

    expect(invokeMock).toHaveBeenCalledWith("get_providers");
  });

  it("invokes resolve_provider_runtime with providerId and model", async () => {
    const expected = {
      type: "PythonUv",
      package: "whisper-batch",
      entryPoint: "whisper_batch",
    };
    invokeMock.mockResolvedValueOnce(expected);

    await expect(resolveProviderRuntime("whisper-openai", "base")).resolves.toEqual(expected);

    expect(invokeMock).toHaveBeenCalledWith("resolve_provider_runtime", {
      providerId: "whisper-openai",
      model: "base",
    });
  });

  it("subscribes to scan-progress and forwards payloads", async () => {
    let callback: ((event: { payload: ScanProgress }) => void) | undefined;
    const unlisten = vi.fn();

    listenMock.mockImplementationOnce(
      (_eventName: string, handler: (event: { payload: ScanProgress }) => void) => {
        callback = handler;
        return Promise.resolve(unlisten);
      }
    );

    const progressHandler = vi.fn();
    const unsub = await onScanProgress(progressHandler);

    expect(listenMock).toHaveBeenCalledWith("scan-progress", expect.any(Function));

    if (!callback) {
      throw new Error("scan-progress callback was not registered");
    }

    callback({
      payload: {
        found: 3,
        scanned: 8,
        currentPath: "/audio/folder/a.wav",
      },
    });

    expect(progressHandler).toHaveBeenCalledWith({
      found: 3,
      scanned: 8,
      currentPath: "/audio/folder/a.wav",
    });

    unsub();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("invokes start_transcription with session payload", async () => {
    const expected = "session-abc";
    invokeMock.mockResolvedValueOnce(expected);

    await expect(
      startTranscription(
        [
          {
            id: "1",
            path: "/audio/a.wav",
            name: "a.wav",
            size: 123,
            status: "idle",
            progress: 0,
          },
        ],
        "parakeet-coreml",
        "v3",
        "/tmp/out",
        {
          outputFormat: "both",
          recursive: true,
          overwrite: false,
          maxRetries: 1,
          extensions: ["wav"],
          ffmpegFallback: true,
          dryRun: false,
          notificationsEnabled: true,
          notifyOnComplete: true,
          notifyOnError: false,
        }
      )
    ).resolves.toBe(expected);

    expect(invokeMock).toHaveBeenCalledWith("start_transcription", {
      items: [
        {
          id: "1",
          path: "/audio/a.wav",
          name: "a.wav",
          size: 123,
          status: "idle",
          progress: 0,
        },
      ],
      provider: "parakeet-coreml",
      model: "v3",
      outputDir: "/tmp/out",
      settings: {
        outputFormat: "both",
        recursive: true,
        overwrite: false,
        maxRetries: 1,
        extensions: ["wav"],
        ffmpegFallback: true,
        dryRun: false,
        notificationsEnabled: true,
        notifyOnComplete: true,
        notifyOnError: false,
      },
    });
  });

  it("invokes stop_transcription with session id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(stopTranscription("session-abc")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("stop_transcription", {
      sessionId: "session-abc",
    });
  });

  it("invokes update_menu_state with queue flags", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(updateMenuState(true, false)).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("update_menu_state", {
      hasItems: true,
      isProcessing: false,
    });
  });

  it("invokes register_file_open_listener without args", async () => {
    const expected = ["/audio/opened-from-finder.wav"];
    invokeMock.mockResolvedValueOnce(expected);

    await expect(registerFileOpenListener()).resolves.toEqual(expected);

    expect(invokeMock).toHaveBeenCalledWith("register_file_open_listener");
  });

  it("invokes read_transcript with selected path", async () => {
    invokeMock.mockResolvedValueOnce("transcript text");

    await expect(readTranscript("/audio/a.txt")).resolves.toBe("transcript text");

    expect(invokeMock).toHaveBeenCalledWith("read_transcript", {
      path: "/audio/a.txt",
    });
  });

  it("invokes export_transcript with source and destination", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(
      exportTranscript("/audio/a.txt", "/exports/a.txt")
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("export_transcript", {
      sourcePath: "/audio/a.txt",
      destinationPath: "/exports/a.txt",
    });
  });

  it("wraps read_transcript invoke errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("permission denied"));

    await expect(readTranscript("/audio/a.txt")).rejects.toThrow(
      "read_transcript failed: permission denied"
    );
  });

  it("wraps export_transcript invoke errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("copy failed"));

    await expect(exportTranscript("/audio/a.txt", "/exports/a.txt")).rejects.toThrow(
      "export_transcript failed: copy failed"
    );
  });

  it("invokes export_transcripts with options", async () => {
    invokeMock.mockResolvedValueOnce("/exports/bundle.zip");

    await expect(
      exportTranscripts(
        [
          {
            id: "item-1",
            path: "/audio/a.wav",
            name: "a.wav",
            size: 100,
            status: "completed",
            progress: 100,
            transcriptPath: "/output/a.txt",
          },
        ],
        "/exports/bundle.zip",
        {
          format: "zip",
          naming: "preserve",
          includeMetadata: true,
          preserveStructure: false,
        }
      )
    ).resolves.toBe("/exports/bundle.zip");

    expect(invokeMock).toHaveBeenCalledWith("export_transcripts", {
      items: [
        {
          id: "item-1",
          path: "/audio/a.wav",
          name: "a.wav",
          size: 100,
          status: "completed",
          progress: 100,
          transcriptPath: "/output/a.txt",
        },
      ],
      destination: "/exports/bundle.zip",
      options: {
        format: "zip",
        naming: "preserve",
        includeMetadata: true,
        preserveStructure: false,
      },
    });
  });

  it("invokes get_session_history and delete_session", async () => {
    const expected = [{ id: "session-a", createdAt: 1, files: [] }];
    invokeMock.mockResolvedValueOnce(expected);
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(getSessionHistory()).resolves.toEqual(expected);
    expect(invokeMock).toHaveBeenCalledWith("get_session_history");

    await expect(deleteSession("session-a")).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("delete_session", { sessionId: "session-a" });
  });

  it("wraps export_transcripts and history invoke errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("zip failed"));
    await expect(
      exportTranscripts([], "/exports/bundle.zip", {
        format: "zip",
        naming: "preserve",
        includeMetadata: true,
        preserveStructure: false,
      })
    ).rejects.toThrow("export_transcripts failed: zip failed");

    invokeMock.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(getSessionHistory()).rejects.toThrow("get_session_history failed: db unavailable");

    invokeMock.mockRejectedValueOnce(new Error("not found"));
    await expect(deleteSession("missing")).rejects.toThrow("delete_session failed: not found");
  });

  it("invokes check_notification_permission without args", async () => {
    invokeMock.mockResolvedValueOnce(true);

    await expect(checkNotificationPermission()).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("check_notification_permission");
  });

  it("invokes request_notification_permission without args", async () => {
    invokeMock.mockResolvedValueOnce(false);

    await expect(requestNotificationPermission()).resolves.toBe(false);

    expect(invokeMock).toHaveBeenCalledWith("request_notification_permission");
  });

  it("invokes health_check without args", async () => {
    invokeMock.mockResolvedValueOnce({
      swiftOk: true,
      whisperOk: false,
      ffprobeOk: true,
    });

    await expect(healthCheck()).resolves.toEqual({
      swiftOk: true,
      whisperOk: false,
      ffprobeOk: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("health_check");
  });

  it("wraps health_check invoke errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("probe failed"));

    await expect(healthCheck()).rejects.toThrow("health_check failed: probe failed");
  });
});
