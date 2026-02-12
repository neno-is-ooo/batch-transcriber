import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Provider, ProviderRuntime } from "../types/providers";
import type { QueueItem } from "../types/queue";

export interface ScanProgress {
  found: number;
  scanned: number;
  currentPath: string;
}

export interface TranscriptionSettings {
  outputFormat: string;
  recursive: boolean;
  overwrite: boolean;
  maxRetries: number;
  extensions: string[];
  ffmpegFallback: boolean;
  dryRun: boolean;
  notificationsEnabled: boolean;
  notifyOnComplete: boolean;
  notifyOnError: boolean;
}

export interface ExportOptions {
  format: "zip" | "folder";
  naming: "preserve" | "timestamp" | "numbered";
  includeMetadata: boolean;
  preserveStructure: boolean;
}

export interface SessionFileRecord {
  id: string;
  path: string;
  name: string;
  status: string;
  transcriptPath?: string;
  jsonPath?: string;
  error?: string;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  provider: string;
  model: string;
  outputDir: string;
  manifestPath: string;
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  durationSeconds: number;
  exitCode: number;
  status: string;
  files: SessionFileRecord[];
}

export interface HealthCheckStatus {
  swiftOk: boolean;
  whisperOk: boolean;
  ffprobeOk: boolean;
}

function formatInvokeError(command: string, error: unknown): Error {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";

  return new Error(`${command} failed: ${detail}`);
}

/** Scans explicit file paths and returns normalized queue items. */
export async function scanFiles(paths: string[]): Promise<QueueItem[]> {
  try {
    return await invoke<QueueItem[]>("scan_files", { paths });
  } catch (error) {
    throw formatInvokeError("scan_files", error);
  }
}

/** Scans a directory path and returns discovered audio queue items. */
export async function scanDirectory(path: string, recursive: boolean): Promise<QueueItem[]> {
  try {
    return await invoke<QueueItem[]>("scan_directory", { path, recursive });
  } catch (error) {
    throw formatInvokeError("scan_directory", error);
  }
}

/** Returns all registered transcription providers and their availability. */
export async function getProviders(): Promise<Provider[]> {
  try {
    return await invoke<Provider[]>("get_providers");
  } catch (error) {
    throw formatInvokeError("get_providers", error);
  }
}

/** Resolves a provider + model to a concrete runtime descriptor. */
export async function resolveProviderRuntime(
  providerId: string,
  model: string
): Promise<ProviderRuntime> {
  try {
    return await invoke<ProviderRuntime>("resolve_provider_runtime", {
      providerId,
      model,
    });
  } catch (error) {
    throw formatInvokeError("resolve_provider_runtime", error);
  }
}

/** Starts a transcription session and returns the generated session ID. */
export async function startTranscription(
  items: QueueItem[],
  provider: string,
  model: string,
  outputDir: string,
  settings: TranscriptionSettings
): Promise<string> {
  try {
    return await invoke<string>("start_transcription", {
      items,
      provider,
      model,
      outputDir,
      settings,
    });
  } catch (error) {
    throw formatInvokeError("start_transcription", error);
  }
}

/** Stops a running transcription session. */
export async function stopTranscription(sessionId: string): Promise<void> {
  try {
    await invoke<void>("stop_transcription", { sessionId });
  } catch (error) {
    throw formatInvokeError("stop_transcription", error);
  }
}

/** Updates menu item enabled state based on queue + processing status. */
export async function updateMenuState(hasItems: boolean, isProcessing: boolean): Promise<void> {
  try {
    await invoke<void>("update_menu_state", {
      hasItems,
      isProcessing,
    });
  } catch (error) {
    throw formatInvokeError("update_menu_state", error);
  }
}

/** Marks frontend file-open listener as ready and returns cold-start file paths. */
export async function registerFileOpenListener(): Promise<string[]> {
  try {
    return await invoke<string[]>("register_file_open_listener");
  } catch (error) {
    throw formatInvokeError("register_file_open_listener", error);
  }
}

/** Reads transcript content from disk through the Tauri backend. */
export async function readTranscript(path: string): Promise<string> {
  try {
    return await invoke<string>("read_transcript", { path });
  } catch (error) {
    throw formatInvokeError("read_transcript", error);
  }
}

/** Exports a transcript file to a chosen destination path. */
export async function exportTranscript(
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  try {
    await invoke<void>("export_transcript", {
      sourcePath,
      destinationPath,
    });
  } catch (error) {
    throw formatInvokeError("export_transcript", error);
  }
}

/** Exports multiple transcript artifacts using ZIP or folder output. */
export async function exportTranscripts(
  items: QueueItem[],
  destination: string,
  options: ExportOptions
): Promise<string> {
  try {
    return await invoke<string>("export_transcripts", {
      items,
      destination,
      options,
    });
  } catch (error) {
    throw formatInvokeError("export_transcripts", error);
  }
}

/** Returns persisted session history records in reverse chronological order. */
export async function getSessionHistory(): Promise<SessionRecord[]> {
  try {
    return await invoke<SessionRecord[]>("get_session_history");
  } catch (error) {
    throw formatInvokeError("get_session_history", error);
  }
}

/** Deletes a persisted session history record by id. */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await invoke<void>("delete_session", {
      sessionId,
    });
  } catch (error) {
    throw formatInvokeError("delete_session", error);
  }
}

/** Returns whether notification permission is currently granted. */
export async function checkNotificationPermission(): Promise<boolean> {
  try {
    return await invoke<boolean>("check_notification_permission");
  } catch (error) {
    throw formatInvokeError("check_notification_permission", error);
  }
}

/** Requests notification permission and returns the resulting granted state. */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    return await invoke<boolean>("request_notification_permission");
  } catch (error) {
    throw formatInvokeError("request_notification_permission", error);
  }
}

/** Returns runtime availability checks for bundled/local worker dependencies. */
export async function healthCheck(): Promise<HealthCheckStatus> {
  try {
    return await invoke<HealthCheckStatus>("health_check");
  } catch (error) {
    throw formatInvokeError("health_check", error);
  }
}

/** Registers a scan progress listener and returns the unlisten function. */
export async function onScanProgress(
  callback: (progress: ScanProgress) => void
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan-progress", (event) => {
    callback(event.payload);
  });
}
