from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any
from unittest.mock import patch

from faster_whisper_batch.worker import print_capabilities, process_manifest


def parse_events(payload: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in payload.strip().splitlines() if line.strip()]


def assert_protocol_event(test_case: unittest.TestCase, event: dict[str, Any]) -> None:
    required: dict[str, set[str]] = {
        "start": {
            "event",
            "timestamp",
            "session_id",
            "provider",
            "model",
            "device",
            "compute_type",
        },
        "scanned": {"event", "timestamp", "total"},
        "models_loaded": {"event", "timestamp"},
        "file_started": {"event", "timestamp", "index", "total", "file", "relative"},
        "file_progress": {"event", "timestamp", "index", "file", "progress", "rtfx"},
        "file_retry": {
            "event",
            "timestamp",
            "index",
            "file",
            "reason",
            "device",
            "compute_type",
        },
        "file_done": {
            "event",
            "timestamp",
            "index",
            "file",
            "duration_seconds",
            "processing_seconds",
            "rtfx",
            "confidence",
            "output",
        },
        "file_failed": {"event", "timestamp", "index", "file", "error", "attempts"},
        "summary": {
            "event",
            "timestamp",
            "total",
            "processed",
            "skipped",
            "failed",
            "duration_seconds",
            "failures",
        },
        "fatal_error": {"event", "timestamp", "error"},
    }

    event_type = event.get("event")
    test_case.assertIsInstance(event_type, str)
    test_case.assertIn(event_type, required)

    expected_keys = required[str(event_type)]
    test_case.assertTrue(expected_keys.issubset(event.keys()))
    test_case.assertTrue(str(event["timestamp"]).endswith("Z"))


class FakeWord:
    def __init__(self, word: str, start: float, end: float, probability: float) -> None:
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability


class FakeSegment:
    def __init__(
        self,
        segment_id: int,
        start: float,
        end: float,
        text: str,
        avg_logprob: float = -0.1,
        words: list[FakeWord] | None = None,
    ) -> None:
        self.id = segment_id
        self.start = start
        self.end = end
        self.text = text
        self.avg_logprob = avg_logprob
        self.words = words or []


class FakeInfo:
    def __init__(self, language: str, language_probability: float, duration: float) -> None:
        self.language = language
        self.language_probability = language_probability
        self.duration = duration


