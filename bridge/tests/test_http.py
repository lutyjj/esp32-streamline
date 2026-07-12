from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

from fastapi.testclient import TestClient

from streamline_bridge.http import make_app, stream_wav_body, wav_header
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.recording import RecordingService, RecordingStore
from streamline_bridge.recording_http import MAX_DOWNLOAD_TICKETS, RecordingHttpService
from streamline_bridge.sources import SourceRegistry


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


class HttpContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.client = TestClient(make_app(self.sources, "test"))

    def test_health_status_and_errors_have_stable_contracts(self) -> None:
        health = self.client.get("/health")
        status = self.client.get("/status")
        malformed = self.client.get("/streamline.wav?source=bridge.local")
        missing = self.client.get("/streamline.wav?source=192.0.2.10")

        self.assertEqual((health.status_code, health.text), (200, "ok\n"))
        self.assertEqual(status.json(), {"bridge_version": "test", "sources": {}})
        self.assertEqual(malformed.status_code, 400)
        self.assertIn("IPv4", malformed.json()["error"]["message"])
        self.assertEqual(missing.status_code, 404)
        self.assertIn("unknown source", missing.json()["error"]["message"])

    def test_status_exposes_validated_per_source_audio_levels(self) -> None:
        source = self.sources.acquire("192.0.2.10")
        source.hub.ingest(1, bytes.fromhex("10270000f0d80080"))

        response = self.client.get("/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["sources"]["192.0.2.10"]["levels"],
            {"peak_left": 10000, "peak_right": 32768, "rms_left": 10000, "rms_right": 23170},
        )

    def test_openapi_is_generated_from_runtime_routes_and_auth(self) -> None:
        document = self.client.get("/api/openapi.json").json()

        self.assertEqual(document["info"]["title"], "StreamLine bridge API")
        self.assertEqual(document["paths"]["/status"]["get"]["operationId"], "getBridgeStatus")
        self.assertEqual(document["paths"]["/api/recordings"]["post"]["operationId"], "startRecording")
        self.assertEqual(
            document["paths"]["/api/recordings"]["get"]["security"],
            [{"bearer_auth": []}],
        )
        self.assertNotIn("security", document["paths"]["/api/recordings/capabilities"]["get"])
        validation_responses = document["paths"]["/api/recordings"]["post"]["responses"]
        self.assertIn("400", validation_responses)
        self.assertNotIn("422", validation_responses)
        self.assertEqual(
            set(document["paths"]["/api/recordings"]["get"]["responses"]),
            {"200", "401", "503"},
        )

    def test_console_routes_inject_ingress_base_and_csp_nonce(self) -> None:
        root = self.client.get("/", headers={"X-Ingress-Path": "/api/hassio_ingress/abc-1_2"})
        alias = self.client.get("/recordings")
        spoofed = self.client.get("/", headers={"X-Ingress-Path": "<script>bad</script>"})

        self.assertIn("Bridge console", root.text)
        self.assertIn('content="/api/hassio_ingress/abc-1_2"', root.text)
        self.assertIn("StreamLine bridge", alias.text)
        self.assertIn('content=""', spoofed.text)
        csp = root.headers["Content-Security-Policy"]
        self.assertNotIn("unsafe-inline", csp)
        nonce = csp.split("script-src 'nonce-", 1)[1].split("'", 1)[0]
        self.assertIn(f'<script nonce="{nonce}"', root.text)

    def test_wav_stream_releases_client_lifecycle_when_consumer_closes(self) -> None:
        source = self.sources.acquire("192.0.2.10")
        body = stream_wav_body(self.sources, source, "192.0.2.20", "/streamline.wav")
        self.assertEqual(next(body), wav_header())
        source.hub.clients.publish(b"pcm")
        self.assertEqual(next(body), b"pcm")

        body.close()

        snapshot = self.sources.snapshot()["192.0.2.10"]
        lifecycle = cast("dict[str, object]", snapshot["lifecycle"])
        self.assertEqual(snapshot["clients"], 0)
        self.assertEqual(lifecycle["http_clients"], 0)


