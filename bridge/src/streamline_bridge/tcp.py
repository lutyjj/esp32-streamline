"""TCP framing and producer connection adapter."""

from __future__ import annotations

import contextlib
import logging
import socket
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from streamline_bridge.protocol import HEADER, parse_header
from streamline_bridge.sources import SourceAdmissionError, SourceLease, SourceRegistry

if TYPE_CHECKING:
    from collections.abc import Callable

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
    """Track live producer sockets and their authenticated identities.

    A mode switch drops every socket; a key mutation drops only the sockets
    that authenticated with that key.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sockets: dict[socket.socket, AuthenticatedConnection | None] = {}

    def add(self, sock: socket.socket) -> None:
        with self._lock:
            self._sockets[sock] = None

    def replace(self, old: socket.socket, authenticated: AuthenticatedConnection) -> None:
        with self._lock:
            self._sockets.pop(old, None)
            self._sockets[authenticated.socket] = authenticated

    def discard(self, sock: socket.socket) -> None:
        with self._lock:
            self._sockets.pop(sock, None)

    def shutdown_matching(self, source_key: str | None) -> None:
        """Shut down every socket, or only TLS sockets holding ``source_key``."""
        with self._lock:
            live = tuple(
                sock
                for sock, authenticated in self._sockets.items()
                if source_key is None
                or (
                    authenticated is not None
                    and authenticated.transport == "tls-psk"
                    and authenticated.source_key == source_key
                )
            )
        for sock in live:
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)


def recv_exact(conn: socket.socket, size: int, *, allow_eof: bool = False) -> bytes | None:
    """Read a complete frame portion, distinguishing clean EOF from truncation."""
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = conn.recv(remaining)
        if not chunk:
            received = size - remaining
            if allow_eof and received == 0:
                return None
            raise ValueError(f"truncated frame: received {received} of {size} bytes")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def receive_source(
    lease: SourceLease[AudioPipeline],
    conn: socket.socket,
    addr: tuple[str, int],
) -> None:
    """Receive framed packets until EOF, timeout, malformed input, or replacement."""
    source = lease.source
    with conn:
        source.hub.note_tcp_connect()
        try:
            while True:
                header = recv_exact(conn, HEADER.size, allow_eof=True)
                if header is None:
                    return
                try:
                    seq, _, _, payload_bytes = parse_header(header)
                except ValueError as exc:
                    raise ValueError(f"bad header from {addr[0]}:{addr[1]}: {exc}") from exc
                payload = recv_exact(conn, payload_bytes)
                if payload is None or not lease.ingest(seq, payload):
                    return
        except (OSError, ValueError) as exc:
            if lease.is_active():
                source.hub.note_tcp_error()
                logger.warning("tcp drop from %s:%s: %s", addr[0], addr[1], exc)
        finally:
            lease.close()
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
        listener_factory: Callable[[], socket.socket] | None = None,
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
        self._listener_factory = listener_factory or (lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM))
        self._state_lock = threading.Lock()
        self._listener: socket.socket | None = None
        self._listener_thread: threading.Thread | None = None
        self._workers: set[threading.Thread] = set()
        self._stopping = threading.Event()
        self._failure: Exception | None = None
        self._on_failure: Callable[[Exception], None] | None = None

    @property
    def healthy(self) -> bool:
        with self._state_lock:
            return self._listener is not None and self._failure is None and not self._stopping.is_set()

    @property
    def failure(self) -> Exception | None:
        with self._state_lock:
            return self._failure

    @property
    def bound_port(self) -> int:
        with self._state_lock:
            if self._listener is None:
                raise RuntimeError("TCP listener has not started")
            return int(self._listener.getsockname()[1])

    def start(self, on_failure: Callable[[Exception], None] | None = None) -> None:
        """Bind synchronously, then start the owned accept loop."""
        with self._state_lock:
            if self._stopping.is_set():
                raise RuntimeError("TCP listener is closed")
            if self._listener is not None or self._listener_thread is not None:
                raise RuntimeError("TCP listener already started")
        listener = self._listener_factory()
        try:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind((self._bind, self._port))
            listener.listen()
        except BaseException:
            listener.close()
            raise
        thread = threading.Thread(target=self._serve, name="pcm-listener", daemon=True)
        try:
            with self._state_lock:
                if self._stopping.is_set():
                    raise RuntimeError("TCP listener is closed")
                self._listener = listener
                self._listener_thread = thread
                self._on_failure = on_failure
                try:
                    thread.start()
                except BaseException:
                    self._listener = None
                    self._listener_thread = None
                    raise
        except BaseException:
            listener.close()
            raise
        logger.info("listening for ESP32 TCP on %s:%s", self._bind, self.bound_port)

    def _serve(self) -> None:
        with self._state_lock:
            listener = self._listener
        if listener is None:
            return
        try:
            while not self._stopping.is_set():
                conn, addr = listener.accept()
                try:
                    self.accept(conn, addr)
                except Exception:
                    with contextlib.suppress(OSError):
                        conn.close()
                    raise
        except Exception as exc:
            if not self._stopping.is_set():
                self._fail(exc)

    def _fail(self, exc: Exception) -> None:
        with self._state_lock:
            if self._stopping.is_set() or self._failure is not None:
                return
            self._failure = exc
            callback = self._on_failure
        logger.error("PCM listener failed: %s", exc)
        self.close_producers()
        if callback is not None:
            callback(exc)

    def accept(self, conn: socket.socket, addr: tuple[str, int]) -> None:
        if not self._connection_slots.acquire(blocking=False):
            logger.warning("rejected TCP source %s:%s: connection limit reached", addr[0], addr[1])
            conn.close()
            return
        rejected = False
        try:
            worker = threading.Thread(
                target=self._worker,
                args=(conn, addr),
                name=f"pcm-source-{addr[0]}:{addr[1]}",
                daemon=True,
            )
            with self._state_lock:
                if self._stopping.is_set():
                    rejected = True
                else:
                    self._workers.add(worker)
                    try:
                        worker.start()
                    except BaseException:
                        self._workers.discard(worker)
                        raise
        except BaseException:
            conn.close()
            self._connection_slots.release()
            raise
        if rejected:
            conn.close()
            self._connection_slots.release()

    def _worker(self, conn: socket.socket, addr: tuple[str, int]) -> None:
        try:
            self._authenticate_and_receive(conn, addr)
        finally:
            self._connection_slots.release()
            with self._state_lock:
                self._workers.discard(threading.current_thread())

    def close_producers(self, source_key: str | None = None) -> None:
        """Drop live producers: all of them, or only one key's TLS sessions."""
        self._live.shutdown_matching(source_key)

    def close(self) -> None:
        """Close the listener and producers, then join every owned worker."""
        self._stopping.set()
        with self._state_lock:
            listener = self._listener
            listener_thread = self._listener_thread
            self._listener = None
        if listener is not None:
            with contextlib.suppress(OSError):
                listener.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                listener.close()
        self.close_producers()
        if listener_thread is not None and listener_thread is not threading.current_thread():
            listener_thread.join()
        while True:
            with self._state_lock:
                workers = tuple(worker for worker in self._workers if worker is not threading.current_thread())
            if not workers:
                break
            for worker in workers:
                worker.join()

    def _authenticate_and_receive(self, conn: socket.socket, addr: tuple[str, int]) -> None:
        self._live.add(conn)
        stream = conn
        try:
            conn.settimeout(self._idle_timeout_seconds)
            authenticated = self._authenticators.producer_authenticator().authenticate(conn, addr)
            stream = authenticated.socket
            self._live.replace(conn, authenticated)
            stream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            stream.settimeout(self._idle_timeout_seconds)
            try:
                lease = self._sources.lease_producer(
                    authenticated.source_key,
                    stream,
                    peer_ip=addr[0],
                    transport=authenticated.transport,
                )
            except SourceAdmissionError as exc:
                logger.warning("rejected %s source: %s", authenticated.transport, exc)
                stream.close()
                return
            logger.info("source %s connected over %s", lease.key, authenticated.transport)
            receive_source(lease, stream, addr)
        except (OSError, ValueError) as exc:
            conn.close()
            logger.warning("rejected producer connection: %s", exc)
        finally:
            self._live.discard(stream)
            self._live.discard(conn)
