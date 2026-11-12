"""HTTP client queues for one playout pipeline."""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

    from streamline_bridge.packet_tracing import AudioChunk, TimedSpan


@dataclass
class ClientStats:
    id: int
    remote_addr: str
    path: str
    connected_at: float
    bytes_sent: int = 0
    chunks_sent: int = 0
    batches_sent: int = 0
    queue_drops: int = 0
    queue_depth: int = 0
    last_write_at: float | None = None


@dataclass
class ClientChunk:
    payload: bytes
    span: TimedSpan | None = None

    def end(self, error: str | None = None) -> None:
        if self.span is not None:
            self.span.end(error)


@dataclass
class ClientStream:
    stats: ClientStats
    queue: queue.Queue[ClientChunk | None]


class ClientFanout:
    """Fan out playout chunks and evict clients that cannot consume them."""

    def __init__(self, max_client_chunks: int, now: Callable[[], float] = time.time) -> None:
        self._max_client_chunks = max_client_chunks
        self._now = now
        self._lock = threading.Lock()
        self._clients: dict[int, ClientStream] = {}
        self._next_client_id = 1
        self._queue_drops = 0
        self._slow_clients = 0

    def register(self, remote_addr: str, path: str) -> ClientStream:
        with self._lock:
            client_id = self._next_client_id
            self._next_client_id += 1
            stream = ClientStream(
                ClientStats(client_id, remote_addr, path, self._now()),
                queue.Queue(self._max_client_chunks),
            )
            self._clients[client_id] = stream
            return stream

    def unregister(self, client_id: int) -> None:
        with self._lock:
            if stream := self._clients.pop(client_id, None):
                _drain(stream.queue)
                stream.queue.put_nowait(None)

    def close(self) -> None:
        """End every client stream without counting it as a slow-client drop."""
        with self._lock:
            clients = tuple(self._clients.values())
            self._clients.clear()
            for stream in clients:
                _drain(stream.queue)
                stream.queue.put_nowait(None)

    def publish(self, chunk: AudioChunk) -> None:
        with self._lock:
            for stream in tuple(self._clients.values()):
                if stream.queue.full():
                    self._evict(stream)
                    continue
                delivery = ClientChunk(chunk.payload, chunk.context.delivery() if chunk.context else None)
                stream.queue.put_nowait(delivery)
                stream.stats.queue_depth = stream.queue.qsize()

    def record_write(self, client_id: int, byte_count: int, chunk_count: int) -> None:
        with self._lock:
            stream = self._clients.get(client_id)
            if stream is None:
                return
            stream.stats.bytes_sent += byte_count
            stream.stats.chunks_sent += chunk_count
            stream.stats.batches_sent += 1
            stream.stats.queue_depth = stream.queue.qsize()
            stream.stats.last_write_at = self._now()

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "clients": len(self._clients),
                "client_buffer_chunks": self._max_client_chunks,
                "client_queue_drops": self._queue_drops,
                "slow_clients": self._slow_clients,
                "client_streams": [asdict(stream.stats) for stream in self._clients.values()],
            }

    def _evict(self, stream: ClientStream) -> None:
        self._clients.pop(stream.stats.id)
        stream.stats.queue_drops += 1
        stream.stats.queue_depth = stream.queue.qsize()
        self._queue_drops += 1
        self._slow_clients += 1
        _drain(stream.queue)
        stream.queue.put_nowait(None)


def _drain(client_queue: queue.Queue[ClientChunk | None]) -> None:
    while True:
        try:
            if chunk := client_queue.get_nowait():
                chunk.end("client closed before submission")
        except queue.Empty:
            break
