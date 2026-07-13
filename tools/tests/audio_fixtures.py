"""Deterministic synthetic audio shared by the analyzer tests."""

import numpy as np
import numpy.typing as npt

from streamline_tools.analysis.signal import CHANNELS, SAMPLE_RATE

Float32Array = npt.NDArray[np.float32]


def modulated_noise(seed: int, seconds: float) -> Float32Array:
    """Independent-per-channel noise with a slow amplitude envelope.

    The envelope gives each 1024-sample block a distinctive RMS, so the
    envelope cross-correlation used for alignment has a sharp, unambiguous peak.
    """
    rng = np.random.default_rng(seed)
    frames = int(seconds * SAMPLE_RATE)
    t = np.arange(frames) / SAMPLE_RATE
    envelope = 0.5 + 0.5 * np.abs(np.sin(2.0 * np.pi * 1.5 * t))
    noise = rng.standard_normal((frames, CHANNELS))
    samples = noise * envelope[:, None] * 0.3
    return samples.astype(np.float32)


def delay(signal: Float32Array, frames: int) -> Float32Array:
    """Prepend `frames` of silence, modeling a capture that starts late."""
    pad = np.zeros((frames, CHANNELS), dtype=np.float32)
    return np.concatenate([pad, signal], axis=0)
