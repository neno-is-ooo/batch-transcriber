import { useSyncExternalStore } from "react";
import type { QueueItem, QueueStatus, TranscriptionEvent } from "../types";

export interface QueueState {
  items: QueueItem[];
  selectedIds: Set<string>;
  isProcessing: boolean;
  currentSessionId: string | null;
}

export interface QueueActions {
  addItems: (items: QueueItem[]) => void;
  removeItems: (ids: string[]) => void;
  updateItem: (id: string, partial: Partial<QueueItem>) => void;
  clearCompleted: () => void;
  setSelection: (ids: string[]) => void;
  reorderItems: (fromIndex: number, toIndex: number) => void;
  setProcessing: (sessionId: string | null) => void;
  handleEvent: (event: TranscriptionEvent) => void;
}

export interface QueueSelectors {
  totalDuration: () => number;
  completedCount: () => number;
  failedCount: () => number;
  canStart: () => boolean;
  getItemByPath: (path: string) => QueueItem | undefined;
}

export type QueueStore = QueueState & QueueActions & QueueSelectors;

interface PersistedQueueState {
  state?: {
    items?: QueueItem[];
  };
}

type QueueListener = () => void;
type QueueSelector<T> = (state: QueueStore) => T;

type Mutation = (state: QueueState) => boolean;

export const QUEUE_STORAGE_KEY = "aura-queue-storage";
const PERSIST_DEBOUNCE_MS = 500;

const listeners = new Set<QueueListener>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

function isQueueStatus(value: unknown): value is QueueStatus {
  return (
    value === "idle" ||
    value === "queued" ||
    value === "processing" ||
    value === "completed" ||
    value === "error"
  );
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof globalThis.localStorage === "undefined") {
      return null;
    }

    const storage = globalThis.localStorage as Partial<Storage>;
    if (
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function"
    ) {
      return null;
    }

    return storage as Storage;
  } catch {
    return null;
  }
}

function normalizeHydratedItem(item: QueueItem): QueueItem {
  const status = isQueueStatus(item.status) ? item.status : "idle";

  return {
    ...item,
    id: item.id || generateId(),
    status: status === "processing" ? "idle" : status,
    progress: Number.isFinite(item.progress) ? clampProgress(item.progress) : 0,
  };
}

function hydrateItemsFromStorage(): QueueItem[] {
  const storage = getLocalStorage();
  if (!storage) {
    return [];
  }

  const raw = storage.getItem(QUEUE_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as PersistedQueueState | QueueItem[];
    const persisted = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.state?.items)
        ? parsed.state.items
        : [];

    return persisted.map((item) => normalizeHydratedItem(item));
  } catch {
    return [];
  }
}

const queueState: QueueState = {
  items: hydrateItemsFromStorage(),
  selectedIds: new Set<string>(),
  isProcessing: false,
  currentSessionId: null,
};

function emitChange(): void {
  listeners.forEach((listener) => listener());
}

function schedulePersist(): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = undefined;

    try {
      const payload: PersistedQueueState = {
        state: {
          items: queueState.items,
        },
      };
      storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota and serialization failures.
    }
  }, PERSIST_DEBOUNCE_MS);
}

function mutate(mutation: Mutation, persistItems: boolean): void {
  const changed = mutation(queueState);
  if (!changed) {
    return;
  }

  if (persistItems) {
    schedulePersist();
  }

  emitChange();
}

function warnMissingItem(path: string, eventName: TranscriptionEvent["event"]): void {
  console.warn(`[queue] ${eventName} event ignored; item not found for path: ${path}`);
}

function addItems(items: QueueItem[]): void {
  mutate((state) => {
    if (items.length === 0) {
      return false;
    }

    const existingPaths = new Set(state.items.map((item) => item.path));
    let changed = false;

    for (const item of items) {
      if (existingPaths.has(item.path)) {
        continue;
      }

      existingPaths.add(item.path);
      state.items.push({
        ...item,
        id: generateId(),
        status: "idle",
        progress: 0,
        error: undefined,
        rtfx: undefined,
      });
      changed = true;
    }

    return changed;
  }, true);
}

function removeItems(ids: string[]): void {
  mutate((state) => {
    if (ids.length === 0) {
      return false;
    }

    const idsSet = new Set(ids);
    const nextItems = state.items.filter((item) => !idsSet.has(item.id));
    if (nextItems.length === state.items.length) {
      return false;
    }

    state.items = nextItems;
    ids.forEach((id) => state.selectedIds.delete(id));
    return true;
  }, true);
}

function updateItem(id: string, partial: Partial<QueueItem>): void {
  mutate((state) => {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) {
      return false;
    }

    Object.assign(item, partial);
    return true;
  }, true);
}

function clearCompleted(): void {
  mutate((state) => {
    const nextItems = state.items.filter((item) => item.status !== "completed");
    if (nextItems.length === state.items.length) {
      return false;
    }

    state.items = nextItems;
    return true;
  }, true);
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function setSelection(ids: string[]): void {
  mutate((state) => {
    const validIds = new Set(state.items.map((item) => item.id));
    const nextSelected = new Set(ids.filter((id) => validIds.has(id)));
    if (areSetsEqual(nextSelected, state.selectedIds)) {
      return false;
    }

    state.selectedIds = nextSelected;
    return true;
  }, false);
}

function reorderItems(fromIndex: number, toIndex: number): void {
  mutate((state) => {
    const itemCount = state.items.length;
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= itemCount ||
      toIndex >= itemCount ||
      fromIndex === toIndex
    ) {
      return false;
    }

    const [movedItem] = state.items.splice(fromIndex, 1);
    state.items.splice(toIndex, 0, movedItem);
    return true;
  }, true);
}

