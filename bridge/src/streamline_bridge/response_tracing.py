"""Time first PCM submission to ASGI, without claiming socket delivery."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from starlette.responses import StreamingResponse

if TYPE_CHECKING:
    from starlette.types import Message, Send


class FirstPcmSubmission:
    """One response-body lifetime, excluding the WAV header from completion."""

    def __init__(self) -> None:
        self._wall = time.time_ns()
        self._started = time.monotonic_ns()
        self._span: trace.Span | None = trace.get_tracer("streamline.audio").start_span(
            "streamline.bridge.first_pcm_submit", start_time=self._wall
        )

    def complete(self) -> None:
        if self._span is not None:
            self._span.end(end_time=self._wall + time.monotonic_ns() - self._started)
            self._span = None

    def close(self) -> None:
        if self._span is not None:
            self._span.set_status(Status(StatusCode.ERROR, "response ended before first PCM submission"))
            self.complete()


class PcmStreamingResponse(StreamingResponse):
    """Observe ASGI send completion after the single WAV header body."""

    async def stream_response(self, send: Send) -> None:
        submission = FirstPcmSubmission()
        header_sent = False

        async def timed_send(message: Message) -> None:
            nonlocal header_sent
            await send(message)
            if message["type"] == "http.response.body" and message.get("body"):
                if header_sent:
                    submission.complete()
                header_sent = True

        try:
            await super().stream_response(timed_send)
        finally:
            submission.close()
