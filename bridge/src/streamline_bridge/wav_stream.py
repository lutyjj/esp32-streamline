"""WAV framing, client batching, and response-owned PCM lifetimes."""

from __future__ import annotations

import queue
import struct
import threading
from typing import TYPE_CHECKING

from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat

if TYPE_CHECKING:
    from collections.abc import Iterator

    from streamline_bridge.fanout import ClientChunk
    from streamline_bridge.pipeline import AudioPipeline
    from streamline_bridge.sources import SourceLease

HTTP_MAX_BATCH_CHUNKS = 64


def wav_header(pcm_format: PcmFormat = DEFAULT_FORMAT) -> bytes:
    """Build a WAV header with an unknown-length PCM data chunk."""
    block_align = pcm_format.channels * pcm_format.bits // 8
    byte_rate = pcm_format.rate * block_align
    unknown_size = 0xFFFFFFFF
    return b"".join(
        (
            b"RIFF",
            struct.pack("<I", unknown_size),
            b"WAVE",
            b"fmt ",
            struct.pack(
                "<IHHIIHH", 16, 1, pcm_format.channels, pcm_format.rate, byte_rate, block_align, pcm_format.bits
            ),
            b"data",
            struct.pack("<I", unknown_size),
        )
    )


def collect_http_batch(client_queue: queue.Queue[ClientChunk | None]) -> list[ClientChunk] | None:
    first = client_queue.get()
    if first is None:
        return None
    chunks = [first]
    while len(chunks) < HTTP_MAX_BATCH_CHUNKS:
        try:
            chunk = client_queue.get_nowait()
        except queue.Empty:
            break
        if chunk is None:
            for pending in chunks:
                pending.end("client closed before submission")
            return None
        chunks.append(chunk)
    return chunks


class WavStream:
    """Own a client's queue and its in-flight ASGI batch until response close."""

    def __init__(self, lease: SourceLease[AudioPipeline], remote_addr: str, path: str) -> None:
        self._lease = lease
        self._stream = lease.hub.register_client(remote_addr, path)
        self._header = True
        self._pending: list[ClientChunk] = []
        self._closed = threading.Event()
        self._lock = threading.Lock()

    def __iter__(self) -> Iterator[bytes]:
        return self

    def __next__(self) -> bytes:
        if self._closed.is_set():
            raise StopIteration
        if self._header:
            self._header = False
            return wav_header()
        chunks = collect_http_batch(self._stream.queue)
        if chunks is None:
            raise StopIteration
        with self._lock:
            if self._closed.is_set():
                for chunk in chunks:
                    chunk.end("response closed before submission")
                raise StopIteration
            self._pending = chunks
        return b"".join(chunk.payload for chunk in chunks)

    def submitted(self) -> None:
        with self._lock:
            for chunk in self._pending:
                chunk.end()
            self._lease.hub.record_client_write(
                self._stream.stats.id, sum(len(chunk.payload) for chunk in self._pending), len(self._pending)
            )
            self._pending = []

    def close(self) -> None:
        with self._lock:
            if self._closed.is_set():
                return
            self._closed.set()
            for chunk in self._pending:
                chunk.end("response closed before submission")
            self._pending = []
            self._lease.hub.unregister_client(self._stream.stats.id)
            self._lease.close()
