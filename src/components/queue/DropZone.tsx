import { useCallback, useMemo, useState, type DragEvent } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onScanProgress, scanDirectory, scanFiles, type ScanProgress } from "../../lib/tauri-commands";
import type { QueueItem } from "../../types/queue";

export interface DropZoneProps {
  onFilesAdded: (items: QueueItem[]) => void;
  disabled?: boolean;
}

export type DragState = "idle" | "drag-over" | "invalid" | "scanning";

interface FileWithPath extends File {
  path?: string;
}

interface FileSystemEntryLike {
  isDirectory: boolean;
  fullPath?: string;
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

interface DropTargets {
  filePaths: string[];
  directoryPaths: string[];
}

function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }

  const types = dataTransfer.types;
  if (!types) {
    return false;
  }

  if (typeof types.includes === "function") {
    return types.includes("Files");
  }

  if (
    typeof (types as unknown as { contains?: (value: string) => boolean }).contains === "function"
  ) {
    return (
      (types as unknown as { contains: (value: string) => boolean }).contains("Files")
    );
  }

  return Array.from(types).includes("Files");
}

function readPath(file: File | null): string | null {
  if (!file) {
    return null;
  }

  const candidate = (file as FileWithPath).path;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate;
  }

  return null;
}

function extractDropTargets(dataTransfer: DataTransfer): DropTargets {
  const filePaths = new Set<string>();
  const directoryPaths = new Set<string>();
  const items = Array.from(dataTransfer.items ?? []);

  for (const item of items) {
    const candidate = item as DataTransferItemWithEntry;
    if (candidate.kind !== "file") {
      continue;
    }

    const entry = typeof candidate.webkitGetAsEntry === "function" ? candidate.webkitGetAsEntry() : null;
    const file = candidate.getAsFile();
    const nativePath = readPath(file);

    if (entry?.isDirectory) {
      if (nativePath) {
        directoryPaths.add(nativePath);
      } else if (typeof entry.fullPath === "string" && entry.fullPath.trim().length > 0) {
        directoryPaths.add(entry.fullPath);
      }
      continue;
    }

    if (nativePath) {
      filePaths.add(nativePath);
    }
  }

  if (items.length === 0 || (filePaths.size === 0 && directoryPaths.size === 0)) {
    for (const file of Array.from(dataTransfer.files ?? [])) {
      const nativePath = readPath(file);
      if (nativePath) {
        filePaths.add(nativePath);
      }
    }
  }

  return {
    filePaths: Array.from(filePaths),
    directoryPaths: Array.from(directoryPaths),
  };
}

function mergeByPath(items: QueueItem[]): QueueItem[] {
  const deduped = new Map<string, QueueItem>();
  for (const item of items) {
    deduped.set(item.path, item);
  }

  return Array.from(deduped.values());
}

function progressCopy(progress: ScanProgress | null): string {
  if (!progress) {
    return "Scanning files...";
  }

  return `Scanning... ${progress.scanned} scanned, ${progress.found} audio found`;
}

export function DropZone({ onFilesAdded, disabled = false }: DropZoneProps) {
  const [dragState, setDragState] = useState<DragState>("idle");
  const [progress, setProgress] = useState<ScanProgress | null>(null);

  const isInteractionDisabled = disabled || dragState === "scanning";

  const statusText = useMemo(() => {
    if (disabled) {
      return "Connect to the Tauri runtime to enable file drops.";
    }

    if (dragState === "invalid") {
      return "Only files or folders can be dropped here.";
    }

    if (dragState === "scanning") {
      return progressCopy(progress);
    }

    return "Drop audio files or folders here";
  }, [disabled, dragState, progress]);

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();

      if (isInteractionDisabled) {
        return;
      }

      setDragState(hasFilePayload(event.dataTransfer) ? "drag-over" : "invalid");
    },
    [isInteractionDisabled]
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      if (dragState !== "scanning") {
        setDragState("idle");
      }
    },
    [dragState]
  );

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();

      if (isInteractionDisabled) {
        return;
      }

      if (!hasFilePayload(event.dataTransfer)) {
        setDragState("invalid");
        return;
      }

      const { filePaths, directoryPaths } = extractDropTargets(event.dataTransfer);
      if (filePaths.length === 0 && directoryPaths.length === 0) {
        setDragState("invalid");
        return;
      }

      setDragState("scanning");
      setProgress(null);

      let unlistenProgress: UnlistenFn | undefined;

      try {
        if (directoryPaths.length > 0) {
          unlistenProgress = await onScanProgress((nextProgress) => {
            setProgress(nextProgress);
          });
        }

        const fileItemsPromise =
          filePaths.length > 0 ? scanFiles(filePaths) : Promise.resolve([] as QueueItem[]);

        const directoryItemsPromise =
          directoryPaths.length > 0
            ? Promise.all(directoryPaths.map((path) => scanDirectory(path, true))).then((groups) =>
                groups.flat()
              )
            : Promise.resolve([] as QueueItem[]);

        const [fileItems, directoryItems] = await Promise.all([
          fileItemsPromise,
          directoryItemsPromise,
        ]);

        const merged = mergeByPath([...fileItems, ...directoryItems]);
        if (merged.length > 0) {
          onFilesAdded(merged);
        }

        setDragState("idle");
      } catch (error) {
        console.error("[drop-zone] failed to process drop", error);
        setDragState("invalid");
      } finally {
        if (unlistenProgress) {
          unlistenProgress();
        }
      }
    },
    [isInteractionDisabled, onFilesAdded]
  );

  return (
    <section
      className={`drop-zone sidebar-blur drop-zone--${dragState}${isInteractionDisabled ? " drop-zone--disabled" : ""}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => {
        void handleDrop(event);
      }}
      aria-disabled={isInteractionDisabled}
      data-testid="drop-zone"
    >
      <p className="drop-zone__title">Ingestion</p>
      <p className="drop-zone__copy">{statusText}</p>
      {dragState === "scanning" && progress?.currentPath ? (
        <p className="drop-zone__detail">{progress.currentPath}</p>
      ) : null}
    </section>
  );
}