class RecordingApiTests(unittest.TestCase):
    token = "test-recording-token"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.source = self.sources.acquire("192.0.2.10")
        self.recordings = RecordingService(self.sources, RecordingStore(Path(self.temp.name)))
        self.client = TestClient(make_app(self.sources, "test", self.recordings, self.token))
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def tearDown(self) -> None:
        self.recordings.shutdown()
        self.temp.cleanup()

    def test_recording_api_requires_bearer_authentication(self) -> None:
        missing = self.client.get("/api/recordings")
        wrong = self.client.get("/api/recordings", headers={"Authorization": "Bearer wrong"})
        capabilities = self.client.get("/api/recordings/capabilities")

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(missing.json()["error"]["code"], "unauthorized")
        self.assertIn("Bearer", missing.headers["WWW-Authenticate"])
        self.assertTrue(capabilities.json()["enabled"])

    def test_api_records_downloads_and_deletes_end_to_end(self) -> None:
        started = self.client.post(
            "/api/recordings",
            headers=self.headers,
            json={"source": "192.0.2.10", "title": "Rare album"},
        )
        recording_id = started.json()["recording"]["id"]
        self.source.hub.ingest(4, bytes(DEFAULT_FORMAT.payload_bytes))
        stopped = self.client.post(f"/api/recordings/{recording_id}/stop", headers=self.headers)
        listed = self.client.get("/api/recordings", headers=self.headers)
        ticket = self.client.post(f"/api/recordings/{recording_id}/download-ticket", headers=self.headers)
        download = self.client.get(ticket.json()["url"])
        reused = self.client.get(ticket.json()["url"])
        deleted = self.client.delete(f"/api/recordings/{recording_id}", headers=self.headers)

        self.assertEqual(started.status_code, 201)
        self.assertEqual(stopped.json()["recording"]["state"], "complete")
        self.assertEqual(len(listed.json()["saved"]), 1)
        self.assertEqual(ticket.status_code, 201)
        self.assertEqual(download.content[:4], b"RIFF")
        self.assertEqual(reused.status_code, 401)
        self.assertEqual(deleted.json(), {"deleted": recording_id})

    def test_invalid_and_oversized_requests_name_the_problem(self) -> None:
        missing = self.client.post("/api/recordings", headers=self.headers, json={"title": "Album"})
        unknown = self.client.post(
            "/api/recordings",
            headers=self.headers,
            json={"source": "192.0.2.11", "title": "Album"},
        )
        oversized = self.client.post(
            "/api/recordings",
            headers={**self.headers, "Content-Type": "application/json"},
            content=json.dumps({"source": "192.0.2.10", "title": "x" * 5000}),
        )

        self.assertEqual(missing.status_code, 400)
        self.assertEqual(unknown.status_code, 400)
        self.assertIn("unknown source", unknown.json()["error"]["message"])
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(oversized.json()["error"]["code"], "request-too-large")

    def test_download_ticket_storage_is_bounded_and_one_use(self) -> None:
        started = self.client.post(
            "/api/recordings",
            headers=self.headers,
            json={"source": "192.0.2.10", "title": "Ticket bound"},
        )
        recording_id = started.json()["recording"]["id"]
        self.source.hub.ingest(1, bytes(DEFAULT_FORMAT.payload_bytes))
        self.client.post(f"/api/recordings/{recording_id}/stop", headers=self.headers)
        service = RecordingHttpService(self.recordings, self.token)
        urls = [service.issue_download(recording_id)["url"] for _ in range(MAX_DOWNLOAD_TICKETS + 1)]

        first = urlsplit(cast("str", urls[0]))
        last = urlsplit(cast("str", urls[-1]))
        with self.assertRaisesRegex(Exception, "new recording download"):
            service.open_download(recording_id, first.query.removeprefix("ticket="))
        opened = service.open_download(recording_id, last.query.removeprefix("ticket="))
        opened.source.close()
