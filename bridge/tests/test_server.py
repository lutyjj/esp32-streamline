from __future__ import annotations

import socket
import unittest
from typing import TYPE_CHECKING
from unittest.mock import patch

import uvicorn

import streamline_bridge.server as bridge_server
from streamline_bridge.options import parse_args

if TYPE_CHECKING:
    from collections.abc import Callable


class FakePcmServer:
    def __init__(self) -> None:
        self.healthy = True
        self.failure: Exception | None = None
        self.started = False
        self.closed = False
        self._on_failure: Callable[[Exception], None] = lambda _exc: None

    def start(self, on_failure: Callable[[Exception], None]) -> None:
        self.started = True
        self._on_failure = on_failure

    def fail(self) -> None:
        self.healthy = False
        self.failure = RuntimeError("listener failed")
        self._on_failure(self.failure)

    def close_producers(self, source_key: str | None = None) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class BridgeServerTests(unittest.TestCase):
    def test_required_pcm_bind_failure_exits_before_http_serving(self) -> None:
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        cases = (
            ("127.0.0.1", blocker.getsockname()[1]),
            ("::1", 0),
        )
        try:
            for bind, port in cases:
                with self.subTest(bind=bind, port=port):
                    args = parse_args(
                        [
                            "--tcp-bind",
                            bind,
                            "--tcp-port",
                            str(port or 39000),
                            "--http-bind",
                            "127.0.0.1",
                            "--http-port",
                            "8088",
                        ]
                    )
                    with (
                        patch.object(bridge_server, "parse_args", return_value=args),
                        patch.object(uvicorn.Server, "run") as run,
                    ):
                        result = bridge_server.main()

                    self.assertEqual(result, 1)
                    run.assert_not_called()
        finally:
            blocker.close()

    def test_fatal_pcm_listener_failure_stops_http_and_returns_failure(self) -> None:
        pcm = FakePcmServer()
        args = parse_args([])

        def run(server: uvicorn.Server) -> None:
            pcm.fail()
            self.assertTrue(server.should_exit)

        with (
            patch.object(bridge_server, "parse_args", return_value=args),
            patch.object(bridge_server, "TcpIngestServer", return_value=pcm),
            patch.object(uvicorn.Server, "run", autospec=True, side_effect=run),
        ):
            result = bridge_server.main()

        self.assertEqual(result, 1)
        self.assertTrue(pcm.closed)

    def test_http_limits_and_shutdown_deadline_preserve_the_public_contract(self) -> None:
        pcm = FakePcmServer()
        args = parse_args(["--max-http-connections", "1"])

        with (
            patch.object(bridge_server, "parse_args", return_value=args),
            patch.object(bridge_server, "TcpIngestServer", return_value=pcm),
            patch.object(uvicorn.Server, "run", autospec=True) as run,
        ):
            result = bridge_server.main()

        configured_server = run.call_args.args[0]
        self.assertEqual(result, 0)
        self.assertTrue(pcm.started)
        self.assertTrue(pcm.closed)
        self.assertEqual(configured_server.config.limit_concurrency, 2)
        self.assertEqual(
            configured_server.config.timeout_graceful_shutdown,
            bridge_server.HTTP_GRACEFUL_SHUTDOWN_SECONDS,
        )
