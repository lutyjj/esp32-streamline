"""Pydantic models for the bridge HTTP contract."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, WithJsonSchema

from streamline_bridge.source_identity import RECOVERY_SOURCE_ID, TRANSPORT_KEY_ID_PATTERN_TEXT, parse_source_identity


def _source_identity_schema(*, allow_recovery: bool = False) -> dict[str, object]:
    alternatives: list[dict[str, object]] = [
        {"type": "string", "format": "ipv4"},
        {"type": "string", "pattern": TRANSPORT_KEY_ID_PATTERN_TEXT},
    ]
    if allow_recovery:
        alternatives.append({"type": "string", "const": RECOVERY_SOURCE_ID})
    return {"oneOf": alternatives}


def _parse_recoverable_source_identity(value: str) -> str:
    return parse_source_identity(value, allow_recovery=True)


SourceIdentity = Annotated[
    str,
    AfterValidator(parse_source_identity),
    WithJsonSchema(_source_identity_schema()),
]
RecoverableSourceIdentity = Annotated[
    str,
    AfterValidator(_parse_recoverable_source_identity),
    WithJsonSchema(_source_identity_schema(allow_recovery=True)),
]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ErrorDetail(ContractModel):
    code: str
    message: str


class ErrorResponse(ContractModel):
    error: ErrorDetail


class LevelSnapshot(ContractModel):
    peak_left: int = Field(ge=0, le=32768)
    peak_right: int = Field(ge=0, le=32768)
    rms_left: int = Field(ge=0, le=32768)
    rms_right: int = Field(ge=0, le=32768)


class SourceLifecycle(ContractModel):
    state: Literal["pending", "connected", "http-selected", "allowlisted", "disconnected"]
    dynamic: bool
    admission: Literal["open", "allowlisted"]
    http_clients: int = Field(ge=0)
    recording_sessions: int = Field(ge=0)
    idle_seconds: float = Field(ge=0)
    eviction_idle_seconds: float | None = Field(default=None, ge=0)
    peer_ip: str
    transport: Literal["cleartext", "tls-psk"]


class ClientSnapshot(ContractModel):
    id: int = Field(ge=1)
    remote_addr: str
    path: str
    connected_at: float
    bytes_sent: int = Field(ge=0)
    chunks_sent: int = Field(ge=0)
    batches_sent: int = Field(ge=0)
    queue_drops: int = Field(ge=0)
    queue_depth: int = Field(ge=0)
    last_write_at: float | None


class SourceSnapshot(ContractModel):
    packets: int = Field(ge=0)
    lost: int = Field(ge=0)
    concealed: int = Field(ge=0)
    late: int = Field(ge=0)
    reordered: int = Field(ge=0)
    duplicate: int = Field(ge=0)
    underruns: int = Field(ge=0)
    overflows: int = Field(ge=0)
    buffered_packets: int = Field(ge=0)
    playout_buffer_packets: int = Field(ge=1)
    max_buffered_packets: int = Field(ge=1)
    max_outage_silence_packets: int = Field(ge=1)
    bytes: int = Field(ge=0)
    frames: int = Field(ge=0)
    played_frames: int = Field(ge=0)
    rate: int = Field(gt=0)
    packet_frames: int | None = Field(default=None, ge=1)
    playout_seq: int | None = Field(default=None, ge=0)
    last_seq: int | None = Field(default=None, ge=0)
    highest_seq: int | None = Field(default=None, ge=0)
    last_packet_at: float | None
    last_playout_at: float | None
    buffer_ready_at: float | None
    started_at: float
    tcp_connections: int = Field(ge=0)
    tcp_disconnects: int = Field(ge=0)
    tcp_errors: int = Field(ge=0)
    uptime_seconds: float = Field(ge=0)
    clients: int = Field(ge=0)
    client_buffer_chunks: int = Field(ge=1)
    client_queue_drops: int = Field(ge=0)
    slow_clients: int = Field(ge=0)
    client_streams: list[ClientSnapshot]
    levels: LevelSnapshot
    lifecycle: SourceLifecycle


class TransportSnapshot(ContractModel):
    contract_version: Literal[1]
    mode: Literal["cleartext", "tls-psk"]
    configurable: bool
    port: int = Field(ge=1, le=65535)
    key_ids: list[str]
    auth_successes: int = Field(ge=0)
    auth_failures: int = Field(ge=0)


class BridgeStatus(ContractModel):
    bridge_version: str
    api_token_configured: bool
    sources: dict[str, SourceSnapshot]
    transport: TransportSnapshot


class UnlockResult(ContractModel):
    ok: Literal[True]


class TransportModeRequest(ContractModel):
    mode: Literal["cleartext", "tls-psk"]


class TransportKeyRequest(ContractModel):
    psk: str = Field(pattern=r"^[0-9a-f]{64}$")


class TransportKeyResult(ContractModel):
    key_id: str


class TransportKeyDeleteResult(ContractModel):
    deleted: str


class RecordingFormat(ContractModel):
    container: Literal["wav"]
    codec: Literal["pcm_s16le"]
    sample_rate: int = Field(gt=0)
    channels: int = Field(gt=0)
    bits_per_sample: int = Field(gt=0)
    bytes_per_second: int = Field(gt=0)


class RecordingLimits(ContractModel):
    max_duration_seconds: int = Field(gt=0)
    max_gap_seconds: int = Field(gt=0)
    min_free_bytes: int = Field(ge=0)
    queue_chunks: int = Field(gt=0)
    max_title_chars: int = Field(gt=0)


class RecordingCapabilities(ContractModel):
    enabled: bool
    format: RecordingFormat
    limits: RecordingLimits


class RecordingSnapshot(ContractModel):
    id: str
    title: str
    source: RecoverableSourceIdentity
    state: Literal["waiting-for-audio", "recording", "finalizing", "complete", "interrupted", "empty"]
    created_at: str
    audio_started_at: str | None
    finished_at: str | None
    frames: int = Field(ge=0)
    bytes: int = Field(ge=0)
    duration_seconds: float = Field(ge=0)
    gap_packets: int = Field(ge=0)
    duplicate_packets: int = Field(ge=0)
    error: str | None
    file_name: str | None


class RecordingStorage(ContractModel):
    free_bytes: int = Field(ge=0)


class RecordingList(ContractModel):
    active: list[RecordingSnapshot]
    saved: list[RecordingSnapshot]
    storage: RecordingStorage


class StartRecordingRequest(ContractModel):
    source: SourceIdentity
    title: str = Field(min_length=1, max_length=80)


class RecordingResult(ContractModel):
    recording: RecordingSnapshot


class DownloadTicket(ContractModel):
    url: str
    expires_in_seconds: int = Field(gt=0)


class DeleteRecordingResult(ContractModel):
    deleted: str
