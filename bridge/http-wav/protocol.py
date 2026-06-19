"""ESP32 StreamLine packet protocol — shared constants and parsing."""

from __future__ import annotations

import struct
from dataclasses import dataclass

HEADER = struct.Struct("<4sBBBBIIII")
MAGIC = b"ELI1"
VERSION = 1

DEFAULT_RATE = 48_000
DEFAULT_CHANNELS = 2
DEFAULT_BITS = 16
DEFAULT_FRAMES = 256


@dataclass(frozen=True)
class PcmFormat:
    """The one PCM format supported by an HTTP WAV bridge instance."""

    rate: int = DEFAULT_RATE
    channels: int = DEFAULT_CHANNELS
    bits: int = DEFAULT_BITS
    frames_per_packet: int = DEFAULT_FRAMES

    @property
    def payload_bytes(self) -> int:
        return self.frames_per_packet * self.channels * (self.bits // 8)


DEFAULT_FORMAT = PcmFormat()


def parse_packet(
    data: bytes,
    expected_format: PcmFormat = DEFAULT_FORMAT,
) -> tuple[int, int, int, bytes]:
    """Parse a StreamLine PCM packet, returning (seq, rate, frames, payload).

    Raises ValueError on any format mismatch.
    """
    if len(data) < HEADER.size:
        raise ValueError(f"short packet: {len(data)} bytes")

    seq, rate, frames, payload_bytes = parse_header(data[: HEADER.size], expected_format)

    payload = data[HEADER.size :]
    if len(payload) != payload_bytes:
        raise ValueError(f"payload length mismatch: header={payload_bytes} actual={len(payload)}")

    return seq, rate, frames, payload


def parse_header(
    header: bytes,
    expected_format: PcmFormat = DEFAULT_FORMAT,
) -> tuple[int, int, int, int]:
    """Parse a StreamLine packet header, returning (seq, rate, frames, payload_bytes).

    Raises ValueError on any format mismatch.
    """
    magic, version, header_size, channels, bits, seq, rate, frames, payload_bytes = _unpack_header(header)
    if magic != MAGIC:
        raise ValueError(f"bad magic: {magic!r}")
    if version != VERSION:
        raise ValueError(f"unsupported version: {version}")
    if header_size != HEADER.size:
        raise ValueError(f"bad header size: {header_size}")
    if (rate, channels, bits, frames) != (
        expected_format.rate,
        expected_format.channels,
        expected_format.bits,
        expected_format.frames_per_packet,
    ):
        raise ValueError(f"unsupported format: rate={rate} channels={channels} bits={bits} frames={frames}")
    if payload_bytes != expected_format.payload_bytes:
        raise ValueError(f"payload size does not match format: {payload_bytes} != {expected_format.payload_bytes}")

    return seq, rate, frames, payload_bytes


def _unpack_header(header: bytes) -> tuple[bytes, int, int, int, int, int, int, int, int]:
    if len(header) != HEADER.size:
        raise ValueError(f"bad header length: {len(header)} bytes")
    return HEADER.unpack(header)
