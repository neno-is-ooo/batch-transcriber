import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionsBar, type ActionsBarProps } from "./ActionsBar";

function renderActionsBar(overrides: Partial<ActionsBarProps> = {}) {
  const props: ActionsBarProps = {
    selectedCount: 0,
    canStart: true,
    isProcessing: false,
    completedCount: 0,
    idleCount: 3,
    pendingCount: 0,
    processedCount: 0,
    totalCount: 0,
    provider: "parakeet-coreml",
    model: "v3",
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRemoveSelected: vi.fn(),
    onClearCompleted: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };

  render(<ActionsBar {...props} />);
  return props;
}

describe("ActionsBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("enables start button when queue can start", () => {
    renderActionsBar({ canStart: true, idleCount: 2 });

    expect(screen.getByRole("button", { name: /transcribe 2 items/i })).toBeEnabled();
  });

  it("disables start button when queue cannot start", () => {
    renderActionsBar({ canStart: false, idleCount: 0 });

    expect(screen.getByRole("button", { name: /transcribe 0 items/i })).toBeDisabled();
  });

  it("renders stop flow with confirmation when there are pending items", () => {
    const onStop = vi.fn();
    renderActionsBar({
      isProcessing: true,
      pendingCount: 3,
      processedCount: 1,
      totalCount: 4,
      onStop,
    });

    fireEvent.click(screen.getByRole("button", { name: /stop/i }));

    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("3 files are still pending.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /stop now/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when no items are pending", () => {
    const onStop = vi.fn();
    renderActionsBar({ isProcessing: true, pendingCount: 0, onStop });

    fireEvent.click(screen.getByRole("button", { name: /stop/i }));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows remove selected action when items are selected", () => {
    const onRemoveSelected = vi.fn();
    renderActionsBar({ selectedCount: 2, onRemoveSelected });

    fireEvent.click(screen.getByRole("button", { name: "Remove (2)" }));

    expect(onRemoveSelected).toHaveBeenCalledTimes(1);
  });

  it("shows export and clear actions when completed items exist", () => {
    const onExport = vi.fn();
    const onClearCompleted = vi.fn();
    renderActionsBar({ completedCount: 4, onExport, onClearCompleted });

    fireEvent.click(screen.getByRole("button", { name: "Export ZIP" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Completed" }));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onClearCompleted).toHaveBeenCalledTimes(1);
  });

  it("renders processing indicator with percentage progress", () => {
    renderActionsBar({
      isProcessing: true,
      pendingCount: 3,
      processedCount: 2,
      totalCount: 5,
    });

    expect(screen.getByTestId("processing-indicator")).toHaveTextContent("2 / 5");
    expect(screen.getByTestId("processing-indicator-fill")).toHaveStyle("width: 40%");
  });
});
