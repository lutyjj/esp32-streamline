"""Recording domain contract: states, limits, snapshots, and manifests."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Literal, TypedDict, cast

from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.source_identity import parse_source_identity

RecordingState = Literal[
    "waiting-for-audio",
    "recording",
    "finalizing",
    "complete",
    "interrupted",
    "empty",
]

WAV_HEADER_BYTES = 44
WAV_MAX_DATA_BYTES = 0xFFFFFFFF - 36
DEFAULT_MAX_DURATION_SECONDS = 4 * 60 * 60
DEFAULT_MAX_GAP_SECONDS = 5 * 60
DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024
DEFAULT_QUEUE_CHUNKS = 1024
MAX_TITLE_CHARS = 80
MAX_RECORDING_ID_CHARS = 128
MAX_MANIFEST_BYTES = 64 * 1024
MAX_MANIFEST_ERROR_CHARS = 512
MAX_MANIFEST_TIMESTAMP_CHARS = 32
ID_PATTERN = re.compile(r"^[a-zA-Z0-9-]+$")


class RecordingError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RecordingSnapshot(TypedDict):
    id: str
    title: str
    source: str
    state: RecordingState
    created_at: str
    audio_started_at: str | None
    finished_at: str | None
    frames: int
    bytes: int
    duration_seconds: float
    gap_packets: int
    duplicate_packets: int
    error: str | None
    file_name: str | None


@dataclass(frozen=True)
class RecordingLimits:
    max_duration_seconds: int = DEFAULT_MAX_DURATION_SECONDS
    max_gap_seconds: int = DEFAULT_MAX_GAP_SECONDS
    min_free_bytes: int = DEFAULT_MIN_FREE_BYTES
    queue_chunks: int = DEFAULT_QUEUE_CHUNKS
    max_title_chars: int = MAX_TITLE_CHARS


DEFAULT_RECORDING_LIMITS = RecordingLimits()


def recording_capabilities(enabled: bool, limits: RecordingLimits = DEFAULT_RECORDING_LIMITS) -> dict[str, object]:
    return {
        "enabled": enabled,
        "format": {
            "container": "wav",
            "codec": "pcm_s16le",
            "sample_rate": DEFAULT_FORMAT.rate,
            "channels": DEFAULT_FORMAT.channels,
            "bits_per_sample": DEFAULT_FORMAT.bits,
            "bytes_per_second": DEFAULT_FORMAT.rate * DEFAULT_FORMAT.channels * DEFAULT_FORMAT.bits // 8,
        },
        "limits": asdict(limits),
    }


@dataclass
class RecordingManifest:
    schema_version: int
    id: str
    title: str
    source: str
    state: RecordingState
    created_at: str
    audio_started_at: str | None
    finished_at: str | None
    sample_rate: int
    channels: int
    bits_per_sample: int
    frames: int
    bytes: int
    duration_seconds: float
    gap_packets: int
    duplicate_packets: int
    error: str | None
    file_name: str

    @classmethod
    def from_dict(cls, data: object, pcm_format: PcmFormat = DEFAULT_FORMAT) -> RecordingManifest:
        """Parse an untrusted persisted manifest into the current contract."""
        if not isinstance(data, dict) or set(data) != set(cls.__dataclass_fields__):
            raise ValueError("manifest fields do not match schema version 1")
        if _manifest_int(data, "schema_version") != 1:
            raise ValueError("unsupported manifest schema")
        recording_id = _manifest_string(data, "id", MAX_RECORDING_ID_CHARS)
        validate_id(recording_id)
        title = _manifest_string(data, "title", MAX_TITLE_CHARS)
        if not title:
            raise ValueError("empty recording title")
        source = parse_source_identity(_manifest_string(data, "source", 45), allow_recovery=True)
        state = _manifest_string(data, "state", 16)
        if state not in {"complete", "interrupted"}:
            raise ValueError("saved recording has an invalid state")
        saved_state = cast("RecordingState", state)
        created_at = _manifest_timestamp(data, "created_at", required=True)
        audio_started_at = _manifest_timestamp(data, "audio_started_at", required=False)
        finished_at = _manifest_timestamp(data, "finished_at", required=True)
        if created_at is None or finished_at is None:
            raise ValueError("saved recording timestamps are required")
        if (
            _manifest_int(data, "sample_rate") != pcm_format.rate
            or _manifest_int(data, "channels") != pcm_format.channels
            or _manifest_int(data, "bits_per_sample") != pcm_format.bits
        ):
            raise ValueError("recording format does not match the bridge format")
        frames = _manifest_int(data, "frames", minimum=1, maximum=pcm_format.rate * DEFAULT_MAX_DURATION_SECONDS)
        frame_bytes = pcm_format.channels * pcm_format.bits // 8
        expected_bytes = frames * frame_bytes
        if _manifest_int(data, "bytes", minimum=frame_bytes, maximum=WAV_MAX_DATA_BYTES) != expected_bytes:
            raise ValueError("recording byte count does not match its frame count")
        duration = data["duration_seconds"]
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise ValueError("recording duration must be numeric")
        expected_duration = frames / pcm_format.rate
        if abs(float(duration) - expected_duration) > 1e-6:
            raise ValueError("recording duration does not match its frame count")
        gap_packets = _manifest_int(data, "gap_packets", minimum=0, maximum=0xFFFFFFFF)
        duplicate_packets = _manifest_int(data, "duplicate_packets", minimum=0, maximum=0xFFFFFFFF)
        error_value = data["error"]
        if error_value is not None and (
            not isinstance(error_value, str) or len(error_value) > MAX_MANIFEST_ERROR_CHARS
        ):
            raise ValueError("recording error is invalid")
        file_name = _manifest_string(data, "file_name", MAX_RECORDING_ID_CHARS + 4)
        if file_name != f"{recording_id}.wav":
            raise ValueError("recording file name does not match its id")
        return cls(
            1,
            recording_id,
            title,
            source,
            saved_state,
            created_at,
            audio_started_at,
            finished_at,
            pcm_format.rate,
            pcm_format.channels,
            pcm_format.bits,
            frames,
            expected_bytes,
            expected_duration,
            gap_packets,
            duplicate_packets,
            error_value,
            file_name,
        )

    def snapshot(self) -> RecordingSnapshot:
        return {
            "id": self.id,
            "title": self.title,
            "source": self.source,
            "state": self.state,
            "created_at": self.created_at,
            "audio_started_at": self.audio_started_at,
            "finished_at": self.finished_at,
            "frames": self.frames,
            "bytes": self.bytes,
            "duration_seconds": self.duration_seconds,
            "gap_packets": self.gap_packets,
            "duplicate_packets": self.duplicate_packets,
            "error": self.error,
            "file_name": self.file_name,
        }


def utc_now() -> datetime:
    return datetime.now(UTC)


def isoformat(value: datetime) -> str:
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def validate_title(title: str, max_chars: int) -> str:
    title = " ".join(title.split())
    if not title:
        raise RecordingError("invalid-title", "Enter a recording title.")
    if len(title) > max_chars:
        raise RecordingError("invalid-title", f"Recording titles must be {max_chars} characters or fewer.")
    return title


def slug(title: str) -> str:
    normalized = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")[:48] or "recording"


def validate_id(recording_id: str) -> None:
    if len(recording_id) > MAX_RECORDING_ID_CHARS or not ID_PATTERN.fullmatch(recording_id):
        raise RecordingError("not-found", "Recording not found. Refresh the recording list.")


def title_from_id(recording_id: str) -> str:
    parts = recording_id.split("-")
    return " ".join(parts[1:-1]).title() or "Recovered recording"


def _manifest_string(data: dict[object, object], name: str, maximum: int) -> str:
    value = data[name]
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"manifest {name} must be a bounded string")
    return value


def _manifest_int(
    data: dict[object, object],
    name: str,
    minimum: int = 0,
    maximum: int = 0x7FFFFFFF,
) -> int:
    value = data[name]
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"manifest {name} must be a bounded integer")
    return value


def _manifest_timestamp(data: dict[object, object], name: str, *, required: bool) -> str | None:
    value = data[name]
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value or len(value) > MAX_MANIFEST_TIMESTAMP_CHARS:
        raise ValueError(f"manifest {name} must be an ISO timestamp")
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value
