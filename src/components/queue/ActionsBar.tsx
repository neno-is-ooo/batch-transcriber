import { useEffect, useState } from "react";

export interface ActionsBarProps {
  selectedCount: number;
  canStart: boolean;
  isProcessing: boolean;
  completedCount: number;
  idleCount: number;
  pendingCount: number;
  processedCount: number;
  totalCount: number;
  provider: string;
  model: string;
  onStart: () => void;
  onStop: () => void;
  onRemoveSelected: () => void;
  onClearCompleted: () => void;
  onExport: () => void;
}

interface StartButtonProps {
  onClick: () => void;
  disabled: boolean;
  itemCount: number;
  provider: string;
  model: string;
}

interface StopButtonProps {
  onClick: () => void;
  pendingCount: number;
}

interface ProcessingIndicatorProps {
  processed: number;
  total: number;
}

function formatItemNoun(count: number): string {
  return count === 1 ? "Item" : "Items";
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function ProcessingIndicator({ processed, total }: ProcessingIndicatorProps) {
  const safeProcessed = safeCount(processed);
  const safeTotal = safeCount(total);
  const boundedProcessed = Math.min(safeProcessed, safeTotal);
  const percentage = safeTotal === 0 ? 0 : Math.round((boundedProcessed / safeTotal) * 100);

  return (
    <div className="processing-indicator" data-testid="processing-indicator">
      <div className="processing-indicator__track" aria-hidden="true">
        <div
          className="processing-indicator__fill"
          style={{ width: `${percentage}%` }}
          data-testid="processing-indicator-fill"
        />
      </div>
      <span className="processing-indicator__text">
        {boundedProcessed} / {safeTotal}
      </span>
    </div>
  );
}

function StartButton({ onClick, disabled, itemCount, provider, model }: StartButtonProps) {
  return (
    <button
      type="button"
      className="actions-bar__start"
      onClick={onClick}
      disabled={disabled}
      data-testid="start-button"
    >
      <span className="actions-bar__icon" aria-hidden="true">
        ▶
      </span>
      <span>
        Transcribe {itemCount} {formatItemNoun(itemCount)}
      </span>
      <span className="actions-bar__provider">
        {provider} / {model}
      </span>
    </button>
  );
}

function StopButton({ onClick, pendingCount }: StopButtonProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const safePendingCount = safeCount(pendingCount);

  useEffect(() => {
    if (!showConfirm) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowConfirm(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [showConfirm]);

  const handleClick = () => {
    if (safePendingCount > 0) {
      setShowConfirm(true);
      return;
    }

    onClick();
  };

  const handleConfirm = () => {
    onClick();
    setShowConfirm(false);
  };

  return (
    <>
      <button
        type="button"
        className="actions-bar__stop"
        onClick={handleClick}
        data-testid="stop-button"
      >
        <span className="actions-bar__icon" aria-hidden="true">
          ■
        </span>
        <span>Stop</span>
      </button>

      {showConfirm ? (
        <div className="actions-bar__dialog-backdrop" role="presentation">
          <div
            className="actions-bar__dialog panel-blur"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stop-transcription-title"
          >
            <h3 id="stop-transcription-title">Stop Transcription?</h3>
            <p>
              {safePendingCount} {safePendingCount === 1 ? "file is" : "files are"} still pending.
            </p>
            <div className="actions-bar__dialog-actions">
              <button
                type="button"
                className="actions-bar__secondary"
                onClick={() => setShowConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="actions-bar__stop-confirm"
                onClick={handleConfirm}
              >
                Stop now
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ActionsBar({
  selectedCount,
  canStart,
  isProcessing,
  completedCount,
  idleCount,
  pendingCount,
  processedCount,
  totalCount,
  provider,
  model,
  onStart,
  onStop,
  onRemoveSelected,
  onClearCompleted,
  onExport,
}: ActionsBarProps) {
  const safeSelectedCount = safeCount(selectedCount);
  const safeCompletedCount = safeCount(completedCount);

  return (
    <div className="actions-bar panel-blur" data-testid="actions-bar">
      <div className="actions-bar__primary">
        {isProcessing ? (
          <>
            <StopButton onClick={onStop} pendingCount={pendingCount} />
            <ProcessingIndicator processed={processedCount} total={totalCount} />
          </>
        ) : (
          <StartButton
            onClick={onStart}
            disabled={!canStart}
            itemCount={safeCount(idleCount)}
            provider={provider}
            model={model}
          />
        )}
      </div>

      <div className="actions-bar__group">
        {safeSelectedCount > 0 ? (
          <button
            type="button"
            className="actions-bar__secondary"
            onClick={onRemoveSelected}
            data-testid="remove-selected-button"
          >
            Remove ({safeSelectedCount})
          </button>
        ) : null}

        {safeCompletedCount > 0 ? (
          <>
            <button
              type="button"
              className="actions-bar__secondary"
              onClick={onExport}
              data-testid="export-zip-button"
            >
              Export ZIP
            </button>
            <button
              type="button"
              className="actions-bar__secondary"
              onClick={onClearCompleted}
              data-testid="clear-completed-button"
            >
              Clear Completed
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
