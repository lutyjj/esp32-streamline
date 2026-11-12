"""Volatile diagnostic sessions with an owned OpenTelemetry SDK provider."""

from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING
from urllib.parse import urlsplit
from uuid import uuid4

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult

from streamline_bridge.semconv import SAMPLE_INTERVAL, STREAMLINE_CLOCK_ALIGNED, STREAMLINE_SAMPLE_INTERVAL
from streamline_bridge.telemetry_models import SessionRequest, SessionState, TelemetryStatus

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence


class SessionBusyError(RuntimeError):
    """A session still owns the diagnostic export worker."""


def validate_session(config: SessionRequest) -> None:
    """Apply the endpoint policy shared with the device API."""
    parts = urlsplit(config.endpoint)
    if (
        not parts.hostname
        or any(char in config.endpoint for char in "@#\0")
        or parts.query
        or not parts.path.endswith("/v1/traces")
        or len(config.endpoint.encode()) > 512
    ):
        raise ValueError("endpoint must include a host and end in /v1/traces without credentials or query")
    if parts.scheme != "https" and not (
        parts.scheme == "http" and config.allow_insecure and not config.bearer_token and not config.ca_certificate_pem
    ):
        raise ValueError("HTTPS is required; credential-free HTTP requires allow_insecure")
    if any(not 33 <= ord(char) <= 126 for char in config.bearer_token):
        raise ValueError("bearer_token must contain visible ASCII bytes")
    if "\0" in config.ca_certificate_pem or len(config.ca_certificate_pem.encode()) > 2048:
        raise ValueError("ca_certificate_pem must contain at most 2048 bytes without NUL")


class ExportHealth(SpanExporter):
    """Count SDK export results without changing its transport or retry policy."""

    def __init__(self, exporter: SpanExporter) -> None:
        self.exporter: SpanExporter | None = exporter
        self.lock = threading.Lock()
        self._export_lock = threading.Lock()
        self.ended = self.exported = self.failed = self.failures = 0

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with self._export_lock:
            return self._export(spans)

    def _export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            result = self.exporter.export(spans) if self.exporter is not None else SpanExportResult.FAILURE
        except Exception:
            result = SpanExportResult.FAILURE
        with self.lock:
            if result == SpanExportResult.SUCCESS:
                self.exported += len(spans)
            else:
                self.failed += len(spans)
                self.failures += 1
        return result

    def shutdown(self) -> None:
        # The SDK can reach exporter shutdown with an export still running.
        # Its session owner must keep stopping until that operation releases I/O.
        with self._export_lock:
            if self.exporter is not None:
                self.exporter.shutdown()
                self.exporter = None


class CountingBatchProcessor(BatchSpanProcessor):
    """Observe ended spans; the SDK owns batching, backpressure, and shutdown."""

    def __init__(self, health: ExportHealth) -> None:
        self.health = health
        super().__init__(health, max_queue_size=128, max_export_batch_size=16, schedule_delay_millis=1000)

    def on_end(self, span: ReadableSpan) -> None:
        with self.health.lock:
            self.health.ended += 1
        super().on_end(span)


class Telemetry:
    """One bounded session; stopping is asynchronous and cannot overlap a restart."""

    def __init__(self, exporter_factory: Callable[[SessionRequest], SpanExporter]) -> None:
        self._factory = exporter_factory
        self._lock = threading.Lock()
        self._instance = str(uuid4())
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self._tracer: trace.Tracer = trace.NoOpTracer()
        self._health: ExportHealth | None = None
        self._state = SessionState.disabled
        self._deadline = 0.0

    def start(self, config: SessionRequest) -> None:
        validate_session(config)
        with self._lock:
            if self._state in (SessionState.running, SessionState.stopping):
                raise SessionBusyError("a telemetry session is running or stopping")
            health = ExportHealth(self._factory(config))
            provider = TracerProvider(
                resource=Resource(
                    {
                        "service.name": "streamline-bridge",
                        "service.instance.id": self._instance,
                        STREAMLINE_SAMPLE_INTERVAL: SAMPLE_INTERVAL,
                        STREAMLINE_CLOCK_ALIGNED: False,
                    }
                ),
                shutdown_on_exit=False,
            )
            try:
                provider.add_span_processor(CountingBatchProcessor(health))
                self._stop.clear()
                worker = threading.Thread(
                    target=self._run, args=(provider, config.duration_seconds), name="telemetry-session", daemon=True
                )
                worker.start()
            except Exception:
                provider.shutdown()
                raise
            self._worker = worker
            self._health = health
            self._deadline = time.monotonic() + config.duration_seconds
            self._tracer = provider.get_tracer("streamline.audio")
            self._state = SessionState.running

    def _run(self, provider: TracerProvider, duration: int) -> None:
        self._stop.wait(duration)
        with self._lock:
            self._state = SessionState.stopping
            self._tracer = trace.NoOpTracer()
        try:
            provider.shutdown()
        finally:
            with self._lock:
                self._state = SessionState.finished

    def stop(self) -> None:
        with self._lock:
            if self._state == SessionState.running:
                self._state = SessionState.stopping
                self._tracer = trace.NoOpTracer()
                self._stop.set()

    def close(self) -> None:
        self.stop()
        if self._worker is not None:
            self._worker.join()

    @property
    def tracer(self) -> trace.Tracer:
        with self._lock:
            return self._tracer

    def snapshot(self) -> TelemetryStatus:
        with self._lock:
            ended = exported = failed = failures = 0
            if self._health is not None:
                with self._health.lock:
                    ended, exported, failed, failures = (
                        self._health.ended,
                        self._health.exported,
                        self._health.failed,
                        self._health.failures,
                    )
            return TelemetryStatus(
                state=self._state,
                remaining_seconds=max(0, int(self._deadline - time.monotonic())),
                sample_interval_packets=SAMPLE_INTERVAL,
                ended_spans=ended,
                exported_spans=exported,
                failed_spans=failed,
                discarded_spans=max(0, ended - exported - failed) if self._state == SessionState.finished else 0,
                export_failures=failures,
                pending_spans=max(0, ended - exported - failed) if self._state != SessionState.finished else 0,
                wall_clock_ready=True,
                cross_host_clock_aligned=False,
            )