function setProcessing(sessionId: string | null): void {
  mutate((state) => {
    const nextIsProcessing = sessionId !== null;
    if (
      state.currentSessionId === sessionId &&
      state.isProcessing === nextIsProcessing
    ) {
      return false;
    }

    state.currentSessionId = sessionId;
    state.isProcessing = nextIsProcessing;
    return true;
  }, false);
}

function handleEvent(event: TranscriptionEvent): void {
  switch (event.event) {
    case "start": {
      setProcessing(event.session_id);
      return;
    }

    case "scanned":
    case "models_loaded": {
      return;
    }

    case "summary": {
      setProcessing(null);
      return;
    }

    case "fatal_error": {
      mutate((state) => {
        let changed = false;

        for (const item of state.items) {
          if (item.status === "processing" || item.status === "queued") {
            item.status = "error";
            item.error = event.error;
            changed = true;
          }
        }

        if (state.isProcessing || state.currentSessionId !== null) {
          state.isProcessing = false;
          state.currentSessionId = null;
          changed = true;
        }

        return changed;
      }, true);
      return;
    }

    case "file_started": {
      mutate((state) => {
        const item = state.items.find((entry) => entry.path === event.file);
        if (!item) {
          warnMissingItem(event.file, event.event);
          return false;
        }

        item.status = "processing";
        item.progress = 0;
        item.error = undefined;
        return true;
      }, true);
      return;
    }

    case "file_progress": {
      mutate((state) => {
        const item = state.items.find((entry) => entry.path === event.file);
        if (!item) {
          warnMissingItem(event.file, event.event);
          return false;
        }

        item.status = "processing";
        item.progress = clampProgress(event.progress);
        item.rtfx = event.rtfx;
        return true;
      }, true);
      return;
    }

    case "file_done": {
      mutate((state) => {
        const item = state.items.find((entry) => entry.path === event.file);
        if (!item) {
          warnMissingItem(event.file, event.event);
          return false;
        }

        item.status = "completed";
        item.progress = 100;
        item.duration = event.duration_seconds;
        item.rtfx = event.rtfx;
        item.transcriptPath = event.output.txt;
        item.jsonPath = event.output.json;
        item.error = undefined;
        return true;
      }, true);
      return;
    }

    case "file_skipped": {
      mutate((state) => {
        const item = state.items.find((entry) => entry.path === event.file);
        if (!item) {
          warnMissingItem(event.file, event.event);
          return false;
        }

        item.status = "completed";
        item.progress = 100;
        item.transcriptPath = event.output?.txt ?? item.transcriptPath;
        item.jsonPath = event.output?.json ?? item.jsonPath;
        item.error = undefined;
        return true;
      }, true);
      return;
    }

    case "file_failed": {
      mutate((state) => {
        const item = state.items.find((entry) => entry.path === event.file);
        if (!item) {
          warnMissingItem(event.file, event.event);
          return false;
        }

        item.status = "error";
        item.error = event.error;
        return true;
      }, true);
      return;
    }

    case "file_retry": {
      mutate((state) => {
        const item = state.items.find((entry) => entry.path === event.file);
        if (!item) {
          warnMissingItem(event.file, event.event);
          return false;
        }

        item.status = "queued";
        item.error = undefined;
        return true;
      }, true);
      return;
    }

    default: {
      return;
    }
  }
}

function totalDuration(): number {
  return queueState.items.reduce(
    (sum, item) => sum + (Number.isFinite(item.duration) ? item.duration ?? 0 : 0),
    0
  );
}

function completedCount(): number {
  return queueState.items.filter((item) => item.status === "completed").length;
}

function failedCount(): number {
  return queueState.items.filter((item) => item.status === "error").length;
}

function canStart(): boolean {
  return !queueState.isProcessing && queueState.items.some((item) => item.status === "idle");
}

function getItemByPath(path: string): QueueItem | undefined {
  return queueState.items.find((item) => item.path === path);
}

function getState(): QueueStore {
  return {
    items: queueState.items,
    selectedIds: queueState.selectedIds,
    isProcessing: queueState.isProcessing,
    currentSessionId: queueState.currentSessionId,
    addItems,
    removeItems,
    updateItem,
    clearCompleted,
    setSelection,
    reorderItems,
    setProcessing,
    handleEvent,
    totalDuration,
    completedCount,
    failedCount,
    canStart,
    getItemByPath,
  };
}

function subscribe(listener: QueueListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function identitySelector(state: QueueStore): QueueStore {
  return state;
}

function rehydrateQueueStore(): void {
  mutate((state) => {
    state.items = hydrateItemsFromStorage();
    state.selectedIds = new Set<string>();
    state.isProcessing = false;
    state.currentSessionId = null;
    return true;
  }, false);
}

export function resetQueueStore(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }

  mutate((state) => {
    state.items = [];
    state.selectedIds = new Set<string>();
    state.isProcessing = false;
    state.currentSessionId = null;
    return true;
  }, false);
}

interface UseQueue {
  (): QueueStore;
  <T>(selector: QueueSelector<T>): T;
  getState: () => QueueStore;
  subscribe: (listener: QueueListener) => () => void;
  rehydrate: () => void;
  reset: () => void;
}

const useQueueImpl = <T,>(
  selector: QueueSelector<T> = identitySelector as QueueSelector<T>
): T => useSyncExternalStore(subscribe, () => selector(getState()), () => selector(getState()));

export const useQueue = useQueueImpl as UseQueue;

useQueue.getState = getState;
useQueue.subscribe = subscribe;
useQueue.rehydrate = rehydrateQueueStore;
useQueue.reset = resetQueueStore;
