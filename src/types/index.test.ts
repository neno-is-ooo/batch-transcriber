import { describe, expect, it } from "vitest";
import {
  isCloudAPIRuntime,
  isFileDoneEvent,
  isFileProgressEvent,
  isPythonUvRuntime,
  isStartEvent,
  isSummaryEvent,
  isSwiftNativeRuntime,
  isTranscriptionEvent,
  type BatchSummary,
  type DiagnosticCheck,
  type HealthStatus,
  type ModelCatalogEntry,
  type ProviderRuntime,
  type RunBatchRequest,
  type StartupDiagnosticsResult,
  type TranscriptionEvent,
} from "./index";

describe("provider runtime guards", () => {
  it("discriminates provider runtime variants", () => {
    const runtimes: ProviderRuntime[] = [
      {
        type: "SwiftNative",
        binaryPath: "/usr/local/bin/coreml-batch",
        modelDir: "/models/parakeet-v3",
      },
      {
        type: "PythonUv",
        package: "parakeet-stt",
        entryPoint: "python -m parakeet_stt",
      },
      {
        type: "CloudAPI",
        baseUrl: "https://api.example.com",
        requiresKey: true,
      },
    ];

    expect(isSwiftNativeRuntime(runtimes[0])).toBe(true);
    expect(isPythonUvRuntime(runtimes[1])).toBe(true);
    expect(isCloudAPIRuntime(runtimes[2])).toBe(true);
  });
});

describe("transcription event guards", () => {
  it("accepts valid events and rejects malformed payloads", () => {
    const validEvents: unknown[] = [
      {
        event: "start",
        session_id: "session-123",
        provider: "coreml-local",
        model: "v3",
      },
      { event: "scanned", total: 4 },
      { event: "models_loaded" },
      {
        event: "file_started",
        index: 1,
        total: 4,
        file: "/input/a.wav",
        relative: "a.wav",
      },
      {
        event: "file_progress",
        index: 1,
        file: "/input/a.wav",
        progress: 35,
        rtfx: 1.6,
      },
      {
        event: "file_done",
        index: 1,
        file: "/input/a.wav",
        duration_seconds: 8.2,
        processing_seconds: 5.1,
        rtfx: 1.61,
        confidence: 0.92,
        output: {
          txt: "/output/a.wav.txt",
          json: "/output/a.wav.json",
        },
      },
      {
        event: "file_skipped",
        index: 2,
        file: "/input/b.wav",
        reason: "outputs_exist",
        output: {
          txt: "/output/b.wav.txt",
          json: "/output/b.wav.json",
        },
      },
      {
        event: "file_failed",
        index: 3,
        file: "/input/c.wav",
        error: "decode failed",
        attempts: 2,
      },
      {
        event: "file_retry",
        index: 3,
        file: "/input/c.wav",
        attempt: 1,
        reason: "temporary error",
      },
      {
        event: "summary",
        total: 4,
        processed: 2,
        skipped: 1,
        failed: 1,
        duration_seconds: 13.6,
        failures: [{ file: "/input/c.wav", error: "decode failed" }],
      },
      { event: "fatal_error", error: "worker unavailable" },
    ];

    validEvents.forEach((event) => {
      expect(isTranscriptionEvent(event)).toBe(true);
    });

    expect(isTranscriptionEvent({ event: "unknown_event" })).toBe(false);
    expect(
      isTranscriptionEvent({
        event: "file_done",
        index: 1,
        file: "/input/a.wav",
        duration_seconds: 8.2,
        processing_seconds: 5.1,
        rtfx: 1.61,
        output: {},
      })
    ).toBe(false);
  });

  it("narrows event payloads safely after JSON parsing", () => {
    const rawProgress: unknown = JSON.parse(
      JSON.stringify({
        event: "file_progress",
        index: 4,
        file: "/input/d.wav",
        progress: 77,
        rtfx: 2.1,
      })
    );

    expect(isTranscriptionEvent(rawProgress)).toBe(true);
    if (!isTranscriptionEvent(rawProgress) || !isFileProgressEvent(rawProgress)) {
      throw new Error("Expected a file_progress event.");
    }
    expect(rawProgress.progress).toBe(77);
    expect(rawProgress.rtfx).toBe(2.1);

    const rawStart: unknown = JSON.parse(
      JSON.stringify({
        event: "start",
        session_id: "session-abc",
        provider: "coreml-local",
        model: "v2",
      })
    );
    expect(isStartEvent(rawStart)).toBe(true);

    const rawSummary: unknown = JSON.parse(
      JSON.stringify({
        event: "summary",
        total: 2,
        processed: 2,
        skipped: 0,
        failed: 0,
        duration_seconds: 8.8,
        failures: [],
      })
    );
    expect(isSummaryEvent(rawSummary)).toBe(true);
  });

  it("supports NDJSON roundtrip for recognized events", () => {
    const sourceEvents: TranscriptionEvent[] = [
      {
        event: "file_done",
        index: 2,
        file: "/input/e.wav",
        duration_seconds: 14.1,
        processing_seconds: 8.9,
        rtfx: 1.58,
        confidence: 0.88,
        output: {
          txt: "/output/e.wav.txt",
          json: "/output/e.wav.json",
        },
      },
      {
        event: "fatal_error",
        error: "disk full",
      },
    ];

    const ndjson = sourceEvents.map((event) => JSON.stringify(event));
    const decoded = ndjson
      .map((line) => JSON.parse(line) as unknown)
      .filter(isTranscriptionEvent);

    expect(decoded).toEqual(sourceEvents);
    expect(isFileDoneEvent(decoded[0])).toBe(true);
  });
});

describe("Rust-aligned frontend types", () => {
  it("matches backend command and response shapes", () => {
    const request: RunBatchRequest = {
      inputDir: "/input",
      outputDir: "/output",
      modelDir: "/models/parakeet-v3",
      modelVersion: "v3",
      outputFormat: "both",
      recursive: true,
      overwrite: false,
      dryRun: false,
      extensions: ["wav", "mp3"],
      maxRetries: 2,
      ffmpegFallback: true,
    };

    const summary: BatchSummary = {
      total: 4,
      processed: 3,
      skipped: 0,
      failed: 1,
      durationSeconds: 45.2,
      failures: [{ file: "/input/f.wav", error: "decode failed" }],
      exitCode: 2,
      failureReportPath: "/output/_reports/run-20260211-123456.json",
    };

    const check: DiagnosticCheck = {
      id: "ffmpeg",
      status: "ok",
      title: "ffmpeg available",
      detail: "Found ffmpeg in PATH",
      action: "",
    };

    const diagnostics: StartupDiagnosticsResult = {
      healthy: true,
      checks: [check],
      checkedOutputPath: "/output",
      availableDiskBytes: 10_000_000,
      recommendedDiskBytes: 5_000_000,
    };

    const catalogEntry: ModelCatalogEntry = {
      id: "parakeet-tdt-0.6b-v3-coreml",
      modelVersion: "v3",
      displayName: "CoreML TDT v3",
      description: "Multilingual model",
      sizeHint: "Large (~0.6B params)",
      recommendedFor: "Best overall accuracy",
      modelDir: "/models/parakeet-v3",
      installed: true,
    };

    const health: HealthStatus = {
      swiftOk: true,
      whisperOk: true,
      ffprobeOk: false,
    };

    expect(request.inputDir).toBe("/input");
    expect(summary.failureReportPath).toContain("_reports");
    expect(diagnostics.checks[0].status).toBe("ok");
    expect(catalogEntry.installed).toBe(true);
    expect(health.ffprobeOk).toBe(false);
  });
});
