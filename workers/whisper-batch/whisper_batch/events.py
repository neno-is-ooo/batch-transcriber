"""NDJSON event emitter for worker protocol events."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TypedDict


class OutputPaths(TypedDict, total=False):
    txt: str
    json: str


class FailureRecord(TypedDict):
    file: str
    error: str


class EventEmitter:
    """Emit newline-delimited JSON events to stdout."""

    def emit(self, event_type: str, **payload: object) -> None:
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        event = {"event": event_type, "timestamp": timestamp, **payload}
        print(json.dumps(event), flush=True)

    def emit_start(self, session_id: str, provider: str, model: str) -> None:
        self.emit("start", session_id=session_id, provider=provider, model=model)

    def emit_models_loaded(self) -> None:
        self.emit("models_loaded")

    def emit_file_started(self, index: int, total: int, file: str, relative: str) -> None:
        self.emit("file_started", index=index, total=total, file=file, relative=relative)

    def emit_file_progress(self, index: int, file: str, progress: float, rtfx: float) -> None:
        self.emit("file_progress", index=index, file=file, progress=progress, rtfx=rtfx)

    def emit_file_done(
        self,
        index: int,
        file: str,
        duration_seconds: float,
        processing_seconds: float,
        rtfx: float,
        confidence: float,
        output: OutputPaths,
    ) -> None:
        self.emit(
            "file_done",
            index=index,
            file=file,
            duration_seconds=duration_seconds,
            processing_seconds=processing_seconds,
            rtfx=rtfx,
            confidence=confidence,
            output=output,
        )

    def emit_file_failed(self, index: int, file: str, error: str, attempts: int) -> None:
        self.emit(
            "file_failed",
            index=index,
            file=file,
            error=error,
            attempts=attempts,
        )

    def emit_file_skipped(self, index: int, file: str, reason: str) -> None:
        self.emit("file_skipped", index=index, file=file, reason=reason)

    def emit_summary(
        self,
        total: int,
        processed: int,
        skipped: int,
        failed: int,
        duration_seconds: float,
        failures: list[FailureRecord],
    ) -> None:
        self.emit(
            "summary",
            total=total,
            processed=processed,
            skipped=skipped,
            failed=failed,
            duration_seconds=duration_seconds,
            failures=failures,
        )

    def emit_fatal_error(self, error: str) -> None:
        self.emit("fatal_error", error=error)
