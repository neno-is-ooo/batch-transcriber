"""Model management and capability utilities for whisper-batch."""

from __future__ import annotations

import json
from typing import Any

AVAILABLE_MODELS = (
    "tiny",
    "base",
    "small",
    "medium",
    "large",
    "large-v2",
    "large-v3",
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


def get_available_models() -> list[str]:
    return list(AVAILABLE_MODELS)


def _available_languages() -> list[str]:
    try:
        from whisper.tokenizer import LANGUAGES
    except Exception:
        return list(FALLBACK_LANGUAGE_CODES)

    return sorted(LANGUAGES.keys())


def ensure_model(model_name: str) -> Any:
    """Load and return a Whisper model, downloading it if needed."""

    normalized_name = model_name.strip().lower()
    if not normalized_name:
        raise ValueError("Model name must be a non-empty string.")

    if normalized_name not in AVAILABLE_MODELS:
        supported = ", ".join(AVAILABLE_MODELS)
        raise ValueError(
            f"Unsupported Whisper model '{model_name}'. Supported models: {supported}"
        )

    try:
        import whisper
    except Exception as error:
        raise RuntimeError("Failed to import openai-whisper.") from error

    return whisper.load_model(normalized_name)


def get_capabilities() -> dict[str, Any]:
    return {
        "supported_models": get_available_models(),
        "word_timestamps": True,
        "speaker_diarization": False,
        "language_detection": True,
        "translation": True,
        "languages": _available_languages(),
        "speed_estimate": 0.5,
    }


def print_capabilities() -> None:
    print(json.dumps(get_capabilities()), flush=True)
