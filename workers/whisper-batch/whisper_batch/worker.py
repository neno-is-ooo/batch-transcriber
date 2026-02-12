"""Worker processing loop for whisper-batch."""

from __future__ import annotations

import json
import math
from pathlib import Path
import time
from typing import Any
from uuid import uuid4

from .events import EventEmitter, FailureRecord, OutputPaths
from .model_manager import ensure_model


def _first_string(data: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed:
                return trimmed
    return None


def _safe_relative_path(raw_relative: str, source_path: str) -> str:
    candidate = raw_relative.strip()
    if not candidate:
        return Path(source_path).name

    candidate_path = Path(candidate)
    if candidate_path.is_absolute():
        return candidate_path.name

    parts = [part for part in candidate_path.parts if part not in ("", ".", "..")]
    if not parts:
        return Path(source_path).name

    return str(Path(*parts))


def _extract_relative_path(entry: dict[str, Any], source_path: str) -> str:
    relative = _first_string(entry, "relative_path", "relativePath", "relative")
    if relative is None:
        return Path(source_path).name
    return _safe_relative_path(relative, source_path)


def _extract_duration_seconds(result: dict[str, Any]) -> float:
    duration = result.get("duration")
    if isinstance(duration, (int, float)):
        return max(0.0, float(duration))

    segments = result.get("segments")
    if not isinstance(segments, list):
        return 0.0

    max_end = 0.0
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        end_value = segment.get("end")
        if isinstance(end_value, (int, float)):
            max_end = max(max_end, float(end_value))

    return max_end


def _estimate_confidence(result: dict[str, Any]) -> float:
    confidence = result.get("confidence")
    if isinstance(confidence, (int, float)):
        return max(0.0, min(1.0, float(confidence)))

    segments = result.get("segments")
    if not isinstance(segments, list):
        return 0.0

    logprobs: list[float] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        logprob = segment.get("avg_logprob")
        if isinstance(logprob, (int, float)):
            logprobs.append(float(logprob))

    if not logprobs:
        return 0.0

    avg_logprob = sum(logprobs) / len(logprobs)
    return max(0.0, min(1.0, math.exp(avg_logprob)))


def _write_outputs(output_root: Path, relative_path: str, result: dict[str, Any]) -> OutputPaths:
    base_path = output_root / relative_path
    txt_output = Path(f"{base_path}.txt")
    json_output = Path(f"{base_path}.json")

    txt_output.parent.mkdir(parents=True, exist_ok=True)
    text = result.get("text")
    txt_output.write_text(str(text) if isinstance(text, str) else "", encoding="utf-8")

    json_output.parent.mkdir(parents=True, exist_ok=True)
    with json_output.open("w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)

    output: OutputPaths = {"txt": str(txt_output), "json": str(json_output)}
    return output


def _manifest_files(manifest_data: dict[str, Any]) -> list[dict[str, Any]]:
    files = manifest_data.get("files")
    if not isinstance(files, list):
        raise ValueError("Manifest is missing a files array.")

    normalized: list[dict[str, Any]] = []
    for entry in files:
        if isinstance(entry, dict):
            normalized.append(entry)
    return normalized


def process_manifest(manifest_path: str, output_dir: str, model_name: str) -> dict[str, Any]:
    """Process all files in the manifest with Whisper and emit NDJSON events."""

    with Path(manifest_path).open("r", encoding="utf-8") as handle:
        manifest_data = json.load(handle)

    if not isinstance(manifest_data, dict):
        raise ValueError("Manifest root must be a JSON object.")

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)

    files = _manifest_files(manifest_data)
    total = len(files)

    session_id = _first_string(manifest_data, "session_id", "sessionId") or str(uuid4())
    provider = _first_string(manifest_data, "provider") or "whisper-openai"
    selected_model = _first_string(manifest_data, "model") or model_name

    emitter = EventEmitter()
    started_at = time.perf_counter()
    emitter.emit_start(session_id=session_id, provider=provider, model=selected_model)
    emitter.emit("scanned", total=total)

    try:
        model = ensure_model(selected_model)
    except Exception as error:
        message = f"Failed to load Whisper model '{selected_model}': {error}"
        emitter.emit_fatal_error(message)
        raise RuntimeError(message) from error

    emitter.emit_models_loaded()

    processed = 0
    skipped = 0
    failed = 0
    failures: list[FailureRecord] = []

    for index, entry in enumerate(files):
        path_value = entry.get("path")
        if not isinstance(path_value, str) or not path_value.strip():
            failed += 1
            error = "Manifest file entry is missing a valid path."
            failures.append({"file": "", "error": error})
            emitter.emit_file_failed(index=index, file="", error=error, attempts=1)
            continue

        source_path = path_value.strip()
        relative_path = _extract_relative_path(entry, source_path)
        emitter.emit_file_started(index=index, total=total, file=source_path, relative=relative_path)

        file_started = time.perf_counter()
        try:
            result = model.transcribe(source_path, word_timestamps=True)
            if not isinstance(result, dict):
                raise TypeError("Whisper returned a non-object transcription payload.")

            processing_seconds = max(time.perf_counter() - file_started, 1e-6)
            duration_seconds = _extract_duration_seconds(result)
            rtfx = duration_seconds / processing_seconds if processing_seconds > 0 else 0.0
            confidence = _estimate_confidence(result)
            output_paths = _write_outputs(output_root, relative_path, result)

            emitter.emit_file_done(
                index=index,
                file=source_path,
                duration_seconds=duration_seconds,
                processing_seconds=processing_seconds,
                rtfx=rtfx,
                confidence=confidence,
                output=output_paths,
            )
            processed += 1
        except Exception as error:
            failed += 1
            message = str(error)
            failures.append({"file": source_path, "error": message})
            emitter.emit_file_failed(index=index, file=source_path, error=message, attempts=1)

    duration_seconds = time.perf_counter() - started_at
    emitter.emit_summary(
        total=total,
        processed=processed,
        skipped=skipped,
        failed=failed,
        duration_seconds=duration_seconds,
        failures=failures,
    )

    return {
        "session_id": session_id,
        "provider": provider,
        "model": selected_model,
        "total": total,
        "processed": processed,
        "skipped": skipped,
        "failed": failed,
        "duration_seconds": duration_seconds,
        "failures": failures,
        "manifest": manifest_data,
        "output_dir": str(output_root),
    }
