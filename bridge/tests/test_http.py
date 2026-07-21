from __future__ import annotations

import json
import socket
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
from streamline_bridge.sources import Source, SourceRegistry
from streamline_bridge.transport import TlsPskAuthenticator, TransportControl, TransportStateStore


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


class SourceTestCase(unittest.TestCase):
    sources: SourceRegistry[AudioPipeline]

    def connect_source(
        self,
        key: str,
        *,
        peer_ip: str | None = None,
        transport: str = "cleartext",
    ) -> Source[AudioPipeline]:
        server, peer = socket.socketpair()
        lease = self.sources.lease_producer(key, server, peer_ip=peer_ip, transport=transport)
        self.addCleanup(peer.close)
        self.addCleanup(server.close)
        self.addCleanup(lease.close)
        return lease.source


class HttpContractTests(SourceTestCase):
    def setUp(self) -> None:
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.client = TestClient(make_app(self.sources, "test"))

    def test_health_status_and_errors_have_stable_contracts(self) -> None:
        health = self.client.get("/health")
        status = self.client.get("/status")
        malformed = self.client.get("/streamline.wav?source=bridge.local")
        missing = self.client.get("/streamline.wav?source=192.0.2.10")

        self.assertEqual((health.status_code, health.text), (200, "ok\n"))
        self.assertEqual(status.json()["bridge_version"], "test")
        self.assertFalse(status.json()["api_token_configured"])
        self.assertEqual(status.json()["sources"], {})
        self.assertEqual(
            status.json()["transport"],
            {
                "contract_version": 1,
                "mode": "cleartext",
                "configurable": False,
                "port": 39000,
                "key_ids": [],
                "auth_successes": 0,
                "auth_failures": 0,
            },
        )
        self.assertEqual(malformed.status_code, 400)
        self.assertIn("IPv4", malformed.json()["error"]["message"])
        self.assertEqual(missing.status_code, 404)
        self.assertIn("unknown source", missing.json()["error"]["message"])

    def test_health_fails_when_the_required_pcm_listener_is_unavailable(self) -> None:
        client = TestClient(make_app(self.sources, "test", healthy=lambda: False))

        response = client.get("/health")

        self.assertEqual((response.status_code, response.text), (503, "unhealthy\n"))

    def test_status_exposes_validated_per_source_audio_levels(self) -> None:
        source = self.connect_source("192.0.2.10")
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
        self.assertEqual(document["paths"]["/api/transport/keys/{key_id}"]["put"]["operationId"], "putTransportKey")
        self.assertEqual(document["paths"]["/api/unlock"]["post"]["operationId"], "unlockBridge")
        self.assertEqual(document["paths"]["/api/transport/mode"]["put"]["operationId"], "setTransportMode")
        self.assertEqual(
            document["paths"]["/api/transport/mode"]["put"]["security"],
            [{"bearer_auth": []}],
        )
        self.assertEqual(
            document["paths"]["/api/recordings"]["get"]["security"],
            [{"bearer_auth": []}],
        )
        self.assertEqual(
            document["paths"]["/api/recordings/{recording_id}/file"]["get"]["security"],
            [{"bearer_auth": []}, {"recording_ticket": []}],
        )
        self.assertNotIn("security", document["paths"]["/api/recordings/capabilities"]["get"])
        validation_responses = document["paths"]["/api/recordings"]["post"]["responses"]
        self.assertIn("400", validation_responses)
        self.assertNotIn("422", validation_responses)
        source_alternatives = [
            {"type": "string", "format": "ipv4"},
            {"type": "string", "pattern": r"^eli1-[0-9a-f]{32}$"},
        ]
        source_identity = {
            "oneOf": source_alternatives,
            "title": "Source",
        }
        self.assertEqual(
            document["components"]["schemas"]["StartRecordingRequest"]["properties"]["source"],
            source_identity,
        )
        self.assertEqual(
            document["components"]["schemas"]["RecordingSnapshot"]["properties"]["source"],
            {
                "oneOf": [
                    *source_alternatives,
                    {"type": "string", "const": "unknown"},
                ],
                "title": "Source",
            },
        )
        self.assertEqual(
            document["paths"]["/streamline.wav"]["get"]["parameters"][0]["schema"],
            {
                "anyOf": [
                    {"oneOf": source_alternatives},
                    {"type": "null"},
                ],
                "title": "Source",
            },
        )
        expected_responses = {
            ("/status", "get"): {"200"},
            ("/health", "get"): {"200", "503"},
            ("/api/transport", "get"): {"200"},
            ("/api/unlock", "post"): {"200", "401", "503"},
            ("/api/transport/mode", "put"): {"200", "400", "401", "413", "503"},
            ("/api/transport/keys/{key_id}", "put"): {"201", "400", "401", "409", "413", "503"},
            ("/api/transport/keys/{key_id}", "delete"): {"200", "400", "401", "404", "503"},
            ("/streamline.wav", "get"): {"200", "400", "404", "409"},
            ("/api/recordings/capabilities", "get"): {"200"},
            ("/api/recordings", "get"): {"200", "401", "503"},
            ("/api/recordings", "post"): {"201", "400", "401", "409", "413", "503", "507"},
            ("/api/recordings/{recording_id}/stop", "post"): {"200", "400", "401", "409", "503"},
            ("/api/recordings/{recording_id}/download-ticket", "post"): {
                "201",
                "400",
                "401",
                "404",
                "503",
            },
            ("/api/recordings/{recording_id}/file", "get"): {"200", "400", "401", "404", "503"},
            ("/api/recordings/{recording_id}", "delete"): {"200", "400", "401", "404", "409", "503"},
        }
        actual_responses = {
            (path, method): set(operation["responses"])
            for path, path_item in document["paths"].items()
            for method, operation in path_item.items()
        }
        self.assertEqual(actual_responses, expected_responses)

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
        source = self.connect_source("192.0.2.10")
        lease = self.sources.lease_http("192.0.2.10")
        body = stream_wav_body(lease, "192.0.2.20", "/streamline.wav")
        self.assertEqual(next(body), wav_header())
        source.hub.clients.publish(b"pcm")
        self.assertEqual(next(body), b"pcm")

        body.close()

        snapshot = self.sources.snapshot()["192.0.2.10"]
        lifecycle = cast("dict[str, object]", snapshot["lifecycle"])
        self.assertEqual(snapshot["clients"], 0)
        self.assertEqual(lifecycle["http_clients"], 0)


