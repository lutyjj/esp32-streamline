"""Lossless packet-timeline recording and durable WAV storage.

The package splits recording into one module per job: `model` owns the
domain contract, `wav` the part-file writer, `store` the pinned directory,
`session` the timeline policy, and `service` the orchestration. This module
is the public surface; consumers import from here.
"""

from streamline_bridge.recording.model import (
    DEFAULT_RECORDING_LIMITS,
    RecordingError,
    RecordingLimits,
    RecordingManifest,
    RecordingSnapshot,
    RecordingState,
    recording_capabilities,
)
from streamline_bridge.recording.service import RecordingService
from streamline_bridge.recording.session import SILENCE_BATCH_PACKETS, RecordingSession
from streamline_bridge.recording.store import OpenedRecording, RecordingPaths, RecordingStore
from streamline_bridge.recording.wav import WavRecordingFile, wav_header

__all__ = [
    "DEFAULT_RECORDING_LIMITS",
    "SILENCE_BATCH_PACKETS",
    "OpenedRecording",
    "RecordingError",
    "RecordingLimits",
    "RecordingManifest",
    "RecordingPaths",
    "RecordingService",
    "RecordingSession",
    "RecordingSnapshot",
    "RecordingState",
    "RecordingStore",
    "WavRecordingFile",
    "recording_capabilities",
    "wav_header",
]
