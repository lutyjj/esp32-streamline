"""Producer registry: one independent playout pipeline per source device.

Every producer — keyed by its IPv4 address — owns its own pipeline, so multiple
ESP32 devices feed one bridge without fighting over a single stream. HTTP
clients pick a stream with ``?source=<ip>``; a bare request resolves only when
it is unambiguous (see :meth:`SourceRegistry.select`).
"""

from __future__ import annotations

import contextlib
import ipaddress
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


class AudioPipeline(Protocol):
    """The pipeline surface the source layer drives; implemented by AudioHub."""

    def reset_source_session(self) -> None: ...

    def ingest(self, seq: int, payload: bytes) -> None: ...

    def snapshot(self) -> dict[str, object]: ...


class TcpSourceGate[H: AudioPipeline]:
    """Own the one TCP connection allowed to feed a pipeline.

    A device rebooting reconnects from the same address; the gate hands the
    pipeline to the newest connection and invalidates the replaced one by
    generation, so a lingering socket cannot inject stale packets.
    """

    def __init__(self, hub: H) -> None:
        self._hub = hub
        self._lock = threading.Lock()
        self._connection: socket.socket | None = None
        self._generation = 0

    def replace(self, conn: socket.socket) -> int:
        """Make conn the active source and close any replaced source socket."""
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
        """Ingest only if this connection is still the active source."""
        with self._lock:
            if generation != self._generation:
                return False
            self._hub.ingest(seq, payload)
            return True

    def is_active(self, generation: int) -> bool:
        with self._lock:
            return generation == self._generation

    def release(self, generation: int, conn: socket.socket) -> None:
        with self._lock:
            if generation == self._generation and conn is self._connection:
                self._connection = None


@dataclass(frozen=True)
class Source[H: AudioPipeline]:
    key: str
    hub: H
    gate: TcpSourceGate[H]


class SourceSelectionError(Exception):
    """A stream request that cannot resolve to a source, with its HTTP status."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# A pipeline created for a bare stream request before any producer connected.
# The first producer from a new address adopts it, so "add the stream URL to
# the player, then power the device" keeps working.
PENDING_KEY = "pending"


class SourceRegistry[H: AudioPipeline]:
    """Create, adopt, and look up per-producer pipelines.

    The factory owns pipeline construction (and starts its playout thread in
    production); the registry only decides which pipeline a producer or HTTP
    client gets. `max_sources` bounds memory on an open LAN; an allowlist
    pre-creates its pipelines so explicit stream URLs work before any device
    connects.
    """

    def __init__(
        self,
        hub_factory: Callable[[], H],
        max_sources: int,
        allowed: frozenset[str] = frozenset(),
    ) -> None:
        if max_sources < 1:
            raise ValueError("max_sources must be at least 1")
        if len(allowed) > max_sources:
            raise ValueError("max_sources is smaller than the source allowlist")
        self._hub_factory = hub_factory
        self._max_sources = max_sources
        self._allowed = allowed
        self._lock = threading.Lock()
        self._sources: dict[str, Source[H]] = {ip: self._create(ip) for ip in sorted(allowed)}

    def _create(self, key: str) -> Source[H]:
        hub = self._hub_factory()
        return Source(key=key, hub=hub, gate=TcpSourceGate(hub))

    def acquire(self, ip: str) -> Source[H] | None:
        """Return the pipeline for a producer address, or None at capacity.

        A known address keeps its pipeline across reconnects. A new address
        adopts the pending pipeline if one is waiting, otherwise gets a fresh
        one.
        """
        if self._allowed and ip not in self._allowed:
            return None
        with self._lock:
            existing = self._sources.get(ip)
            if existing is not None:
                return existing
            pending = self._sources.pop(PENDING_KEY, None)
            if pending is not None:
                adopted = Source(key=ip, hub=pending.hub, gate=pending.gate)
                self._sources[ip] = adopted
                return adopted
            if len(self._sources) >= self._max_sources:
                return None
            source = self._create(ip)
            self._sources[ip] = source
            return source

    def select(self, requested: str | None) -> Source[H]:
        """Resolve a stream request to a source, or raise SourceSelectionError.

        An explicit ``requested`` address gets its pipeline, created on demand
        so the stream URL works before the device connects. A bare request
        resolves to the only source, or to a pending pipeline when none exist
        yet; with several sources it demands an explicit choice.
        """
        with self._lock:
            if requested is not None:
                return self._select_explicit(requested)
            if not self._sources:
                pending = self._create(PENDING_KEY)
                self._sources[PENDING_KEY] = pending
                return pending
            if len(self._sources) == 1:
                return next(iter(self._sources.values()))
            available = ", ".join(sorted(self._sources))
            raise SourceSelectionError(
                409,
                f"multiple sources; request /streamline.wav?source=<ip> (available: {available})",
            )

    def _select_explicit(self, requested: str) -> Source[H]:
        try:
            ip = str(ipaddress.IPv4Address(requested))
        except ipaddress.AddressValueError:
            raise SourceSelectionError(400, "source must be an IPv4 address") from None
        if self._allowed and ip not in self._allowed:
            raise SourceSelectionError(404, f"unknown source {ip}")
        existing = self._sources.get(ip)
        if existing is not None:
            return existing
        if len(self._sources) >= self._max_sources:
            raise SourceSelectionError(503, "source limit reached")
        source = self._create(ip)
        self._sources[ip] = source
        return source

    def snapshot(self) -> dict[str, object]:
        """Per-source pipeline snapshots, keyed by producer address."""
        with self._lock:
            sources = dict(self._sources)
        return {key: source.hub.snapshot() for key, source in sorted(sources.items())}
