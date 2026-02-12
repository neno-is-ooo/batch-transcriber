import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { ProviderSelector } from "./components/providers/ProviderSelector";
import { ExportDialog } from "./components/export/ExportDialog";
import { HistoryView } from "./components/history/HistoryView";
import { QuickLook } from "./components/preview/QuickLook";
import { QueueView } from "./components/queue/QueueView";
import { Toast, type ToastTone } from "./components/ui";
import { resolveModelSelection } from "./components/providers/providerModels";
import { getProviderById, useProviders } from "./hooks/useProviders";
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useQueue } from "./hooks/useQueue";
import {
  checkNotificationPermission,
  deleteSession,
  exportTranscripts,
  getSessionHistory,
  registerFileOpenListener,
  requestNotificationPermission,
  scanDirectory,
  scanFiles,
  startTranscription,
  stopTranscription,
  type TranscriptionSettings,
  type ExportOptions,
  type SessionFileRecord,
  type SessionRecord,
  updateMenuState,
} from "./lib/tauri-commands";
import type { QueueItem } from "./types";

type BridgeStatus = "checking" | "connected" | "web" | "error";
type OutputFormatPreference = "both" | "txt" | "json";

interface StoredPreferences {
  providerId: string;
  modelByProvider: Record<string, string>;
  outputFormat: OutputFormatPreference;
  notificationsEnabled: boolean;
  notifyOnComplete: boolean;
  notifyOnError: boolean;
}

interface ToastState {
  id: number;
  message: string;
  tone: ToastTone;
}

const DEFAULT_PROVIDER = "parakeet-coreml";
const DEFAULT_MODEL = "v3";
const DEFAULT_OUTPUT_DIR = "/tmp/parakeet-transcripts";
const SETTINGS_STORAGE_KEY = "parakeet.settings.v1";
const APP_TITLE = "Batch Transcriber";
const MENU_EVENT_FILES_SELECTED = "files-selected";
const FILES_OPENED_EVENT = "files-opened";
const MENU_EVENT_FOLDER_SELECTED = "folder-selected";
const MENU_EVENT_START_TRANSCRIPTION = "menu-start-transcription";
const MENU_EVENT_STOP_TRANSCRIPTION = "menu-stop-transcription";
const MENU_EVENT_SHOW_PREFERENCES = "show-preferences";
const MENU_EVENT_SHOW_MODEL_MANAGER = "show-model-manager";
const MENU_EVENT_RUN_DIAGNOSTICS = "run-diagnostics";
const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  outputFormat: "both",
  recursive: true,
  overwrite: false,
  maxRetries: 1,
  extensions: ["wav", "mp3", "m4a", "ogg", "flac"],
  ffmpegFallback: true,
  dryRun: false,
  notificationsEnabled: true,
  notifyOnComplete: true,
  notifyOnError: true,
};
const OUTPUT_FORMAT_OPTIONS: Array<{ value: OutputFormatPreference; label: string }> = [
  { value: "both", label: "TXT + JSON" },
  { value: "txt", label: "TXT only" },
  { value: "json", label: "JSON only" },
];

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOutputFormat(value: unknown): value is OutputFormatPreference {
  return value === "both" || value === "txt" || value === "json";
}

function readStoredPreferences(): StoredPreferences | null {
  const storage = globalThis.localStorage;
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    const providerId = parsed.providerId;
    const outputFormat = parsed.outputFormat;
    const notificationsEnabled = parsed.notificationsEnabled;
    const notifyOnComplete = parsed.notifyOnComplete;
    const notifyOnError = parsed.notifyOnError;
    const modelByProvider = parsed.modelByProvider;

    if (
      typeof providerId !== "string" ||
      !isOutputFormat(outputFormat) ||
      typeof notificationsEnabled !== "boolean" ||
      !isRecord(modelByProvider)
    ) {
      return null;
    }

    const sanitizedModelMap = Object.entries(modelByProvider).reduce<Record<string, string>>(
      (accumulator, [providerKey, modelValue]) => {
        if (typeof modelValue === "string") {
          accumulator[providerKey] = modelValue;
        }

        return accumulator;
      },
      {}
    );

    return {
      providerId,
      modelByProvider: sanitizedModelMap,
      outputFormat,
      notificationsEnabled,
      notifyOnComplete:
        typeof notifyOnComplete === "boolean" ? notifyOnComplete : notificationsEnabled,
      notifyOnError: typeof notifyOnError === "boolean" ? notifyOnError : notificationsEnabled,
    };
  } catch {
    return null;
  }
}

