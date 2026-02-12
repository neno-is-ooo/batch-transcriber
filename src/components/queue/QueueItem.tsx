import { memo, type CSSProperties, type MouseEvent } from "react";
import type { QueueItem as QueueItemModel, QueueStatus } from "../../types/queue";

export interface QueueItemProps {
  item: QueueItemModel;
  isSelected: boolean;
  style?: CSSProperties;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onQuickLook: () => void;
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds?: number): string {
  if (!Number.isFinite(seconds)) {
    return "--:--";
  }

  const totalSeconds = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatRtfx(rtfx?: number): string {
  if (!Number.isFinite(rtfx)) {
    return "--";
  }

  return `${(rtfx ?? 0).toFixed(2)}x`;
}

function formatBadge(format?: string): string {
  if (!format) {
    return "AUDIO";
  }

  const normalized = format.trim().toUpperCase();
  if (normalized.length === 0) {
    return "AUDIO";
  }

  return normalized.slice(0, 5);
}

function statusLabel(status: QueueStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    default:
      return "Unknown";
  }
}

function renderStatus(item: QueueItemModel) {
  if (item.status === "idle") {
    return (
      <div className="queue-item__status queue-item__status--idle" data-status="idle">
        <span className="queue-item__status-icon">CLK</span>
        <span>Idle</span>
      </div>
    );
  }

  if (item.status === "queued") {
    return (
      <div className="queue-item__status queue-item__status--queued" data-status="queued">
        <span className="queue-item__spinner" aria-hidden="true" />
        <span>Queued</span>
      </div>
    );
  }

  if (item.status === "processing") {
    const progress = Math.max(0, Math.min(100, Math.round(item.progress)));

    return (
      <div className="queue-item__status queue-item__status--processing" data-status="processing">
        <span
          className="queue-item__progress-ring"
          style={{
            background: `conic-gradient(var(--accent) ${progress * 3.6}deg, rgba(255, 255, 255, 0.12) 0deg)`,
          }}
          aria-label={`Progress ${progress}%`}
        >
          <span className="queue-item__progress-core">{progress}</span>
        </span>
        <span className="queue-item__rtfx">{formatRtfx(item.rtfx)}</span>
      </div>
    );
  }

  if (item.status === "completed") {
    return (
      <div className="queue-item__status queue-item__status--completed" data-status="completed">
        <span className="queue-item__status-icon">OK</span>
        <span>Done</span>
      </div>
    );
  }

  return (
    <div
      className="queue-item__status queue-item__status--error"
      data-status="error"
      title={item.error ?? "Unknown error"}
    >
      <span className="queue-item__status-icon">ERR</span>
      <span>Error</span>
    </div>
  );
}

function QueueItemComponent({ item, isSelected, style, onClick, onQuickLook }: QueueItemProps) {
  return (
    <div style={style} className="queue-item__row-wrap">
      <button
        type="button"
        className={`queue-item${isSelected ? " queue-item--selected" : ""}`}
        onClick={onClick}
        onDoubleClick={onQuickLook}
        role="option"
        aria-selected={isSelected}
        data-testid={`queue-item-${item.id}`}
      >
        <span className="queue-item__format">{formatBadge(item.format)}</span>
        <span className="queue-item__content">
          <span className="queue-item__name">{item.name}</span>
          <span className="queue-item__meta">
            {formatBytes(item.size)} | {formatDuration(item.duration)}
          </span>
        </span>
        <span className="queue-item__status-slot" aria-label={statusLabel(item.status)}>
          {renderStatus(item)}
        </span>
      </button>
    </div>
  );
}

function isSameVisualState(left: QueueItemModel, right: QueueItemModel): boolean {
  return (
    left.id === right.id &&
    left.status === right.status &&
    left.progress === right.progress &&
    left.rtfx === right.rtfx &&
    left.error === right.error
  );
}

function areQueueItemPropsEqual(prev: QueueItemProps, next: QueueItemProps): boolean {
  return (
    prev.isSelected === next.isSelected &&
    prev.onClick === next.onClick &&
    prev.onQuickLook === next.onQuickLook &&
    prev.style === next.style &&
    isSameVisualState(prev.item, next.item)
  );
}

export const QueueItem = memo(QueueItemComponent, areQueueItemPropsEqual);
