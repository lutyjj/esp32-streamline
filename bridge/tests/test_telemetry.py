from __future__ import annotations

import threading
import unittest
from typing import TYPE_CHECKING
from unittest.mock import patch

from fastapi.testclient import TestClient
from opentelemetry.sdk._shared_internal import BatchProcessor
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from streamline_bridge.http import make_app
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import SourceRegistry
from streamline_bridge.telemetry import Telemetry
from streamline_bridge.telemetry_models import SessionRequest, SessionState

if TYPE_CHECKING:
    from collections.abc import Sequence

    from opentelemetry.sdk.trace import ReadableSpan


class BlockedExporter(SpanExporter):
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.closed = False
        self.closed_event = threading.Event()

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.entered.set()
        if not self.release.wait(5):
            raise TimeoutError("test did not release exporter")
        return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        self.closed = True
        self.closed_event.set()


class TelemetryTests(unittest.TestCase):
    def config(self) -> SessionRequest:
        return SessionRequest(endpoint="http://192.0.2.1:4318/v1/traces", duration_seconds=30, allow_insecure=True)

    def test_stop_is_nonblocking_and_queue_loss_is_accounted_after_shutdown(self) -> None:
        exporter = BlockedExporter()
        manager = Telemetry(lambda _config: exporter)
        self.addCleanup(manager.close)
        self.addCleanup(exporter.release.set)
        manager.start(self.config())
        for _ in range(16):
            manager.tracer.start_span("test").end()
        self.assertTrue(exporter.entered.wait(2))
        for _ in range(400):
            manager.tracer.start_span("test").end()
        manager.stop()
        self.assertEqual(manager.snapshot().state, SessionState.stopping)
        self.assertFalse(manager.tracer.start_span("test").is_recording())
        with self.assertRaises(RuntimeError):
            manager.start(self.config())
        exporter.release.set()
        manager.close()
        status = manager.snapshot()
        self.assertEqual(status.state, SessionState.finished)
        self.assertEqual(status.ended_spans, 416)
        self.assertEqual(status.ended_spans, status.failed_spans + status.discarded_spans)
        self.assertGreater(status.discarded_spans, 0)
        self.assertGreater(status.export_failures, 0)
        self.assertEqual(status.pending_spans, 0)
        self.assertTrue(exporter.closed)

    def test_api_auth_validation_health_and_restart(self) -> None:
        manager = Telemetry(lambda _config: InMemorySpanExporter())
        self.addCleanup(manager.close)
        sources = SourceRegistry(lambda: AudioPipeline(4, 0.01, 1, 1, start_worker=False), 1)
        self.addCleanup(sources.close)
        client = TestClient(make_app(sources, "test", api_token="test-token-for-api", telemetry=manager))
        self.assertEqual(client.get("/api/telemetry").status_code, 401)
        self.assertEqual(client.post("/api/telemetry/start", json=self.config().model_dump()).status_code, 401)
        headers = {"Authorization": "Bearer test-token-for-api"}
        self.assertEqual(client.get("/api/telemetry", headers=headers).json()["state"], "disabled")
        for changes in (
            {"allow_insecure": False},
            {"bearer_token": "secret"},
            {"endpoint": "file:///v1/traces"},
            {"endpoint": "https://user:secret@collector.example/v1/traces"},
            {"endpoint": "https://collector.example/v1/traces?token=secret"},
            {"duration_seconds": 29},
            {"duration_seconds": 3601},
            {"unknown": True},
            {"allow_insecure": None},
        ):
            with self.subTest(changes=changes):
                response = client.post(
                    "/api/telemetry/start", json=self.config().model_dump() | changes, headers=headers
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(manager.snapshot().state, SessionState.disabled)
        started = client.post("/api/telemetry/start", json=self.config().model_dump(), headers=headers)
        self.assertEqual(started.status_code, 202)
        self.assertEqual(started.json()["state"], "running")
        self.assertNotIn("endpoint", started.json())
        self.assertNotIn("bearer_token", started.json())
        self.assertEqual(
            client.post("/api/telemetry/start", json=self.config().model_dump(), headers=headers).status_code, 409
        )
        self.assertEqual(client.post("/api/telemetry/stop", headers=headers).status_code, 202)
        manager.close()
        self.assertEqual(client.get("/api/telemetry", headers=headers).json()["state"], "finished")
        self.assertEqual(
            client.post("/api/telemetry/start", json=self.config().model_dump(), headers=headers).status_code, 202
        )

    def test_sdk_shutdown_timeout_does_not_release_an_active_export(self) -> None:
        exporter = BlockedExporter()
        manager = Telemetry(lambda _config: exporter)
        self.addCleanup(manager.close)
        self.addCleanup(exporter.release.set)
        shutdown_entered = threading.Event()
        native_shutdown = BatchProcessor.shutdown

        def immediate_shutdown(processor: BatchProcessor[ReadableSpan]) -> None:
            shutdown_entered.set()
            native_shutdown(processor, timeout_millis=0)

        with patch.object(BatchProcessor, "shutdown", immediate_shutdown):
            manager.start(self.config())
            for _ in range(16):
                manager.tracer.start_span("test").end()
            self.assertTrue(exporter.entered.wait(2))
            manager.stop()
            self.assertTrue(shutdown_entered.wait(2))
            self.assertFalse(exporter.closed_event.wait(0.1))
            self.assertEqual(manager.snapshot().state, SessionState.stopping)
            with self.assertRaises(RuntimeError):
                manager.start(self.config())
            exporter.release.set()
            manager.close()
        self.assertTrue(exporter.closed)
        self.assertEqual(manager.snapshot().state, SessionState.finished)