function persistPreferences(preferences: StoredPreferences): void {
  const storage = globalThis.localStorage;
  if (!storage) {
    return;
  }

  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
}

function getErrorMessage(prefix: string, error: unknown): string {
  const detail =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return `${prefix}: ${detail}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function selectedQueueItem(items: QueueItem[], selectedIds: Set<string>): QueueItem | null {
  if (selectedIds.size === 0) {
    return null;
  }

  const firstSelectedId = selectedIds.values().next().value;
  if (typeof firstSelectedId !== "string") {
    return null;
  }

  return items.find((item) => item.id === firstSelectedId) ?? null;
}

function normalizeDialogPath(value: string | string[] | null): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  return value[0] ?? null;
}

function queueItemFromSessionFile(file: SessionFileRecord): QueueItem {
  const status = file.status === "success" || file.status === "skipped" ? "completed" : "idle";
  const progress = status === "completed" ? 100 : 0;

  return {
    id: file.id,
    path: file.path,
    name: file.name || file.path.split("/").pop() || file.path,
    size: 0,
    status,
    progress,
    transcriptPath: file.transcriptPath,
    jsonPath: file.jsonPath,
    error: file.error,
  };
}

function mergeQueueItemsByPath(items: QueueItem[]): QueueItem[] {
  const deduped = new Map<string, QueueItem>();
  for (const item of items) {
    deduped.set(item.path, item);
  }

  return Array.from(deduped.values());
}

function TauriEventBridge() {
  useTauriEvents();
  return null;
}

export default function App() {
  const tauriRuntime = isTauriRuntime();
  const storedPreferences = useMemo(() => readStoredPreferences(), []);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>(() =>
    tauriRuntime ? "checking" : "web"
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [activeRunItemIds, setActiveRunItemIds] = useState<string[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>(
    () => storedPreferences?.providerId ?? DEFAULT_PROVIDER
  );
  const [selectedModelByProvider, setSelectedModelByProvider] = useState<Record<string, string>>(
    () =>
      storedPreferences?.modelByProvider ?? {
        [DEFAULT_PROVIDER]: DEFAULT_MODEL,
      }
  );
  const [outputFormatPreference, setOutputFormatPreference] = useState<OutputFormatPreference>(
    () => storedPreferences?.outputFormat ?? "both"
  );
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(
    () => storedPreferences?.notificationsEnabled ?? true
  );
  const [notifyOnComplete, setNotifyOnComplete] = useState<boolean>(
    () => storedPreferences?.notifyOnComplete ?? true
  );
  const [notifyOnError, setNotifyOnError] = useState<boolean>(
    () => storedPreferences?.notifyOnError ?? true
  );
  const [quickLookItemId, setQuickLookItemId] = useState<string | null>(null);
  const [isQuickLookOpen, setIsQuickLookOpen] = useState(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [exportItems, setExportItems] = useState<QueueItem[]>([]);
  const [historySessions, setHistorySessions] = useState<SessionRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const { providers, loading: providersLoading, refresh: refreshProviders } = useProviders();
  const addItems = useQueue((state) => state.addItems);
  const items = useQueue((state) => state.items);
  const selectedIds = useQueue((state) => state.selectedIds);
  const setSelection = useQueue((state) => state.setSelection);
  const clearCompleted = useQueue((state) => state.clearCompleted);
  const isProcessing = useQueue((state) => state.isProcessing);
  const canQueueStart = useQueue((state) => state.canStart());
  const completedItemsCount = useQueue((state) => state.completedCount());

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    setToast({
      id: Date.now(),
      message,
      tone,
    });
  }, []);

  const loadSessionHistory = useCallback(async () => {
    if (!tauriRuntime) {
      setHistorySessions([]);
      return;
    }

    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const sessions = await getSessionHistory();
      setHistorySessions(sessions);
    } catch (error) {
      setHistoryError(getErrorMessage("Failed to load session history", error));
    } finally {
      setHistoryLoading(false);
    }
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    void invoke<unknown[]>("get_model_catalog")
      .then(() => setBridgeStatus("connected"))
      .catch(() => setBridgeStatus("error"));
  }, [tauriRuntime]);

  useEffect(() => {
    void loadSessionHistory();
  }, [loadSessionHistory]);

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let mounted = true;
    let unlisten: UnlistenFn | undefined;

    void listen<Record<string, unknown>>("transcription-event", (event) => {
      const payload = event.payload;
      if (!isRecord(payload) || payload.event !== "session_summary") {
        return;
      }

      void loadSessionHistory();
    })
      .then((cleanup) => {
        if (!mounted) {
          cleanup();
          return;
        }

        unlisten = cleanup;
      })
      .catch((error: unknown) => {
        console.warn("[history] failed to subscribe to session summaries", error);
      });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [loadSessionHistory, tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime || !notificationsEnabled) {
      return;
    }

    let cancelled = false;

    const ensurePermission = async () => {
      const granted = await checkNotificationPermission();
      if (cancelled || granted) {
        return;
      }

      await requestNotificationPermission();
    };

    void ensurePermission().catch((error: unknown) => {
      console.warn("[notifications] failed to sync permission", error);
    });

    return () => {
      cancelled = true;
    };
  }, [notificationsEnabled, tauriRuntime]);

  const activeProviderId = useMemo(() => {
    if (providers.length === 0) {
      return selectedProvider;
    }

    if (providers.some((provider) => provider.id === selectedProvider)) {
      return selectedProvider;
    }

    return (providers.find((provider) => provider.available) ?? providers[0]).id;
  }, [providers, selectedProvider]);

  const selectedModel = useMemo(() => {
    const preferredModel = selectedModelByProvider[activeProviderId] ?? DEFAULT_MODEL;
    return resolveModelSelection(activeProviderId, preferredModel, DEFAULT_MODEL);
  }, [activeProviderId, selectedModelByProvider]);

  useEffect(() => {
    persistPreferences({
      providerId: activeProviderId,
      modelByProvider: selectedModelByProvider,
      outputFormat: outputFormatPreference,
      notificationsEnabled,
      notifyOnComplete,
      notifyOnError,
    });
  }, [
    activeProviderId,
    notifyOnComplete,
    notifyOnError,
    notificationsEnabled,
    outputFormatPreference,
    selectedModelByProvider,
  ]);

  const selectedProviderInfo = useMemo(
    () => getProviderById(providers, activeProviderId),
    [activeProviderId, providers]
  );

  const idleCount = useMemo(
    () => items.filter((item) => item.status === "idle").length,
    [items]
  );

  const pendingFallbackCount = useMemo(
    () =>
      items.filter(
        (item) =>
          item.status === "idle" || item.status === "queued" || item.status === "processing"
      ).length,
    [items]
  );

  const activeRunSet = useMemo(() => new Set(activeRunItemIds), [activeRunItemIds]);

  const runProcessedCount = useMemo(() => {
    if (activeRunItemIds.length === 0) {
      return 0;
    }

    return items.reduce((count, item) => {
      if (!activeRunSet.has(item.id)) {
        return count;
      }

      return item.status === "completed" || item.status === "error" ? count + 1 : count;
    }, 0);
  }, [activeRunItemIds.length, activeRunSet, items]);

  const runTotalCount = activeRunItemIds.length;
  const pendingCount =
    runTotalCount > 0
      ? Math.max(0, runTotalCount - runProcessedCount)
      : pendingFallbackCount;
  const progressProcessedCount = runTotalCount > 0 ? runProcessedCount : 0;
  const progressTotalCount = runTotalCount > 0 ? runTotalCount : pendingFallbackCount;

  const handleStart = useCallback(async () => {
    if (bridgeStatus !== "connected") {
      return;
    }

    if (!selectedProviderInfo?.available) {
      setActionError(`Selected provider is not available: ${activeProviderId}`);
      return;
    }

    const queue = useQueue.getState();
    const idleItems = queue.items.filter((item) => item.status === "idle");
    if (idleItems.length === 0) {
      return;
    }

    try {
      setActionError(null);
      const settings: TranscriptionSettings = {
        ...DEFAULT_TRANSCRIPTION_SETTINGS,
        outputFormat: outputFormatPreference,
        notificationsEnabled,
        notifyOnComplete: notificationsEnabled && notifyOnComplete,
        notifyOnError: notificationsEnabled && notifyOnError,
      };
      const sessionId = await startTranscription(
        idleItems,
        activeProviderId,
        selectedModel,
        DEFAULT_OUTPUT_DIR,
        settings
      );
      queue.setProcessing(sessionId);
      setActiveRunItemIds(idleItems.map((item) => item.id));
    } catch (error) {
      setActionError(getErrorMessage("Failed to start transcription", error));
    }
  }, [
    bridgeStatus,
    activeProviderId,
    notifyOnComplete,
    notifyOnError,
    notificationsEnabled,
    outputFormatPreference,
    selectedModel,
    selectedProviderInfo?.available,
  ]);

  const handleStop = useCallback(async () => {
    const sessionId = useQueue.getState().currentSessionId;
    if (!sessionId) {
      return;
    }

    try {
      setActionError(null);
      await stopTranscription(sessionId);
      useQueue.getState().setProcessing(null);
    } catch (error) {
      setActionError(getErrorMessage("Failed to stop transcription", error));
    }
  }, []);

  const handleScanFilesFromMenu = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        return;
      }

      try {
        setActionError(null);
        const scannedItems = await scanFiles(paths);
        if (scannedItems.length > 0) {
          addItems(scannedItems);
        }
      } catch (error) {
        setActionError(getErrorMessage("Failed to add files from menu", error));
      }
    },
    [addItems]
  );

  const handleScanFolderFromMenu = useCallback(
    async (path: string) => {
      if (!path.trim()) {
        return;
      }

      try {
        setActionError(null);
        const scannedItems = await scanDirectory(path, true);
        if (scannedItems.length > 0) {
          addItems(scannedItems);
        }
      } catch (error) {
        setActionError(getErrorMessage("Failed to add folder from menu", error));
      }
    },
    [addItems]
  );

  const handleFilesOpened = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        return;
      }

      const queueBefore = useQueue.getState();
      const priorCount = queueBefore.items.length;

      if (paths.length >= 50) {
        showToast(`Adding ${paths.length} files...`);
      }

      try {
        setActionError(null);
        const directScanResults = await Promise.allSettled(paths.map((path) => scanFiles([path])));
        const scannedItems: QueueItem[] = [];
        const unresolvedPaths: string[] = [];

        directScanResults.forEach((result, index) => {
          if (result.status === "fulfilled") {
            scannedItems.push(...result.value);
            return;
          }

          unresolvedPaths.push(paths[index]);
        });

        if (unresolvedPaths.length > 0) {
          const directoryScanResults = await Promise.allSettled(
            unresolvedPaths.map((path) => scanDirectory(path, true))
          );

          directoryScanResults.forEach((result, index) => {
            if (result.status === "fulfilled") {
              scannedItems.push(...result.value);
              return;
            }

            console.warn(
              "[ingestion] failed to scan dropped path",
              unresolvedPaths[index],
              result.reason
            );
          });
        }

        const mergedItems = mergeQueueItemsByPath(scannedItems);
        if (mergedItems.length > 0) {
          addItems(mergedItems);
        }

        const addedCount = Math.max(0, useQueue.getState().items.length - priorCount);
        if (addedCount === 0) {
          return;
        }

        if (queueBefore.isProcessing) {
          showToast("Files queued - will process after current batch", "warning");
          return;
        }

        if (priorCount === 0) {
          showToast(`Ready to transcribe. Added ${addedCount} file(s) to queue.`, "success");
          return;
        }

        showToast(`Added ${addedCount} file(s) to queue.`, "success");
      } catch (error) {
        setActionError(getErrorMessage("Failed to process opened files", error));
      }
    },
    [addItems, showToast]
  );

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let mounted = true;
    let unlistenDragDrop: UnlistenFn | undefined;
    let currentWindow: ReturnType<typeof getCurrentWindow> | null = null;

    try {
      currentWindow = getCurrentWindow();
    } catch {
      return;
    }

    void currentWindow
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          return;
        }

        const droppedPaths = event.payload.paths.filter((path) => path.trim().length > 0);
        if (droppedPaths.length === 0) {
          return;
        }

        void handleFilesOpened(droppedPaths);
      })
      .then((cleanup) => {
        if (!mounted) {
          cleanup();
          return;
        }
        unlistenDragDrop = cleanup;
      })
      .catch(() => {});

    return () => {
      mounted = false;
      unlistenDragDrop?.();
    };
  }, [handleFilesOpened, tauriRuntime]);

  const quickLookItem = useMemo(() => {
    if (!quickLookItemId) {
      return null;
    }

    return items.find((item) => item.id === quickLookItemId) ?? null;
  }, [items, quickLookItemId]);

  const quickLookIndex = useMemo(() => {
    if (!quickLookItemId) {
      return -1;
    }

    return items.findIndex((item) => item.id === quickLookItemId);
  }, [items, quickLookItemId]);

  const openQuickLookForId = useCallback(
    (itemId: string) => {
      const nextItem = items.find((entry) => entry.id === itemId);
      if (!nextItem) {
        return;
      }

      setSelection([nextItem.id]);
      setQuickLookItemId(nextItem.id);
      setIsQuickLookOpen(true);
    },
    [items, setSelection]
  );

  const closeQuickLook = useCallback(() => {
    setIsQuickLookOpen(false);
  }, []);

  const navigateQuickLook = useCallback(
    (direction: -1 | 1) => {
      if (!isQuickLookOpen || quickLookIndex < 0 || items.length === 0) {
        return;
      }

      const nextIndex = Math.max(0, Math.min(items.length - 1, quickLookIndex + direction));
      if (nextIndex === quickLookIndex) {
        return;
      }

      const nextItem = items[nextIndex];
      setQuickLookItemId(nextItem.id);
      setSelection([nextItem.id]);
    },
    [isQuickLookOpen, items, quickLookIndex, setSelection]
  );

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let mounted = true;
    let listeners: UnlistenFn[] = [];

    const bindMenuEvents = async () => {
      const unlisteners = await Promise.all([
        listen<string[]>(MENU_EVENT_FILES_SELECTED, (event) => {
          void handleScanFilesFromMenu(event.payload ?? []);
        }),
        listen<string[]>(FILES_OPENED_EVENT, (event) => {
          void handleFilesOpened(event.payload ?? []);
        }),
        listen<string>(MENU_EVENT_FOLDER_SELECTED, (event) => {
          void handleScanFolderFromMenu(event.payload ?? "");
        }),
        listen(MENU_EVENT_START_TRANSCRIPTION, () => {
          void handleStart();
        }),
        listen(MENU_EVENT_STOP_TRANSCRIPTION, () => {
          void handleStop();
        }),
        listen(MENU_EVENT_SHOW_PREFERENCES, () => {
          const panel = document.querySelector<HTMLElement>("[data-testid='settings-panel']");
          panel?.scrollIntoView({ block: "start", behavior: "smooth" });
          const providerSelect = document.querySelector<HTMLSelectElement>(
            "[data-testid='provider-select']"
          );
          providerSelect?.focus();
        }),
        listen(MENU_EVENT_SHOW_MODEL_MANAGER, () => {
          void refreshProviders();
        }),
        listen(MENU_EVENT_RUN_DIAGNOSTICS, () => {
          setActionError("Diagnostics action is not implemented yet.");
        }),
      ]);

      if (!mounted) {
        unlisteners.forEach((unlisten) => unlisten());
        return;
      }

      listeners = unlisteners;

      const pendingOpenedFiles = await registerFileOpenListener();
      if (pendingOpenedFiles.length > 0) {
        void handleFilesOpened(pendingOpenedFiles);
      }
    };

    void bindMenuEvents().catch((error: unknown) => {
      setActionError(getErrorMessage("Failed to bind menu events", error));
    });

    return () => {
      mounted = false;
      listeners.forEach((unlisten) => unlisten());
      listeners = [];
    };
  }, [
    handleFilesOpened,
    handleScanFilesFromMenu,
    handleScanFolderFromMenu,
    handleStart,
    handleStop,
    refreshProviders,
    tauriRuntime,
  ]);

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    void updateMenuState(items.length > 0, isProcessing).catch((error: unknown) => {
      console.warn("[menu] failed to update native menu state", error);
    });
  }, [isProcessing, items.length, tauriRuntime]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const metaPressed = event.metaKey || event.ctrlKey;

      if (
        !metaPressed &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === " " || key === "space")
      ) {
        const selectedItem = selectedQueueItem(items, selectedIds);
        if (!selectedItem) {
          return;
        }

        event.preventDefault();
        if (isQuickLookOpen && quickLookItemId === selectedItem.id) {
          closeQuickLook();
        } else {
          openQuickLookForId(selectedItem.id);
        }
        return;
      }

      if (
        isQuickLookOpen &&
        !metaPressed &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        navigateQuickLook(event.key === "ArrowRight" ? 1 : -1);
        return;
      }

      if (metaPressed && (key === "1" || key === "2")) {
        event.preventDefault();
        return;
      }

      if (event.key === "Escape") {
        if (isQuickLookOpen) {
          event.preventDefault();
          closeQuickLook();
          return;
        }

        if (selectedIds.size > 0) {
          event.preventDefault();
          setSelection([]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    closeQuickLook,
    isQuickLookOpen,
    items,
    navigateQuickLook,
    openQuickLookForId,
    quickLookItemId,
    selectedIds,
    setSelection,
  ]);

  const handleRemoveSelected = useCallback(() => {
    const queue = useQueue.getState();
    const ids = Array.from(queue.selectedIds);
    if (ids.length === 0) {
      return;
    }

    queue.removeItems(ids);
  }, []);

  const handleExport = useCallback(() => {
    const completed = items.filter(
      (item) => item.status === "completed" && (item.transcriptPath || item.jsonPath)
    );
    if (completed.length === 0) {
      setActionError("No completed transcripts are available for export.");
      return;
    }

    setActionError(null);
    setExportItems(completed);
    setIsExportDialogOpen(true);
  }, [items]);

  const handleExportDialogClose = useCallback(() => {
    setIsExportDialogOpen(false);
  }, []);

  const handleExportDialogSubmit = useCallback(
    async (options: ExportOptions) => {
      if (exportItems.length === 0) {
        setActionError("No transcript files available for export.");
        return;
      }

      try {
        setActionError(null);

        const destination = options.format === "zip"
          ? normalizeDialogPath(
              await save({
                defaultPath: "transcripts.zip",
                filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
              })
            )
          : normalizeDialogPath(
              await open({
                directory: true,
                multiple: false,
              })
            );

        if (!destination) {
          return;
        }

        await exportTranscripts(exportItems, destination, options);
        setIsExportDialogOpen(false);
        showToast("Export complete.", "success");
      } catch (error) {
        setActionError(getErrorMessage("Export failed", error));
      }
    },
    [exportItems, showToast]
  );

  const handleReopenSession = useCallback(
    (session: SessionRecord) => {
      setSelectedProvider(session.provider);
      setSelectedModelByProvider((current) => ({
        ...current,
        [session.provider]: session.model,
      }));

      const reopenedItems = session.files.map((file) => queueItemFromSessionFile(file));
      addItems(reopenedItems);
      showToast(`Reopened ${session.id}.`, "info");
    },
    [addItems, showToast]
  );

  const handleExportSession = useCallback((session: SessionRecord) => {
    const sessionItems = session.files
      .map((file) => queueItemFromSessionFile(file))
      .filter((item) => item.transcriptPath || item.jsonPath)
      .map((item) => ({
        ...item,
        status: "completed" as const,
        progress: 100,
      }));

    if (sessionItems.length === 0) {
      setActionError("This session has no exported transcript files to bundle.");
      return;
    }

    setActionError(null);
    setExportItems(sessionItems);
    setIsExportDialogOpen(true);
  }, []);

  const handleDeleteSession = useCallback(
    async (session: SessionRecord) => {
      const confirmed =
        typeof globalThis.confirm === "function"
          ? globalThis.confirm(`Delete session ${session.id} from history?`)
          : true;
      if (!confirmed) {
        return;
      }

      try {
        setHistoryError(null);
        await deleteSession(session.id);
        setHistorySessions((current) => current.filter((entry) => entry.id !== session.id));
        showToast(`Deleted ${session.id}.`, "info");
      } catch (error) {
        setHistoryError(getErrorMessage("Failed to delete session", error));
      }
    },
    [showToast]
  );

  const handleRevealPath = useCallback(async (path: string) => {
    if (!path.trim()) {
      return;
    }

    try {
      await openPath(path);
    } catch (error) {
      setActionError(getErrorMessage("Failed to open path", error));
    }
  }, []);

  const canStart =
    bridgeStatus === "connected" && canQueueStart && selectedProviderInfo?.available === true;

  const statusText =
    bridgeStatus === "checking"
      ? "Initializing desktop runtime..."
      : bridgeStatus === "connected"
        ? "Ready to transcribe."
        : bridgeStatus === "web"
          ? "Desktop runtime not detected."
          : "Desktop runtime check failed.";

  return (
    <div className="app-window">
      <main className="react-shell">
        {tauriRuntime ? <TauriEventBridge /> : null}
        <h1>{APP_TITLE}</h1>
        <p>Drop audio files or folders to begin.</p>
        <p className="react-status">{statusText}</p>
        {actionError ? <p className="react-status react-status--error">{actionError}</p> : null}
        <section className="settings-panel panel-blur" data-testid="settings-panel">
          <header className="settings-panel__header">
            <h2 className="settings-panel__title">Preferences</h2>
            <p className="settings-panel__description">
              Provider defaults are saved for the next app launch.
            </p>
          </header>
          <ProviderSelector
            providers={providers}
            loading={providersLoading}
            selectedProvider={activeProviderId}
            selectedModel={selectedModel}
            onProviderChange={(providerId) => setSelectedProvider(providerId)}
            onModelChange={(model) => {
              setSelectedModelByProvider((currentMap) => ({
                ...currentMap,
                [activeProviderId]: model,
              }));
            }}
            onRefresh={() => {
              void refreshProviders();
            }}
          />
          <div className="settings-panel__grid">
            <label className="settings-panel__field" htmlFor="output-format-select">
              <span className="settings-panel__label">Output Format</span>
              <select
                id="output-format-select"
                className="settings-panel__select"
                data-testid="output-format-select"
                value={outputFormatPreference}
                onChange={(event) =>
                  setOutputFormatPreference(event.target.value as OutputFormatPreference)
                }
              >
                {OUTPUT_FORMAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                data-testid="notifications-toggle"
                checked={notificationsEnabled}
                onChange={(event) => setNotificationsEnabled(event.target.checked)}
              />
              <span>Enable system notifications</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                data-testid="notify-on-complete-toggle"
                checked={notifyOnComplete}
                disabled={!notificationsEnabled}
                onChange={(event) => setNotifyOnComplete(event.target.checked)}
              />
              <span>Notify on completion</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                data-testid="notify-on-error-toggle"
                checked={notifyOnError}
                disabled={!notificationsEnabled}
                onChange={(event) => setNotifyOnError(event.target.checked)}
              />
              <span>Notify on errors</span>
            </label>
          </div>
        </section>
        <QueueView
          items={items}
          selectedIds={selectedIds}
          onFilesAdded={addItems}
          onSelectionChange={setSelection}
          onQuickLook={openQuickLookForId}
          dropDisabled={bridgeStatus !== "connected"}
          canStart={canStart}
          isProcessing={isProcessing}
          completedCount={completedItemsCount}
          idleCount={idleCount}
          pendingCount={pendingCount}
          processedCount={progressProcessedCount}
          totalCount={progressTotalCount}
          provider={activeProviderId}
          model={selectedModel}
          onStart={handleStart}
          onStop={handleStop}
          onRemoveSelected={handleRemoveSelected}
          onClearCompleted={clearCompleted}
          onExport={handleExport}
        />
        <HistoryView
          sessions={historySessions}
          loading={historyLoading}
          error={historyError}
          onRefresh={() => {
            void loadSessionHistory();
          }}
          onReopenSession={handleReopenSession}
          onExportSession={handleExportSession}
          onDeleteSession={(session) => {
            void handleDeleteSession(session);
          }}
          onRevealPath={(path) => {
            void handleRevealPath(path);
          }}
        />
        <QuickLook
          item={quickLookItem}
          isOpen={isQuickLookOpen}
          onClose={closeQuickLook}
          onNavigatePrevious={() => {
            navigateQuickLook(-1);
          }}
          onNavigateNext={() => {
            navigateQuickLook(1);
          }}
          hasPrevious={quickLookIndex > 0}
          hasNext={quickLookIndex >= 0 && quickLookIndex < items.length - 1}
        />
        {isExportDialogOpen ? (
          <ExportDialog
            isOpen={true}
            itemCount={exportItems.length}
            onCancel={handleExportDialogClose}
            onExport={(options) => {
              void handleExportDialogSubmit(options);
            }}
          />
        ) : null}
      </main>
      {toast ? (
        <div className="toast-stack">
          <Toast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            onDismiss={() => {
              setToast((current) => (current?.id === toast.id ? null : current));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
