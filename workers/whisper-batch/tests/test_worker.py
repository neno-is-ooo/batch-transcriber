from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any
from unittest.mock import patch

from whisper_batch.worker import process_manifest


def parse_events(payload: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in payload.strip().splitlines() if line.strip()]


def assert_protocol_event(test_case: unittest.TestCase, event: dict[str, Any]) -> None:
    required: dict[str, set[str]] = {
        "start": {"event", "timestamp", "session_id", "provider", "model"},
        "scanned": {"event", "timestamp", "total"},
        "models_loaded": {"event", "timestamp"},
        "file_started": {"event", "timestamp", "index", "total", "file", "relative"},
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


class FakeModel:
    def __init__(self, responses: dict[str, Any]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def transcribe(self, source_path: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append((source_path, kwargs))
        response = self.responses[source_path]
        if isinstance(response, Exception):
            raise response
        return response


class WorkerTests(unittest.TestCase):
    def test_process_manifest_emits_events_and_writes_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audio_path = root / "audio" / "sample.wav"
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(b"fake")

            manifest = {
                "session_id": "session-123",
                "provider": "whisper-openai",
                "model": "small",
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
                    str(audio_path): {
                        "text": "hello world",
                        "duration": 8.0,
                        "segments": [
                            {"start": 0.0, "end": 8.0, "avg_logprob": -0.2},
                        ],
                    }
                }
            )

            stream = io.StringIO()
            with (
                patch("whisper_batch.worker.ensure_model", return_value=fake_model) as ensure_model,
                redirect_stdout(stream),
            ):
                summary = process_manifest(str(manifest_path), str(output_dir), "base")

            ensure_model.assert_called_once_with("small")
            self.assertEqual(summary["processed"], 1)
            self.assertEqual(summary["failed"], 0)

            events = parse_events(stream.getvalue())
            self.assertEqual(
                [event["event"] for event in events],
                ["start", "scanned", "models_loaded", "file_started", "file_done", "summary"],
            )
            for event in events:
                assert_protocol_event(self, event)

            self.assertEqual(events[0]["session_id"], "session-123")
            self.assertEqual(events[3]["relative"], "nested/sample.wav")

            done = events[4]
            self.assertGreater(done["processing_seconds"], 0.0)
            self.assertGreater(done["rtfx"], 0.0)

            txt_output = output_dir / "nested" / "sample.wav.txt"
            json_output = output_dir / "nested" / "sample.wav.json"
            self.assertTrue(txt_output.exists())
            self.assertTrue(json_output.exists())
            self.assertEqual(txt_output.read_text(encoding="utf-8"), "hello world")

            payload = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(payload["text"], "hello world")
            self.assertEqual(done["output"]["txt"], str(txt_output))
            self.assertEqual(done["output"]["json"], str(json_output))
            self.assertEqual(fake_model.calls[0][1], {"word_timestamps": True})

    def test_process_manifest_emits_file_failed_and_continues(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audio_path = root / "audio" / "broken.wav"
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(b"fake")

            manifest = {
                "sessionId": "session-camel",
                "provider": "whisper-openai",
                "files": [{"path": str(audio_path)}],
            }
            manifest_path = root / "manifest.json"
            output_dir = root / "output"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            fake_model = FakeModel({str(audio_path): RuntimeError("transcription failed")})

            stream = io.StringIO()
            with (
                patch("whisper_batch.worker.ensure_model", return_value=fake_model),
                redirect_stdout(stream),
            ):
                summary = process_manifest(str(manifest_path), str(output_dir), "base")

            events = parse_events(stream.getvalue())
            self.assertEqual(events[0]["session_id"], "session-camel")
            self.assertEqual(events[3]["event"], "file_started")
            self.assertEqual(events[3]["relative"], "broken.wav")
            self.assertEqual(events[4]["event"], "file_failed")
            self.assertIn("transcription failed", events[4]["error"])
            self.assertEqual(events[5]["event"], "summary")
            for event in events:
                assert_protocol_event(self, event)
            self.assertEqual(events[5]["processed"], 0)
            self.assertEqual(events[5]["failed"], 1)
            self.assertEqual(summary["failed"], 1)
            self.assertEqual(summary["processed"], 0)

            self.assertFalse((output_dir / "broken.wav.txt").exists())
            self.assertFalse((output_dir / "broken.wav.json").exists())

    def test_process_manifest_marks_invalid_manifest_file_entry_as_failed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            valid_audio_path = root / "audio" / "valid.wav"
            valid_audio_path.parent.mkdir(parents=True, exist_ok=True)
            valid_audio_path.write_bytes(b"fake")

            manifest = {
                "session_id": "session-invalid-entry",
                "files": [
                    {"relative_path": "missing.wav"},
                    {"path": str(valid_audio_path), "relative_path": "nested/valid.wav"},
                ],
            }
            manifest_path = root / "manifest.json"
            output_dir = root / "output"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            fake_model = FakeModel(
                {
                    str(valid_audio_path): {
                        "text": "ok",
                        "duration": 2.0,
                        "segments": [{"start": 0.0, "end": 2.0, "avg_logprob": -0.1}],
                    }
                }
            )

            stream = io.StringIO()
            with (
                patch("whisper_batch.worker.ensure_model", return_value=fake_model),
                redirect_stdout(stream),
            ):
                summary = process_manifest(str(manifest_path), str(output_dir), "base")

            events = parse_events(stream.getvalue())
            self.assertEqual(
                [event["event"] for event in events],
                [
                    "start",
                    "scanned",
                    "models_loaded",
                    "file_failed",
                    "file_started",
                    "file_done",
                    "summary",
                ],
            )
            for event in events:
                assert_protocol_event(self, event)

            self.assertIn("missing a valid path", events[3]["error"])
            self.assertEqual(summary["processed"], 1)
            self.assertEqual(summary["failed"], 1)
            self.assertEqual(events[6]["processed"], 1)
            self.assertEqual(events[6]["failed"], 1)

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
                patch("whisper_batch.worker.ensure_model", side_effect=RuntimeError("download failed")),
                redirect_stdout(stream),
            ):
                with self.assertRaisesRegex(RuntimeError, "Failed to load Whisper model 'base'"):
                    process_manifest(str(manifest_path), str(output_dir), "base")

            events = parse_events(stream.getvalue())
            self.assertEqual([event["event"] for event in events], ["start", "scanned", "fatal_error"])
            for event in events:
                assert_protocol_event(self, event)
            self.assertIn("download failed", str(events[2]["error"]))


if __name__ == "__main__":
    unittest.main()
