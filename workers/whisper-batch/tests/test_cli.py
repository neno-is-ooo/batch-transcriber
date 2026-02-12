from __future__ import annotations

import unittest
from unittest.mock import patch

from whisper_batch.__main__ import main


class CLITests(unittest.TestCase):
    def test_capabilities_short_circuits_manifest_processing(self) -> None:
        with (
            patch("whisper_batch.__main__.print_capabilities") as print_capabilities,
            patch("whisper_batch.__main__.process_manifest") as process_manifest,
        ):
            exit_code = main(["--capabilities"])

        self.assertEqual(exit_code, 0)
        print_capabilities.assert_called_once_with()
        process_manifest.assert_not_called()

    def test_requires_manifest_and_output_without_capabilities(self) -> None:
        with self.assertRaises(SystemExit) as exc:
            main([])

        self.assertEqual(exc.exception.code, 2)

    def test_uses_default_model(self) -> None:
        with patch("whisper_batch.__main__.process_manifest") as process_manifest:
            exit_code = main(["--manifest", "manifest.json", "--output-dir", "out"])

        self.assertEqual(exit_code, 0)
        process_manifest.assert_called_once_with("manifest.json", "out", "base")

    def test_passes_explicit_model(self) -> None:
        with patch("whisper_batch.__main__.process_manifest") as process_manifest:
            exit_code = main(
                [
                    "--manifest",
                    "manifest.json",
                    "--output-dir",
                    "out",
                    "--model",
                    "small",
                ]
            )

        self.assertEqual(exit_code, 0)
        process_manifest.assert_called_once_with("manifest.json", "out", "small")


if __name__ == "__main__":
    unittest.main()
