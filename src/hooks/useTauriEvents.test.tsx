import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem, TranscriptionEvent } from "../types";
import { useQueue } from "./useQueue";
import { useTauriEvents } from "./useTauriEvents";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

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

function EventHarness() {
  useTauriEvents();
  return null;
}

describe("useTauriEvents", () => {
  beforeEach(() => {
    localStorage.clear();
    useQueue.reset();
    listenMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useQueue.reset();
    localStorage.clear();
  });

  it("subscribes to tauri events and forwards payloads", async () => {
    let callback:
      | ((event: { payload: TranscriptionEvent }) => void)
      | undefined;
    const unlisten = vi.fn();

    listenMock.mockImplementation(
      (_eventName: string, handler: (event: { payload: TranscriptionEvent }) => void) => {
        callback = handler;
        return Promise.resolve(unlisten);
      }
    );

    useQueue.getState().addItems([createQueueItem("/audio/from-hook.wav")]);

    const { unmount } = render(<EventHarness />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith("transcription-event", expect.any(Function));
    });

    if (!callback) {
      throw new Error("Expected tauri event callback to be registered.");
    }

    callback({
      payload: {
        event: "file_progress",
        index: 1,
        file: "/audio/from-hook.wav",
        progress: 73,
        rtfx: 1.2,
      },
    });

    expect(useQueue.getState().getItemByPath("/audio/from-hook.wav")?.progress).toBe(73);

    unmount();

    await waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});
