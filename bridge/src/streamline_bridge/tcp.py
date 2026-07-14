"""TCP framing and producer connection adapter."""

from __future__ import annotations

import contextlib
import logging
import socket
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, NoReturn, Protocol

from streamline_bridge.protocol import HEADER, parse_header
from streamline_bridge.sources import Source, SourceAdmissionError, SourceRegistry

if TYPE_CHECKING:
    from streamline_bridge.pipeline import AudioPipeline

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuthenticatedConnection:
    socket: socket.socket
    source_key: str
    transport: str


class ConnectionAuthenticator(Protocol):
    def authenticate(self, conn: socket.socket, addr: tuple[str, int]) -> AuthenticatedConnection: ...


class AuthenticatorSource(Protocol):
    """Supplies the authenticator matching the transport mode at accept time."""

    def producer_authenticator(self) -> ConnectionAuthenticator: ...


class CleartextAuthenticator:
    def authenticate(self, conn: socket.socket, addr: tuple[str, int]) -> AuthenticatedConnection:
        return AuthenticatedConnection(conn, addr[0], "cleartext")


class _FixedAuthenticatorSource:
    def __init__(self, authenticator: ConnectionAuthenticator) -> None:
        self._authenticator = authenticator

    def producer_authenticator(self) -> ConnectionAuthenticator:
        return self._authenticator


class _LiveConnections:
    """Track live producer sockets so a mode switch can drop them all."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sockets: set[socket.socket] = set()

    def add(self, sock: socket.socket) -> None:
        with self._lock:
            self._sockets.add(sock)

    def replace(self, old: socket.socket, new: socket.socket) -> None:
        with self._lock:
            self._sockets.discard(old)
            self._sockets.add(new)

    def discard(self, sock: socket.socket) -> None:
        with self._lock:
            self._sockets.discard(sock)

    def shutdown_all(self) -> None:
        with self._lock:
            live = tuple(self._sockets)
        for sock in live:
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)


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
        authenticators: AuthenticatorSource | None = None,
        connection_slots: threading.BoundedSemaphore | None = None,
    ) -> None:
        if max_connections < 1:
            raise ValueError("TCP connection limit must be positive")
        self._sources = sources
        self._bind = bind
        self._port = port
        self._idle_timeout_seconds = idle_timeout_seconds
        self._connection_slots = connection_slots or threading.BoundedSemaphore(max_connections)
        self._authenticators = authenticators or _FixedAuthenticatorSource(CleartextAuthenticator())
        self._live = _LiveConnections()

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
            threading.Thread(
                target=self._authenticate_and_receive,
                args=(conn, addr),
                daemon=True,
            ).start()
        except BaseException:
            conn.close()
            self._connection_slots.release()
            raise

    def close_producers(self) -> None:
        """Drop every live producer so the next connect renegotiates the mode."""
        self._live.shutdown_all()

    def _authenticate_and_receive(self, conn: socket.socket, addr: tuple[str, int]) -> None:
        self._live.add(conn)
        stream = conn
        try:
            conn.settimeout(self._idle_timeout_seconds)
            authenticated = self._authenticators.producer_authenticator().authenticate(conn, addr)
            stream = authenticated.socket
            self._live.replace(conn, stream)
            stream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            stream.settimeout(self._idle_timeout_seconds)
            try:
                source = self._sources.acquire(
                    authenticated.source_key,
                    peer_ip=addr[0],
                    transport=authenticated.transport,
                )
            except SourceAdmissionError as exc:
                logger.warning("rejected %s source: %s", authenticated.transport, exc)
                stream.close()
                return
            generation = self._sources.connect(source, stream)
            logger.info("source %s connected over %s", source.key, authenticated.transport)
            receive_source(self._sources, source, generation, stream, addr)
        except (OSError, ValueError) as exc:
            conn.close()
            logger.warning("rejected producer connection: %s", exc)
        finally:
            self._live.discard(stream)
            self._live.discard(conn)
            self._connection_slots.release()
