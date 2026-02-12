import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toast } from "./Toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toast", () => {
  it("renders the message", () => {
    render(<Toast message="Added 2 files to queue" />);

    expect(screen.getByTestId("toast")).toHaveTextContent("Added 2 files to queue");
  });

  it("auto-dismisses after duration", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    render(<Toast message="Done" duration={1000} onDismiss={onDismiss} />);

    vi.advanceTimersByTime(999);
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
