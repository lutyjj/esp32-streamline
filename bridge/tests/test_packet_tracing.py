from __future__ import annotations

import unittest
from unittest.mock import patch

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from streamline_bridge.packet_tracing import PacketTraces
from streamline_bridge.playout import PlayoutBuffer
from streamline_bridge.protocol import DEFAULT_FORMAT


class PacketTracingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.exporter = InMemorySpanExporter()
        self.provider = TracerProvider()
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.addCleanup(self.provider.shutdown)
        self.monotonic = 0
        self.wall = 1_000_000_000
        self.traces = PacketTraces(
            self.provider.get_tracer("streamline.audio"), lambda: self.monotonic, lambda: self.wall
        )

    def test_playout_path_measures_one_sample_despite_wall_clock_step_and_duplicate(self) -> None:
        with patch("streamline_bridge.playout.PacketTraces", return_value=self.traces):
            buffer = PlayoutBuffer(0.001, 1, 1.0, max_playout_buffer_seconds=0.001)
        self.addCleanup(buffer.close)
        packet = bytes(DEFAULT_FORMAT.payload_bytes)
        self.assertTrue(buffer.ingest(257, packet))
        self.assertTrue(buffer.ingest(257, packet))
        self.wall += 9_000_000_000
        self.monotonic = 1_250_000
        self.assertEqual(buffer.next_chunk(), packet)
        spans = self.exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].name, "streamline.bridge.playout")
        self.assertEqual(spans[0].start_time, 1_000_000_000)
        self.assertEqual(spans[0].end_time, 1_001_250_000)
        self.assertEqual(dict(spans[0].attributes or {}), {"streamline.packet.sequence": 257})

    def test_reset_finishes_pending_samples_as_not_delivered(self) -> None:
        with patch("streamline_bridge.playout.PacketTraces", return_value=self.traces):
            buffer = PlayoutBuffer(1.0, 1, 1.0)
        self.addCleanup(buffer.close)
        buffer.ingest(257, b"")
        buffer.reset_source_session()
        spans = self.exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].status.status_code, StatusCode.ERROR)
        buffer.ingest(257, b"")
        buffer.close()
        self.assertEqual(len(self.exporter.get_finished_spans()), 2)

    def test_sampling_is_bounded_when_a_consumer_never_plays(self) -> None:
        for sequence in range(2570):
            self.traces.admit(sequence)
        self.traces.reset()
        self.assertEqual(len(self.exporter.get_finished_spans()), 8)
