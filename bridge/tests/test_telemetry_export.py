"""Exercise response limits through Requests' native HTTP buffering boundary."""

from __future__ import annotations

import gzip
import io
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING
from unittest.mock import patch

import requests
from urllib3.response import HTTPResponse

from streamline_bridge.telemetry_export import ExportSession

if TYPE_CHECKING:
    from collections.abc import Iterator


@contextmanager
def collector(body: bytes, *, encoding: str = "identity", drip: bool = False, status: int = 200) -> Iterator[str]:
    stop = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_POST(self) -> None:
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Encoding", encoding)
            self.end_headers()
            try:
                if drip:
                    for byte in body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        if stop.wait(0.08):
                            break
                else:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1/traces"
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        worker.join()


class ExportResponseTests(unittest.TestCase):
    def test_redirect_with_location_is_closed_without_reading_any_body(self) -> None:
        class Body(io.BytesIO):
            reads = 0

            def __init__(self, payload: bytes, stalls: bool) -> None:
                super().__init__(payload)
                self.stalls = stalls

            def read(self, size: int | None = -1) -> bytes:
                self.reads += 1
                if self.stalls:
                    raise AssertionError("a redirect must not enter a stalled body read")
                return super().read(size)

            def read1(self, size: int | None = -1) -> bytes:
                return self.read(size)

        for status in (302, 307):
            for payload, encoding, stalls in (
                (b"x" * 65_536, "identity", False),
                (gzip.compress(b"x" * 1_000_000), "gzip", False),
                (b"x", "identity", True),
            ):
                body = Body(payload, stalls)
                response = requests.Response()
                response.status_code = status
                response.url = "http://collector.example/v1/traces"
                response.request = requests.Request("POST", response.url, data=b"trace").prepare()
                response.headers.update({"Location": "/elsewhere", "Content-Encoding": encoding})
                response.raw = HTTPResponse(body=body, headers=response.headers, preload_content=False)
                with (
                    self.subTest(status=status, encoding=encoding, stalls=stalls),
                    patch.object(requests.adapters.HTTPAdapter, "send", return_value=response) as transport,
                    ExportSession("") as session,
                ):
                    with self.assertRaises(requests.HTTPError):
                        session.post("http://collector.example/v1/traces", data=b"trace", timeout=0.5)
                    self.assertEqual(body.reads, 0)
                    self.assertTrue(body.closed)
                    self.assertEqual(transport.call_count, 1)

    def test_redirect_is_an_export_failure_including_without_location(self) -> None:
        for status in (302, 304):
            with (
                self.subTest(status=status),
                collector(b"", status=status) as endpoint,
                ExportSession("") as session,
                self.assertRaises(requests.HTTPError),
            ):
                session.post(endpoint, data=b"trace", timeout=0.5)

    def test_bounded_body_remains_available_to_native_exporter(self) -> None:
        with collector(b"ok") as endpoint, ExportSession("") as session:
            response = session.post(endpoint, data=b"trace", timeout=0.5)
            self.assertEqual(response.content, b"ok")
            self.assertEqual(response.text, "ok")
            self.assertEqual(response.status_code, 200)

    def test_oversized_response_is_rejected_before_eager_buffering(self) -> None:
        with (
            collector(b"x" * 4097) as endpoint,
            ExportSession("") as session,
            self.assertRaisesRegex(requests.RequestException, "exceeds"),
        ):
            session.post(endpoint, data=b"trace", timeout=0.5)

    def test_compression_cannot_expand_an_unbounded_response(self) -> None:
        with (
            collector(gzip.compress(b"x" * 1_000_000), encoding="gzip") as endpoint,
            ExportSession("") as session,
            self.assertRaisesRegex(requests.RequestException, "compressed"),
        ):
            session.post(endpoint, data=b"trace", timeout=0.5)

    def test_dripping_body_cannot_extend_the_response_read_budget(self) -> None:
        with (
            collector(b"x" * 32, drip=True) as endpoint,
            ExportSession("") as session,
            self.assertRaisesRegex(requests.Timeout, "deadline"),
        ):
            session.post(endpoint, data=b"trace", timeout=0.5)
