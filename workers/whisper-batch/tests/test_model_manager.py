from __future__ import annotations

import builtins
import io
import json
import sys
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

from whisper_batch.model_manager import ensure_model, get_available_models, print_capabilities


class ModelManagerTests(unittest.TestCase):
    def test_get_available_models_lists_supported_whisper_models(self) -> None:
        self.assertEqual(
            get_available_models(),
            ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        )

    def test_ensure_model_loads_requested_model(self) -> None:
        expected_model = object()
        load_model = Mock(return_value=expected_model)
        fake_whisper = types.SimpleNamespace(load_model=load_model)

        with patch.dict(sys.modules, {"whisper": fake_whisper}):
            loaded = ensure_model(" Base ")

        self.assertIs(loaded, expected_model)
        load_model.assert_called_once_with("base")

    def test_ensure_model_rejects_unknown_model(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported Whisper model"):
            ensure_model("ultra")

    def test_ensure_model_wraps_import_errors(self) -> None:
        original_import = builtins.__import__

        def failing_import(name: str, *args: object, **kwargs: object) -> object:
            if name == "whisper":
                raise ImportError("boom")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=failing_import):
            with self.assertRaisesRegex(RuntimeError, "Failed to import openai-whisper"):
                ensure_model("base")

    def test_print_capabilities_outputs_valid_json(self) -> None:
        stream = io.StringIO()
        with redirect_stdout(stream):
            print_capabilities()

        parsed = json.loads(stream.getvalue().strip())
        self.assertEqual(
            parsed["supported_models"],
            ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        )
        self.assertTrue(parsed["word_timestamps"])
        self.assertFalse(parsed["speaker_diarization"])
        self.assertTrue(parsed["language_detection"])
        self.assertTrue(parsed["translation"])
        self.assertIn("en", parsed["languages"])
        self.assertIn("speed_estimate", parsed)


if __name__ == "__main__":
    unittest.main()
