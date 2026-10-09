"""Packet ordering, loss concealment, and paced playout."""

from __future__ import annotations

import struct
import threading
import time
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Protocol

from streamline_bridge.adaptive_buffer import AdaptiveBuffer
from streamline_bridge.protocol import DEFAULT_FORMAT, DEFAULT_RATE, PcmFormat
from streamline_bridge.quality import QualityWindow

if TYPE_CHECKING:
    from collections.abc import Callable

MAX_UINT32 = 0xFFFFFFFF
UINT32_MOD = 0x100000000
# Admission headroom above the jitter target: a producer may burst up to this
# much audio beyond the playout buffer before the bridge disconnects it.
BUFFER_SLACK_SECONDS = 1.0


class Clock(Protocol):
    """Clock used by playout policy and its runtime worker."""

    def time(self) -> float: ...

    def monotonic(self) -> float: ...

    def sleep(self, seconds: float) -> None: ...


class SystemClock:
    def time(self) -> float:
        return time.time()

    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


@dataclass
class ReceiverStats:
    packets: int = 0
    missing_packets: int = 0
    silence_packets: int = 0
    late: int = 0
    reordered: int = 0
    duplicate: int = 0
    underruns: int = 0
    overflows: int = 0
    buffered_packets: int = 0
    playout_buffer_packets: int = 0
    applied_buffer_packets: int = 0
    min_playout_buffer_packets: int = 0
    max_playout_buffer_packets: int = 0
    buffer_expansion_packets: int = 0
    buffer_reduction_packets: int = 0
    max_buffered_packets: int = 0
    max_outage_silence_packets: int = 0
    bytes: int = 0
    frames: int = 0
    played_frames: int = 0
    rate: int = DEFAULT_RATE
    packet_frames: int | None = None
    playout_seq: int | None = None
    last_seq: int | None = None
    highest_seq: int | None = None
    last_packet_at: float | None = None
    last_playout_at: float | None = None
    buffer_ready_at: float | None = None
    started_at: float = 0.0
    tcp_connections: int = 0
    tcp_disconnects: int = 0
    tcp_errors: int = 0


def seq_distance(base: int, seq: int) -> int:
    """Return signed forward distance from base to seq in uint32 sequence space."""
    distance = (seq - base) & MAX_UINT32
    return distance - UINT32_MOD if distance >= UINT32_MOD // 2 else distance


def attenuate_pcm16(payload: bytes, max_steps: int, step: int) -> bytes:
    """Return little-endian signed 16-bit PCM with linear loss-conceal attenuation."""
    gain = max(0.0, 1.0 - (step / (max_steps + 1)))
    return b"".join(struct.pack("<h", round(sample[0] * gain)) for sample in struct.iter_unpack("<h", payload))


