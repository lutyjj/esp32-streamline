from __future__ import annotations

import unittest
from typing import TYPE_CHECKING

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from streamline_bridge.response_tracing import PcmStreamingResponse
from streamline_bridge.wav_stream import wav_header

if TYPE_CHECKING:
    from collections.abc import Iterator

    from starlette.types import Message


class Body:
    def __init__(self) -> None:
        self.content = iter([wav_header(), bytes(1024)])
        self.completed = 0
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        return self

    def __next__(self) -> bytes:
        return next(self.content)

    def submitted(self) -> None:
        self.completed += 1

    def close(self) -> None:
        self.closed = True


class ResponseTracingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.addCleanup(provider.shutdown)
        self.tracer = provider.get_tracer("test")
        self.body = Body()

    async def test_only_a_completed_pcm_submission_ends_the_span(self) -> None:
        response = PcmStreamingResponse(self.body, self.tracer)

        async def send(message: Message) -> None:
            if message.get("more_body", True):
                self.assertEqual(len(self.exporter.get_finished_spans()), 0)
                self.assertEqual(self.body.completed, 0)
            else:
                self.assertEqual(len(self.exporter.get_finished_spans()), 1)

        await response.stream_response(send)
        spans = self.exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].name, "streamline.bridge.first_pcm_submit")
        self.assertEqual(spans[0].status.status_code, StatusCode.UNSET)
        self.assertEqual(self.body.completed, 1)
        self.assertTrue(self.body.closed)

    async def test_a_raised_pcm_write_error_marks_the_submission_as_failed(self) -> None:
        response = PcmStreamingResponse(self.body, self.tracer)

        async def send(message: Message) -> None:
            if message.get("body") == bytes(1024):
                raise OSError("client closed")

        with self.assertRaises(OSError):
            await response.stream_response(send)
        self.assertEqual(self.exporter.get_finished_spans()[0].status.status_code, StatusCode.ERROR)
        self.assertEqual(self.body.completed, 0)
        self.assertTrue(self.body.closed)
