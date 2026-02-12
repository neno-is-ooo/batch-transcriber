import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "./ExportDialog";

describe("ExportDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render when closed", () => {
    render(<ExportDialog isOpen={false} itemCount={3} onCancel={vi.fn()} onExport={vi.fn()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("submits default options", () => {
    const onExport = vi.fn();
    render(<ExportDialog isOpen={true} itemCount={2} onCancel={vi.fn()} onExport={onExport} />);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(onExport).toHaveBeenCalledWith({
      format: "zip",
      naming: "preserve",
      includeMetadata: true,
      preserveStructure: false,
    });
  });

  it("updates options before exporting", () => {
    const onExport = vi.fn();
    render(<ExportDialog isOpen={true} itemCount={1} onCancel={vi.fn()} onExport={onExport} />);

    fireEvent.click(screen.getByRole("radio", { name: "Folder" }));
    fireEvent.change(screen.getByLabelText("Naming"), {
      target: { value: "numbered" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include metadata.json" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Preserve directory structure" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(onExport).toHaveBeenCalledWith({
      format: "folder",
      naming: "numbered",
      includeMetadata: false,
      preserveStructure: true,
    });
  });
});