class FakeModel:
    def __init__(self, responses: dict[str, Any]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def transcribe(self, source_path: str, **kwargs: Any) -> tuple[Any, Any]:
        self.calls.append((source_path, kwargs))
        response = self.responses[source_path]
        if isinstance(response, Exception):
            raise response

        segments, info = response
        return iter(segments), info


class WorkerTests(unittest.TestCase):
    def test_process_manifest_emits_events_and_writes_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audio_path = root / "audio" / "sample.wav"
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(b"fake")

            manifest = {
                "session_id": "session-123",
                "provider": "faster-whisper",
                "model": "large-v3",
                "settings": {"output_format": "both"},
                "files": [
                    {
                        "path": str(audio_path),
                        "relative_path": "nested/sample.wav",
                    }
                ],
            }
            manifest_path = root / "manifest.json"
            output_dir = root / "output"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            fake_model = FakeModel(
                {
                    str(audio_path): (
                        [
                            FakeSegment(
                                0,
                                0.0,
                                2.0,
                                " hello",
                                words=[FakeWord("hello", 0.0, 0.5, 0.95)],
                            ),
                            FakeSegment(1, 2.0, 4.0, " world"),
                        ],
                        FakeInfo("en", 0.99, 4.0),
                    )
                }
            )

            stream = io.StringIO()
            with (
                patch("faster_whisper_batch.worker.get_device", return_value="cuda"),
                patch("faster_whisper_batch.worker.get_optimal_compute_type", return_value="float16"),
                patch("faster_whisper_batch.worker.ensure_model", return_value=fake_model) as ensure_model,
                redirect_stdout(stream),
            ):
                summary = process_manifest(str(manifest_path), str(output_dir), "large-v3")

            ensure_model.assert_called_once_with("large-v3", device="cuda", compute_type="float16")
            self.assertEqual(summary["processed"], 1)
            self.assertEqual(summary["failed"], 0)
            self.assertEqual(summary["device"], "cuda")
            self.assertEqual(summary["compute_type"], "float16")

            events = parse_events(stream.getvalue())
            self.assertEqual(events[0]["event"], "start")
            self.assertEqual(events[1]["event"], "scanned")
            self.assertEqual(events[2]["event"], "models_loaded")
            self.assertEqual(events[-1]["event"], "summary")
            self.assertIn("file_progress", [event["event"] for event in events])

            for event in events:
                assert_protocol_event(self, event)

            done_events = [event for event in events if event["event"] == "file_done"]
            self.assertEqual(len(done_events), 1)
            done = done_events[0]
            self.assertGreater(done["processing_seconds"], 0.0)
            self.assertGreater(done["rtfx"], 0.0)

            txt_output = output_dir / "nested" / "sample.wav.txt"
            json_output = output_dir / "nested" / "sample.wav.json"
            self.assertTrue(txt_output.exists())
            self.assertTrue(json_output.exists())
            self.assertEqual(txt_output.read_text(encoding="utf-8"), "hello world")

            payload = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(payload["text"], "hello world")
            self.assertEqual(payload["language"], "en")
            self.assertEqual(done["output"]["txt"], str(txt_output))
            self.assertEqual(done["output"]["json"], str(json_output))

            self.assertEqual(
                fake_model.calls[0][1],
                {
                    "word_timestamps": True,
                    "vad_filter": True,
                    "vad_parameters": {"min_silence_duration_ms": 500},
                },
            )

    def test_process_manifest_retries_on_gpu_oom(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audio_path = root / "audio" / "oom.wav"
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(b"fake")

            manifest = {
                "session_id": "session-oom",
                "provider": "faster-whisper",
                "model": "large-v3",
                "files": [{"path": str(audio_path)}],
            }
            manifest_path = root / "manifest.json"
            output_dir = root / "output"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            first_model = FakeModel({str(audio_path): RuntimeError("CUDA out of memory")})
            fallback_model = FakeModel(
                {
                    str(audio_path): (
                        [FakeSegment(0, 0.0, 3.0, " recovered")],
                        FakeInfo("en", 0.8, 3.0),
                    )
                }
            )

            def ensure_model_side_effect(model_name: str, *, device: str, compute_type: str) -> FakeModel:
                if device == "cuda" and compute_type == "float16":
                    return first_model
                if device == "cuda" and compute_type == "int8_float16":
                    return fallback_model
                raise AssertionError(f"unexpected runtime {device}/{compute_type} for {model_name}")

            stream = io.StringIO()
            with (
                patch("faster_whisper_batch.worker.get_device", return_value="cuda"),
                patch("faster_whisper_batch.worker.get_optimal_compute_type", return_value="float16"),
                patch(
                    "faster_whisper_batch.worker.ensure_model",
                    side_effect=ensure_model_side_effect,
                ) as ensure_model,
                redirect_stdout(stream),
            ):
                summary = process_manifest(str(manifest_path), str(output_dir), "large-v3")

            self.assertEqual(summary["processed"], 1)
            self.assertEqual(summary["failed"], 0)
            self.assertEqual(summary["compute_type"], "int8_float16")
            self.assertEqual(ensure_model.call_count, 2)
            ensure_model.assert_any_call("large-v3", device="cuda", compute_type="float16")
            ensure_model.assert_any_call("large-v3", device="cuda", compute_type="int8_float16")

            events = parse_events(stream.getvalue())
            event_types = [event["event"] for event in events]
            self.assertIn("file_retry", event_types)
            retry = next(event for event in events if event["event"] == "file_retry")
            self.assertIn("int8_float16", str(retry["reason"]))
            for event in events:
                assert_protocol_event(self, event)

            self.assertEqual(len(first_model.calls), 1)
            self.assertEqual(len(fallback_model.calls), 1)

    def test_process_manifest_uses_cpu_when_cuda_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audio_path = root / "audio" / "cpu.wav"
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(b"fake")

            manifest = {
                "sessionId": "session-cpu",
                "files": [{"path": str(audio_path)}],
            }
            manifest_path = root / "manifest.json"
            output_dir = root / "output"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            model = FakeModel(
                {
                    str(audio_path): (
                        [FakeSegment(0, 0.0, 1.5, " cpu")],
                        FakeInfo("en", 0.9, 1.5),
                    )
                }
            )

            stream = io.StringIO()
            with (
                patch("faster_whisper_batch.worker.get_device", return_value="cpu"),
                patch("faster_whisper_batch.worker.get_optimal_compute_type", return_value="int8"),
                patch("faster_whisper_batch.worker.ensure_model", return_value=model),
                redirect_stdout(stream),
            ):
                summary = process_manifest(str(manifest_path), str(output_dir), "base")

            self.assertEqual(summary["processed"], 1)
            self.assertEqual(summary["device"], "cpu")
            self.assertEqual(summary["compute_type"], "int8")

            events = parse_events(stream.getvalue())
            self.assertEqual(events[0]["device"], "cpu")
            self.assertEqual(events[0]["compute_type"], "int8")
            for event in events:
                assert_protocol_event(self, event)

    def test_print_capabilities_includes_device_metadata(self) -> None:
        stream = io.StringIO()
        with (
            patch("faster_whisper_batch.worker.get_device", return_value="cuda"),
            patch("faster_whisper_batch.worker.get_optimal_compute_type", return_value="float16"),
            patch(
                "faster_whisper_batch.worker.get_fallback_chain",
                return_value=[("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")],
            ),
            redirect_stdout(stream),
        ):
            print_capabilities()

        payload = json.loads(stream.getvalue().strip())
        self.assertEqual(payload["device"], "cuda")
        self.assertEqual(payload["compute_type"], "float16")
        self.assertEqual(payload["fallback_chain"][1], {"device": "cuda", "compute_type": "int8_float16"})
        self.assertTrue(payload["word_timestamps"])
        self.assertIn("large-v3", payload["supported_models"])

    def test_process_manifest_emits_fatal_error_when_model_loading_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audio_path = root / "audio" / "sample.wav"
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(b"fake")

            manifest = {
                "session_id": "session-model-fail",
                "files": [{"path": str(audio_path)}],
            }
            manifest_path = root / "manifest.json"
            output_dir = root / "output"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            stream = io.StringIO()
            with (
                patch("faster_whisper_batch.worker.get_device", return_value="cuda"),
                patch("faster_whisper_batch.worker.get_optimal_compute_type", return_value="float16"),
                patch("faster_whisper_batch.worker.ensure_model", side_effect=RuntimeError("load failed")),
                redirect_stdout(stream),
            ):
                with self.assertRaisesRegex(RuntimeError, "Failed to load Faster-Whisper model"):
                    process_manifest(str(manifest_path), str(output_dir), "base")

            events = parse_events(stream.getvalue())
            self.assertEqual([event["event"] for event in events], ["start", "scanned", "fatal_error"])
            for event in events:
                assert_protocol_event(self, event)


if __name__ == "__main__":
    unittest.main()
