import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../../types/queue";
import { QueueView } from "./QueueView";

function createItem(id: string, duration: number): QueueItem {
  return {
    id,
    path: `/audio/${id}.wav`,
    name: `${id}.wav`,
    size: 5_000_000,
    duration,
    format: "wav",
    status: "idle",
    progress: 0,
  };
}

describe("QueueView", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders drop zone when queue is empty", () => {
    render(
      <QueueView
        items={[]}
        selectedIds={new Set()}
        onFilesAdded={vi.fn()}
        onSelectionChange={vi.fn()}
      />
    );

    expect(screen.getByTestId("drop-zone")).toBeInTheDocument();
    expect(screen.getByText("0 items")).toBeInTheDocument();
    expect(screen.getByText("Total 00:00:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transcribe 0 items/i })).toBeDisabled();
  });

  it("renders queue list and total duration when items exist", () => {
    const items = [createItem("a", 61), createItem("b", 30)];
    render(
      <QueueView
        items={items}
        selectedIds={new Set(["a"])}
        onFilesAdded={vi.fn()}
        onSelectionChange={vi.fn()}
      />
    );

    expect(screen.queryByTestId("drop-zone")).not.toBeInTheDocument();
    expect(screen.getByTestId("queue-list")).toBeInTheDocument();
    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("Total 00:01:31")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transcribe 2 items/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove (1)" })).toBeInTheDocument();
  });
});
