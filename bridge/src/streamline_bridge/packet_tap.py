"""Non-blocking observers of accepted source packets."""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)


class PacketSink(Protocol):
    """A packet consumer that returns immediately."""

    def __call__(self, sequence: int, payload: bytes) -> None: ...


class PacketTapFanout:
    """Publish accepted packets to independently owned non-blocking sinks."""

    def __init__(self, on_sink_error: Callable[[int, Exception], None] | None = None) -> None:
        self._lock = threading.Lock()
        self._sinks: dict[int, PacketSink] = {}
        self._next_id = 1
        self._on_sink_error = on_sink_error

    def register(self, sink: PacketSink) -> int:
        with self._lock:
            sink_id = self._next_id
            self._next_id += 1
            self._sinks[sink_id] = sink
            return sink_id

    def unregister(self, sink_id: int) -> None:
        with self._lock:
            self._sinks.pop(sink_id, None)

    def publish(self, sequence: int, payload: bytes) -> None:
        with self._lock:
            sinks = tuple(self._sinks.items())
        for sink_id, sink in sinks:
            try:
                sink(sequence, payload)
            except Exception as exc:
                logger.exception("packet tap %s failed", sink_id)
                self.unregister(sink_id)
                if self._on_sink_error is not None:
                    self._on_sink_error(sink_id, exc)