class TransportApiTests(unittest.TestCase):
    token = "bridge-api-test-token"

    @staticmethod
    def make_client(temporary: str, token: str | None) -> TestClient:
        store = TransportStateStore(Path(temporary) / "state.json")
        control = TransportControl(store, TlsPskAuthenticator(store), port=39000)
        sources = SourceRegistry(make_pipeline, max_sources=2)
        return TestClient(make_app(sources, "test", api_token=token, transport=control))

    def test_unlock_accepts_case_insensitive_bearer_scheme_and_rejects_bad_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = self.make_client(temporary, self.token)

            accepted = [
                client.post("/api/unlock", headers={"Authorization": f"{scheme} {self.token}"})
                for scheme in ("Bearer", "bearer", "BEARER")
            ]
            wrong = client.post("/api/unlock", headers={"Authorization": "Bearer wrong"})
            wrong_scheme = client.post("/api/unlock", headers={"Authorization": f"Basic {self.token}"})
            missing = client.post("/api/unlock")

            self.assertEqual(
                [(response.status_code, response.json()) for response in accepted], [(200, {"ok": True})] * 3
            )
            self.assertEqual(wrong.status_code, 401)
            self.assertEqual(wrong_scheme.status_code, 401)
            self.assertEqual(missing.status_code, 401)

    def test_an_unset_token_names_the_fix_instead_of_rejecting_the_credential(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = self.make_client(temporary, token=None)

            response = client.post("/api/unlock", headers={"Authorization": "Bearer anything"})

            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["error"]["code"], "control-disabled")
            self.assertIn("api_token", response.json()["error"]["message"])

    def test_mode_endpoint_switches_and_persists_the_listener_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = self.make_client(temporary, self.token)
            headers = {"Authorization": f"Bearer {self.token}"}

            denied = client.put("/api/transport/mode", json={"mode": "tls-psk"})
            enabled = client.put("/api/transport/mode", headers=headers, json={"mode": "tls-psk"})
            status = client.get("/api/transport")

            self.assertEqual(denied.status_code, 401)
            self.assertEqual(enabled.status_code, 200)
            self.assertEqual(enabled.json()["mode"], "tls-psk")
            self.assertEqual(status.json()["mode"], "tls-psk")
            self.assertTrue(TransportStateStore(Path(temporary) / "state.json").tls_enabled)

    def test_mode_endpoint_without_state_storage_is_unavailable(self) -> None:
        sources = SourceRegistry(make_pipeline, max_sources=2)
        client = TestClient(make_app(sources, "test", api_token=self.token))

        response = client.put(
            "/api/transport/mode",
            headers={"Authorization": f"Bearer {self.token}"},
            json={"mode": "tls-psk"},
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "transport-unavailable")


