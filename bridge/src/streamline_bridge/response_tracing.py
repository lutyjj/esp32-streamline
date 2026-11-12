"""Observe PCM ASGI submission and terminate response-owned samples on cancellation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from opentelemetry import trace
from starlette.responses import StreamingResponse

from streamline_bridge.packet_tracing import TimedSpan
from streamline_bridge.semconv import SPAN_STREAMLINE_BRIDGE_FIRST_PCM_SUBMIT

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping

    from starlette.background import BackgroundTask
    from starlette.types import Message, Send


class PcmBody(Protocol):
    def __iter__(self) -> Iterator[bytes]: ...
    def __next__(self) -> bytes: ...
    def submitted(self) -> None: ...
    def close(self) -> None: ...


class PcmStreamingResponse(StreamingResponse):
    """ASGI send completion proves submission, not remote socket delivery."""

    def __init__(
        self,
        body: PcmBody,
        tracer: trace.Tracer | None = None,
        *,
        media_type: str = "audio/wav",
        headers: Mapping[str, str] | None = None,
        background: BackgroundTask | None = None,
    ) -> None:
        super().__init__(body, media_type=media_type, headers=headers, background=background)
        self._body = body
        self._tracer = tracer or trace.NoOpTracer()

    async def stream_response(self, send: Send) -> None:
        submission = TimedSpan(self._tracer, SPAN_STREAMLINE_BRIDGE_FIRST_PCM_SUBMIT)
        header_sent = False
        completed = False

        async def timed_send(message: Message) -> None:
            nonlocal header_sent, completed
            await send(message)
            if message["type"] == "http.response.body" and message.get("body"):
                if header_sent:
                    submission.end()
                    completed = True
                    self._body.submitted()
                header_sent = True

        try:
            await super().stream_response(timed_send)
        finally:
            submission.end(None if completed else "response ended before first PCM submission")
            self._body.close()
