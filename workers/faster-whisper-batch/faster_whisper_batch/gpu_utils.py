"""CUDA detection and compute type selection utilities."""

from __future__ import annotations

import os
from typing import Any

CPU_DEVICE = "cpu"
CUDA_DEVICE = "cuda"
CPU_COMPUTE_TYPE = "int8"
CUDA_COMPUTE_TYPE = "float16"
CUDA_LOW_VRAM_COMPUTE_TYPE = "int8_float16"
LOW_VRAM_THRESHOLD_GB = 6.0


def _load_ctranslate2() -> Any | None:
    try:
        import ctranslate2  # type: ignore
    except Exception:
        return None

    return ctranslate2


def _parse_float_env(name: str) -> float | None:
    raw = os.getenv(name)
    if raw is None:
        return None

    try:
        value = float(raw.strip())
    except ValueError:
        return None

    if value <= 0:
        return None

    return value


def _supported_compute_types(module: Any, device: str | None = None) -> set[str]:
    get_supported = getattr(module, "get_supported_compute_types", None)
    if not callable(get_supported):
        return set()

    try:
        values = get_supported(device) if device is not None else get_supported()
    except TypeError:
        try:
            values = get_supported()
        except Exception:
            return set()
    except Exception:
        return set()

    if isinstance(values, (list, tuple, set)):
        return {str(item).strip().lower() for item in values if str(item).strip()}

    return set()


def _cuda_device_count(module: Any) -> int:
    get_count = getattr(module, "get_cuda_device_count", None)
    if not callable(get_count):
        return 0

    try:
        count = int(get_count())
    except Exception:
        return 0

    return max(count, 0)


def _detect_vram_gb(module: Any) -> float | None:
    env_vram = _parse_float_env("FASTER_WHISPER_CUDA_VRAM_GB")
    if env_vram is not None:
        return env_vram

    get_properties = getattr(module, "get_cuda_device_properties", None)
    if not callable(get_properties):
        return None

    try:
        properties = get_properties(0)
    except Exception:
        return None

    total_memory: Any = None
    if isinstance(properties, dict):
        total_memory = properties.get("totalGlobalMem") or properties.get("total_memory")
    else:
        total_memory = getattr(properties, "totalGlobalMem", None)
        if total_memory is None:
            total_memory = getattr(properties, "total_memory", None)

    if isinstance(total_memory, (int, float)) and total_memory > 0:
        return float(total_memory) / (1024.0**3)

    return None


def detect_cuda() -> bool:
    forced_device = os.getenv("FASTER_WHISPER_FORCE_DEVICE", "").strip().lower()
    if forced_device == CPU_DEVICE:
        return False
    if forced_device == CUDA_DEVICE:
        return True

    ctranslate2 = _load_ctranslate2()
    if ctranslate2 is None:
        return False

    if _cuda_device_count(ctranslate2) > 0:
        return True

    direct_cuda = _supported_compute_types(ctranslate2, CUDA_DEVICE)
    if direct_cuda:
        return True

    default_types = _supported_compute_types(ctranslate2)
    return CUDA_DEVICE in default_types


def get_device() -> str:
    return CUDA_DEVICE if detect_cuda() else CPU_DEVICE


def get_optimal_compute_type() -> str:
    override = os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "").strip().lower()
    if override:
        return override

    ctranslate2 = _load_ctranslate2()
    if detect_cuda() and ctranslate2 is not None:
        vram_gb = _detect_vram_gb(ctranslate2)
        if vram_gb is not None and vram_gb < LOW_VRAM_THRESHOLD_GB:
            return CUDA_LOW_VRAM_COMPUTE_TYPE
        return CUDA_COMPUTE_TYPE

    return CPU_COMPUTE_TYPE


def get_fallback_chain(device: str, compute_type: str) -> list[tuple[str, str]]:
    normalized_device = device.strip().lower() or CPU_DEVICE
    normalized_compute = compute_type.strip().lower() or CPU_COMPUTE_TYPE

    chain: list[tuple[str, str]] = [(normalized_device, normalized_compute)]

    if normalized_device == CUDA_DEVICE:
        if normalized_compute == CUDA_COMPUTE_TYPE:
            chain.append((CUDA_DEVICE, CUDA_LOW_VRAM_COMPUTE_TYPE))
            chain.append((CPU_DEVICE, CPU_COMPUTE_TYPE))
        elif normalized_compute == CUDA_LOW_VRAM_COMPUTE_TYPE:
            chain.append((CPU_DEVICE, CPU_COMPUTE_TYPE))
        elif normalized_compute != CPU_COMPUTE_TYPE:
            chain.append((CUDA_DEVICE, CUDA_LOW_VRAM_COMPUTE_TYPE))
            chain.append((CPU_DEVICE, CPU_COMPUTE_TYPE))
    elif normalized_compute != CPU_COMPUTE_TYPE:
        chain.append((CPU_DEVICE, CPU_COMPUTE_TYPE))

    deduped: list[tuple[str, str]] = []
    for candidate in chain:
        if candidate not in deduped:
            deduped.append(candidate)

    return deduped


def get_next_fallback(device: str, compute_type: str) -> tuple[str, str] | None:
    chain = get_fallback_chain(device, compute_type)
    current = (device.strip().lower() or CPU_DEVICE, compute_type.strip().lower() or CPU_COMPUTE_TYPE)

    try:
        index = chain.index(current)
    except ValueError:
        return chain[0] if chain else None

    next_index = index + 1
    if next_index >= len(chain):
        return None

    return chain[next_index]
