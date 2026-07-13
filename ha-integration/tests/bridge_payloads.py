"""Bridge API payloads for tests, each checked against the generated models."""

from __future__ import annotations

from typing import Any

from custom_components.streamline.models import (
    BridgeStatus,
    ErrorResponse,
    RecordingCapabilities,
    RecordingList,
    RecordingResult,
    RecordingSnapshot,
    SourceSnapshot,
)

SOURCE = "192.0.2.10"
BRIDGE_URL = "http://bridge.local:8088"


def source_snapshot(
    *,
    state: str = "connected",
    peak: int = 16384,
    clients: int = 1,
    lost: int = 2,
) -> dict[str, Any]:
    """Return one complete source snapshot payload."""
    payload: dict[str, Any] = {
        "buffer_ready_at": 1.0,
        "buffered_packets": 2,
        "bytes": 4096,
        "client_buffer_chunks": 8,
        "client_queue_drops": 0,
        "client_streams": [],
        "clients": clients,
        "concealed": 0,
        "duplicate": 0,
        "frames": 96,
        "last_packet_at": 2.0,
        "last_playout_at": 2.0,
        "late": 0,
        "levels": {
            "peak_left": peak,
            "peak_right": peak // 2,
            "rms_left": 100,
            "rms_right": 100,
        },
        "lifecycle": {
            "dynamic": True,
            "http_clients": clients,
            "idle_seconds": 0.0,
            "recording_sessions": 0,
            "state": state,
        },
        "lost": lost,
        "max_outage_silence_packets": 100,
        "packets": 42,
        "played_frames": 96,
        "playout_buffer_packets": 4,
        "rate": 48000,
        "reordered": 0,
        "slow_clients": 0,
        "started_at": 1.0,
        "tcp_connections": 1,
        "tcp_disconnects": 0,
        "tcp_errors": 0,
        "underruns": 0,
        "uptime_seconds": 60.0,
    }
    SourceSnapshot.model_validate(payload)
    return payload


def bridge_status(sources: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Return a bridge status payload; defaults to one connected source."""
    payload = {
        "bridge_version": "1.0.0",
        "sources": {SOURCE: source_snapshot()} if sources is None else sources,
    }
    BridgeStatus.model_validate(payload)
    return payload


def recording_capabilities(*, enabled: bool = True) -> dict[str, Any]:
    """Return a recording capabilities payload."""
    payload = {
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
            "max_duration_seconds": 7200,
            "max_gap_seconds": 60,
            "max_title_chars": 80,
            "min_free_bytes": 1_000_000,
            "queue_chunks": 64,
        },
    }
    RecordingCapabilities.model_validate(payload)
    return payload


def recording_snapshot(
    *,
    recording_id: str = "rec-1",
    source: str = SOURCE,
    state: str = "recording",
    title: str = "Test recording",
    file_name: str | None = None,
) -> dict[str, Any]:
    """Return one recording session payload."""
    payload: dict[str, Any] = {
        "audio_started_at": "2026-07-13T10:00:00+00:00",
        "bytes": 1024,
        "created_at": "2026-07-13T10:00:00+00:00",
        "duplicate_packets": 0,
        "duration_seconds": 5.0,
        "error": None,
        "file_name": file_name,
        "finished_at": None,
        "frames": 240,
        "gap_packets": 0,
        "id": recording_id,
        "source": source,
        "state": state,
        "title": title,
    }
    RecordingSnapshot.model_validate(payload)
    return payload


def recording_list(
    active: list[dict[str, Any]] | None = None,
    saved: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a recording list payload; defaults to no recordings."""
    payload = {
        "active": active or [],
        "saved": saved or [],
        "storage": {"free_bytes": 10_000_000},
    }
    RecordingList.model_validate(payload)
    return payload


def recording_result(recording: dict[str, Any]) -> dict[str, Any]:
    """Return the payload wrapping one recording action result."""
    payload = {"recording": recording}
    RecordingResult.model_validate(payload)
    return payload


def error_response(code: str, message: str) -> dict[str, Any]:
    """Return one bridge error payload."""
    payload = {"error": {"code": code, "message": message}}
    ErrorResponse.model_validate(payload)
    return payload
