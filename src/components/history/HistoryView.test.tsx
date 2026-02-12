import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../lib/tauri-commands";
import { HistoryView } from "./HistoryView";

function createSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-a",
    createdAt: 1_707_696_000,
    provider: "coreml-local",
    model: "v3",
    outputDir: "/tmp/out",
    manifestPath: "/tmp/sessions/session-a.json",
    total: 2,
    processed: 1,
    skipped: 0,
    failed: 1,
    durationSeconds: 11.4,
    exitCode: 1,
    status: "failed",
    files: [
      {
        id: "file-a",
        path: "/audio/a.wav",
        name: "a.wav",
        status: "success",
        transcriptPath: "/tmp/out/a.txt",
      },
      {
        id: "file-b",
        path: "/audio/b.wav",
        name: "b.wav",
        status: "failed",
        error: "decode failed",
      },
    ],
    ...overrides,
  };
}

describe("HistoryView", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders sessions and shows details for selected entry", () => {
    render(
      <HistoryView
        sessions={[
          createSession(),
          createSession({
            id: "session-b",
            provider: "whisper-openai",
            model: "base",
            status: "completed",
            failed: 0,
            processed: 2,
            total: 2,
            files: [
              {
                id: "file-c",
                path: "/audio/c.wav",
                name: "c.wav",
                status: "success",
              },
            ],
          }),
        ]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onReopenSession={vi.fn()}
        onExportSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRevealPath={vi.fn()}
      />
    );

    expect(screen.getByText("session-a")).toBeInTheDocument();
    expect(within(screen.getByTestId("history-list")).getByText("whisper-openai")).toBeInTheDocument();
    expect(screen.getByText("a.wav")).toBeInTheDocument();
    expect(screen.getByText("b.wav")).toBeInTheDocument();
  });

  it("filters by search and provider", () => {
    render(
      <HistoryView
        sessions={[
          createSession(),
          createSession({
            id: "session-b",
            provider: "whisper-openai",
            model: "base",
            files: [{ id: "file-c", path: "/audio/c.wav", name: "special.wav", status: "success" }],
          }),
        ]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onReopenSession={vi.fn()}
        onExportSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRevealPath={vi.fn()}
      />
    );

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "special" },
    });

    expect(screen.queryByText("session-a")).not.toBeInTheDocument();
    expect(screen.getByText("session-b")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "coreml-local" },
    });

    expect(screen.queryByText("session-b")).not.toBeInTheDocument();
    expect(screen.getByText("No sessions match the current filters.")).toBeInTheDocument();
  });

  it("triggers callbacks from detail actions", () => {
    const onRefresh = vi.fn();
    const onReopenSession = vi.fn();
    const onExportSession = vi.fn();
    const onDeleteSession = vi.fn();
    const onRevealPath = vi.fn();

    render(
      <HistoryView
        sessions={[createSession()]}
        loading={false}
        error={null}
        onRefresh={onRefresh}
        onReopenSession={onReopenSession}
        onExportSession={onExportSession}
        onDeleteSession={onDeleteSession}
        onRevealPath={onRevealPath}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen Session" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Transcripts" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Session" }));
    fireEvent.click(screen.getByRole("button", { name: "/tmp/out" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onReopenSession).toHaveBeenCalledTimes(1);
    expect(onExportSession).toHaveBeenCalledTimes(1);
    expect(onDeleteSession).toHaveBeenCalledTimes(1);
    expect(onRevealPath).toHaveBeenCalledWith("/tmp/out");
  });
});
