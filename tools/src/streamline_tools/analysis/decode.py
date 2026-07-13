"""Turn audio files into 48 kHz stereo float frames."""

from __future__ import annotations

import pathlib
import subprocess
import tempfile
from typing import cast

import numpy as np

from .signal import CHANNELS, SAMPLE_RATE, FloatArray


def decode_with_ffmpeg(path: pathlib.Path) -> FloatArray:
    with tempfile.NamedTemporaryFile(suffix=".f32le") as tmp:
        cmd = [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "f32le",
            tmp.name,
        ]
        subprocess.run(cmd, check=True)
        data = np.fromfile(tmp.name, dtype=np.float32)
    if data.size % CHANNELS:
        data = data[: data.size - (data.size % CHANNELS)]
    return cast(FloatArray, data.reshape((-1, CHANNELS)))


def read_raw_s16le(path: pathlib.Path) -> FloatArray:
    data = np.fromfile(path, dtype="<i2")
    if data.size % CHANNELS:
        data = data[: data.size - (data.size % CHANNELS)]
    return data.reshape((-1, CHANNELS)).astype(np.float32) / 32768.0


def load_capture(path: pathlib.Path, raw: bool) -> FloatArray:
    if raw or path.suffix.lower() in {".raw", ".pcm", ".s16le"}:
        return read_raw_s16le(path)
    return decode_with_ffmpeg(path)
