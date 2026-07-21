from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
import unittest
from typing import TYPE_CHECKING, cast

import uvicorn
from fastapi import HTTPException
from fastapi.testclient import TestClient

from streamline_bridge.http import make_app
from streamline_bridge.http_ingress import HttpIngressGuard, ProgressDeadlineH11Protocol
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import SourceRegistry

if TYPE_CHECKING:
    from collections.abc import Iterator

    from streamline_bridge.http_ingress import Message, Receive, Scope, Send

LIMIT = 64
DEADLINE = 0.5


class RecordingApp:
    """Inner ASGI app that records whether endpoint work started."""

    def __init__(self) -> None:
        self.reached = False
        self.body = b""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        while True:
            message = await receive()
            self.reached = True
            body = message.get("body", b"")
            assert isinstance(body, bytes)
            self.body += body
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def http_scope(headers: list[tuple[bytes, bytes]] | None = None) -> Scope:
    return cast(
        "Scope",
        {"type": "http", "method": "POST", "path": "/", "headers": headers or [], "client": ("192.0.2.9", 4000)},
    )


def body_receive(chunks: list[bytes]) -> Receive:
    queue = [{"type": "http.request", "body": chunk, "more_body": True} for chunk in chunks]
    if queue:
        queue[-1]["more_body"] = False

    async def receive() -> Message:
        return cast("Message", queue.pop(0))

    return receive


class SentResponse:
    def __init__(self) -> None:
        self.messages: list[Message] = []

    async def send(self, message: Message) -> None:
        self.messages.append(message)

    @property
    def status(self) -> int | None:
        for message in self.messages:
            if message["type"] == "http.response.start":
                return cast("int", message["status"])
        return None

    def header(self, name: bytes) -> bytes | None:
        for message in self.messages:
            if message["type"] == "http.response.start":
                for key, value in cast("list[tuple[bytes, bytes]]", message["headers"]):
                    if key == name:
                        return value
        return None


