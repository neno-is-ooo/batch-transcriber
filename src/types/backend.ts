import type { FailureRecord } from "./events";

export interface RunBatchRequest {
  inputDir: string;
  outputDir: string;
  modelDir: string;
  modelVersion: string;
  outputFormat: string;
  recursive: boolean;
  overwrite: boolean;
  dryRun: boolean;
  extensions: string[];
  maxRetries: number;
  ffmpegFallback: boolean;
}

export interface BatchSummary {
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  durationSeconds: number;
  failures: FailureRecord[];
  exitCode: number;
  failureReportPath: string;
}

export interface DiagnosticCheck {
  id: string;
  status: string;
  title: string;
  detail: string;
  action: string;
}

export interface ModelCatalogEntry {
  id: string;
  modelVersion: string;
  displayName: string;
  description: string;
  sizeHint: string;
  recommendedFor: string;
  modelDir: string;
  installed: boolean;
}

export interface StartupDiagnosticsResult {
  healthy: boolean;
  checks: DiagnosticCheck[];
  checkedOutputPath: string;
  availableDiskBytes: number;
  recommendedDiskBytes: number;
}

export interface HealthStatus {
  swiftOk: boolean;
  whisperOk: boolean;
  ffprobeOk: boolean;
}
