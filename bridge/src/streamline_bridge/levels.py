"""Thread-safe level analysis for interleaved stereo PCM packets."""

from __future__ import annotations

import math
import struct
import threading
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class LevelSnapshot:
    peak_left: int = 0
    peak_right: int = 0
    rms_left: int = 0
    rms_right: int = 0


def analyze_pcm16_stereo(payload: bytes) -> LevelSnapshot:
    """Measure one little-endian 16-bit stereo PCM packet."""
    peak_left = peak_right = 0
    sum_sq_left = sum_sq_right = 0
    frames = 0
    complete = payload[: len(payload) - (len(payload) % 4)]
    for left, right in struct.iter_unpack("<hh", complete):
        left_abs = abs(left)
        right_abs = abs(right)
        peak_left = max(peak_left, left_abs)
        peak_right = max(peak_right, right_abs)
        sum_sq_left += left_abs * left_abs
        sum_sq_right += right_abs * right_abs
        frames += 1
    if frames == 0:
        return LevelSnapshot()
    return LevelSnapshot(
        peak_left,
        peak_right,
        math.isqrt(sum_sq_left // frames),
        math.isqrt(sum_sq_right // frames),
    )


class AudioLevels:
    """Store the latest complete packet measurement for status readers."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snapshot = LevelSnapshot()

    def update(self, payload: bytes) -> None:
        snapshot = analyze_pcm16_stereo(payload)
        with self._lock:
            self._snapshot = snapshot

    def reset(self) -> None:
        with self._lock:
            self._snapshot = LevelSnapshot()

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return asdict(self._snapshot)
