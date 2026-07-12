"""HTTP WAV, status, and health adapter."""

from __future__ import annotations

import json
import logging
import queue
import re
import secrets
import struct
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from typing import TYPE_CHECKING
from urllib.parse import parse_qs, urlsplit

from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.recording_http import FileResponse, JsonResponse, RecordingHttpController
from streamline_bridge.sources import SourceRegistry, SourceSelectionError

if TYPE_CHECKING:
    import socket

    from streamline_bridge.pipeline import AudioPipeline
    from streamline_bridge.recording import RecordingService

logger = logging.getLogger(__name__)
HTTP_MAX_BATCH_CHUNKS = 64
HTTP_MAX_JSON_BODY_BYTES = 4096
DEFAULT_MAX_HTTP_CONNECTIONS = 32
DEFAULT_HTTP_REQUEST_TIMEOUT_SECONDS = 10.0
CONSOLE_PAGE = files("streamline_bridge").joinpath("console.html").read_bytes()
# Home Assistant ingress forwards requests with an X-Ingress-Path prefix the
# console must resolve its own requests against. Accept only a plain URL path so
# a spoofed header on the published port cannot inject markup into the page.
INGRESS_BASE_PATTERN = re.compile(r"(?:/[A-Za-z0-9._~-]+)*")


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Serve a fixed maximum of timeout-bound HTTP connections."""

    daemon_threads = True
    block_on_close = False

    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        max_connections: int = DEFAULT_MAX_HTTP_CONNECTIONS,
        request_timeout_seconds: float = DEFAULT_HTTP_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        if max_connections < 1 or request_timeout_seconds <= 0:
            raise ValueError("HTTP connection limits must be positive")
        self._connection_slots = threading.BoundedSemaphore(max_connections)
        self._request_timeout_seconds = request_timeout_seconds
        super().__init__(server_address, handler)

    def get_request(self) -> tuple[socket.socket, tuple[str, int]]:
        request, client_address = super().get_request()
        request.settimeout(self._request_timeout_seconds)
        return request, client_address

    def process_request(
        self, request: socket.socket | tuple[bytes, socket.socket], client_address: tuple[str, int]
    ) -> None:
        if not self._connection_slots.acquire(blocking=False):
            logger.warning("rejected HTTP connection from %s: connection limit reached", client_address[0])
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connection_slots.release()
            raise

    def process_request_thread(
        self, request: socket.socket | tuple[bytes, socket.socket], client_address: tuple[str, int]
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_slots.release()

    def handle_error(
        self, request: socket.socket | tuple[bytes, socket.socket], client_address: tuple[str, int]
    ) -> None:
        logger.debug("HTTP connection from %s ended with a socket error", client_address[0])


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


def collect_http_batch(client_queue: queue.Queue[bytes | None]) -> list[bytes] | None:
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
            return None
        chunks.append(chunk)
    return chunks


def make_handler(
    sources: SourceRegistry[AudioPipeline],
    bridge_version: str,
    recordings: RecordingService | None = None,
    recording_token: str | None = None,
) -> type[BaseHTTPRequestHandler]:
    """Create a handler class bound to one bridge source registry."""

    recording_http = RecordingHttpController(recordings, recording_token)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "StreamLine"
        sys_version = ""

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            if url.path == "/status":
                self._send_json({"bridge_version": bridge_version, "sources": sources.snapshot()})
            elif url.path in {"/", "/recordings", "/recordings/"}:
                self._send_recordings_page()
            elif url.path == "/health":
                self._send_text("ok\n")
            elif url.path == "/streamline.wav":
                self._stream_wav(url.query)
            else:
                self._dispatch_recording("GET", url.path, query=url.query)

        def do_POST(self) -> None:
            body = self._read_body()
            if body is None:
                self.close_connection = True
                self._send_json(
                    {"error": {"code": "request-too-large", "message": "Request bodies must not exceed 4096 bytes."}},
                    HTTPStatus(413),
                )
                return
            self._dispatch_recording("POST", urlsplit(self.path).path, body)

        def do_DELETE(self) -> None:
            self._dispatch_recording("DELETE", urlsplit(self.path).path)

        def log_message(self, fmt: str, *args: object) -> None:
            logger.info("%s - %s", self.address_string(), fmt % args)

        def _send_json(
            self,
            data: dict[str, object],
            status: HTTPStatus = HTTPStatus.OK,
            extra_headers: dict[str, str] | None = None,
        ) -> None:
            body = json.dumps(data, sort_keys=True).encode() + b"\n"
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self) -> bytes | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return None
            if not 0 <= length <= HTTP_MAX_JSON_BODY_BYTES:
                return None
            return self.rfile.read(length)

        def _dispatch_recording(self, method: str, path: str, body: bytes = b"", query: str = "") -> None:
            response = recording_http.handle(method, path, self.headers.get("Authorization"), body, query)
            if response is None:
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            elif isinstance(response, JsonResponse):
                self._send_json(response.data, response.status, response.headers)
            else:
                self._send_file(response)

        def _send_file(self, response: FileResponse) -> None:
            with response.source:
                try:
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(response.size))
                    self.send_header("Content-Disposition", f'attachment; filename="{response.name}"')
                    self.send_header("Cache-Control", "private, no-store")
                    self.end_headers()
                    while chunk := response.source.read(64 * 1024):
                        self.wfile.write(chunk)
                except OSError:
                    pass

        def _send_text(self, body_text: str) -> None:
            body = body_text.encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _ingress_base(self) -> str:
            base = self.headers.get("X-Ingress-Path", "")
            return base if INGRESS_BASE_PATTERN.fullmatch(base) else ""

        def _send_recordings_page(self) -> None:
            nonce = secrets.token_urlsafe(18)
            body = CONSOLE_PAGE.replace(b"__CSP_NONCE__", nonce.encode()).replace(
                b"__INGRESS_BASE__", self._ingress_base().encode()
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
            self.send_header(
                "Content-Security-Policy",
                f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
                "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",
            )
            self.end_headers()
            self.wfile.write(body)

        def _stream_wav(self, query: str) -> None:
            requested = parse_qs(query).get("source", [None])[0]
            try:
                source = sources.select(requested)
            except SourceSelectionError as exc:
                self._send_json({"error": exc.message}, exc.status)
                return
            sources.retain_http(source)
            stream = source.hub.register_client(self.client_address[0], self.path, self.connection)
            try:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(wav_header())
                self.wfile.flush()
                while (chunks := collect_http_batch(stream.queue)) is not None:
                    body = b"".join(chunks)
                    self.wfile.write(body)
                    self.wfile.flush()
                    source.hub.record_client_write(stream.stats.id, len(body), len(chunks))
            except OSError:
                pass
            finally:
                source.hub.unregister_client(stream.stats.id)
                sources.release_http(source)

    return Handler
