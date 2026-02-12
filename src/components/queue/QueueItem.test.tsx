import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QueueItem as QueueItemModel, QueueStatus } from "../../types/queue";
import { QueueItem } from "./QueueItem";

function createQueueItem(status: QueueStatus): QueueItemModel {
  return {
    id: `item-${status}`,
    path: `/audio/${status}.wav`,
    name: `${status}.wav`,
    size: 12_345,
    duration: 65,
    format: "wav",
    status,
    progress: status === "processing" ? 42 : status === "completed" ? 100 : 0,
    rtfx: status === "processing" ? 1.37 : undefined,
    error: status === "error" ? "Decoder failed" : undefined,
  };
}

describe("QueueItem", () => {
  it("renders idle status", () => {
    render(
      <QueueItem
        item={createQueueItem("idle")}
        isSelected={false}
        onClick={vi.fn()}
        onQuickLook={vi.fn()}
      />
    );

    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("CLK")).toBeInTheDocument();
  });

  it("renders queued status with spinner", () => {
    render(
      <QueueItem
        item={createQueueItem("queued")}
        isSelected={false}
        onClick={vi.fn()}
        onQuickLook={vi.fn()}
      />
    );

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(document.querySelector(".queue-item__spinner")).toBeInTheDocument();
  });

  it("renders processing status with progress and rtfx", () => {
    render(
      <QueueItem
        item={createQueueItem("processing")}
        isSelected={false}
        onClick={vi.fn()}
        onQuickLook={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Progress 42%")).toBeInTheDocument();
    expect(screen.getByText("1.37x")).toBeInTheDocument();
  });

  it("renders completed status", () => {
    render(
      <QueueItem
        item={createQueueItem("completed")}
        isSelected={false}
        onClick={vi.fn()}
        onQuickLook={vi.fn()}
      />
    );

    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("renders error status with tooltip", () => {
    render(
      <QueueItem
        item={createQueueItem("error")}
        isSelected={false}
        onClick={vi.fn()}
        onQuickLook={vi.fn()}
      />
    );

    const status = screen.getByText("Error").closest(".queue-item__status");
    expect(status).toHaveAttribute("title", "Decoder failed");
    expect(screen.getByText("ERR")).toBeInTheDocument();
  });
});
