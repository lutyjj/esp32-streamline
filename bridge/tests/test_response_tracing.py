from __future__ import annotations

import unittest
from typing import TYPE_CHECKING
from unittest.mock import patch

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from streamline_bridge.http import wav_header
from streamline_bridge.response_tracing import PcmStreamingResponse

if TYPE_CHECKING:
    from starlette.types import Message


class ResponseTracingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.addCleanup(provider.shutdown)
        tracer = patch("streamline_bridge.response_tracing.trace.get_tracer", return_value=provider.get_tracer("test"))
        tracer.start()
        self.addCleanup(tracer.stop)

    async def test_only_a_completed_pcm_submission_ends_the_span(self) -> None:
        response = PcmStreamingResponse(iter([wav_header(), bytes(1024)]))

        async def send(message: Message) -> None:
            if message.get("more_body", True):
                self.assertEqual(len(self.exporter.get_finished_spans()), 0)
            else:
                self.assertEqual(len(self.exporter.get_finished_spans()), 1)

        await response.stream_response(send)
        spans = self.exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].name, "streamline.bridge.first_pcm_submit")
        self.assertEqual(spans[0].status.status_code, StatusCode.UNSET)

    async def test_a_raised_pcm_write_error_marks_the_submission_as_failed(self) -> None:
        response = PcmStreamingResponse(iter([wav_header(), bytes(1024)]))

        async def send(message: Message) -> None:
            if message.get("body") == bytes(1024):
                raise OSError("client closed")

        with self.assertRaises(OSError):
            await response.stream_response(send)
        self.assertEqual(self.exporter.get_finished_spans()[0].status.status_code, StatusCode.ERROR)
