import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { exportTranscript, readTranscript } from "../../lib/tauri-commands";
import type { QueueItem } from "../../types/queue";
import { MetadataCard } from "./MetadataCard";
import { TranscriptContent } from "./TranscriptContent";

export interface QuickLookProps {
  item: QueueItem | null;
  isOpen: boolean;
  onClose: () => void;
  onNavigatePrevious: () => void;
  onNavigateNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
}

function resolveTranscriptPath(item: QueueItem | null): string | null {
  if (!item) {
    return null;
  }

  return item.transcriptPath ?? item.jsonPath ?? null;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? path;
}

function detectFormat(path: string | null): string {
  if (!path) {
    return "txt";
  }

  const fileName = baseName(path);
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1 || lastDot === fileName.length - 1) {
    return "txt";
  }

  return fileName.slice(lastDot + 1).toLowerCase();
}

function getErrorMessage(prefix: string, error: unknown): string {
  const detail =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return `${prefix}: ${detail}`;
}

export function QuickLook({
  item,
  isOpen,
  onClose,
  onNavigatePrevious,
  onNavigateNext,
  hasPrevious,
  hasNext,
}: QuickLookProps) {
  const transcriptPath = useMemo(() => resolveTranscriptPath(item), [item]);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setLoading(false);
      setStatusMessage(null);
      return;
    }

    if (!transcriptPath) {
      setContent(null);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setContent(null);
    setLoading(true);
    setError(null);
    setStatusMessage(null);

    void readTranscript(transcriptPath)
      .then((value) => {
        if (!active) {
          return;
        }

        setContent(value);
      })
      .catch((loadError: unknown) => {
        if (!active) {
          return;
        }

        setContent(null);
        setError(getErrorMessage("Failed to load transcript", loadError));
      })
      .finally(() => {
        if (!active) {
          return;
        }

        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, transcriptPath]);

  const handleCopy = useCallback(async () => {
    if (!content) {
      return;
    }

    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") {
        throw new Error("Clipboard API is unavailable in this environment");
      }

      await clipboard.writeText(content);
      setStatusMessage("Copied transcript to clipboard.");
    } catch (copyError) {
      setStatusMessage(getErrorMessage("Copy failed", copyError));
    }
  }, [content]);

  const handleOpenInEditor = useCallback(async () => {
    if (!transcriptPath) {
      return;
    }

    try {
      await openPath(transcriptPath);
      setStatusMessage("Opened transcript in the default editor.");
    } catch (openError) {
      setStatusMessage(getErrorMessage("Open failed", openError));
    }
  }, [transcriptPath]);

  const handleExport = useCallback(async () => {
    if (!transcriptPath) {
      return;
    }

    try {
      const destinationPath = await save({
        defaultPath: baseName(transcriptPath),
      });

      if (!destinationPath) {
        return;
      }

      await exportTranscript(transcriptPath, destinationPath);
      setStatusMessage(`Exported transcript to ${baseName(destinationPath)}.`);
    } catch (exportError) {
      setStatusMessage(getErrorMessage("Export failed", exportError));
    }
  }, [transcriptPath]);

  if (!item) {
    return null;
  }

  const transcriptName = transcriptPath ? baseName(transcriptPath) : "No transcript file";

  return (
    <div
      className={`quick-look-overlay${isOpen ? " quick-look-overlay--open" : ""}`}
      data-testid="quick-look-overlay"
      aria-hidden={!isOpen}
    >
      <button
        type="button"
        className="quick-look-overlay__backdrop"
        onClick={onClose}
        aria-label="Close transcript preview"
      />

      <aside className={`quick-look panel-blur${isOpen ? " quick-look--open" : ""}`} role="dialog" aria-modal="true" aria-label="Transcript preview">
        <header className="quick-look__header">
          <div className="quick-look__header-title">
            <p className="quick-look__eyebrow">QuickLook</p>
            <h2 className="quick-look__filename">{item.name}</h2>
            <p className="quick-look__source">{transcriptName}</p>
          </div>

          <div className="quick-look__actions" role="group" aria-label="Preview actions">
            <button
              type="button"
              className="quick-look__action"
              onClick={onNavigatePrevious}
              disabled={!hasPrevious}
              aria-label="Previous transcript"
            >
              Prev
            </button>
            <button
              type="button"
              className="quick-look__action"
              onClick={onNavigateNext}
              disabled={!hasNext}
              aria-label="Next transcript"
            >
              Next
            </button>
            <button
              type="button"
              className="quick-look__action"
              onClick={() => {
                void handleCopy();
              }}
              disabled={!content}
            >
              Copy
            </button>
            <button
              type="button"
              className="quick-look__action"
              onClick={() => {
                void handleOpenInEditor();
              }}
              disabled={!transcriptPath}
            >
              Open
            </button>
            <button
              type="button"
              className="quick-look__action"
              onClick={() => {
                void handleExport();
              }}
              disabled={!transcriptPath}
            >
              Export
            </button>
            <button type="button" className="quick-look__action" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {statusMessage ? <p className="quick-look__status">{statusMessage}</p> : null}

        <div className="quick-look__body">
          <section className="quick-look__content" aria-label="Transcript content">
            <TranscriptContent
              content={content}
              format={detectFormat(transcriptPath)}
              loading={loading}
              error={error}
            />
          </section>

          <MetadataCard item={item} content={content} transcriptPath={transcriptPath} />
        </div>
      </aside>
    </div>
  );
}
