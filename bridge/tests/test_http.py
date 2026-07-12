from __future__ import annotations

import http.client
import json
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import cast

from streamline_bridge.http import make_handler, wav_header
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.recording import RecordingService, RecordingStore
from streamline_bridge.recording_http import JsonResponse, RecordingHttpController
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
        capabilities, _, capabilities_body = self.request("/api/recordings/capabilities")
        recordings_page, recordings_headers, recordings_body = self.request("/recordings")
        self.assertEqual((health, body), (200, b"ok\n"))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(json.loads(status_body), {"bridge_version": "test", "sources": {}})
        self.assertEqual(malformed, 400)
        self.assertIn("IPv4", malformed_body.decode())
        self.assertEqual(missing, 404)
        self.assertIn("unknown source", missing_body.decode())
        self.assertEqual(unknown, 404)
        self.assertEqual(capabilities, 200)
        self.assertFalse(json.loads(capabilities_body)["enabled"])
        self.assertEqual(recordings_page, 200)
        self.assertEqual(recordings_headers["Content-Type"], "text/html; charset=utf-8")
        self.assertIn(b"Lossless recordings", recordings_body)

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


class RecordingHttpTests(unittest.TestCase):
    token = "test-recording-token"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.source = self.sources.acquire("192.0.2.10")
        self.recordings = RecordingService(self.sources, RecordingStore(Path(self.temp.name)))
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), make_handler(self.sources, "test", self.recordings, self.token)
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.recordings.shutdown()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, object] | None = None,
        token: str | None = token,
    ) -> tuple[int, dict[str, str], bytes]:
        encoded = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=1)
        conn.request(method, path, body=encoded, headers=headers)
        response = conn.getresponse()
        response_body = response.read()
        response_headers = dict(response.getheaders())
        conn.close()
        return response.status, response_headers, response_body

    def test_recording_api_requires_the_bridge_token(self) -> None:
        unauthorized, headers, body = self.request("GET", "/api/recordings", token=None)
        wrong, _, _ = self.request("GET", "/api/recordings", token="wrong")

        self.assertEqual(unauthorized, 401)
        self.assertEqual(wrong, 401)
        self.assertIn("Bearer", headers["WWW-Authenticate"])
        self.assertEqual(json.loads(body)["error"]["code"], "unauthorized")
        raw_token = RecordingHttpController(self.recordings, self.token).handle("GET", "/api/recordings", self.token)
        self.assertIsInstance(raw_token, JsonResponse)
        self.assertEqual(cast("JsonResponse", raw_token).status, 401)

    def test_api_drives_record_download_and_delete_end_to_end(self) -> None:
        started_status, _, started_body = self.request(
            "POST", "/api/recordings", {"source": "192.0.2.10", "title": "Rare album"}
        )
        started = json.loads(started_body)["recording"]
        self.source.hub.ingest(4, bytes(DEFAULT_FORMAT.payload_bytes))
        stopped_status, _, stopped_body = self.request("POST", f"/api/recordings/{started['id']}/stop")
        listed_status, _, listed_body = self.request("GET", "/api/recordings")
        ticket_status, _, ticket_body = self.request("POST", f"/api/recordings/{started['id']}/download-ticket")
        ticket_url = json.loads(ticket_body)["url"]
        file_status, file_headers, file_body = self.request("GET", ticket_url, token=None)
        reused_ticket_status, _, _ = self.request("GET", ticket_url, token=None)
        deleted_status, _, _ = self.request("DELETE", f"/api/recordings/{started['id']}")
        missing_status, _, _ = self.request("GET", f"/api/recordings/{started['id']}/file")

        self.assertEqual(started_status, 201)
        self.assertEqual(json.loads(stopped_body)["recording"]["state"], "complete")
        self.assertEqual(stopped_status, 200)
        self.assertEqual(listed_status, 200)
        self.assertEqual(len(json.loads(listed_body)["saved"]), 1)
        self.assertEqual(ticket_status, 201)
        self.assertEqual(file_status, 200)
        self.assertEqual(file_headers["Content-Type"], "audio/wav")
        self.assertEqual(file_body[:4], b"RIFF")
        self.assertEqual(reused_ticket_status, 401)
        self.assertEqual(deleted_status, 200)
        self.assertEqual(missing_status, 404)

    def test_invalid_requests_name_the_correction(self) -> None:
        missing_field, _, missing_field_body = self.request("POST", "/api/recordings", {"title": "Album"})
        unknown_source, _, unknown_source_body = self.request(
            "POST", "/api/recordings", {"source": "192.0.2.11", "title": "Album"}
        )
        wrong_method, wrong_method_headers, _ = self.request("DELETE", "/api/recordings")

        self.assertEqual(missing_field, 400)
        self.assertIn("source and title", json.loads(missing_field_body)["error"]["message"])
        self.assertEqual(unknown_source, 400)
        self.assertIn("unknown source", json.loads(unknown_source_body)["error"]["message"])
        self.assertEqual(wrong_method, 405)
        self.assertEqual(wrong_method_headers["Allow"], "GET, POST")

    def test_oversized_request_is_rejected_before_json_parsing(self) -> None:
        status, _, body = self.request(
            "POST",
            "/api/recordings",
            {"source": "192.0.2.10", "title": "x" * 5000},
        )

        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)["error"]["code"], "request-too-large")
