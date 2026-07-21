"""Source admission, selection, connection ownership, and eviction lifecycle."""

from __future__ import annotations

import contextlib
import socket
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Literal, Protocol

from streamline_bridge.source_identity import parse_source_identity

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable


class AudioPipeline(Protocol):
    def reset_source_session(self) -> None: ...
    def ingest(self, seq: int, payload: bytes) -> bool: ...
    def close(self) -> None: ...
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
            return self._hub.ingest(seq, payload)

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
    permanent: bool
    created_at: float
    disconnected_at: float
    connected: bool = False
    http_clients: int = 0
    recording_sessions: int = 0
    peer_ip: str = ""
    transport: str = "cleartext"
    admission: Literal["open", "allowlisted"] = "open"


class SourceSelectionError(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class SourceAdmissionError(Exception):
    """A TCP producer the registry refuses to admit."""


PENDING_KEY = "pending"


class SourceLease[H: AudioPipeline]:
    """Own one producer or consumer claim on a registry source."""

    def __init__(
        self,
        registry: SourceRegistry[H],
        source: Source[H],
        kind: Literal["producer", "http", "recording"],
        conn: socket.socket | None = None,
        generation: int | None = None,
    ) -> None:
        self._registry = registry
        self.source = source
        self.kind = kind
        self._conn = conn
        self._generation = generation
        self._closed = False

    @property
    def key(self) -> str:
        return self.source.key

    @property
    def hub(self) -> H:
        return self.source.hub

    def ingest(self, seq: int, payload: bytes) -> bool:
        if self.kind != "producer" or self._generation is None or self._closed:
            return False
        return self.source.gate.ingest(self._generation, seq, payload)

    def is_active(self) -> bool:
        return (
            self.kind == "producer"
            and self._generation is not None
            and not self._closed
            and self.source.gate.is_active(self._generation)
        )

    def close(self) -> None:
        self._registry._release(self)

    def __enter__(self) -> SourceLease[H]:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


class SourceRegistry[H: AudioPipeline]:
    """Own bounded source pipelines and their lifecycle state.

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

    def _create(self, key: str, permanent: bool, peer_ip: str = "", transport: str = "cleartext") -> Source[H]:
        created_at = self._now()
        hub = self._hub_factory()
        return Source(
            key,
            hub,
            TcpSourceGate(hub),
            permanent,
            created_at,
            created_at,
            peer_ip=peer_ip,
            transport=transport,
            admission="allowlisted" if self._allowed else "open",
        )

    def lease_producer(
        self,
        key: str,
        conn: socket.socket,
        *,
        peer_ip: str | None = None,
        transport: str = "cleartext",
    ) -> SourceLease[H]:
        """Atomically admit an identity and connect its producer socket."""
        peer = peer_ip or key
        with self._lock:
            evicted = self._evict_expired_locked()
            source = self._acquire_locked(key, peer, transport)
            generation = source.gate.replace(conn)
            source.connected = True
            lease = SourceLease(self, source, "producer", conn, generation)
        self._close_hubs(evicted)
        return lease

    def lease_http(self, requested: str | None) -> SourceLease[H]:
        return self._lease_consumer(requested, "http")

    def lease_recording(self, requested: str | None) -> SourceLease[H]:
        return self._lease_consumer(requested, "recording")

    def close(self) -> None:
        """Retire every source and stop its pipeline for process shutdown."""
        with self._lock:
            retired = tuple(self._sources.values())
            self._sources.clear()
        self._close_hubs(retired)

    def _lease_consumer(self, requested: str | None, kind: Literal["http", "recording"]) -> SourceLease[H]:
        with self._lock:
            evicted = self._evict_expired_locked()
            source = self._select_locked(requested)
            if kind == "http":
                source.http_clients += 1
            else:
                source.recording_sessions += 1
            lease = SourceLease(self, source, kind)
        self._close_hubs(evicted)
        return lease

    def _release(self, lease: SourceLease[H]) -> None:
        with self._lock:
            if lease._closed:
                return
            lease._closed = True
            source = lease.source
            if lease.kind == "producer":
                if (
                    lease._generation is not None
                    and lease._conn is not None
                    and source.gate.release(lease._generation, lease._conn)
                ):
                    source.connected = False
                    source.disconnected_at = self._now()
            elif lease.kind == "http":
                source.http_clients -= 1
            else:
                source.recording_sessions -= 1
            if not source.connected and not source.http_clients and not source.recording_sessions:
                source.disconnected_at = self._now()

    def snapshot(self) -> dict[str, dict[str, object]]:
        with self._lock:
            evicted = self._evict_expired_locked()
            sources = tuple(sorted(self._sources.items()))
            now = self._now()
            data = {key: self._snapshot_source(source, now) for key, source in sources}
        self._close_hubs(evicted)
        return data

    def _acquire_locked(self, key: str, peer: str, transport: str) -> Source[H]:
        if self._allowed and peer not in self._allowed:
            raise SourceAdmissionError(f"{peer} is not in --source-allow")
        try:
            canonical_key = parse_source_identity(key)
        except ValueError as exc:
            raise SourceAdmissionError(str(exc)) from exc
        existing = self._sources.get(canonical_key)
        if existing is not None:
            existing.peer_ip = peer
            existing.transport = transport
            existing.admission = "allowlisted" if self._allowed else "open"
            return existing
        reusable = self._reusable_locked(peer, at_capacity=len(self._sources) >= self._max_sources)
        if reusable is not None:
            old_key, source = reusable
            del self._sources[old_key]
            source.key = canonical_key
            source.permanent = canonical_key == peer and peer in self._allowed
            source.peer_ip = peer
            source.transport = transport
            source.admission = "allowlisted" if self._allowed else "open"
            self._sources[canonical_key] = source
            return source
        if len(self._sources) >= self._max_sources:
            raise SourceAdmissionError(f"source limit reached (--max-sources={self._max_sources})")
        source = self._create(canonical_key, canonical_key == peer and peer in self._allowed, peer, transport)
        self._sources[canonical_key] = source
        return source

    def _reusable_locked(self, peer: str, *, at_capacity: bool) -> tuple[str, Source[H]] | None:
        candidates = (
            peer,
            PENDING_KEY,
            *(candidate for candidate in self._sources if candidate not in {peer, PENDING_KEY}),
        )
        for candidate in candidates:
            source = self._sources.get(candidate)
            if source is None or source.connected or source.recording_sessions:
                continue
            if candidate == PENDING_KEY:
                return candidate, source
            if candidate == peer and source.permanent:
                if source.http_clients:
                    continue
                return candidate, source
            if not at_capacity:
                continue
            if source.http_clients:
                continue
            if candidate == peer or (not source.permanent and source.peer_ip == peer):
                return candidate, source
        return None

    def _select_locked(self, requested: str | None) -> Source[H]:
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
            f"multiple sources; request /streamline.wav?source=<source> (available: {available})",
        )

    def _select_explicit_locked(self, requested: str) -> Source[H]:
        try:
            key = parse_source_identity(requested)
        except ValueError as exc:
            raise SourceSelectionError(HTTPStatus.BAD_REQUEST, str(exc)) from None
        source = self._sources.get(key)
        if source is None:
            raise SourceSelectionError(
                HTTPStatus.NOT_FOUND, f"unknown source {key}; connect the device or list it in --source-allow"
            )
        return source

    def _evict_expired_locked(self) -> list[Source[H]]:
        """Drop expired sources; the caller closes their hubs outside the lock."""
        now = self._now()
        evicted: list[Source[H]] = []
        for key, source in tuple(self._sources.items()):
            if source.permanent or source.connected or source.http_clients or source.recording_sessions:
                continue
            if now - source.disconnected_at >= self._eviction_idle_seconds:
                del self._sources[key]
                evicted.append(source)
        return evicted

    @staticmethod
    def _close_hubs(sources: Iterable[Source[H]]) -> None:
        for source in sources:
            source.hub.close()

    def _snapshot_source(self, source: Source[H], now: float) -> dict[str, object]:
        data = source.hub.snapshot()
        if source.key == PENDING_KEY:
            lifecycle = "pending"
        elif source.connected:
            lifecycle = "connected"
        elif source.http_clients:
            lifecycle = "http-selected"
        elif source.permanent:
            lifecycle = "allowlisted"
        else:
            lifecycle = "disconnected"
        data["lifecycle"] = {
            "state": lifecycle,
            "dynamic": not source.permanent,
            "admission": source.admission,
            "http_clients": source.http_clients,
            "recording_sessions": source.recording_sessions,
            "idle_seconds": 0.0
            if source.connected or source.http_clients or source.recording_sessions
            else now - source.disconnected_at,
            "eviction_idle_seconds": self._eviction_idle_seconds if not source.permanent else None,
            "peer_ip": source.peer_ip,
            "transport": source.transport,
        }
        return data
