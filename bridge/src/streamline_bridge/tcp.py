"""TCP framing and producer connection adapter."""

from __future__ import annotations

import logging
import socket
import threading
from typing import TYPE_CHECKING, NoReturn

from streamline_bridge.protocol import HEADER, parse_header
from streamline_bridge.sources import Source, SourceAdmissionError, SourceRegistry

if TYPE_CHECKING:
    from streamline_bridge.pipeline import AudioPipeline

logger = logging.getLogger(__name__)


def recv_exact(conn: socket.socket, size: int) -> bytes | None:
    """Read a complete frame portion, returning ``None`` for a clean EOF."""
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = conn.recv(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def receive_source(
    sources: SourceRegistry[AudioPipeline],
    source: Source[AudioPipeline],
    generation: int,
    conn: socket.socket,
    addr: tuple[str, int],
) -> None:
    """Receive framed packets until EOF, timeout, malformed input, or replacement."""
    with conn:
        source.hub.note_tcp_connect()
        try:
            while True:
                header = recv_exact(conn, HEADER.size)
                if header is None:
                    return
                try:
                    seq, _, _, payload_bytes = parse_header(header)
                except ValueError as exc:
                    raise ValueError(f"bad header from {addr[0]}:{addr[1]}: {exc}") from exc
                payload = recv_exact(conn, payload_bytes)
                if payload is None or not source.gate.ingest(generation, seq, payload):
                    return
        except (OSError, ValueError) as exc:
            if source.gate.is_active(generation):
                source.hub.note_tcp_error()
                logger.warning("tcp drop from %s:%s: %s", addr[0], addr[1], exc)
        finally:
            sources.disconnect(source, generation, conn)
            source.hub.note_tcp_disconnect()
            logger.info("source %s:%s disconnected", addr[0], addr[1])


class TcpIngestServer:
    """Accept TCP producers and attach each to its source lifecycle."""

    def __init__(
        self,
        sources: SourceRegistry[AudioPipeline],
        bind: str,
        port: int,
        idle_timeout_seconds: float,
        max_connections: int,
    ) -> None:
        if max_connections < 1:
            raise ValueError("TCP connection limit must be positive")
        self._sources = sources
        self._bind = bind
        self._port = port
        self._idle_timeout_seconds = idle_timeout_seconds
        self._connection_slots = threading.BoundedSemaphore(max_connections)

    def serve_forever(self) -> NoReturn:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind((self._bind, self._port))
            listener.listen()
            logger.info("listening for ESP32 TCP on %s:%s", self._bind, self._port)
            while True:
                conn, addr = listener.accept()
                self.accept(conn, addr)

    def accept(self, conn: socket.socket, addr: tuple[str, int]) -> None:
        if not self._connection_slots.acquire(blocking=False):
            logger.warning("rejected TCP source %s:%s: connection limit reached", addr[0], addr[1])
            conn.close()
            return
        try:
            source = self._sources.acquire(addr[0])
        except SourceAdmissionError as exc:
            logger.warning("rejected TCP source %s:%s: %s", addr[0], addr[1], exc)
            conn.close()
            self._connection_slots.release()
            return
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn.settimeout(self._idle_timeout_seconds)
        generation = self._sources.connect(source, conn)
        logger.info("source %s:%s connected", addr[0], addr[1])
        try:
            threading.Thread(
                target=self._receive_source,
                args=(source, generation, conn, addr),
                daemon=True,
            ).start()
        except BaseException:
            self._sources.disconnect(source, generation, conn)
            conn.close()
            self._connection_slots.release()
            raise

    def _receive_source(
        self,
        source: Source[AudioPipeline],
        generation: int,
        conn: socket.socket,
        addr: tuple[str, int],
    ) -> None:
        try:
            receive_source(self._sources, source, generation, conn, addr)
        finally:
            self._connection_slots.release()
