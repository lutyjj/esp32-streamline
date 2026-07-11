from __future__ import annotations

import http.client
import json
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from typing import cast

from streamline_bridge.http import make_handler, wav_header
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import SourceRegistry


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


class HttpAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.sources, "test"))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path: str) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=1)
        conn.request("GET", path)
        response = conn.getresponse()
        body = response.read()
        headers = dict(response.getheaders())
        conn.close()
        return response.status, headers, body

    @staticmethod
    def lifecycle(snapshot: dict[str, object]) -> dict[str, object]:
        return cast("dict[str, object]", snapshot["lifecycle"])

    def test_wav_header_uses_declared_pcm_format(self) -> None:
        header = wav_header()
        self.assertEqual(header[:4], b"RIFF")
        self.assertEqual(header[8:12], b"WAVE")
        self.assertEqual(len(header), 44)

    def test_health_status_and_source_errors_have_stable_http_contracts(self) -> None:
        health, _, body = self.request("/health")
        status, headers, status_body = self.request("/status")
        malformed, _, malformed_body = self.request("/streamline.wav?source=bridge.local")
        missing, _, missing_body = self.request("/streamline.wav?source=192.0.2.10")
        unknown, _, _ = self.request("/missing")
        self.assertEqual((health, body), (200, b"ok\n"))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(json.loads(status_body), {"bridge_version": "test", "sources": {}})
        self.assertEqual(malformed, 400)
        self.assertIn("IPv4", malformed_body.decode())
        self.assertEqual(missing, 404)
        self.assertIn("unknown source", missing_body.decode())
        self.assertEqual(unknown, 404)

    def test_stream_cleanup_releases_http_source_lifecycle(self) -> None:
        source = self.sources.acquire("192.0.2.10")
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=1)
        conn.request("GET", "/streamline.wav?source=192.0.2.10")
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(44), wav_header())
        source.hub.clients.publish(b"x")
        self.assertEqual(response.read(1), b"x")
        response.close()
        conn.close()
        for _ in range(5):
            source.hub.clients.publish(b"x")
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            lifecycle = self.lifecycle(self.sources.snapshot()["192.0.2.10"])
            if lifecycle["http_clients"] == 0:
                break
            time.sleep(0.01)
        self.assertEqual(self.lifecycle(self.sources.snapshot()["192.0.2.10"])["http_clients"], 0)
