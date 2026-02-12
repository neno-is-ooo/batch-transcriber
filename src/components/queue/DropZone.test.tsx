import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropZone } from "./DropZone";
import type { QueueItem } from "../../types/queue";
import type { ScanProgress } from "../../lib/tauri-commands";

const { scanFilesMock, scanDirectoryMock, onScanProgressMock } = vi.hoisted(() => ({
  scanFilesMock: vi.fn(),
  scanDirectoryMock: vi.fn(),
  onScanProgressMock: vi.fn(),
}));

vi.mock("../../lib/tauri-commands", () => ({
  scanFiles: scanFilesMock,
  scanDirectory: scanDirectoryMock,
  onScanProgress: onScanProgressMock,
}));

function createQueueItem(path: string): QueueItem {
  return {
    id: `seed-${path}`,
    path,
    name: path.split("/").pop() ?? "audio.wav",
    size: 1_024,
    status: "idle",
    progress: 0,
  };
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

function createDropItem(
  file: File,
  options: { isDirectory?: boolean; fullPath?: string } = {}
): DataTransferItem {
  return {
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => ({
      isDirectory: options.isDirectory ?? false,
      fullPath: options.fullPath,
    }),
  } as unknown as DataTransferItem;
}

function createDataTransfer(options: {
  types?: string[];
  items?: DataTransferItem[];
  files?: File[];
}): DataTransfer {
  return {
    types: options.types ?? ["Files"],
    items: (options.items ?? []) as unknown as DataTransferItemList,
    files: (options.files ?? []) as unknown as FileList,
  } as unknown as DataTransfer;
}

describe("DropZone", () => {
  beforeEach(() => {
    scanFilesMock.mockReset();
    scanDirectoryMock.mockReset();
    onScanProgressMock.mockReset();

    scanFilesMock.mockResolvedValue([]);
    scanDirectoryMock.mockResolvedValue([]);
    onScanProgressMock.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows invalid state for non-file drag payloads", () => {
    render(<DropZone onFilesAdded={vi.fn()} />);
    const zone = screen.getByTestId("drop-zone");

    fireEvent.dragOver(zone, {
      dataTransfer: createDataTransfer({ types: ["text/plain"] }),
    });

    expect(zone).toHaveClass("drop-zone--invalid");
    expect(screen.getByText("Only files or folders can be dropped here.")).toBeInTheDocument();
  });

  it("shows drag-over state for file payloads", () => {
    render(<DropZone onFilesAdded={vi.fn()} />);
    const zone = screen.getByTestId("drop-zone");

    fireEvent.dragOver(zone, {
      dataTransfer: createDataTransfer({ types: ["Files"] }),
    });

    expect(zone).toHaveClass("drop-zone--drag-over");
  });

  it("drops a single audio file and adds it", async () => {
    const onFilesAdded = vi.fn();
    const expected = [createQueueItem("/audio/single.mp3")];
    const file = createFileWithPath("/audio/single.mp3");

    scanFilesMock.mockResolvedValueOnce(expected);

    render(<DropZone onFilesAdded={onFilesAdded} />);
    const zone = screen.getByTestId("drop-zone");

    fireEvent.drop(zone, {
      dataTransfer: createDataTransfer({
        items: [createDropItem(file)],
        files: [file],
      }),
    });

    await waitFor(() => {
      expect(scanFilesMock).toHaveBeenCalledWith(["/audio/single.mp3"]);
    });

    expect(scanDirectoryMock).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(onFilesAdded).toHaveBeenCalledWith(expected);
    });
  });

  it("drops a folder and adds all discovered audio items", async () => {
    const onFilesAdded = vi.fn();
    const folderPath = "/audio/large-folder";
    const folderHandle = createFileWithPath(folderPath);
    const expected = Array.from({ length: 100 }, (_, index) =>
      createQueueItem(`${folderPath}/track-${index}.wav`)
    );

    scanDirectoryMock.mockResolvedValueOnce(expected);

    render(<DropZone onFilesAdded={onFilesAdded} />);
    const zone = screen.getByTestId("drop-zone");

    fireEvent.drop(zone, {
      dataTransfer: createDataTransfer({
        items: [
          createDropItem(folderHandle, {
            isDirectory: true,
            fullPath: folderPath,
          }),
        ],
      }),
    });

    await waitFor(() => {
      expect(scanDirectoryMock).toHaveBeenCalledWith(folderPath, true);
    });

    await waitFor(() => {
      expect(onFilesAdded).toHaveBeenCalledWith(expected);
    });
  });

  it("drops mixed folder contents and keeps only returned audio files", async () => {
    const onFilesAdded = vi.fn();
    const folderPath = "/audio/mixed-folder";
    const folderHandle = createFileWithPath(folderPath);
    const audioOnly = [
      createQueueItem(`${folderPath}/good-1.wav`),
      createQueueItem(`${folderPath}/good-2.ogg`),
    ];

    scanDirectoryMock.mockResolvedValueOnce(audioOnly);

    render(<DropZone onFilesAdded={onFilesAdded} />);
    const zone = screen.getByTestId("drop-zone");

    fireEvent.drop(zone, {
      dataTransfer: createDataTransfer({
        items: [
          createDropItem(folderHandle, {
            isDirectory: true,
            fullPath: folderPath,
          }),
        ],
      }),
    });

    await waitFor(() => {
      expect(onFilesAdded).toHaveBeenCalledWith(audioOnly);
    });

    const addedItems = onFilesAdded.mock.calls[0][0] as QueueItem[];
    expect(addedItems).toHaveLength(2);
    expect(addedItems.every((item) => item.path.endsWith(".wav") || item.path.endsWith(".ogg"))).toBe(
      true
    );
  });

  it("shows scan progress updates during folder scans", async () => {
    const onFilesAdded = vi.fn();
    const folderPath = "/audio/progress-folder";
    const folderHandle = createFileWithPath(folderPath);

    let resolveDirectory: ((items: QueueItem[]) => void) | undefined;
    const directoryPromise = new Promise<QueueItem[]>((resolve) => {
      resolveDirectory = resolve;
    });

    scanDirectoryMock.mockReturnValueOnce(directoryPromise);

    let progressCallback: ((progress: ScanProgress) => void) | undefined;
    const unlisten = vi.fn();

    onScanProgressMock.mockImplementationOnce(async (callback: (progress: ScanProgress) => void) => {
      progressCallback = callback;
      return unlisten;
    });

    render(<DropZone onFilesAdded={onFilesAdded} />);
    const zone = screen.getByTestId("drop-zone");

    fireEvent.drop(zone, {
      dataTransfer: createDataTransfer({
        items: [
          createDropItem(folderHandle, {
            isDirectory: true,
            fullPath: folderPath,
          }),
        ],
      }),
    });

    await waitFor(() => {
      expect(onScanProgressMock).toHaveBeenCalledTimes(1);
    });

    if (!progressCallback) {
      throw new Error("Expected progress callback to be registered");
    }

    progressCallback({
      found: 12,
      scanned: 34,
      currentPath: `${folderPath}/track-34.wav`,
    });

    await waitFor(() => {
      expect(screen.getByText("Scanning... 34 scanned, 12 audio found")).toBeInTheDocument();
    });

    if (!resolveDirectory) {
      throw new Error("Expected scan_directory promise resolver");
    }

    resolveDirectory([createQueueItem(`${folderPath}/track-34.wav`)]);

    await waitFor(() => {
      expect(onFilesAdded).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});