class IngressGuardBodyTests(unittest.TestCase):
    """The ceiling counts every chunk before any endpoint work."""

    def setUp(self) -> None:
        self.app = RecordingApp()
        self.guard = HttpIngressGuard(self.app, max_body_bytes=LIMIT, progress_deadline_seconds=DEADLINE)
        self.response = SentResponse()

    def run_guard(self, scope: Scope, receive: Receive) -> None:
        asyncio.run(self.guard(scope, receive, self.response.send))

    def test_declared_oversize_is_rejected_before_the_endpoint(self) -> None:
        scope = http_scope([(b"content-length", str(LIMIT + 1).encode())])
        self.run_guard(scope, body_receive([b"x"]))
        self.assertEqual(self.response.status, 413)
        self.assertEqual(self.response.header(b"connection"), b"close")
        self.assertFalse(self.app.reached, "an oversize declaration must not reach the endpoint")

    def assert_ceiling_crossing_raises_413(self, chunks: list[bytes]) -> None:
        # FastAPI re-raises an HTTPException from body reading untouched, so
        # the raise is the contract; the bare recording app has no handler.
        with self.assertRaises(HTTPException) as raised:
            self.run_guard(http_scope(), body_receive(chunks))
        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual((raised.exception.headers or {}).get("Connection"), "close")
        self.assertLess(len(self.app.body), sum(len(chunk) for chunk in chunks), "the oversize tail never arrives")

    def test_a_lying_declaration_is_caught_by_chunk_counting(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self.run_guard(http_scope([(b"content-length", b"8")]), body_receive([b"a" * LIMIT, b"b" * LIMIT]))
        self.assertEqual(raised.exception.status_code, 413)

    def test_chunked_bodies_without_a_length_meet_the_same_ceiling(self) -> None:
        self.assert_ceiling_crossing_raises_413([b"a" * LIMIT, b"b"])

    def test_exactly_the_ceiling_passes_and_one_more_byte_fails(self) -> None:
        self.run_guard(http_scope(), body_receive([b"a" * LIMIT]))
        self.assertEqual(self.response.status, 200)
        self.assertEqual(self.app.body, b"a" * LIMIT)

        self.setUp()
        self.assert_ceiling_crossing_raises_413([b"a" * (LIMIT + 1)])

    def test_invalid_declared_length_is_rejected(self) -> None:
        self.run_guard(http_scope([(b"content-length", b"not-a-number")]), body_receive([b"x"]))
        self.assertEqual(self.response.status, 413)

    def test_non_http_scopes_pass_through_untouched(self) -> None:
        async def run() -> None:
            scope = cast("Scope", {"type": "lifespan"})

            async def receive() -> Message:
                return cast("Message", {"type": "lifespan.startup"})

            passed: list[str] = []

            async def inner(scope: Scope, receive: Receive, send: Send) -> None:
                passed.append(cast("str", scope["type"]))

            guard = HttpIngressGuard(inner, max_body_bytes=LIMIT, progress_deadline_seconds=DEADLINE)
            await guard(scope, receive, self.response.send)
            assert passed == ["lifespan"]

        asyncio.run(run())


class IngressGuardWriteDeadlineTests(unittest.TestCase):
    def test_a_stalled_response_write_is_abandoned_at_the_deadline(self) -> None:
        async def run() -> None:
            async def stalled_send(_message: Message) -> None:
                await asyncio.Event().wait()

            async def stream(_scope: Scope, _receive: Receive, send: Send) -> None:
                await send({"type": "http.response.start", "status": 200, "headers": []})

            guard = HttpIngressGuard(stream, max_body_bytes=LIMIT, progress_deadline_seconds=0.05)
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                await guard(http_scope(), body_receive([]), stalled_send)
            assert time.monotonic() - started < 5.0

        asyncio.run(run())


class LiveServerTests(unittest.TestCase):
    """The real uvicorn stack closes stalled clients and recovers capacity."""

    DEADLINE_SECONDS = 1  # uvicorn's Config annotates timeout_keep_alive as int
    CONCURRENCY_SLOTS = 3

    def setUp(self) -> None:
        registry: SourceRegistry[AudioPipeline] = SourceRegistry(
            lambda: AudioPipeline(4, 0.001, 1, 1.0, start_worker=False), max_sources=2
        )
        app = make_app(registry, "test", progress_deadline_seconds=self.DEADLINE_SECONDS)
        self.server = uvicorn.Server(
            uvicorn.Config(
                app,
                host="127.0.0.1",
                port=0,
                log_config=None,
                limit_concurrency=self.CONCURRENCY_SLOTS + 1,
                timeout_keep_alive=self.DEADLINE_SECONDS,
                timeout_graceful_shutdown=5,
                http=ProgressDeadlineH11Protocol,
            )
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 10.0
        while not self.server.started:
            if time.monotonic() > deadline:
                raise AssertionError("uvicorn did not start")
            time.sleep(0.01)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]

    def tearDown(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10.0)
        self.assertFalse(self.thread.is_alive())

    def open_client(self) -> socket.socket:
        client = socket.create_connection(("127.0.0.1", self.port), timeout=10.0)
        self.addCleanup(client.close)
        return client

    def assert_closed_within_deadline(self, client: socket.socket) -> None:
        client.settimeout(self.DEADLINE_SECONDS * 4)
        self.assertEqual(client.recv(4096), b"", "the server closes the stalled connection")

    def test_a_stalled_header_read_is_closed_at_the_deadline(self) -> None:
        client = self.open_client()
        client.sendall(b"GET /health HT")  # never finished
        self.assert_closed_within_deadline(client)

    def test_a_stalled_chunked_body_is_closed_at_the_deadline(self) -> None:
        client = self.open_client()
        client.sendall(
            b"PUT /api/transport/mode HTTP/1.1\r\n"
            b"Host: bridge\r\n"
            b"Transfer-Encoding: chunked\r\n"
            b"Content-Type: application/json\r\n"
            b"\r\n"
            b"4\r\nab"  # a chunk that never completes
        )
        self.assert_closed_within_deadline(client)

    def test_an_oversized_chunked_body_is_rejected_with_413(self) -> None:
        client = self.open_client()
        chunk = b"x" * 1024
        head = (
            b"PUT /api/transport/mode HTTP/1.1\r\n"
            b"Host: bridge\r\n"
            b"Transfer-Encoding: chunked\r\n"
            b"Content-Type: application/json\r\n"
            b"\r\n"
        )
        client.sendall(head)
        try:
            for _ in range(8):  # 8 KiB across chunks, over the 4096 ceiling
                client.sendall(b"400\r\n" + chunk + b"\r\n")
                time.sleep(0.01)
        except OSError:
            pass  # the server may already have rejected and closed
        client.settimeout(self.DEADLINE_SECONDS * 4)
        response = b""
        try:
            while b"\r\n\r\n" not in response:
                data = client.recv(4096)
                if not data:
                    break
                response += data
        except OSError:
            pass
        self.assertIn(b" 413 ", response.split(b"\r\n", 1)[0] + b" ")
        self.assertIn(b"request-too-large", self.read_remainder(client, response))

    @staticmethod
    def read_remainder(client: socket.socket, buffered: bytes) -> bytes:
        try:
            while True:
                data = client.recv(4096)
                if not data:
                    return buffered
                buffered += data
        except OSError:
            return buffered

    def test_expired_clients_cannot_keep_health_unavailable(self) -> None:
        for _ in range(self.CONCURRENCY_SLOTS):
            self.open_client().sendall(b"GET /health HT")
        time.sleep(self.DEADLINE_SECONDS * 2.5)  # all stalled slots expire

        probe = self.open_client()
        probe.sendall(b"GET /health HTTP/1.1\r\nHost: bridge\r\nConnection: close\r\n\r\n")
        probe.settimeout(10.0)
        response = self.read_remainder(probe, b"")
        self.assertIn(b" 200 ", response.split(b"\r\n", 1)[0] + b" ")
        self.assertIn(b"ok", response)


class IngressContractTests(unittest.TestCase):
    """The FastAPI app keeps its 413 contract through the pure ASGI guard."""

    def setUp(self) -> None:
        registry: SourceRegistry[AudioPipeline] = SourceRegistry(
            lambda: AudioPipeline(4, 0.001, 1, 1.0, start_worker=False), max_sources=2
        )
        self.client = TestClient(make_app(registry, "test"))

    def test_declared_oversize_bodies_receive_the_stable_413_envelope(self) -> None:
        response = self.client.put(
            "/api/transport/mode",
            content=b"x" * 5000,
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["error"]["code"], "request-too-large")

    def test_chunked_oversize_bodies_receive_the_same_envelope(self) -> None:
        def chunks() -> Iterator[bytes]:
            for _ in range(3):
                yield b"x" * 2048  # 6 KiB total, no Content-Length

        response = self.client.put(
            "/api/transport/mode",
            content=chunks(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["error"]["code"], "request-too-large")
        self.assertEqual(response.headers.get("connection"), "close")

    def test_bodies_within_the_ceiling_still_reach_endpoints(self) -> None:
        response = self.client.put("/api/transport/mode", content=json.dumps({"mode": "tls-psk"}))
        self.assertEqual(response.status_code, 503, "the request passes the guard and fails on missing auth config")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
