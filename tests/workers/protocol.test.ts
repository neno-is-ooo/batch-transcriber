import { describe, expect, it } from "vitest";
import { validateEvent, validateNDJSON } from "./validate-ndjson";

describe("Worker NDJSON protocol validation", () => {
  it("accepts valid start events", () => {
    const result = validateEvent({
      event: "start",
      timestamp: "2026-02-12T12:30:00Z",
      session_id: "session-123",
      provider: "whisper-openai",
      model: "large-v3",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("rejects malformed start events", () => {
    const result = validateEvent({
      event: "start",
      timestamp: "2026-02-12T12:30:00Z",
      provider: "whisper-openai",
    });

    expect(result.valid).toBe(false);
    expect(result.errors?.length ?? 0).toBeGreaterThan(0);
  });

  it("accepts a complete success workflow stream", () => {
    const stream = [
      "{\"event\":\"start\",\"timestamp\":\"2026-02-12T12:30:00Z\",\"session_id\":\"session-1\",\"provider\":\"whisper-openai\",\"model\":\"base\"}",
      "{\"event\":\"scanned\",\"timestamp\":\"2026-02-12T12:30:01Z\",\"total\":1}",
      "{\"event\":\"models_loaded\",\"timestamp\":\"2026-02-12T12:30:02Z\"}",
      "{\"event\":\"file_started\",\"timestamp\":\"2026-02-12T12:30:03Z\",\"index\":0,\"total\":1,\"file\":\"/audio/input.wav\",\"relative\":\"input.wav\"}",
      "{\"event\":\"file_progress\",\"timestamp\":\"2026-02-12T12:30:04Z\",\"index\":0,\"file\":\"/audio/input.wav\",\"progress\":50,\"rtfx\":2.1}",
      "{\"event\":\"file_done\",\"timestamp\":\"2026-02-12T12:30:05Z\",\"index\":0,\"file\":\"/audio/input.wav\",\"duration_seconds\":5.2,\"processing_seconds\":2.6,\"rtfx\":2.0,\"confidence\":0.93,\"output\":{\"txt\":\"/tmp/out/input.wav.txt\"}}",
      "{\"event\":\"summary\",\"timestamp\":\"2026-02-12T12:30:06Z\",\"total\":1,\"processed\":1,\"skipped\":0,\"failed\":0,\"duration_seconds\":6.0,\"failures\":[]}"
    ];

    const result = validateNDJSON(stream);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts failure workflow stream with fatal and summary events", () => {
    const stream = [
      "{\"event\":\"start\",\"timestamp\":\"2026-02-12T12:31:00Z\",\"session_id\":\"session-2\",\"provider\":\"coreml-local\",\"model\":\"v3\"}",
      "{\"event\":\"ffmpeg_status\",\"timestamp\":\"2026-02-12T12:31:01Z\",\"requested\":true,\"available\":true}",
      "{\"event\":\"scanned\",\"timestamp\":\"2026-02-12T12:31:02Z\",\"total\":1}",
      "{\"event\":\"file_failed\",\"timestamp\":\"2026-02-12T12:31:03Z\",\"index\":0,\"file\":\"/audio/bad.wav\",\"error\":\"decode failed\",\"attempts\":2}",
      "{\"event\":\"summary\",\"timestamp\":\"2026-02-12T12:31:04Z\",\"total\":1,\"processed\":0,\"skipped\":0,\"failed\":1,\"duration_seconds\":4.2,\"failures\":[{\"file\":\"/audio/bad.wav\",\"error\":\"decode failed\"}]}",
      "{\"event\":\"fatal_error\",\"timestamp\":\"2026-02-12T12:31:05Z\",\"error\":\"worker crashed after summary\"}"
    ];

    const result = validateNDJSON(stream);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports malformed lines with line numbers", () => {
    const stream = [
      "{\"event\":\"scanned\",\"timestamp\":\"2026-02-12T12:30:01Z\"}",
      "not-json",
      "{\"event\":\"unknown_event\",\"timestamp\":\"2026-02-12T12:30:03Z\"}"
    ];

    const result = validateNDJSON(stream);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0].line).toBe(1);
    expect(result.errors[1].line).toBe(2);
    expect(result.errors[2].line).toBe(3);
  });
});