class PlayoutBuffer:
    """A thread-safe ordered PCM buffer with deterministic single-step playout."""

    def __init__(
        self,
        playout_buffer_seconds: float,
        max_repeat_conceal_packets: int,
        max_outage_silence_seconds: float,
        pcm_format: PcmFormat = DEFAULT_FORMAT,
        clock: Clock | None = None,
        max_playout_buffer_seconds: float = 3.0,
    ) -> None:
        self._format = pcm_format
        self._clock = clock or SystemClock()
        self._max_repeat_conceal_packets = max_repeat_conceal_packets
        self._packet_interval = pcm_format.frames_per_packet / pcm_format.rate
        self._adaptive = AdaptiveBuffer(
            max(1, round(playout_buffer_seconds / self._packet_interval)),
            max(1, round(max_playout_buffer_seconds / self._packet_interval)),
            self._packet_interval,
        )
        self._max_buffered_packets = self._adaptive.maximum + max(
            1, round(BUFFER_SLACK_SECONDS / self._packet_interval)
        )
        self._max_outage_silence_packets = max(1, round(max_outage_silence_seconds / self._packet_interval))
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._closed = False
        self._packets: dict[int, bytes] = {}
        self._last_payload: bytes | None = None
        self._last_payload_size = pcm_format.payload_bytes
        self._loss_run = 0
        self._outage_conceal_packets = 0
        self._quality = QualityWindow()
        self._arrival_seq: int | None = None
        self.stats = ReceiverStats(
            started_at=self._clock.time(),
            playout_buffer_packets=self._adaptive.target,
            applied_buffer_packets=self._adaptive.target,
            min_playout_buffer_packets=self._adaptive.minimum,
            max_playout_buffer_packets=self._adaptive.maximum,
            max_buffered_packets=self._max_buffered_packets,
            max_outage_silence_packets=self._max_outage_silence_packets,
        )

    @property
    def packet_interval(self) -> float:
        return self._packet_interval

    def wait_until_ready(self) -> None:
        self._ready.wait()

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def close(self) -> None:
        """Stop admitting and playing packets and wake a waiting worker."""
        with self._lock:
            self._closed = True
            self._packets.clear()
            self.stats.buffered_packets = 0
            self._ready.set()

    def ingest(self, seq: int, payload: bytes) -> bool:
        """Admit one packet; ``False`` demands the producer's disconnect."""
        with self._lock:
            if self._closed:
                return False
            self.stats.packets += 1
            self.stats.bytes += len(payload)
            self.stats.frames += self._format.frames_per_packet
            self.stats.packet_frames = self._format.frames_per_packet
            self.stats.last_seq = seq
            self.stats.last_packet_at = self._clock.time()
            advance = None if self._arrival_seq is None else seq_distance(self._arrival_seq, seq)
            self._adaptive.observe(advance, self._clock.monotonic())
            if advance is None or advance > 0:
                self._arrival_seq = seq
            if self.stats.playout_seq is not None and seq_distance(self.stats.playout_seq, seq) < 0:
                self.stats.late += 1
                self._quality.record("late_packets", self._clock.monotonic())
                self._adaptive.impair(self._clock.monotonic())
                return True
            if seq in self._packets:
                self.stats.duplicate += 1
                return True
            if len(self._packets) >= self._max_buffered_packets:
                self.stats.overflows += 1
                return False
            if self.stats.highest_seq is not None and seq_distance(self.stats.highest_seq, seq) < 0:
                self.stats.reordered += 1
            self._packets[seq] = payload
            self.stats.highest_seq = (
                seq
                if self.stats.highest_seq is None or seq_distance(self.stats.highest_seq, seq) > 0
                else self.stats.highest_seq
            )
            if self.stats.playout_seq is None:
                self.stats.playout_seq = seq
            self.stats.buffered_packets = len(self._packets)
            if len(self._packets) >= self._adaptive.target:
                if self.stats.buffer_ready_at is None:
                    self.stats.buffer_ready_at = self._clock.time()
                    self.stats.applied_buffer_packets = self._adaptive.target
                self._ready.set()
            return True

    def next_chunk(self) -> bytes | None:
        """Play buffered PCM or silence while buffering; only close ends output."""
        with self._lock:
            if self._closed:
                return None
            self.stats.played_frames += self._format.frames_per_packet
            self.stats.last_playout_at = self._clock.time()
            if not self._ready.is_set() or self.stats.playout_seq is None:
                return bytes(self._last_payload_size)
            seq = self.stats.playout_seq
            if self._packets.get(seq) == b"":
                if self.stats.applied_buffer_packets < self._adaptive.target:
                    self.stats.applied_buffer_packets += 1
                    self.stats.buffer_expansion_packets += 1
                    return bytes(self._last_payload_size)
                following = (seq + 1) & MAX_UINT32
                if self.stats.applied_buffer_packets > self._adaptive.target and self._packets.get(following) == b"":
                    del self._packets[seq]
                    seq = following
                    self.stats.applied_buffer_packets -= 1
                    self.stats.buffer_reduction_packets += 1
            payload = self._packets.pop(seq, None)
            if payload is None:
                self.stats.missing_packets += 1
                self._quality.record("missing_packets", self._clock.monotonic())
                self._adaptive.impair(self._clock.monotonic())
                self._loss_run += 1
                self._outage_conceal_packets += 1
                payload = self._conceal_payload()
            else:
                if payload:
                    self._quality.record("audio_packets", self._clock.monotonic())
                else:
                    self.stats.silence_packets += 1
                    self._quality.record("silence_packets", self._clock.monotonic())
                    payload = bytes(self._last_payload_size)
                self._loss_run = 0
                self._outage_conceal_packets = 0
                self._last_payload = payload
            self.stats.playout_seq = (seq + 1) & MAX_UINT32
            self.stats.buffered_packets = len(self._packets)
            if self._outage_conceal_packets > self._max_outage_silence_packets:
                self._clear_for_rebuffer()
                self.stats.underruns += 1
                self._quality.record("underruns", self._clock.monotonic())
            return payload

    def reset_source_session(self) -> None:
        with self._lock:
            self._clear_for_rebuffer()
            self._last_payload = None
            self.stats.last_seq = 0

    def note_tcp_connect(self) -> None:
        with self._lock:
            self.stats.tcp_connections += 1

    def note_tcp_disconnect(self) -> None:
        with self._lock:
            self.stats.tcp_disconnects += 1
            self._quality.record("disconnects", self._clock.monotonic())
            self._adaptive.impair(self._clock.monotonic())

    def note_tcp_error(self) -> None:
        with self._lock:
            self.stats.tcp_errors += 1

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            data = asdict(self.stats)
            data["buffered_packets"] = len(self._packets)
            data["playout_buffer_packets"] = self._adaptive.target
            data["quality"] = self._quality.snapshot(self._clock.monotonic())
        data["uptime_seconds"] = self._clock.time() - float(data["started_at"])
        return data

    def _clear_for_rebuffer(self) -> None:
        # Stored packets go too: sequence state resets, so packets kept across
        # a rebuffer could strand at offsets the new session never plays.
        self._packets.clear()
        self.stats.buffered_packets = 0
        if not self._closed:
            self._ready.clear()
        self.stats.playout_seq = None
        self.stats.highest_seq = None
        self._adaptive.reset_arrivals()
        self._arrival_seq = None
        self.stats.buffer_ready_at = None
        self._loss_run = 0
        self._outage_conceal_packets = 0

    def _conceal_payload(self) -> bytes:
        if self._last_payload is not None and self._loss_run <= self._max_repeat_conceal_packets:
            return attenuate_pcm16(self._last_payload, self._max_repeat_conceal_packets, self._loss_run)
        return bytes(self._last_payload_size)


class PlayoutWorker:
    """Drive a ``PlayoutBuffer`` at packet cadence and hand chunks to a sink."""

    def __init__(self, buffer: PlayoutBuffer, publish: Callable[[bytes], None], clock: Clock | None = None) -> None:
        self._buffer = buffer
        self._publish = publish
        self._clock = clock or SystemClock()

    def run(self) -> None:
        # Wait for the first buffered audio, then keep the HTTP audio clock
        # running through gated silence and later source-session resets.
        self._buffer.wait_until_ready()
        next_tick = self._clock.monotonic()
        while True:
            chunk = self._buffer.next_chunk()
            if chunk is None:
                return
            self._publish(chunk)
            next_tick += self._buffer.packet_interval
            delay = next_tick - self._clock.monotonic()
            if delay > 0:
                self._clock.sleep(delay)
            else:
                next_tick = self._clock.monotonic()
