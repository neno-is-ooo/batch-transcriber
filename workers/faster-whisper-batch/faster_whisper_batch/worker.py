"""Worker processing loop for Faster-Whisper batch transcription."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
import time
from typing import Any
from uuid import uuid4

from .events import EventEmitter, FailureRecord, OutputPaths
from .gpu_utils import get_device, get_fallback_chain, get_next_fallback, get_optimal_compute_type

AVAILABLE_MODELS = (
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large-v1",
    "large-v2",
    "large-v3",
    "distil-large-v2",
    "distil-large-v3",
)

FALLBACK_LANGUAGE_CODES = (
    "en",
    "zh",
    "de",
    "es",
    "ru",
    "ko",
    "fr",
    "ja",
    "pt",
    "tr",
    "pl",
    "ca",
    "nl",
    "ar",
    "sv",
    "it",
    "id",
    "hi",
    "fi",
    "vi",
    "he",
    "uk",
    "el",
    "ms",
    "cs",
    "ro",
    "da",
    "hu",
    "ta",
    "no",
    "th",
    "ur",
    "hr",
    "bg",
    "lt",
    "la",
    "mi",
    "ml",
    "cy",
    "sk",
    "te",
    "fa",
    "lv",
    "bn",
    "sr",
    "az",
    "sl",
    "kn",
    "et",
    "mk",
    "br",
    "eu",
    "is",
    "hy",
    "ne",
    "mn",
    "bs",
    "kk",
    "sq",
    "sw",
    "gl",
    "mr",
    "pa",
    "si",
    "km",
    "sn",
    "yo",
    "so",
    "af",
    "oc",
    "ka",
    "be",
    "tg",
    "sd",
    "gu",
    "am",
    "yi",
    "lo",
    "uz",
    "fo",
    "ht",
    "ps",
    "tk",
    "nn",
    "mt",
    "sa",
    "lb",
    "my",
    "bo",
    "tl",
    "mg",
    "as",
    "tt",
    "haw",
    "ln",
    "ha",
    "ba",
    "jw",
    "su",
)


@dataclass
class RuntimeState:
    model: Any
    device: str
    compute_type: str


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


def _output_formats(manifest_data: dict[str, Any]) -> set[str]:
    settings = manifest_data.get("settings")
    if not isinstance(settings, dict):
        return {"txt", "json"}

    output_format = _first_string(settings, "output_format", "outputFormat")
    if output_format is None:
        return {"txt", "json"}

    normalized = output_format.lower()
    if normalized in {"txt", "text"}:
        return {"txt"}
    if normalized == "json":
        return {"json"}

    return {"txt", "json"}


def _coerce_non_negative_float(value: Any) -> float | None:
    if not isinstance(value, (int, float)):
        return None

    return max(0.0, float(value))


def _segment_words(segment: Any) -> list[dict[str, Any]]:
    words = getattr(segment, "words", None)
    if not isinstance(words, (list, tuple)):
        return []

    parsed: list[dict[str, Any]] = []
    for word in words:
        payload: dict[str, Any] = {}

        text = getattr(word, "word", None)
        if isinstance(text, str):
            payload["word"] = text

        start = _coerce_non_negative_float(getattr(word, "start", None))
        if start is not None:
            payload["start"] = start

        end = _coerce_non_negative_float(getattr(word, "end", None))
        if end is not None:
            payload["end"] = end

        probability = _coerce_non_negative_float(getattr(word, "probability", None))
        if probability is not None:
            payload["probability"] = min(probability, 1.0)

        if payload:
            parsed.append(payload)

    return parsed


def _segment_to_dict(segment: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {}

    segment_id = getattr(segment, "id", None)
    if isinstance(segment_id, int):
        payload["id"] = segment_id

    start = _coerce_non_negative_float(getattr(segment, "start", None))
    if start is not None:
        payload["start"] = start

    end = _coerce_non_negative_float(getattr(segment, "end", None))
    if end is not None:
        payload["end"] = end

    text = getattr(segment, "text", None)
    if isinstance(text, str):
        payload["text"] = text

    avg_logprob = getattr(segment, "avg_logprob", None)
    if isinstance(avg_logprob, (int, float)):
        payload["avg_logprob"] = float(avg_logprob)

    no_speech_prob = getattr(segment, "no_speech_prob", None)
    if isinstance(no_speech_prob, (int, float)):
        payload["no_speech_prob"] = float(no_speech_prob)

    words = _segment_words(segment)
    if words:
        payload["words"] = words

    return payload


def _confidence_from_segments(segments: list[dict[str, Any]]) -> float:
    logprobs = [
        float(entry["avg_logprob"])
        for entry in segments
        if isinstance(entry.get("avg_logprob"), (int, float))
    ]
    if logprobs:
        avg_logprob = sum(logprobs) / len(logprobs)
        return max(0.0, min(1.0, math.exp(avg_logprob)))

    probabilities: list[float] = []
    for segment in segments:
        words = segment.get("words")
        if not isinstance(words, list):
            continue

        for word in words:
            if isinstance(word, dict) and isinstance(word.get("probability"), (int, float)):
                probabilities.append(float(word["probability"]))

    if probabilities:
        return max(0.0, min(1.0, sum(probabilities) / len(probabilities)))

    return 0.0


def _info_payload(info: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {}

    language = getattr(info, "language", None)
    if isinstance(language, str):
        payload["language"] = language

    language_probability = _coerce_non_negative_float(getattr(info, "language_probability", None))
    if language_probability is not None:
        payload["language_probability"] = min(language_probability, 1.0)

    duration = _coerce_non_negative_float(getattr(info, "duration", None))
    if duration is not None:
        payload["duration"] = duration

    duration_after_vad = _coerce_non_negative_float(getattr(info, "duration_after_vad", None))
    if duration_after_vad is not None:
        payload["duration_after_vad"] = duration_after_vad

    return payload


def _build_result_payload(segments: list[dict[str, Any]], info: Any) -> dict[str, Any]:
    text_parts = [
        str(segment.get("text", "")).strip()
        for segment in segments
        if isinstance(segment.get("text"), str)
    ]
    text = " ".join(part for part in text_parts if part).strip()

    payload = {
        "text": text,
        "segments": segments,
    }
    payload.update(_info_payload(info))
    return payload


def _write_outputs(
    output_root: Path,
    relative_path: str,
    result: dict[str, Any],
    formats: set[str],
) -> OutputPaths:
    base_path = output_root / relative_path
    output: OutputPaths = {}

    if "txt" in formats:
        txt_output = Path(f"{base_path}.txt")
        txt_output.parent.mkdir(parents=True, exist_ok=True)
        text = result.get("text")
        txt_output.write_text(str(text) if isinstance(text, str) else "", encoding="utf-8")
        output["txt"] = str(txt_output)

    if "json" in formats:
        json_output = Path(f"{base_path}.json")
        json_output.parent.mkdir(parents=True, exist_ok=True)
        with json_output.open("w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)
        output["json"] = str(json_output)

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


def _is_cuda_oom_error(error: Exception, device: str) -> bool:
    if device != "cuda":
        return False

    message = str(error).lower()
    return "out of memory" in message or "cuda oom" in message


def _transcribe_once(
    model: Any,
    source_path: str,
    index: int,
    emitter: EventEmitter,
    file_started_at: float,
) -> tuple[dict[str, Any], float, float]:
    segments_iterable, info = model.transcribe(
        source_path,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )

    info_data = _info_payload(info)
    info_duration = _coerce_non_negative_float(info_data.get("duration")) or 0.0

    segments: list[dict[str, Any]] = []
    max_end = 0.0

    for segment in segments_iterable:
        parsed = _segment_to_dict(segment)
        segments.append(parsed)

        end = _coerce_non_negative_float(parsed.get("end")) or 0.0
        if end > max_end:
            max_end = end

        if info_duration > 0:
            elapsed = max(time.perf_counter() - file_started_at, 1e-6)
            progress = min(100.0, (end / info_duration) * 100.0)
            rtfx = end / elapsed if elapsed > 0 else 0.0
            emitter.emit_file_progress(index=index, file=source_path, progress=progress, rtfx=rtfx)

    result = _build_result_payload(segments, info)
    duration_seconds = max(info_duration, max_end)
    confidence = _confidence_from_segments(segments)
    return result, duration_seconds, confidence


def _load_runtime(model_name: str, device: str, compute_type: str) -> RuntimeState:
    model = ensure_model(model_name, device=device, compute_type=compute_type)
    return RuntimeState(model=model, device=device, compute_type=compute_type)


def ensure_model(model_name: str, device: str, compute_type: str) -> Any:
    normalized_name = model_name.strip()
    if not normalized_name:
        raise ValueError("Model name must be a non-empty string.")

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as error:
        raise RuntimeError("Failed to import faster-whisper.") from error

    try:
        return WhisperModel(normalized_name, device=device, compute_type=compute_type)
    except Exception as error:
        raise RuntimeError(
            f"Failed to load Faster-Whisper model '{normalized_name}' with {device}/{compute_type}."
        ) from error


def get_available_models() -> list[str]:
    return list(AVAILABLE_MODELS)


def get_capabilities() -> dict[str, Any]:
    device = get_device()
    compute_type = get_optimal_compute_type()
    fallback_chain = [
        {"device": fallback_device, "compute_type": fallback_compute}
        for fallback_device, fallback_compute in get_fallback_chain(device, compute_type)
    ]

    return {
        "supported_models": get_available_models(),
        "word_timestamps": True,
        "speaker_diarization": False,
        "language_detection": True,
        "translation": True,
        "languages": list(FALLBACK_LANGUAGE_CODES),
        "speed_estimate": 0.1 if device == "cuda" else 0.4,
        "device": device,
        "compute_type": compute_type,
        "fallback_chain": fallback_chain,
    }


def print_capabilities() -> None:
    print(json.dumps(get_capabilities()), flush=True)


def process_manifest(
    manifest_path: str,
    output_dir: str,
    model_name: str,
) -> dict[str, Any]:
    """Process all files in the manifest with Faster-Whisper and emit NDJSON events."""

    with Path(manifest_path).open("r", encoding="utf-8") as handle:
        manifest_data = json.load(handle)

    if not isinstance(manifest_data, dict):
        raise ValueError("Manifest root must be a JSON object.")

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)

    files = _manifest_files(manifest_data)
    total = len(files)
    formats = _output_formats(manifest_data)

    session_id = _first_string(manifest_data, "session_id", "sessionId") or str(uuid4())
    provider = _first_string(manifest_data, "provider") or "faster-whisper"
    selected_model = _first_string(manifest_data, "model") or model_name

    initial_device = get_device()
    initial_compute_type = get_optimal_compute_type()

    emitter = EventEmitter()
    started_at = time.perf_counter()
    emitter.emit_start(
        session_id=session_id,
        provider=provider,
        model=selected_model,
        device=initial_device,
        compute_type=initial_compute_type,
    )
    emitter.emit("scanned", total=total)

    try:
        runtime = _load_runtime(selected_model, initial_device, initial_compute_type)
    except Exception as error:
        message = (
            f"Failed to load Faster-Whisper model '{selected_model}' "
            f"with {initial_device}/{initial_compute_type}: {error}"
        )
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
        attempts = 0

        while True:
            attempts += 1
            try:
                result, duration_seconds, confidence = _transcribe_once(
                    runtime.model,
                    source_path,
                    index,
                    emitter,
                    file_started,
                )
                processing_seconds = max(time.perf_counter() - file_started, 1e-6)
                rtfx = duration_seconds / processing_seconds if processing_seconds > 0 else 0.0
                output_paths = _write_outputs(output_root, relative_path, result, formats)

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
                break
            except Exception as error:
                if not _is_cuda_oom_error(error, runtime.device):
                    failed += 1
                    message = str(error)
                    failures.append({"file": source_path, "error": message})
                    emitter.emit_file_failed(
                        index=index,
                        file=source_path,
                        error=message,
                        attempts=attempts,
                    )
                    break

                fallback = get_next_fallback(runtime.device, runtime.compute_type)
                if fallback is None:
                    failed += 1
                    message = str(error)
                    failures.append({"file": source_path, "error": message})
                    emitter.emit_file_failed(
                        index=index,
                        file=source_path,
                        error=message,
                        attempts=attempts,
                    )
                    break

                fallback_device, fallback_compute_type = fallback
                emitter.emit_file_retry(
                    index=index,
                    file=source_path,
                    reason=f"GPU OOM, retrying with {fallback_compute_type}",
                    device=fallback_device,
                    compute_type=fallback_compute_type,
                )
                try:
                    runtime = _load_runtime(
                        selected_model,
                        device=fallback_device,
                        compute_type=fallback_compute_type,
                    )
                except Exception as fallback_error:
                    failed += 1
                    message = str(fallback_error)
                    failures.append({"file": source_path, "error": message})
                    emitter.emit_file_failed(
                        index=index,
                        file=source_path,
                        error=message,
                        attempts=attempts + 1,
                    )
                    break

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
        "device": runtime.device,
        "compute_type": runtime.compute_type,
        "total": total,
        "processed": processed,
        "skipped": skipped,
        "failed": failed,
        "duration_seconds": duration_seconds,
        "failures": failures,
        "manifest": manifest_data,
        "output_dir": str(output_root),
    }