class RecordingApiTests(SourceTestCase):
    token = "test-recording-token"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.source = self.connect_source("192.0.2.10")
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

    def test_recording_download_accepts_bearer_or_ticket_and_rejects_neither(self) -> None:
        started = self.client.post(
            "/api/recordings",
            headers=self.headers,
            json={"source": "192.0.2.10", "title": "Download alternatives"},
        )
        recording_id = started.json()["recording"]["id"]
        self.source.hub.ingest(4, bytes(DEFAULT_FORMAT.payload_bytes))
        self.client.post(f"/api/recordings/{recording_id}/stop", headers=self.headers)
        ticket = self.client.post(f"/api/recordings/{recording_id}/download-ticket", headers=self.headers).json()["url"]

        bearer_only = self.client.get(f"/api/recordings/{recording_id}/file", headers=self.headers)
        ticket_only = self.client.get(ticket)
        ticket_with_bad_bearer = self.client.post(
            f"/api/recordings/{recording_id}/download-ticket", headers=self.headers
        ).json()["url"]
        ticket_alternative = self.client.get(
            ticket_with_bad_bearer,
            headers={"Authorization": "Bearer wrong"},
        )
        missing = self.client.get(f"/api/recordings/{recording_id}/file")
        invalid = self.client.get(
            f"/api/recordings/{recording_id}/file?ticket=invalid",
            headers={"Authorization": "Bearer wrong"},
        )

        self.assertEqual(bearer_only.content[:4], b"RIFF")
        self.assertEqual(ticket_only.content[:4], b"RIFF")
        self.assertEqual(ticket_alternative.content[:4], b"RIFF")
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(invalid.status_code, 401)
        self.assertIn("Bearer", missing.headers["WWW-Authenticate"])

    def test_tls_source_recording_lists_downloads_and_deletes_by_key_identity(self) -> None:
        key_id = "eli1-00112233445566778899aabbccddeeff"
        source = self.connect_source(key_id, peer_ip="192.0.2.20", transport="tls-psk")
        started = self.client.post(
            "/api/recordings",
            headers=self.headers,
            json={"source": key_id, "title": "Encrypted source"},
        )
        recording_id = started.json()["recording"]["id"]
        source.hub.ingest(1, bytes(DEFAULT_FORMAT.payload_bytes))
        self.client.post(f"/api/recordings/{recording_id}/stop", headers=self.headers)

        listed = self.client.get("/api/recordings", headers=self.headers)
        downloaded = self.client.get(f"/api/recordings/{recording_id}/file", headers=self.headers)
        deleted = self.client.delete(f"/api/recordings/{recording_id}", headers=self.headers)

        self.assertEqual(started.status_code, 201)
        self.assertEqual(listed.json()["saved"][0]["source"], key_id)
        self.assertEqual(downloaded.content[:4], b"RIFF")
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
        service = RecordingHttpService(self.recordings)
        urls = [service.issue_download(recording_id)["url"] for _ in range(MAX_DOWNLOAD_TICKETS + 1)]

        first = urlsplit(cast("str", urls[0]))
        last = urlsplit(cast("str", urls[-1]))
        with self.assertRaisesRegex(Exception, "new recording download"):
            service.open_download(recording_id, first.query.removeprefix("ticket="))
        opened = service.open_download(recording_id, last.query.removeprefix("ticket="))
        opened.source.close()

        bound = urlsplit(cast("str", service.issue_download(recording_id)["url"])).query.removeprefix("ticket=")
        with self.assertRaisesRegex(Exception, "new recording download"):
            service.open_download("different-recording", bound)
        with self.assertRaisesRegex(Exception, "new recording download"):
            service.open_download(recording_id, bound)
