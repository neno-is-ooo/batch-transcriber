export interface OutputPaths {
  txt?: string;
  json?: string;
}

export interface FailureRecord {
  file: string;
  error: string;
}

export interface StartEvent {
  event: "start";
  session_id: string;
  provider: string;
  model: string;
}

export interface ScannedEvent {
  event: "scanned";
  total: number;
}

export interface ModelsLoadedEvent {
  event: "models_loaded";
}

export interface FileStartedEvent {
  event: "file_started";
  index: number;
  total: number;
  file: string;
  relative: string;
}

export interface FileProgressEvent {
  event: "file_progress";
  index: number;
  file: string;
  progress: number;
  rtfx: number;
}

export interface FileDoneEvent {
  event: "file_done";
  index: number;
  file: string;
  duration_seconds: number;
  processing_seconds: number;
  rtfx: number;
  confidence: number;
  output: OutputPaths;
}

export interface FileSkippedEvent {
  event: "file_skipped";
  index: number;
  file: string;
  reason: string;
  output?: OutputPaths;
}

export interface FileFailedEvent {
  event: "file_failed";
  index: number;
  file: string;
  error: string;
  attempts: number;
}

export interface FileRetryEvent {
  event: "file_retry";
  index: number;
  file: string;
  attempt: number;
  reason: string;
}

export interface SummaryEvent {
  event: "summary";
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  duration_seconds: number;
  failures: FailureRecord[];
}

export interface FatalErrorEvent {
  event: "fatal_error";
  error: string;
}

export type TranscriptionEvent =
  | StartEvent
  | ScannedEvent
  | ModelsLoadedEvent
  | FileStartedEvent
  | FileProgressEvent
  | FileDoneEvent
  | FileSkippedEvent
  | FileFailedEvent
  | FileRetryEvent
  | SummaryEvent
  | FatalErrorEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasString(data: Record<string, unknown>, key: string): boolean {
  return typeof data[key] === "string";
}

function hasNumber(data: Record<string, unknown>, key: string): boolean {
  return typeof data[key] === "number" && Number.isFinite(data[key]);
}

function isOutputPaths(data: unknown): data is OutputPaths {
  if (!isRecord(data)) {
    return false;
  }

  if ("txt" in data && data.txt !== undefined && typeof data.txt !== "string") {
    return false;
  }

  if ("json" in data && data.json !== undefined && typeof data.json !== "string") {
    return false;
  }

  return true;
}

function isFailureRecord(data: unknown): data is FailureRecord {
  if (!isRecord(data)) {
    return false;
  }

  return hasString(data, "file") && hasString(data, "error");
}

export function isStartEvent(data: unknown): data is StartEvent {
  if (!isRecord(data) || data.event !== "start") {
    return false;
  }

  return (
    hasString(data, "session_id") &&
    hasString(data, "provider") &&
    hasString(data, "model")
  );
}

export function isScannedEvent(data: unknown): data is ScannedEvent {
  if (!isRecord(data) || data.event !== "scanned") {
    return false;
  }

  return hasNumber(data, "total");
}

export function isModelsLoadedEvent(data: unknown): data is ModelsLoadedEvent {
  return isRecord(data) && data.event === "models_loaded";
}

export function isFileStartedEvent(data: unknown): data is FileStartedEvent {
  if (!isRecord(data) || data.event !== "file_started") {
    return false;
  }

  return (
    hasNumber(data, "index") &&
    hasNumber(data, "total") &&
    hasString(data, "file") &&
    hasString(data, "relative")
  );
}

export function isFileProgressEvent(data: unknown): data is FileProgressEvent {
  if (!isRecord(data) || data.event !== "file_progress") {
    return false;
  }

  return (
    hasNumber(data, "index") &&
    hasString(data, "file") &&
    hasNumber(data, "progress") &&
    hasNumber(data, "rtfx")
  );
}

export function isFileDoneEvent(data: unknown): data is FileDoneEvent {
  if (!isRecord(data) || data.event !== "file_done") {
    return false;
  }

  return (
    hasNumber(data, "index") &&
    hasString(data, "file") &&
    hasNumber(data, "duration_seconds") &&
    hasNumber(data, "processing_seconds") &&
    hasNumber(data, "rtfx") &&
    hasNumber(data, "confidence") &&
    isOutputPaths(data.output)
  );
}

export function isFileSkippedEvent(data: unknown): data is FileSkippedEvent {
  if (!isRecord(data) || data.event !== "file_skipped") {
    return false;
  }

  if (!hasNumber(data, "index") || !hasString(data, "file") || !hasString(data, "reason")) {
    return false;
  }

  if ("output" in data && data.output !== undefined && !isOutputPaths(data.output)) {
    return false;
  }

  return true;
}

export function isFileFailedEvent(data: unknown): data is FileFailedEvent {
  if (!isRecord(data) || data.event !== "file_failed") {
    return false;
  }

  return (
    hasNumber(data, "index") &&
    hasString(data, "file") &&
    hasString(data, "error") &&
    hasNumber(data, "attempts")
  );
}

export function isFileRetryEvent(data: unknown): data is FileRetryEvent {
  if (!isRecord(data) || data.event !== "file_retry") {
    return false;
  }

  return (
    hasNumber(data, "index") &&
    hasString(data, "file") &&
    hasNumber(data, "attempt") &&
    hasString(data, "reason")
  );
}

export function isSummaryEvent(data: unknown): data is SummaryEvent {
  if (!isRecord(data) || data.event !== "summary") {
    return false;
  }

  if (
    !hasNumber(data, "total") ||
    !hasNumber(data, "processed") ||
    !hasNumber(data, "skipped") ||
    !hasNumber(data, "failed") ||
    !hasNumber(data, "duration_seconds")
  ) {
    return false;
  }

  if (!Array.isArray(data.failures)) {
    return false;
  }

  return data.failures.every((failure) => isFailureRecord(failure));
}

export function isFatalErrorEvent(data: unknown): data is FatalErrorEvent {
  if (!isRecord(data) || data.event !== "fatal_error") {
    return false;
  }

  return hasString(data, "error");
}

export function isTranscriptionEvent(data: unknown): data is TranscriptionEvent {
  return (
    isStartEvent(data) ||
    isScannedEvent(data) ||
    isModelsLoadedEvent(data) ||
    isFileStartedEvent(data) ||
    isFileProgressEvent(data) ||
    isFileDoneEvent(data) ||
    isFileSkippedEvent(data) ||
    isFileFailedEvent(data) ||
    isFileRetryEvent(data) ||
    isSummaryEvent(data) ||
    isFatalErrorEvent(data)
  );
}
