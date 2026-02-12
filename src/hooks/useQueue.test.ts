import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../types";
import { QUEUE_STORAGE_KEY, useQueue } from "./useQueue";

function createQueueItem(path: string, overrides: Partial<QueueItem> = {}): QueueItem {
  const fileName = path.split("/").pop() ?? path;

  return {
    id: `seed-${fileName}`,
    path,
    name: fileName,
    size: 1_024,
    status: "idle",
    progress: 0,
    ...overrides,
  };
}

describe("useQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useQueue.reset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useQueue.reset();
    localStorage.clear();
  });

  it("adds items with path dedupe and idle defaults", () => {
    useQueue.getState().addItems([
      createQueueItem("/audio/alpha.wav", { status: "completed", progress: 99 }),
      createQueueItem("/audio/alpha.wav"),
      createQueueItem("/audio/beta.wav", { status: "error", progress: 22 }),
    ]);

    const items = useQueue.getState().items;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.path)).toEqual([
      "/audio/alpha.wav",
      "/audio/beta.wav",
    ]);
    expect(items[0].status).toBe("idle");
    expect(items[0].progress).toBe(0);
    expect(items[1].status).toBe("idle");
    expect(items[1].progress).toBe(0);
    expect(items[0].id).not.toBe("seed-alpha.wav");
  });

  it("removes items and clears removed ids from selection", () => {
    const queue = useQueue.getState();
    queue.addItems([
      createQueueItem("/audio/one.wav"),
      createQueueItem("/audio/two.wav"),
    ]);

    const [first, second] = useQueue.getState().items;
    queue.setSelection([first.id, second.id, "missing-id"]);
    queue.removeItems([first.id]);

    const nextState = useQueue.getState();
    expect(nextState.items).toHaveLength(1);
    expect(nextState.items[0].id).toBe(second.id);
    expect(nextState.selectedIds.has(first.id)).toBe(false);
    expect(nextState.selectedIds.has(second.id)).toBe(true);
  });

  it("reorders items between valid indices", () => {
    const queue = useQueue.getState();
    queue.addItems([
      createQueueItem("/audio/first.wav"),
      createQueueItem("/audio/second.wav"),
      createQueueItem("/audio/third.wav"),
    ]);

    queue.reorderItems(0, 2);

    expect(useQueue.getState().items.map((item) => item.path)).toEqual([
      "/audio/second.wav",
      "/audio/third.wav",
      "/audio/first.wav",
    ]);

    queue.reorderItems(10, 0);
    expect(useQueue.getState().items.map((item) => item.path)).toEqual([
      "/audio/second.wav",
      "/audio/third.wav",
      "/audio/first.wav",
    ]);
  });

  it("persists only items with a 500ms debounce", () => {
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    const queue = useQueue.getState();

    queue.addItems([createQueueItem("/audio/a.wav")]);
    vi.advanceTimersByTime(300);
    queue.addItems([createQueueItem("/audio/b.wav")]);

    vi.advanceTimersByTime(499);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(QUEUE_STORAGE_KEY)).toBeNull();

    vi.advanceTimersByTime(1);

    expect(setItemSpy).toHaveBeenCalledTimes(1);
    const storedRaw = localStorage.getItem(QUEUE_STORAGE_KEY);
    expect(storedRaw).not.toBeNull();

    const stored = JSON.parse(storedRaw as string) as {
      state: {
        items: QueueItem[];
      };
    };

    expect(stored.state.items).toHaveLength(2);
    expect(stored.state.items.map((item) => item.path)).toEqual([
      "/audio/a.wav",
      "/audio/b.wav",
    ]);
    expect(Object.keys(stored.state)).toEqual(["items"]);
  });

  it("rehydrates persisted items and resets processing status to idle", () => {
    localStorage.setItem(
      QUEUE_STORAGE_KEY,
      JSON.stringify({
        state: {
          items: [
            createQueueItem("/audio/restore.wav", {
              status: "processing",
              progress: 61,
            }),
          ],
        },
      })
    );

    useQueue.rehydrate();

    const [restored] = useQueue.getState().items;
    expect(restored.path).toBe("/audio/restore.wav");
    expect(restored.status).toBe("idle");
    expect(restored.progress).toBe(61);
    expect(useQueue.getState().isProcessing).toBe(false);
    expect(useQueue.getState().currentSessionId).toBeNull();
  });

  it("handles transcription events and updates queue items", () => {
    const queue = useQueue.getState();
    queue.addItems([
      createQueueItem("/audio/live.wav"),
      createQueueItem("/audio/fail.wav"),
    ]);

    queue.handleEvent({
      event: "start",
      session_id: "session-01",
      provider: "coreml-local",
      model: "v3",
    });

    expect(useQueue.getState().isProcessing).toBe(true);
    expect(useQueue.getState().currentSessionId).toBe("session-01");

    queue.handleEvent({
      event: "file_started",
      index: 1,
      total: 2,
      file: "/audio/live.wav",
      relative: "live.wav",
    });

    queue.handleEvent({
      event: "file_progress",
      index: 1,
      file: "/audio/live.wav",
      progress: 47,
      rtfx: 1.4,
    });

    queue.handleEvent({
      event: "file_done",
      index: 1,
      file: "/audio/live.wav",
      duration_seconds: 15.2,
      processing_seconds: 10.1,
      rtfx: 1.5,
      confidence: 0.93,
      output: {
        txt: "/output/live.txt",
        json: "/output/live.json",
      },
    });

    queue.handleEvent({
      event: "file_failed",
      index: 2,
      file: "/audio/fail.wav",
      error: "decode failed",
      attempts: 2,
    });

    const liveItem = useQueue.getState().getItemByPath("/audio/live.wav");
    const failItem = useQueue.getState().getItemByPath("/audio/fail.wav");

    expect(liveItem?.status).toBe("completed");
    expect(liveItem?.progress).toBe(100);
    expect(liveItem?.duration).toBe(15.2);
    expect(liveItem?.rtfx).toBe(1.5);
    expect(liveItem?.transcriptPath).toBe("/output/live.txt");
    expect(liveItem?.jsonPath).toBe("/output/live.json");
    expect(failItem?.status).toBe("error");
    expect(failItem?.error).toBe("decode failed");

    queue.handleEvent({
      event: "summary",
      total: 2,
      processed: 1,
      skipped: 0,
      failed: 1,
      duration_seconds: 20,
      failures: [{ file: "/audio/fail.wav", error: "decode failed" }],
    });

    expect(useQueue.getState().isProcessing).toBe(false);
    expect(useQueue.getState().currentSessionId).toBeNull();
  });

  it("keeps transcript paths for skipped files when outputs already exist", () => {
    const queue = useQueue.getState();
    queue.addItems([createQueueItem("/audio/already-done.wav")]);

    queue.handleEvent({
      event: "file_skipped",
      index: 1,
      file: "/audio/already-done.wav",
      reason: "outputs_exist",
      output: {
        txt: "/tmp/batch-transcripts/already-done.wav.txt",
        json: "/tmp/batch-transcripts/already-done.wav.json",
      },
    });

    const item = useQueue.getState().getItemByPath("/audio/already-done.wav");
    expect(item?.status).toBe("completed");
    expect(item?.transcriptPath).toBe("/tmp/batch-transcripts/already-done.wav.txt");
    expect(item?.jsonPath).toBe("/tmp/batch-transcripts/already-done.wav.json");
  });

  it("computes derived selectors", () => {
    const queue = useQueue.getState();
    queue.addItems([
      createQueueItem("/audio/idle.wav", { duration: 6 }),
      createQueueItem("/audio/done.wav", { duration: 4 }),
      createQueueItem("/audio/error.wav", { duration: 2 }),
    ]);

    const [idleItem, doneItem, errorItem] = useQueue.getState().items;
    queue.updateItem(doneItem.id, { status: "completed" });
    queue.updateItem(errorItem.id, { status: "error", error: "bad input" });

    expect(queue.totalDuration()).toBe(12);
    expect(queue.completedCount()).toBe(1);
    expect(queue.failedCount()).toBe(1);
    expect(queue.canStart()).toBe(true);

    queue.setProcessing("session-02");
    expect(queue.canStart()).toBe(false);

    queue.setProcessing(null);
    expect(useQueue.getState().getItemByPath(idleItem.path)?.name).toBe("idle.wav");
  });

  it("warns when receiving events for unknown files", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    useQueue.getState().handleEvent({
      event: "file_progress",
      index: 1,
      file: "/audio/missing.wav",
      progress: 10,
      rtfx: 2,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "[queue] file_progress event ignored; item not found for path: /audio/missing.wav"
    );
  });
});
