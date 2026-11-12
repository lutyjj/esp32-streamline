"""Sampled packet context and monotonic timing through playout and delivery."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.trace import Status, StatusCode

from streamline_bridge.semconv import (
    SAMPLE_INTERVAL,
    SPAN_STREAMLINE_BRIDGE_CLIENT_SUBMIT,
    SPAN_STREAMLINE_BRIDGE_PLAYOUT,
    STREAMLINE_PACKET_SEQUENCE,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from streamline_bridge.telemetry import Telemetry


class TimedSpan:
    """End once with a duration immune to wall-clock adjustments."""

    def __init__(
        self,
        tracer: trace.Tracer,
        name: str,
        parent: Context | None = None,
        sequence: int | None = None,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
        wall_ns: Callable[[], int] = time.time_ns,
    ) -> None:
        self._clock = monotonic_ns
        self._started = monotonic_ns()
        self._wall = wall_ns()
        self.span = tracer.start_span(
            name,
            context=parent or Context(),
            start_time=self._wall,
            attributes={STREAMLINE_PACKET_SEQUENCE: sequence} if sequence is not None else None,
        )
        self._ended = False

    def end(self, error: str | None = None) -> None:
        if not self._ended:
            if error is not None:
                self.span.set_status(Status(StatusCode.ERROR, error))
            self.span.end(end_time=self._wall + self._clock() - self._started)
            self._ended = True


@dataclass(frozen=True)
class PacketContext:
    context: Context
    sequence: int
    tracer: trace.Tracer

    def delivery(self) -> TimedSpan:
        return TimedSpan(self.tracer, SPAN_STREAMLINE_BRIDGE_CLIENT_SUBMIT, self.context, self.sequence)


@dataclass(frozen=True)
class AudioChunk:
    payload: bytes
    context: PacketContext | None = None


class PacketTraces:
    """Bounded samples owned and locked by one playout buffer."""

    def __init__(
        self,
        telemetry: Telemetry | None = None,
        *,
        tracer: trace.Tracer | None = None,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
        wall_ns: Callable[[], int] = time.time_ns,
    ) -> None:
        self._telemetry = telemetry
        self._tracer = tracer or trace.NoOpTracer()
        self._monotonic_ns = monotonic_ns
        self._wall_ns = wall_ns
        self._pending: dict[int, tuple[TimedSpan, trace.Tracer]] = {}

    def admit(self, sequence: int, parent: Context | None = None) -> None:
        if (parent is None and sequence % SAMPLE_INTERVAL) or len(self._pending) >= 8:
            return
        tracer = self._telemetry.tracer if self._telemetry is not None else self._tracer
        span = TimedSpan(tracer, SPAN_STREAMLINE_BRIDGE_PLAYOUT, parent, sequence, self._monotonic_ns, self._wall_ns)
        if span.span.is_recording():
            self._pending[sequence] = span, tracer

    def played(self, sequence: int, discarded: bool = False) -> PacketContext | None:
        pending = self._pending.pop(sequence, None)
        if pending is None:
            return None
        span, tracer = pending
        span.end("silence removed to reduce buffer" if discarded else None)
        return None if discarded else PacketContext(trace.set_span_in_context(span.span), sequence, tracer)

    def reset(self) -> None:
        for span, _tracer in self._pending.values():
            span.end("source reset before playout")
        self._pending.clear()
