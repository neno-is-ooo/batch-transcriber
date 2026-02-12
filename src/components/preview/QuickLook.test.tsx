import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../../types/queue";
import { QuickLook } from "./QuickLook";

const {
  exportTranscriptMock,
  openPathMock,
  readTranscriptMock,
  saveMock,
  writeTextMock,
} = vi.hoisted(() => ({
  readTranscriptMock: vi.fn(),
  exportTranscriptMock: vi.fn(),
  openPathMock: vi.fn(),
  saveMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("../../lib/tauri-commands", () => ({
  readTranscript: readTranscriptMock,
  exportTranscript: exportTranscriptMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: openPathMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: saveMock,
}));

function createItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "preview-item",
    path: "/audio/demo.wav",
    name: "demo.wav",
    size: 4_096,
    duration: 75,
    status: "completed",
    progress: 100,
    rtfx: 1.23,
    transcriptPath: "/output/demo.txt",
    ...overrides,
  };
}

describe("QuickLook", () => {
  beforeEach(() => {
    readTranscriptMock.mockReset();
    exportTranscriptMock.mockReset();
    openPathMock.mockReset();
    saveMock.mockReset();
    writeTextMock.mockReset();

    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: {
        writeText: writeTextMock,
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("toggles open/closed classes for overlay animation", () => {
    readTranscriptMock.mockResolvedValue("alpha");

    const { rerender } = render(
      <QuickLook
        item={createItem()}
        isOpen={false}
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    expect(screen.getByTestId("quick-look-overlay")).not.toHaveClass("quick-look-overlay--open");
    expect(readTranscriptMock).not.toHaveBeenCalled();

    rerender(
      <QuickLook
        item={createItem()}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    expect(screen.getByTestId("quick-look-overlay")).toHaveClass("quick-look-overlay--open");
  });

  it("loads and displays transcript content", async () => {
    readTranscriptMock.mockResolvedValue("line one\nline two");

    render(
      <QuickLook
        item={createItem()}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    await waitFor(() => {
      expect(readTranscriptMock).toHaveBeenCalledWith("/output/demo.txt");
    });

    expect(screen.getByText("line one")).toBeInTheDocument();
    expect(screen.getByText("line two")).toBeInTheDocument();
  });

  it("pretty-prints JSON transcripts", async () => {
    readTranscriptMock.mockResolvedValue('{"name":"parakeet","count":2}');

    render(
      <QuickLook
        item={createItem({ transcriptPath: "/output/demo.json" })}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("quick-look-json-content")).toBeInTheDocument();
    });

    expect(screen.getByText(/"name"/)).toBeInTheDocument();
    expect(screen.getByText(/"parakeet"/)).toBeInTheDocument();
  });

  it("highlights subtitle timestamps", async () => {
    readTranscriptMock.mockResolvedValue("1\n00:00:01,000 --> 00:00:02,000\nHello");

    const { container } = render(
      <QuickLook
        item={createItem({ transcriptPath: "/output/demo.srt" })}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("quick-look-subtitle-content")).toBeInTheDocument();
    });

    expect(container.querySelector(".quick-look__line--timestamp")).toBeTruthy();
  });

  it("renders metadata values", async () => {
    readTranscriptMock.mockResolvedValue("hello preview world");

    render(
      <QuickLook
        item={createItem({ size: 2_048, duration: 95, rtfx: 1.5 })}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("metadata-card")).toBeInTheDocument();
    });

    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("1:35")).toBeInTheDocument();
    expect(screen.getByText("Word Count")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("RTFx")).toBeInTheDocument();
    expect(screen.getByText("1.50x")).toBeInTheDocument();
  });

  it("copies transcript content to clipboard", async () => {
    readTranscriptMock.mockResolvedValue("copy me");
    writeTextMock.mockResolvedValue(undefined);

    render(
      <QuickLook
        item={createItem()}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("copy me");
    });
  });

  it("opens transcript in default editor", async () => {
    readTranscriptMock.mockResolvedValue("open me");
    openPathMock.mockResolvedValue(undefined);

    render(
      <QuickLook
        item={createItem()}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(openPathMock).toHaveBeenCalledWith("/output/demo.txt");
    });
  });

  it("exports transcript to selected destination", async () => {
    readTranscriptMock.mockResolvedValue("export me");
    saveMock.mockResolvedValue("/exports/demo.txt");
    exportTranscriptMock.mockResolvedValue(undefined);

    render(
      <QuickLook
        item={createItem()}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({ defaultPath: "demo.txt" });
      expect(exportTranscriptMock).toHaveBeenCalledWith("/output/demo.txt", "/exports/demo.txt");
    });
  });

  it("shows loading state while transcript is fetching", () => {
    readTranscriptMock.mockImplementation(
      () => new Promise<string>(() => {
        // Keep pending for loading state assertion.
      })
    );

    render(
      <QuickLook
        item={createItem()}
        isOpen
        onClose={vi.fn()}
        onNavigatePrevious={vi.fn()}
        onNavigateNext={vi.fn()}
        hasPrevious={false}
        hasNext={false}
      />
    );

    expect(screen.getByTestId("quick-look-loading")).toBeInTheDocument();
  });
});
