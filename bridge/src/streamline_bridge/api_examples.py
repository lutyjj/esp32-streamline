"""Example payloads the contract publishes, which client fixtures derive from."""

from __future__ import annotations

from typing import Any, Final

SOURCE: Final = "192.0.2.10"

BRIDGE_STATUS: Final[dict[str, Any]] = {
    "bridge_version": "1.2.3",
    "public_url": "http://192.0.2.20:8088",
    "api_token_configured": True,
    "sources": {
        SOURCE: {
            "packets": 11250,
            "missing_packets": 0,
            "silence_packets": 0,
            "quality": {
                "window_seconds": 60,
                "observed_seconds": 60,
                "audio_packets": 11250,
                "silence_packets": 0,
                "missing_packets": 0,
                "late_packets": 0,
                "underruns": 0,
                "disconnects": 0,
            },
            "late": 0,
            "reordered": 0,
            "duplicate": 0,
            "underruns": 0,
            "overflows": 0,
            "buffered_packets": 188,
            "playout_buffer_packets": 188,
            "applied_buffer_packets": 188,
            "min_playout_buffer_packets": 188,
            "max_playout_buffer_packets": 563,
            "buffer_expansion_packets": 0,
            "buffer_reduction_packets": 0,
            "max_buffered_packets": 750,
            "max_outage_silence_packets": 938,
            "bytes": 11520000,
            "frames": 2880000,
            "played_frames": 2831872,
            "rate": 48000,
            "packet_frames": 256,
            "playout_seq": 11062,
            "last_seq": 11249,
            "highest_seq": 11249,
            "last_packet_at": 1767225660.0,
            "last_playout_at": 1767225660.0,
            "buffer_ready_at": 1767225601.0,
            "started_at": 1767225600.0,
            "tcp_connections": 1,
            "tcp_disconnects": 0,
            "tcp_errors": 0,
            "uptime_seconds": 60.0,
            "clients": 1,
            "client_buffer_chunks": 2048,
            "client_queue_drops": 0,
            "slow_clients": 0,
            "client_streams": [
                {
                    "id": 1,
                    "remote_addr": "192.0.2.30",
                    "path": "/streamline.wav",
                    "connected_at": 1767225602.0,
                    "bytes_sent": 11300000,
                    "chunks_sent": 11035,
                    "batches_sent": 5600,
                    "queue_drops": 0,
                    "queue_depth": 2,
                    "last_write_at": 1767225660.0,
                }
            ],
            "levels": {"peak_left": 16384, "peak_right": 15000, "rms_left": 4096, "rms_right": 3800},
            "signal": "present",
            "lifecycle": {
                "state": "connected",
                "dynamic": True,
                "admission": "open",
                "http_clients": 1,
                "recording_sessions": 0,
                "sendspin_streams": 0,
                "idle_seconds": 0.0,
                "eviction_idle_seconds": 300.0,
                "peer_ip": SOURCE,
                "transport": "cleartext",
            },
        }
    },
    "transport": {
        "contract_version": 1,
        "mode": "cleartext",
        "configurable": True,
        "port": 39000,
        "key_ids": [],
        "auth_successes": 0,
        "auth_failures": 0,
    },
    "sendspin": {
        "enabled": True,
        "server_url": "ws://192.0.2.20:8927/sendspin",
        "sources": [
            {
                "source": SOURCE,
                "client_id": "q3Vx0p8YtW2nR5sL1cJ7aKf9eH4mB6zD0uG2iO8yT1E",
                "name": f"StreamLine {SOURCE}",
                "connection": "connected",
                "paired": False,
                "input_enabled": False,
                "streaming": False,
                "signal": "present",
            }
        ],
    },
}

RECORDING_LIST: Final[dict[str, Any]] = {
    "active": [
        {
            "id": "20260101-120500-side-b",
            "title": "Side B",
            "source": SOURCE,
            "state": "recording",
            "created_at": "2026-01-01T12:05:00Z",
            "audio_started_at": "2026-01-01T12:05:04Z",
            "finished_at": None,
            "frames": 2880000,
            "bytes": 11520000,
            "duration_seconds": 60.0,
            "gap_packets": 0,
            "duplicate_packets": 0,
            "error": None,
            "file_name": None,
        }
    ],
    "saved": [
        {
            "id": "20260101-120000-side-a",
            "title": "Side A",
            "source": SOURCE,
            "state": "complete",
            "created_at": "2026-01-01T12:00:00Z",
            "audio_started_at": "2026-01-01T12:00:03Z",
            "finished_at": "2026-01-01T12:04:03Z",
            "frames": 11520000,
            "bytes": 46080044,
            "duration_seconds": 240.0,
            "gap_packets": 0,
            "duplicate_packets": 0,
            "error": None,
            "file_name": "20260101-120000-side-a.wav",
        }
    ],
    "storage": {"free_bytes": 32 * 1024**3},
}
