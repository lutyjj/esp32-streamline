from __future__ import annotations

import struct
import unittest

from streamline_bridge.fanout import ClientFanout
from streamline_bridge.playout import MAX_UINT32, PlayoutBuffer
from streamline_bridge.protocol import DEFAULT_FORMAT


class FakeClock:
    def __init__(self) -> None:
        self.current = 100.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.current

    def monotonic(self) -> float:
        return self.current

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.current += seconds


def payload(sample: int) -> bytes:
    return struct.pack("<h", sample) * (DEFAULT_FORMAT.payload_bytes // 2)


class PlayoutBufferTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()

    def make_buffer(self, buffered_packets: int = 1, outage_packets: int = 2) -> PlayoutBuffer:
        interval = DEFAULT_FORMAT.frames_per_packet / DEFAULT_FORMAT.rate
        return PlayoutBuffer(
            playout_buffer_seconds=interval * buffered_packets,
            max_repeat_conceal_packets=1,
            max_outage_silence_seconds=interval * outage_packets,
            clock=self.clock,
        )

    def test_wrap_reorder_duplicate_and_late_packets_have_deterministic_policy(self) -> None:
        buffer = self.make_buffer(buffered_packets=3)
        maximum = payload(1000)
        zero = payload(2000)
        reordered = payload(3000)
        buffer.ingest(MAX_UINT32, maximum)
        buffer.ingest(1, reordered)
        buffer.ingest(0, zero)
        buffer.ingest(0, zero)
        self.assertEqual(buffer.next_chunk(), maximum)
        self.assertEqual(buffer.next_chunk(), zero)
        buffer.ingest(MAX_UINT32, maximum)
        snapshot = buffer.snapshot()
        self.assertEqual(buffer.next_chunk(), reordered)
        self.assertEqual(snapshot["reordered"], 1)
        self.assertEqual(snapshot["duplicate"], 1)
        self.assertEqual(snapshot["late"], 1)

    def test_short_loss_repeats_then_silences(self) -> None:
        buffer = self.make_buffer()
        source = payload(10_000)
        buffer.ingest(4, source)
        self.assertEqual(buffer.next_chunk(), source)
        self.assertEqual(buffer.next_chunk(), payload(5000))
        self.assertEqual(buffer.next_chunk(), bytes(DEFAULT_FORMAT.payload_bytes))
        self.assertEqual(buffer.snapshot()["concealed"], 2)

    def test_long_loss_rebuffers_then_new_packet_starts_a_new_run(self) -> None:
        buffer = self.make_buffer(outage_packets=1)
        buffer.ingest(4, payload(10_000))
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNone(buffer.next_chunk())
        self.assertEqual(buffer.snapshot()["underruns"], 1)
        buffer.ingest(20, payload(2000))
        self.assertEqual(buffer.next_chunk(), payload(2000))

    def test_session_reset_discards_old_sequence_state(self) -> None:
        buffer = self.make_buffer()
        buffer.ingest(50, payload(10))
        buffer.reset_source_session()
        buffer.ingest(0, payload(20))
        self.assertEqual(buffer.next_chunk(), payload(20))


class ClientFanoutTests(unittest.TestCase):
    def test_overflow_evicts_a_slow_client(self) -> None:
        fanout = ClientFanout(1)
        stream = fanout.register("192.0.2.10", "/streamline.wav")
        fanout.publish(b"first")
        fanout.publish(b"second")
        snapshot = fanout.snapshot()
        self.assertEqual(snapshot["clients"], 0)
        self.assertEqual(snapshot["slow_clients"], 1)
        self.assertEqual(snapshot["client_queue_drops"], 1)
        self.assertIsNone(stream.queue.get_nowait())
