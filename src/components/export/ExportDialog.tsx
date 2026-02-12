import { useState } from "react";
import type { ExportOptions } from "../../lib/tauri-commands";

const DEFAULT_OPTIONS: ExportOptions = {
  format: "zip",
  naming: "preserve",
  includeMetadata: true,
  preserveStructure: false,
};

function cloneDefaults(): ExportOptions {
  return { ...DEFAULT_OPTIONS };
}

export interface ExportDialogProps {
  isOpen: boolean;
  itemCount: number;
  onCancel: () => void;
  onExport: (options: ExportOptions) => void;
}

export function ExportDialog({ isOpen, itemCount, onCancel, onExport }: ExportDialogProps) {
  const [options, setOptions] = useState<ExportOptions>(cloneDefaults);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="export-dialog-overlay" role="presentation" data-testid="export-dialog-overlay">
      <button
        type="button"
        className="export-dialog-overlay__backdrop"
        onClick={onCancel}
        aria-label="Close export dialog"
      />
      <section
        className="export-dialog panel-blur"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
      >
        <header className="export-dialog__header">
          <h2 id="export-dialog-title">Export Transcripts</h2>
          <p>{itemCount} completed item(s) ready for export.</p>
        </header>

        <fieldset className="export-dialog__group">
          <legend>Format</legend>
          <label className="export-dialog__choice">
            <input
              type="radio"
              name="export-format"
              value="zip"
              checked={options.format === "zip"}
              onChange={() => setOptions((current) => ({ ...current, format: "zip" }))}
            />
            <span>ZIP Archive</span>
          </label>
          <label className="export-dialog__choice">
            <input
              type="radio"
              name="export-format"
              value="folder"
              checked={options.format === "folder"}
              onChange={() => setOptions((current) => ({ ...current, format: "folder" }))}
            />
            <span>Folder</span>
          </label>
        </fieldset>

        <label className="export-dialog__field" htmlFor="export-naming-select">
          <span>Naming</span>
          <select
            id="export-naming-select"
            value={options.naming}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                naming: event.target.value as ExportOptions["naming"],
              }))
            }
          >
            <option value="preserve">Preserve original</option>
            <option value="timestamp">Timestamp prefix</option>
            <option value="numbered">Sequential numbers</option>
          </select>
        </label>

        <label className="export-dialog__choice">
          <input
            type="checkbox"
            checked={options.includeMetadata}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                includeMetadata: event.target.checked,
              }))
            }
          />
          <span>Include metadata.json</span>
        </label>

        <label className="export-dialog__choice">
          <input
            type="checkbox"
            checked={options.preserveStructure}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                preserveStructure: event.target.checked,
              }))
            }
          />
          <span>Preserve directory structure</span>
        </label>

        <div className="export-dialog__actions">
          <button type="button" className="actions-bar__secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="actions-bar__start"
            onClick={() => onExport(options)}
            disabled={itemCount <= 0}
          >
            Export
          </button>
        </div>
      </section>
    </div>
  );
}
