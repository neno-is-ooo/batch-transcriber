import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../../types/queue";
import { QueueList } from "./QueueList";

function createItem(index: number): QueueItem {
  return {
    id: `item-${index}`,
    path: `/audio/track-${index}.wav`,
    name: `track-${index}.wav`,
    size: 2048 + index,
    duration: 30 + index,
    format: "wav",
    status: "idle",
    progress: 0,
  };
}

function QueueListHarness({
  items,
  onItemClick,
}: {
  items: QueueItem[];
  onItemClick?: (id: string) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const handleItemClick = onItemClick ?? vi.fn();
  const selectedCopy = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <QueueList
      items={items}
      selectedIds={selectedCopy}
      onSelectionChange={(ids) => setSelectedIds(new Set(ids))}
      onItemClick={handleItemClick}
      onQuickLook={vi.fn()}
    />
  );
}

describe("QueueList", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a virtualized subset for large queues", () => {
    const items = Array.from({ length: 1000 }, (_, index) => createItem(index));
    render(<QueueListHarness items={items} />);

    const rendered = screen.getAllByRole("option");
    expect(rendered.length).toBeLessThan(64);
  });

  it("supports single click selection", () => {
    const items = Array.from({ length: 8 }, (_, index) => createItem(index));
    render(<QueueListHarness items={items} />);

    const first = screen.getByTestId("queue-item-item-0");
    const second = screen.getByTestId("queue-item-item-1");

    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-selected", "true");

    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveAttribute("aria-selected", "true");
  });

  it("supports cmd or ctrl click toggled selection", () => {
    const items = Array.from({ length: 8 }, (_, index) => createItem(index));
    render(<QueueListHarness items={items} />);

    const first = screen.getByTestId("queue-item-item-0");
    const second = screen.getByTestId("queue-item-item-1");

    fireEvent.click(first);
    fireEvent.click(second, { metaKey: true });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("aria-selected", "true");

    fireEvent.click(first, { ctrlKey: true });
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveAttribute("aria-selected", "true");
  });

  it("supports shift click range selection", () => {
    const items = Array.from({ length: 10 }, (_, index) => createItem(index));
    render(<QueueListHarness items={items} />);

    fireEvent.click(screen.getByTestId("queue-item-item-1"));
    fireEvent.click(screen.getByTestId("queue-item-item-4"), { shiftKey: true });

    expect(screen.getByTestId("queue-item-item-1")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("queue-item-item-2")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("queue-item-item-3")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("queue-item-item-4")).toHaveAttribute("aria-selected", "true");
  });

  it("supports keyboard navigation and shift-extend range selection", () => {
    const items = Array.from({ length: 10 }, (_, index) => createItem(index));
    const onItemClick = vi.fn();
    render(<QueueListHarness items={items} onItemClick={onItemClick} />);

    fireEvent.click(screen.getByTestId("queue-item-item-1"));

    const list = screen.getByTestId("queue-list");
    list.focus();

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByTestId("queue-item-item-2")).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByTestId("queue-item-item-2")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("queue-item-item-3")).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(list, { key: "a", ctrlKey: true });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(10);
    expect(onItemClick).toHaveBeenCalled();
  });
});
