import type { QueueItem } from "../../types/queue";

interface MetadataCardProps {
  item: QueueItem;
  content: string | null;
  transcriptPath: string | null;
}

interface MetadataRowProps {
  label: string;
  value: string;
}

function MetadataRow({ label, value }: MetadataRowProps) {
  return (
    <div className="metadata-card__row">
      <dt className="metadata-card__label">{label}</dt>
      <dd className="metadata-card__value">{value}</dd>
    </div>
  );
}

function formatDuration(seconds?: number): string {
  if (!Number.isFinite(seconds)) {
    return "--:--";
  }

  const safeSeconds = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
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

function countWords(content: string | null): number {
  if (!content) {
    return 0;
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return 0;
  }

  return trimmed.split(/\s+/).length;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? path;
}

function transcriptFormat(path: string | null, fallbackFormat?: string): string {
  if (path) {
    const fileName = baseName(path);
    const lastDot = fileName.lastIndexOf(".");
    if (lastDot > -1 && lastDot < fileName.length - 1) {
      return fileName.slice(lastDot + 1).toUpperCase();
    }
  }

  return fallbackFormat ? fallbackFormat.toUpperCase() : "TXT";
}

export function MetadataCard({ item, content, transcriptPath }: MetadataCardProps) {
  const wordCount = countWords(content);
  const rows = [
    {
      label: "Duration",
      value: formatDuration(item.duration),
    },
    {
      label: "Word Count",
      value: wordCount.toLocaleString(),
    },
    {
      label: "Format",
      value: transcriptFormat(transcriptPath, item.format),
    },
    {
      label: "Size",
      value: formatBytes(item.size),
    },
  ];

  return (
    <aside className="metadata-card panel-blur" data-testid="metadata-card" aria-label="Transcript metadata">
      <h3 className="metadata-card__title">Metadata</h3>
      <dl className="metadata-card__list">
        {rows.map((row) => (
          <MetadataRow key={row.label} label={row.label} value={row.value} />
        ))}
        {Number.isFinite(item.rtfx) ? (
          <MetadataRow label="RTFx" value={`${(item.rtfx ?? 0).toFixed(2)}x`} />
        ) : null}
      </dl>
    </aside>
  );
}
