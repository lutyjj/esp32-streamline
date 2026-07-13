"""Shared stereo-signal primitives: the frame type, its format, and centering."""

from __future__ import annotations

from typing import Any, cast

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 48_000
CHANNELS = 2
type FloatArray = npt.NDArray[np.floating[Any]]


def center(audio: FloatArray) -> FloatArray:
    """Remove each channel's DC offset so correlations are zero-mean."""
    return cast(FloatArray, audio - np.mean(audio, axis=0, keepdims=True))
