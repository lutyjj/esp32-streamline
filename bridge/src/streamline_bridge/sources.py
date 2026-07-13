"""Source admission, selection, connection ownership, and eviction lifecycle."""

from __future__ import annotations

import contextlib
import ipaddress
import re
import socket
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable


class AudioPipeline(Protocol):
    def reset_source_session(self) -> None: ...
    def ingest(self, seq: int, payload: bytes) -> None: ...
    def snapshot(self) -> dict[str, object]: ...
    def register_packet_tap(self, sink: Callable[[int, bytes], None]) -> int: ...
    def unregister_packet_tap(self, sink_id: int) -> None: ...


class TcpSourceGate[H: AudioPipeline]:
    """Own the sole TCP connection allowed to feed one source pipeline."""

    def __init__(self, hub: H) -> None:
        self._hub = hub
        self._lock = threading.Lock()
        self._connection: socket.socket | None = None
        self._generation = 0

    def replace(self, conn: socket.socket) -> int:
        with self._lock:
            previous = self._connection
            self._generation += 1
            generation = self._generation
            self._connection = conn
            self._hub.reset_source_session()
        if previous is not None:
            with contextlib.suppress(OSError):
                previous.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                previous.close()
        return generation

    def ingest(self, generation: int, seq: int, payload: bytes) -> bool:
        with self._lock:
            if generation != self._generation:
                return False
            self._hub.ingest(seq, payload)
            return True

    def is_active(self, generation: int) -> bool:
        with self._lock:
            return generation == self._generation

    def release(self, generation: int, conn: socket.socket) -> bool:
        """Release the current connection and report whether it was current."""
        with self._lock:
            if generation != self._generation or conn is not self._connection:
                return False
            self._connection = None
            return True


@dataclass
class Source[H: AudioPipeline]:
    key: str
    hub: H
    gate: TcpSourceGate[H]
    allowlisted: bool
    created_at: float
    disconnected_at: float
    connected: bool = False
    http_clients: int = 0
    recording_sessions: int = 0
    peer_ip: str = ""
    transport: str = "cleartext"


