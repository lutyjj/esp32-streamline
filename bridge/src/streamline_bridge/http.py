"""HTTP WAV, status, and health adapter."""

from __future__ import annotations

import json
import logging
import queue
import struct
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from typing import TYPE_CHECKING
from urllib.parse import parse_qs, urlsplit

from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.sources import SourceRegistry, SourceSelectionError

if TYPE_CHECKING:
    from streamline_bridge.pipeline import AudioPipeline

logger = logging.getLogger(__name__)
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


def make_handler(sources: SourceRegistry[AudioPipeline], bridge_version: str) -> type[BaseHTTPRequestHandler]:
    """Create a handler class bound to one bridge source registry."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            if url.path in {"/", "/status"}:
                self._send_json({"bridge_version": bridge_version, "sources": sources.snapshot()})
            elif url.path == "/health":
                self._send_text("ok\n")
            elif url.path == "/streamline.wav":
                self._stream_wav(url.query)
            else:
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

        def log_message(self, fmt: str, *args: object) -> None:
            logger.info("%s - %s", self.address_string(), fmt % args)

        def _send_json(self, data: dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(data, sort_keys=True).encode() + b"\n"
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_text(self, body_text: str) -> None:
            body = body_text.encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
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
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                source.hub.unregister_client(stream.stats.id)
                sources.release_http(source)

    return Handler
