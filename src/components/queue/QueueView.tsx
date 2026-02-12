import type { QueueItem } from "../../types/queue";
import { ActionsBar } from "./ActionsBar";
import { DropZone } from "./DropZone";
import { QueueList } from "./QueueList";

export interface QueueViewProps {
  items: QueueItem[];
  selectedIds: Set<string>;
  onFilesAdded: (items: QueueItem[]) => void;
  onSelectionChange: (ids: string[]) => void;
  dropDisabled?: boolean;
  canStart?: boolean;
  isProcessing?: boolean;
  completedCount?: number;
  idleCount?: number;
  pendingCount?: number;
  processedCount?: number;
  totalCount?: number;
  provider?: string;
  model?: string;
  onStart?: () => void;
  onStop?: () => void;
  onRemoveSelected?: () => void;
  onClearCompleted?: () => void;
  onExport?: () => void;
  onItemClick?: (id: string) => void;
  onQuickLook?: (id: string) => void;
}

function formatTotalDuration(seconds: number): string {
  const safeTotalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeTotalSeconds / 3600);
  const minutes = Math.floor((safeTotalSeconds % 3600) / 60);
  const remainingSeconds = safeTotalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function sumDuration(items: QueueItem[]): number {
  return items.reduce((sum, item) => {
    if (!Number.isFinite(item.duration)) {
      return sum;
    }

    return sum + (item.duration ?? 0);
  }, 0);
}

export function QueueView({
  items,
  selectedIds,
  onFilesAdded,
  onSelectionChange,
  dropDisabled = false,
  canStart,
  isProcessing = false,
  completedCount,
  idleCount,
  pendingCount,
  processedCount,
  totalCount,
  provider = "parakeet-coreml",
  model = "v3",
  onStart = () => {
    // Intentionally optional while app wiring is incremental.
  },
  onStop = () => {
    // Intentionally optional while app wiring is incremental.
  },
  onRemoveSelected = () => {
    // Intentionally optional while app wiring is incremental.
  },
  onClearCompleted = () => {
    // Intentionally optional while app wiring is incremental.
  },
  onExport = () => {
    // Intentionally optional while app wiring is incremental.
  },
  onItemClick = () => {
    // Intentionally optional for now.
  },
  onQuickLook = () => {
    // Intentionally optional for now.
  },
}: QueueViewProps) {
  const totalDuration = sumDuration(items);
  const selectedCount = selectedIds.size;
  const derivedIdleCount =
    idleCount ?? items.filter((item) => item.status === "idle").length;
  const derivedCompletedCount =
    completedCount ?? items.filter((item) => item.status === "completed").length;
  const derivedPendingCount =
    pendingCount ??
    items.filter(
      (item) =>
        item.status === "idle" || item.status === "queued" || item.status === "processing"
    ).length;
  const derivedTotalCount = totalCount ?? Math.max(0, derivedPendingCount + derivedCompletedCount);
  const derivedProcessedCount =
    processedCount ?? Math.max(0, derivedTotalCount - derivedPendingCount);
  const derivedCanStart = canStart ?? (!isProcessing && derivedIdleCount > 0);

  return (
    <section className="queue-view panel-blur" data-testid="queue-view">
      <header className="queue-view__header">
        <div>
          <p className="queue-view__eyebrow">Queue</p>
          <p className="queue-view__count">
            {items.length} item{items.length === 1 ? "" : "s"}
          </p>
        </div>
        <p className="queue-view__duration">Total {formatTotalDuration(totalDuration)}</p>
      </header>

      <div className="queue-view__body">
        {items.length === 0 ? (
          <DropZone onFilesAdded={onFilesAdded} disabled={dropDisabled} />
        ) : (
          <QueueList
            items={items}
            selectedIds={selectedIds}
            onSelectionChange={onSelectionChange}
            onItemClick={onItemClick}
            onQuickLook={onQuickLook}
          />
        )}
      </div>

      <footer className="queue-view__actions">
        <ActionsBar
          selectedCount={selectedCount}
          canStart={derivedCanStart}
          isProcessing={isProcessing}
          completedCount={derivedCompletedCount}
          idleCount={derivedIdleCount}
          pendingCount={derivedPendingCount}
          processedCount={derivedProcessedCount}
          totalCount={derivedTotalCount}
          provider={provider}
          model={model}
          onStart={onStart}
          onStop={onStop}
          onRemoveSelected={onRemoveSelected}
          onClearCompleted={onClearCompleted}
          onExport={onExport}
        />
      </footer>
    </section>
  );
}