class SourceSelectionError(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class SourceAdmissionError(Exception):
    """A TCP producer the registry refuses to admit."""


PENDING_KEY = "pending"
TRANSPORT_KEY_ID = re.compile(r"^eli1-[0-9a-f]{32}$")


class SourceRegistry[H: AudioPipeline]:
    """Own bounded per-address source pipelines and their lifecycle state.

    Dynamic sources remain reusable for ``eviction_idle_seconds`` after a TCP
    disconnect. Allowlisted sources are permanent addressable slots. Pending
    bare-WAV requests use a dynamic slot until a producer adopts it.
    """

    def __init__(
        self,
        hub_factory: Callable[[], H],
        max_sources: int,
        allowed: frozenset[str] = frozenset(),
        eviction_idle_seconds: float = 300.0,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_sources < 1:
            raise ValueError("max_sources must be at least 1")
        if len(allowed) > max_sources:
            raise ValueError("max_sources is smaller than the source allowlist")
        if eviction_idle_seconds <= 0:
            raise ValueError("eviction_idle_seconds must be greater than 0")
        self._hub_factory = hub_factory
        self._max_sources = max_sources
        self._allowed = allowed
        self._eviction_idle_seconds = eviction_idle_seconds
        self._now = now
        self._lock = threading.Lock()
        self._sources = {ip: self._create(ip, True, ip, "cleartext") for ip in sorted(allowed)}

    def _create(self, key: str, allowlisted: bool, peer_ip: str = "", transport: str = "cleartext") -> Source[H]:
        created_at = self._now()
        hub = self._hub_factory()
        return Source(
            key, hub, TcpSourceGate(hub), allowlisted, created_at, created_at, peer_ip=peer_ip, transport=transport
        )

    def acquire(self, key: str, peer_ip: str | None = None, transport: str = "cleartext") -> Source[H]:
        peer = peer_ip or key
        if self._allowed and peer not in self._allowed:
            raise SourceAdmissionError(f"{peer} is not in --source-allow")
        with self._lock:
            self._evict_expired_locked()
            existing = self._sources.get(key)
            if existing is not None:
                existing.peer_ip = peer
                existing.transport = transport
                return existing
            placeholder = self._sources.pop(peer, None) if key != peer else None
            if placeholder is not None and placeholder.allowlisted and not placeholder.connected:
                placeholder.key = key
                placeholder.peer_ip = peer
                placeholder.transport = transport
                self._sources[key] = placeholder
                return placeholder
            pending = self._sources.pop(PENDING_KEY, None)
            if pending is not None:
                pending.key = key
                pending.peer_ip = peer
                pending.transport = transport
                self._sources[key] = pending
                return pending
            if len(self._sources) >= self._max_sources:
                raise SourceAdmissionError(f"source limit reached (--max-sources={self._max_sources})")
            source = self._create(key, False, peer, transport)
            self._sources[key] = source
            return source

    def connect(self, source: Source[H], conn: socket.socket) -> int:
        with self._lock:
            generation = source.gate.replace(conn)
            source.connected = True
        return generation

    def disconnect(self, source: Source[H], generation: int, conn: socket.socket) -> None:
        with self._lock:
            if source.gate.release(generation, conn):
                source.connected = False
                source.disconnected_at = self._now()

    def select(self, requested: str | None) -> Source[H]:
        with self._lock:
            self._evict_expired_locked()
            if requested is not None:
                return self._select_explicit_locked(requested)
            if not self._sources:
                pending = self._create(PENDING_KEY, False)
                self._sources[PENDING_KEY] = pending
                return pending
            if len(self._sources) == 1:
                return next(iter(self._sources.values()))
            available = ", ".join(sorted(self._sources))
            raise SourceSelectionError(
                HTTPStatus.CONFLICT,
                f"multiple sources; request /streamline.wav?source=<ip> (available: {available})",
            )

    def retain_http(self, source: Source[H]) -> None:
        with self._lock:
            source.http_clients += 1

    def release_http(self, source: Source[H]) -> None:
        with self._lock:
            source.http_clients = max(0, source.http_clients - 1)
            if source.http_clients == 0 and not source.connected:
                source.disconnected_at = self._now()

    def retain_recording(self, source: Source[H]) -> None:
        with self._lock:
            source.recording_sessions += 1

    def release_recording(self, source: Source[H]) -> None:
        with self._lock:
            source.recording_sessions = max(0, source.recording_sessions - 1)
            if source.recording_sessions == 0 and source.http_clients == 0 and not source.connected:
                source.disconnected_at = self._now()

    def snapshot(self) -> dict[str, dict[str, object]]:
        with self._lock:
            self._evict_expired_locked()
            sources = tuple(sorted(self._sources.items()))
            now = self._now()
            return {key: self._snapshot_source(source, now) for key, source in sources}

    def _select_explicit_locked(self, requested: str) -> Source[H]:
        try:
            key = str(ipaddress.IPv4Address(requested))
        except ipaddress.AddressValueError:
            if not TRANSPORT_KEY_ID.fullmatch(requested):
                raise SourceSelectionError(
                    HTTPStatus.BAD_REQUEST, "source must be an IPv4 address or PCM transport key id"
                ) from None
            key = requested
        source = self._sources.get(key)
        if source is None:
            raise SourceSelectionError(
                HTTPStatus.NOT_FOUND, f"unknown source {key}; connect the device or list it in --source-allow"
            )
        return source

    def _evict_expired_locked(self) -> None:
        now = self._now()
        for key, source in tuple(self._sources.items()):
            if source.allowlisted or source.connected or source.http_clients or source.recording_sessions:
                continue
            if now - source.disconnected_at >= self._eviction_idle_seconds:
                del self._sources[key]

    def _snapshot_source(self, source: Source[H], now: float) -> dict[str, object]:
        data = source.hub.snapshot()
        if source.key == PENDING_KEY:
            lifecycle = "pending"
        elif source.connected:
            lifecycle = "connected"
        elif source.http_clients:
            lifecycle = "http-selected"
        elif source.allowlisted:
            lifecycle = "allowlisted"
        else:
            lifecycle = "disconnected"
        data["lifecycle"] = {
            "state": lifecycle,
            "dynamic": not source.allowlisted,
            "http_clients": source.http_clients,
            "recording_sessions": source.recording_sessions,
            "idle_seconds": 0.0
            if source.connected or source.http_clients or source.recording_sessions
            else now - source.disconnected_at,
            "eviction_idle_seconds": self._eviction_idle_seconds if not source.allowlisted else None,
            "peer_ip": source.peer_ip,
            "transport": source.transport,
        }
        return data
