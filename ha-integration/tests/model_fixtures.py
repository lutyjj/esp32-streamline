"""Valid generated bridge models for Home Assistant tests."""

from __future__ import annotations

from typing import TYPE_CHECKING

from custom_components.streamline.generated import (
    BridgeStatus,
    RecordingCapabilities,
    RecordingList,
    RecordingSnapshot,
    SourceSnapshot,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


def source_snapshot(*, peak: int = 16384) -> SourceSnapshot:
    """Return one complete bridge source model."""
    return SourceSnapshot.model_validate(
        {
            "buffer_ready_at": 1.0,
            "buffered_packets": 2,
            "bytes": 4,
            "client_buffer_chunks": 8,
            "client_queue_drops": 0,
            "client_streams": [],
            "clients": 1,
            "concealed": 0,
            "duplicate": 0,
            "frames": 2,
            "highest_seq": 42,
            "last_packet_at": 2.0,
            "last_playout_at": 2.0,
            "last_seq": 42,
            "late": 0,
            "levels": {
                "peak_left": peak,
                "peak_right": peak,
                "rms_left": 100,
                "rms_right": 100,
            },
            "lifecycle": {
                "dynamic": True,
                "http_clients": 1,
                "idle_seconds": 0.0,
                "recording_sessions": 0,
                "state": "connected",
            },
            "lost": 2,
            "max_outage_silence_packets": 100,
            "packet_frames": 48,
            "packets": 42,
            "played_frames": 2,
            "playout_buffer_packets": 4,
            "playout_seq": 42,
            "rate": 48000,
            "reordered": 0,
            "slow_clients": 0,
            "started_at": 1.0,
            "tcp_connections": 1,
            "tcp_disconnects": 0,
            "tcp_errors": 0,
            "underruns": 0,
            "uptime_seconds": 1.0,
        }
    )


def bridge_status(sources: Mapping[str, SourceSnapshot] | None = None) -> BridgeStatus:
    """Return bridge status containing the supplied sources."""
    return BridgeStatus(bridge_version="0.5.6", sources=dict(sources or {}))


def recording_capabilities(*, enabled: bool = True) -> RecordingCapabilities:
    """Return the complete recording capability contract."""
    return RecordingCapabilities.model_validate(
        {
            "enabled": enabled,
            "format": {
                "bits_per_sample": 16,
                "bytes_per_second": 192000,
                "channels": 2,
                "codec": "pcm_s16le",
                "container": "wav",
                "sample_rate": 48000,
            },
            "limits": {
                "max_duration_seconds": 3600,
                "max_gap_seconds": 5,
                "max_title_chars": 80,
                "min_free_bytes": 0,
                "queue_chunks": 8,
            },
        }
    )


def recording_snapshot(
    *,
    recording_id: str = "recording-1",
    state: str = "complete",
    file_name: str | None = "recording-1.wav",
) -> RecordingSnapshot:
    """Return one complete recording model."""
    return RecordingSnapshot.model_validate(
        {
            "audio_started_at": "2026-07-12T12:00:01Z",
            "bytes": 4,
            "created_at": "2026-07-12T12:00:00Z",
            "duplicate_packets": 0,
            "duration_seconds": 180.0,
            "error": None,
            "file_name": file_name,
            "finished_at": "2026-07-12T12:03:01Z" if file_name else None,
            "frames": 1,
            "gap_packets": 0,
            "id": recording_id,
            "source": "192.0.2.10",
            "state": state,
            "title": "Album side A",
        }
    )


def recording_list(
    *,
    active: Iterable[RecordingSnapshot] = (),
    saved: Iterable[RecordingSnapshot] = (),
) -> RecordingList:
    """Return a recording catalog with stable storage data."""
    return RecordingList.model_validate(
        {
            "active": list(active),
            "saved": list(saved),
            "storage": {"free_bytes": 1024},
        }
    )
