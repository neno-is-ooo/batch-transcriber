from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout

from whisper_batch.events import EventEmitter


def parse_lines(payload: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in payload.strip().splitlines() if line.strip()]


class EventEmitterTests(unittest.TestCase):
    def test_emits_protocol_events_as_ndjson_lines(self) -> None:
        stream = io.StringIO()
        emitter = EventEmitter()

        with redirect_stdout(stream):
            emitter.emit_start("session-1", "whisper-openai", "base")
            emitter.emit_models_loaded()
            emitter.emit_file_started(0, 2, "/audio/a.wav", "a.wav")
            emitter.emit_file_progress(0, "/audio/a.wav", 50.0, 0.8)
            emitter.emit_file_done(
                index=0,
                file="/audio/a.wav",
                duration_seconds=10.5,
                processing_seconds=5.2,
                rtfx=2.01,
                confidence=0.9,
                output={"txt": "/out/a.wav.txt", "json": "/out/a.wav.json"},
            )
            emitter.emit_file_failed(1, "/audio/b.wav", "decode failed", 1)
            emitter.emit_file_skipped(2, "/audio/c.wav", "outputs_exist")
            emitter.emit_fatal_error("model bootstrap failed")
            emitter.emit_summary(
                total=3,
                processed=1,
                skipped=1,
                failed=1,
                duration_seconds=15.7,
                failures=[{"file": "/audio/b.wav", "error": "decode failed"}],
            )

        events = parse_lines(stream.getvalue())
        self.assertEqual(len(events), 9)
        self.assertEqual(events[0]["event"], "start")
        self.assertEqual(events[1]["event"], "models_loaded")
        self.assertEqual(events[2]["event"], "file_started")
        self.assertEqual(events[3]["event"], "file_progress")
        self.assertEqual(events[4]["event"], "file_done")
        self.assertEqual(events[5]["event"], "file_failed")
        self.assertEqual(events[6]["event"], "file_skipped")
        self.assertEqual(events[7]["event"], "fatal_error")
        self.assertEqual(events[8]["event"], "summary")

        for event in events:
            self.assertIn("timestamp", event)
            self.assertTrue(str(event["timestamp"]).endswith("Z"))

        done = events[4]
        self.assertEqual(done["file"], "/audio/a.wav")
        self.assertEqual(done["output"], {"txt": "/out/a.wav.txt", "json": "/out/a.wav.json"})

        self.assertEqual(events[7]["error"], "model bootstrap failed")

        summary = events[8]
        self.assertEqual(summary["total"], 3)
        self.assertEqual(summary["processed"], 1)
        self.assertEqual(summary["skipped"], 1)
        self.assertEqual(summary["failed"], 1)


if __name__ == "__main__":
    unittest.main()
