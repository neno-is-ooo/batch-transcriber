from __future__ import annotations

import os
import types
import unittest
from unittest.mock import patch

from faster_whisper_batch import gpu_utils


class GPUUtilsTests(unittest.TestCase):
    def test_detect_cuda_true_when_device_count_positive(self) -> None:
        fake_module = types.SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda *_args: set(),
        )

        with patch("faster_whisper_batch.gpu_utils._load_ctranslate2", return_value=fake_module):
            self.assertTrue(gpu_utils.detect_cuda())

    def test_detect_cuda_false_when_ctranslate2_missing(self) -> None:
        with patch("faster_whisper_batch.gpu_utils._load_ctranslate2", return_value=None):
            self.assertFalse(gpu_utils.detect_cuda())

    def test_get_optimal_compute_type_uses_cpu_fallback_without_cuda(self) -> None:
        with patch("faster_whisper_batch.gpu_utils.detect_cuda", return_value=False):
            self.assertEqual(gpu_utils.get_optimal_compute_type(), gpu_utils.CPU_COMPUTE_TYPE)

    def test_get_optimal_compute_type_uses_low_vram_cuda_type(self) -> None:
        fake_module = types.SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda *_args: {"float16", "int8_float16"},
            get_cuda_device_properties=lambda *_args: {"total_memory": int(4 * 1024**3)},
        )

        with (
            patch.dict(os.environ, {}, clear=True),
            patch("faster_whisper_batch.gpu_utils._load_ctranslate2", return_value=fake_module),
        ):
            self.assertEqual(
                gpu_utils.get_optimal_compute_type(),
                gpu_utils.CUDA_LOW_VRAM_COMPUTE_TYPE,
            )

    def test_compute_type_override_wins(self) -> None:
        with patch.dict(os.environ, {"FASTER_WHISPER_COMPUTE_TYPE": "int8"}, clear=True):
            self.assertEqual(gpu_utils.get_optimal_compute_type(), "int8")

    def test_fallback_chain_and_next_step(self) -> None:
        chain = gpu_utils.get_fallback_chain("cuda", "float16")
        self.assertEqual(
            chain,
            [
                ("cuda", "float16"),
                ("cuda", "int8_float16"),
                ("cpu", "int8"),
            ],
        )
        self.assertEqual(gpu_utils.get_next_fallback("cuda", "float16"), ("cuda", "int8_float16"))
        self.assertEqual(gpu_utils.get_next_fallback("cpu", "int8"), None)


if __name__ == "__main__":
    unittest.main()
