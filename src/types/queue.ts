export type QueueStatus =
  | "idle"
  | "queued"
  | "processing"
  | "completed"
  | "error";

export interface AudioMetadata {
  codec?: string;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
}

export interface ItemSettings {
  provider?: string;
  model?: string;
  outputFormat?: string;
}

export interface QueueItem {
  id: string;
  path: string;
  name: string;
  relativePath?: string;
  size: number;
  duration?: number;
  format?: string;
  status: QueueStatus;
  progress: number;
  rtfx?: number;
  transcriptPath?: string;
  jsonPath?: string;
  error?: string;
  metadata?: AudioMetadata;
  settings?: ItemSettings;
}
