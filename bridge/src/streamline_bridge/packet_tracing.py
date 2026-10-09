"""Sample packet residence in the playout buffer using the OpenTelemetry SDK."""

from __future__ import annotations

import os
import time
from typing import TYPE_CHECKING
from uuid import uuid4

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode

if TYPE_CHECKING:
    from collections.abc import Callable


def configure() -> TracerProvider | None:
    """Enable the experiment only with an explicit standard OTLP endpoint."""
    if not (os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")):
        return None
    provider = TracerProvider(
        resource=Resource.create({"service.name": "streamline-bridge", "service.instance.id": str(uuid4())})
    )
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(timeout=0.5),
            max_queue_size=128,
            max_export_batch_size=16,
            schedule_delay_millis=1000,
        )
    )
    trace.set_tracer_provider(provider)
    return provider


class PacketTraces:
    """Bounded samples owned and locked by one playout buffer."""

    def __init__(
        self,
        tracer: trace.Tracer | None = None,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
        wall_ns: Callable[[], int] = time.time_ns,
    ) -> None:
        self._tracer = tracer or trace.get_tracer("streamline.audio")
        self._monotonic_ns = monotonic_ns
        self._wall_ns = wall_ns
        self._pending: dict[int, tuple[trace.Span, int, int]] = {}

    def admit(self, sequence: int) -> None:
        if sequence % 257 or len(self._pending) >= 8:
            return
        wall = self._wall_ns()
        span = self._tracer.start_span(
            "streamline.bridge.playout",
            start_time=wall,
            attributes={"streamline.packet.sequence": sequence},
        )
        if span.is_recording():
            self._pending[sequence] = span, wall, self._monotonic_ns()

    def played(self, sequence: int, discarded: bool = False) -> None:
        if pending := self._pending.pop(sequence, None):
            span, wall, started = pending
            if discarded:
                span.set_status(Status(StatusCode.ERROR, "silence removed to reduce buffer"))
            span.end(end_time=wall + self._monotonic_ns() - started)

    def reset(self) -> None:
        for span, wall, started in self._pending.values():
            span.set_status(Status(StatusCode.ERROR, "source reset before playout"))
            span.end(end_time=wall + self._monotonic_ns() - started)
        self._pending.clear()
