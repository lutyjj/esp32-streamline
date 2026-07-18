"""Stream PCM into a repairable WAV part file and publish it atomically."""

from __future__ import annotations

import os
import struct
from typing import TYPE_CHECKING

from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.recording.model import WAV_HEADER_BYTES, WAV_MAX_DATA_BYTES, RecordingError

if TYPE_CHECKING:
    from pathlib import Path

    from streamline_bridge.recording.store import RecordingPaths, RecordingStore


def wav_header(data_bytes: int, pcm_format: PcmFormat = DEFAULT_FORMAT) -> bytes:
    if data_bytes < 0 or data_bytes > WAV_MAX_DATA_BYTES:
        raise ValueError("WAV data size is outside the RIFF limit")
    block_align = pcm_format.channels * pcm_format.bits // 8
    byte_rate = pcm_format.rate * block_align
    return b"".join(
        (
            b"RIFF",
            struct.pack("<I", data_bytes + 36),
            b"WAVEfmt ",
            struct.pack(
                "<IHHIIHH", 16, 1, pcm_format.channels, pcm_format.rate, byte_rate, block_align, pcm_format.bits
            ),
            b"data",
            struct.pack("<I", data_bytes),
        )
    )


class WavRecordingFile:
    """Stream PCM to a repairable part file and atomically publish it."""

    def __init__(self, store: RecordingStore, paths: RecordingPaths, pcm_format: PcmFormat = DEFAULT_FORMAT) -> None:
        self._store = store
        self.paths = paths
        self._format = pcm_format
        self._file = os.fdopen(store.create_part(paths), "w+b")
        self._file.write(wav_header(0, pcm_format))
        self.data_bytes = 0

    def append(self, payload: bytes) -> None:
        if len(payload) % (self._format.channels * self._format.bits // 8):
            raise ValueError("PCM payload is not frame-aligned")
        if self.data_bytes + len(payload) > WAV_MAX_DATA_BYTES:
            raise RecordingError("duration-limit", "The WAV size limit was reached. Start a new recording.")
        written = self._file.write(payload)
        self.data_bytes += written
        if written != len(payload):
            raise OSError(f"short recording write: {written} of {len(payload)} bytes")

    def finalize(self) -> Path:
        self._file.flush()
        file_bytes = self._file.seek(0, os.SEEK_END)
        frame_bytes = self._format.channels * self._format.bits // 8
        self.data_bytes = max(0, file_bytes - WAV_HEADER_BYTES)
        self.data_bytes -= self.data_bytes % frame_bytes
        self._file.truncate(WAV_HEADER_BYTES + self.data_bytes)
        self._file.seek(0)
        self._file.write(wav_header(self.data_bytes, self._format))
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()
        self._store.publish_part(self.paths)
        return self.paths.wav

    def discard(self) -> None:
        self._file.close()
        self._store.discard_part(self.paths)

    def close_for_recovery(self) -> None:
        if self._file.closed:
            return
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()
