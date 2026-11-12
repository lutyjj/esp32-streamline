from __future__ import annotations

import os
import socket
import unittest
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

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


class ShutdownOrderTests(unittest.TestCase):
    def test_recordings_finalize_before_sendspin_publishers_disconnect(self) -> None:
        calls: list[str] = []
        recordings = MagicMock()
        recordings.shutdown.side_effect = lambda: calls.append("recordings")
        sendspin = MagicMock()
        sendspin.close.side_effect = lambda: calls.append("sendspin")
        args = parse_args(
            [
                "--recordings-dir",
                "/recordings",
                "--sendspin-server-url",
                "ws://192.0.2.30:8927/sendspin",
                "--sendspin-state-dir",
                "/data/sendspin",
            ]
        )

        with (
            patch.dict(os.environ, {"STREAMLINE_API_TOKEN": "a" * 16}),
            patch.object(bridge_server, "parse_args", return_value=args),
            patch.object(bridge_server, "TcpIngestServer", return_value=FakePcmServer()),
            patch.object(bridge_server, "RecordingStore"),
            patch.object(bridge_server, "RecordingService", return_value=recordings),
            patch.object(bridge_server, "SendspinService", return_value=sendspin),
            patch.object(uvicorn.Server, "run"),
        ):
            self.assertEqual(bridge_server.main(), 0)

        self.assertEqual(calls, ["recordings", "sendspin"])


class PublicUrlTests(unittest.TestCase):
    def test_advertised_address_is_normalized_without_guessing_ports(self) -> None:
        from streamline_bridge.options import validate_args

        args = validate_args(parse_args(["--public-url", "http://192.0.2.20:8099/audio/"]))
        self.assertEqual(args.public_url, "http://192.0.2.20:8099/audio")

    def test_credentials_and_non_http_addresses_are_rejected(self) -> None:
        from streamline_bridge.options import validate_args

        for value in (
            "javascript:alert(1)",
            "https://secret@example.com",
            "http://example.com?token=secret",
            "http://example.com/#fragment",
            "http://example.com:99999",
            "http://example.com/ bad",
            "https://home.example/api/hassio_ingress/secret",
            "http://example.com/" + "a" * 2048,
        ):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                validate_args(parse_args(["--public-url", value]))


class SendspinOptionTests(unittest.TestCase):
    def test_server_url_accepts_websocket_addresses_and_requires_state(self) -> None:
        from streamline_bridge.options import validate_args

        for value in ("ws://192.0.2.30:8927/sendspin", "wss://music.example/sendspin"):
            with self.subTest(value=value):
                args = validate_args(
                    parse_args(["--sendspin-server-url", value, "--sendspin-state-dir", "/data/sendspin"])
                )
                self.assertEqual(args.sendspin_server_url, value)
        with self.assertRaisesRegex(SystemExit, "requires --sendspin-state-dir"):
            validate_args(parse_args(["--sendspin-server-url", "ws://192.0.2.30:8927/sendspin"]))

    def test_server_url_rejects_other_schemes_credentials_and_queries(self) -> None:
        from streamline_bridge.options import validate_args

        for value in (
            "http://192.0.2.30:8927/sendspin",
            "ws://user:secret@192.0.2.30:8927/sendspin",
            "ws://192.0.2.30:8927/sendspin?token=secret",
            "ws:///sendspin",
            "ws://192.0.2.30:99999/sendspin",
        ):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                validate_args(parse_args(["--sendspin-server-url", value, "--sendspin-state-dir", "/data/sendspin"]))

    def test_publishing_requires_the_bridge_api_token(self) -> None:
        args = parse_args(
            ["--sendspin-server-url", "ws://192.0.2.30:8927/sendspin", "--sendspin-state-dir", "/data/sendspin"]
        )

        with (
            patch.dict(os.environ, {"STREAMLINE_API_TOKEN": ""}),
            patch.object(bridge_server, "parse_args", return_value=args),
            self.assertRaisesRegex(SystemExit, "STREAMLINE_API_TOKEN is required"),
        ):
            bridge_server.main()
